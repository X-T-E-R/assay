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
  listSourceAdoptions,
  loadManifest,
  readSourceContentListing,
  registerSystem,
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

/**
 * Hand-write the 0.13 adoption store: a two-target definition with three
 * mappings, a decided target, and the inspection/evidence/decision chain that
 * accumulated around it.
 *
 * Unlike the source records above, there is no 0.14 writer to wind back — the
 * whole shape is retired — so the fixture is written out directly. The migration
 * proof against the real 0.13 CLI lives outside the test suite.
 */
async function writeLegacyAdoption(
  root: string,
  observation: string,
): Promise<{ readonly digest: string; readonly decisionId: string }> {
  const entryRoot = path.join(root, ".assay", "source-adoptions", "upstream-product");
  const digest = "b".repeat(64);
  const decisionId = "decision-000000000000000000000001";
  const inspectionId = "inspection-000000000000000000000001";
  const definition = {
    schema: "assay.source-adoption-definition/v1",
    id: "upstream-product",
    title: "Upstream adoption",
    source: { alias: "live", observation },
    targets: [
      { id: "product", system: "product", adapter: "local-system/v1" },
      { id: "docs", system: "docs", adapter: "local-system/v1" },
    ],
    mappings: [
      {
        id: "readme",
        kind: "documentation",
        mode: "copy",
        source: { path: "README.md", match: "exact" },
        target: { target_id: "product", path: "README.md", match: "exact" },
        evidence: [],
      },
      {
        id: "src",
        kind: "source-code",
        mode: "adapt",
        source: { path: "src", match: "prefix" },
        target: { target_id: "product", path: "vendor", match: "prefix" },
        evidence: [],
      },
      {
        id: "docs-readme",
        kind: "documentation",
        mode: "adapt",
        source: { path: "README.md", match: "exact" },
        target: { target_id: "docs", path: "upstream.md", match: "exact" },
        evidence: [],
      },
    ],
    evidence: [],
  };
  const baseline = {
    decision_id: decisionId,
    definition_digest: digest,
    source: {
      alias: "live",
      lineage_id: "live",
      observation_id: observation,
      manifest_fingerprint: "c".repeat(64),
      vcs_commit: "d".repeat(40),
      locators: {},
    },
    target: { system: "product", registered_path: "systems/product", locators: {} },
    accepted_at: "2026-07-20T10:00:00.000Z",
  };

  for (const [relative, value] of [
    [path.join("definitions", `${digest}.json`), definition],
    [
      "state.json",
      {
        schema: "assay.source-adoption-state/v1",
        adoption_id: "upstream-product",
        current_definition: digest,
        generation: 2,
        targets: { product: { baseline }, docs: { baseline: null } },
        decisions: [decisionId],
        updated_at: "2026-07-20T10:00:00.000Z",
      },
    ],
    [
      path.join("decisions", `${decisionId}.json`),
      {
        schema: "assay.source-adoption-decision/v1",
        id: decisionId,
        adoption_id: "upstream-product",
        target_id: "product",
        outcome: "accept",
        reason: "Reviewed the parser rewrite by hand.",
        inspection_id: inspectionId,
      },
    ],
    [
      path.join("inspections", `${inspectionId}.json`),
      { schema: "assay.source-adoption-inspection/v1", id: inspectionId },
    ],
    [
      path.join("evidence", "evidence-000000000000000000000001.json"),
      { schema: "assay.source-adoption-evidence/v1", check_id: "focused-test", result: "passed" },
    ],
  ] as const) {
    const file = path.join(entryRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  return { digest, decisionId };
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
    "retires the stock 0.13 zone purpose and leaves a customized one alone",
    async () => {
      const legacy = await legacyWorkspace("MigrationZonePurposes");
      const manifestFile = path.join(legacy.root, ".assay", "manifest.json");
      const before = JSON.parse(await readFile(manifestFile, "utf8"));
      before.layout.entries = before.layout.entries.map(
        (entry: { readonly path: string; readonly purpose?: string }) => {
          if (entry.path === "sources") {
            return { ...entry, purpose: "Living and frozen external evidence" };
          }
          if (entry.path === "analyses/gaps") {
            return { ...entry, purpose: "Our own gap vocabulary, deliberately different" };
          }
          return entry;
        },
      );
      await writeFile(manifestFile, JSON.stringify(before, null, 2), "utf8");

      const result = await applyWorkspaceMigration({ root: legacy.root });
      expect(result.changes.join("\n")).toContain(
        "zone sources purpose -> External material, tracked or copied",
      );

      const manifest = await loadManifest(legacy.root);
      expect(manifest?.framework_version).toBe("0.14.0");
      const purposes = new Map(
        (manifest?.layout.entries ?? []).map((entry) => [entry.path, entry.purpose]),
      );
      expect(purposes.get("sources")).toBe("External material, tracked or copied");
      expect(purposes.get("analyses/gaps")).toBe("Our own gap vocabulary, deliberately different");

      const check = await checkFramework({ root: legacy.root });
      expect(check.rows.some((row) => row.message === "Living and frozen external evidence")).toBe(
        false,
      );
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
    "collapses each adoption mapping into its own record and keeps the last decision as a note",
    async () => {
      const legacy = await legacyWorkspace("MigrationAdoption");
      await writeLegacyAdoption(legacy.root, legacy.checkoutObservation);

      const analysis = await analyzeWorkspaceMigration(legacy.root);
      expect(analysis.steps.map((step) => step.id)).toContain("source-adoptions-collapse");

      const result = await applyWorkspaceMigration({ root: legacy.root });
      const report = result.changes.join("\n");
      // The report names what it rewrote and what it dropped, per adoption.
      expect(report).toContain(
        ".assay/source-adoptions/upstream-product: 3 mapping(s) -> upstream-product-readme, upstream-product-src, upstream-product-docs-readme",
      );
      expect(report).toContain("dropped 1 inspections, 1 evidence records, 1 decisions");
      expect(report).toContain("retired directory left on disk");

      const storeRoot = path.join(legacy.root, ".assay", "source-adoptions");
      const record = async (id: string) =>
        JSON.parse(await readFile(path.join(storeRoot, `${id}.json`), "utf8"));

      const readme = await record("upstream-product-readme");
      expect(readme).toMatchObject({
        schema: "assay.source-adoption/v1",
        id: "upstream-product-readme",
        // The descriptive mode survives: it is not part of the removed ceremony.
        mode: "copy",
        source: { alias: "live", path: "README.md", match: "exact" },
        target: { system: "product", path: "README.md", match: "exact" },
        recorded_on: "2026-07-20T10:00:00.000Z",
      });
      // The accepted baseline knew which commit it accepted, so that becomes the
      // tier-1 pin. 0.13 never recorded where the commit came from.
      expect(readme.source.pin).toEqual({
        kind: "git-commit",
        commit: "d".repeat(40),
        origin: null,
      });
      expect(readme.note).toContain("Upstream adoption");
      expect(readme.note).toContain(
        "last 0.13.0 decision: accept — Reviewed the parser rewrite by hand.",
      );
      expect(readme.note).toContain(
        "migrated from 0.13.0 adoption upstream-product mapping readme",
      );

      // A prefix mapping stays a prefix mapping on both ends.
      expect((await record("upstream-product-src")).source.match).toBe("prefix");
      expect((await record("upstream-product-src")).target).toMatchObject({
        system: "product",
        path: "vendor",
        match: "prefix",
      });

      // The second target was never decided, so it carries no pin and no
      // decision sentence — it was a draft, and it migrates as one.
      const docs = await record("upstream-product-docs-readme");
      expect(docs.target).toMatchObject({ system: "docs", path: "upstream.md" });
      expect(docs.source.pin).toBeUndefined();
      expect(docs.note).not.toContain("decision:");

      // The retired directory is left alone rather than deleted behind the user,
      // and its files are not mistaken for records.
      expect(await exists(path.join(storeRoot, "upstream-product", "state.json"))).toBe(true);

      // Both systems are registrable again, and the migrated records read
      // through the ordinary surface.
      for (const [name, relative] of [
        ["product", "systems/product"],
        ["docs", "systems/docs"],
      ] as const) {
        await mkdir(path.join(legacy.root, relative), { recursive: true });
        await writeFile(path.join(legacy.root, relative, "README.md"), `# ${name}\n`, "utf8");
        await registerSystem(legacy.root, { name, path: relative, vcs: "none" });
      }
      expect(
        (await listSourceAdoptions({ root: legacy.root })).adoptions.map((entry) => entry.id),
      ).toEqual([
        "upstream-product-docs-readme",
        "upstream-product-readme",
        "upstream-product-src",
      ]);
      expect(await checkFramework({ root: legacy.root })).toMatchObject({ ok: true });
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
