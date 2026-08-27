import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  addSource,
  analyzeWorkspaceMigration,
  applyUpdate,
  applyWorkspaceMigration,
  captureSource,
  checkFramework,
  diffSource,
  getSourceLog,
  getSourceStatus,
  initFramework,
  loadManifest,
  readSourceContentListing,
  syncSource,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-migrate");
const GIT_INTEGRATION_TIMEOUT_MS = 45_000;

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

/** Git repository with one commit on `main`, the shape a 0.13 living source had. */
async function gitOrigin(name: string): Promise<string> {
  const repo = path.join(await tempDirs.createTempDir(), name);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "assay@example.test"]);
  await git(repo, ["config", "user.name", "Assay Test"]);
  await writeFile(path.join(repo, "README.md"), "# Live\n\nv1\n", "utf8");
  await writeFile(path.join(repo, "src", "index.ts"), "export const live = 1;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  return repo;
}

/**
 * Build a 0.13-shaped workspace out of records this build wrote, then wind them
 * back to the previous format.
 *
 * Winding a real record back beats hand-writing one: the capture bytes, their
 * manifest, and its hash are all genuine, so the migration is exercised against
 * the shape it will actually meet rather than a plausible-looking sketch.
 */
async function legacyWorkspace(name: string): Promise<{
  readonly root: string;
  readonly origin: string;
  readonly checkout: string;
  readonly checkoutObservation: string;
  readonly frozenObservation: string;
  readonly frozenFingerprint: string;
}> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });

  const origin = await gitOrigin("live-origin");
  const live = await addSource({ root, source: origin, alias: "live" });

  const frozenOrigin = path.join(await tempDirs.createTempDir(), "frozen-origin");
  await mkdir(frozenOrigin, { recursive: true });
  await writeFile(path.join(frozenOrigin, "README.md"), "# Frozen\n\nkept\n", "utf8");
  const frozen = await addSource({ root, source: frozenOrigin, alias: "froze" });
  const captured = await captureSource({ root, alias: "froze" });

  // `live` becomes a living checkout source: the bytes already sit under
  // checkout/, so only the records wind back — including a fingerprint that has
  // no home in the new schema.
  const liveRoot = path.join(root, "sources", "live");
  await writeLegacyLineage(liveRoot, { mode: "living", default_capture_mode: "checkout" });
  const liveFingerprint = "a".repeat(64);
  await writeLegacyObservation(liveRoot, live.observation.observation_id, {
    capture_mode: "checkout",
    fingerprint: {
      algorithm: "sha256-tree-v1",
      value: liveFingerprint,
      file_count: 2,
      byte_count: 40,
      excluded: [],
    },
    manifest: `manifests/${live.observation.observation_id}.json`,
    materials_path: "materials",
    checkout_path: "checkout",
  });
  await mkdir(path.join(liveRoot, "manifests"), { recursive: true });
  await writeFile(
    path.join(liveRoot, "manifests", `${live.observation.observation_id}.json`),
    JSON.stringify({ __schema: 1, root: "checkout", files: [] }),
    "utf8",
  );

  // `froze` becomes a frozen source: no readable root of its own, only the
  // archive capture and the manifest that proved it.
  const frozenRoot = path.join(root, "sources", "froze");
  const capturedManifest = JSON.parse(
    await readFile(path.join(frozenRoot, captured.capture.manifest), "utf8"),
  );
  await rm(path.join(frozenRoot, "content"), { recursive: true, force: true });
  await rm(path.join(frozenRoot, "observations", `${frozen.observation.observation_id}.yaml`), {
    force: true,
  });
  await rm(path.join(frozenRoot, path.dirname(captured.capture.manifest), "manifest.json"), {
    force: true,
  });
  await writeLegacyLineage(frozenRoot, { mode: "frozen", default_capture_mode: "archive" });
  const frozenObservation = captured.observation.observation_id;
  await writeLegacyObservation(frozenRoot, frozenObservation, {
    capture_mode: "archive",
    fingerprint: {
      algorithm: "sha256-tree-v1",
      value: captured.capture.value,
      file_count: captured.capture.file_count,
      byte_count: captured.capture.byte_count,
      excluded: [],
    },
    manifest: `manifests/${frozenObservation}.json`,
    materials_path: "materials",
    capture_path: `captures/${frozenObservation}/source`,
  });
  await mkdir(path.join(frozenRoot, "manifests"), { recursive: true });
  await writeFile(
    path.join(frozenRoot, "manifests", `${frozenObservation}.json`),
    JSON.stringify(capturedManifest),
    "utf8",
  );

  const manifestFile = path.join(root, ".assay", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.framework_version = "0.13.0";
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

  return {
    root,
    origin,
    checkout: path.join(liveRoot, "checkout"),
    checkoutObservation: live.observation.observation_id,
    frozenObservation,
    frozenFingerprint: captured.capture.value,
  };
}

/** Strip the 0.14-only fields so the record on disk looks like 0.13 wrote it. */
function withoutFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));
}

async function writeLegacyLineage(
  entryRoot: string,
  legacy: { readonly mode: string; readonly default_capture_mode: string },
): Promise<void> {
  const file = path.join(entryRoot, "source.yaml");
  const record = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(
    file,
    stringifyYaml({ ...withoutFields(record, ["content_mode"]), ...legacy }),
    "utf8",
  );
}

async function writeLegacyObservation(
  entryRoot: string,
  observationId: string,
  legacy: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.join(entryRoot, "observations"), { recursive: true });
  const file = path.join(entryRoot, "observations", `${observationId}.yaml`);
  const parsed = ((await exists(file)) ? parseYaml(await readFile(file, "utf8")) : {}) as Record<
    string,
    unknown
  >;
  const record = withoutFields(parsed, ["kind", "note", "advisories", "capture"]);
  await writeFile(
    file,
    stringifyYaml({
      observation_id: observationId,
      observed_on: record.observed_on ?? "2026-07-01T08:00:00.000Z",
      lineage_id: record.lineage_id ?? path.basename(entryRoot),
      source_path: record.source_path ?? `sources/${path.basename(entryRoot)}`,
      previous_observation: record.previous_observation ?? null,
      change_class: record.change_class ?? "normal",
      ...legacy,
      ...(record.vcs === undefined ? {} : { vcs: record.vcs }),
    }),
    "utf8",
  );
}

describe("workspace migration into 0.14", () => {
  it(
    "refuses the old envelope everywhere and names the command that fixes it",
    async () => {
      const legacy = await legacyWorkspace("MigrationRefusal");

      await expect(loadManifest(legacy.root)).rejects.toMatchObject({
        code: "WORKSPACE_CUTOVER_REQUIRED",
        observed: "0.13.0+s4+l8",
        required: "0.14.0+s4+l8",
        locator: "assay-update:0.13.0+s4+l8->0.14.0+s4+l8",
      });
      await expect(loadManifest(legacy.root)).rejects.toThrow(/run `assay update`/);
      await expect(getSourceStatus({ root: legacy.root })).rejects.toMatchObject({
        code: "WORKSPACE_CUTOVER_REQUIRED",
      });
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "reports what it would rewrite without touching anything",
    async () => {
      const legacy = await legacyWorkspace("MigrationDryRun");
      const lineageBefore = await readFile(
        path.join(legacy.root, "sources", "live", "source.yaml"),
        "utf8",
      );

      const analysis = await analyzeWorkspaceMigration(legacy.root);
      expect(analysis).toMatchObject({ required: true, from: "0.13.0", to: "0.14.0" });
      expect(analysis.steps.map((step) => step.id)).toContain("sources-content-mode");

      const dryRun = await applyUpdate({ root: legacy.root, dryRun: true });
      expect(dryRun.migration).toMatchObject({ from: "0.13.0", to: "0.14.0" });
      expect(dryRun.report.notes.join("\n")).toContain("dry-run: workspace records would migrate");
      expect(await readFile(path.join(legacy.root, "sources", "live", "source.yaml"), "utf8")).toBe(
        lineageBefore,
      );
      expect(
        JSON.parse(await readFile(path.join(legacy.root, ".assay", "manifest.json"), "utf8"))
          .framework_version,
      ).toBe("0.13.0");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "collapses living and frozen sources into content modes without dropping a record",
    async () => {
      const legacy = await legacyWorkspace("MigrationApply");

      const result = await applyWorkspaceMigration({ root: legacy.root });
      expect(result).toMatchObject({ from: "0.13.0", to: "0.14.0" });
      expect(result.changes.join("\n")).toContain("content_mode checkout");
      expect(result.changes.join("\n")).toContain("content_mode copy");

      expect((await loadManifest(legacy.root))?.framework_version).toBe("0.14.0");
      expect(await checkFramework({ root: legacy.root })).toMatchObject({ ok: true });

      const status = await getSourceStatus({ root: legacy.root });
      expect(status.sources.map((source) => [source.alias, source.contentMode]).sort()).toEqual([
        ["froze", "copy"],
        ["live", "checkout"],
      ]);

      // The living checkout keeps its bytes where they were.
      expect(await exists(path.join(legacy.root, "sources", "live", "checkout", "README.md"))).toBe(
        true,
      );
      const liveObservation = await readFile(
        path.join(
          legacy.root,
          "sources",
          "live",
          "observations",
          `${legacy.checkoutObservation}.yaml`,
        ),
        "utf8",
      );
      expect(liveObservation).toContain("kind: add");
      expect(liveObservation).not.toContain("capture_mode:");
      // Nothing silently dropped: the retired tree hash survives in the note.
      expect(liveObservation).toContain("a".repeat(64));

      // The frozen source becomes copied content, filled from its own capture.
      const frozenContent = path.join(legacy.root, "sources", "froze", "content", "README.md");
      expect(await readFile(frozenContent, "utf8")).toContain("kept");
      const frozenObservation = await readFile(
        path.join(
          legacy.root,
          "sources",
          "froze",
          "observations",
          `${legacy.frozenObservation}.yaml`,
        ),
        "utf8",
      );
      expect(frozenObservation).toContain("kind: capture");
      expect(frozenObservation).toContain(legacy.frozenFingerprint);

      // Its archive capture is now a first-class capture, manifest included.
      const listing = await readSourceContentListing({
        root: legacy.root,
        alias: "froze",
        observation: legacy.frozenObservation,
      });
      expect(listing.origin).toBe("capture");
      expect(listing.fingerprint.value).toBe(legacy.frozenFingerprint);

      // The 0.13 manifests are left on disk rather than deleted behind the user.
      expect(await exists(path.join(legacy.root, "sources", "froze", "manifests"))).toBe(true);
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "leaves both migrated sources usable",
    async () => {
      const legacy = await legacyWorkspace("MigrationUsable");
      await applyWorkspaceMigration({ root: legacy.root });

      // Copied content: capture it again, and the bytes still hash the same.
      expect((await getSourceLog({ root: legacy.root, alias: "froze" })).entries).toHaveLength(1);
      const captured = await captureSource({ root: legacy.root, alias: "froze" });
      expect(captured.capture.file_count).toBe(1);
      expect(captured.capture.value).toBe(legacy.frozenFingerprint);
      expect(
        (await getSourceStatus({ root: legacy.root, alias: "froze" })).sources[0]?.captures,
      ).toBe(2);
      expect(await diffSource({ root: legacy.root, alias: "froze" })).toMatchObject({
        added: [],
        removed: [],
        changed: [],
      });

      // Checkout-backed content: sync a dirty checkout against a moved upstream.
      // It records the advisory and proceeds; the local edit is still there.
      await writeFile(path.join(legacy.checkout, "LOCAL.md"), "local work\n", "utf8");
      await writeFile(
        path.join(legacy.origin, "src", "index.ts"),
        "export const live = 2;\n",
        "utf8",
      );
      await git(legacy.origin, ["commit", "-am", "upstream change"]);

      const synced = await syncSource({ root: legacy.root, alias: "live" });
      expect(synced.observation?.advisories).toContain("observed with local modifications");
      expect(await readFile(path.join(legacy.checkout, "LOCAL.md"), "utf8")).toBe("local work\n");
      expect(await readFile(path.join(legacy.checkout, "src", "index.ts"), "utf8")).toContain(
        "live = 2",
      );
      expect((await getSourceLog({ root: legacy.root, alias: "live" })).entries).toHaveLength(2);

      expect(await checkFramework({ root: legacy.root })).toMatchObject({ ok: true });
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "migrates and then updates templates in one `assay update`",
    async () => {
      const legacy = await legacyWorkspace("MigrationThroughUpdate");

      const applied = await applyUpdate({ root: legacy.root });
      expect(applied.migration).toMatchObject({ from: "0.13.0", to: "0.14.0" });
      expect(applied.report.notes.join("\n")).toContain("migrated workspace records");
      expect((await loadManifest(legacy.root))?.framework_version).toBe("0.14.0");
      expect(await checkFramework({ root: legacy.root })).toMatchObject({ ok: true });

      // A second run has nothing left to migrate.
      const again = await applyUpdate({ root: legacy.root });
      expect(again.migration).toBeUndefined();
      const events = await readdir(path.join(legacy.root, ".assay", "events"));
      expect(events.length).toBeGreaterThan(0);
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );
});
