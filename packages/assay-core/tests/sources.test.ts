import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  SOURCE_CONTENT_MODES,
  addSource,
  captureSource,
  checkFramework,
  createAnalysis,
  diffSource,
  getSourceLog,
  getSourceStatus,
  importSourceContent,
  initFramework,
  readSourceContentListing,
  registerSystem,
  resolveSourceObservation,
  switchSource,
  syncSource,
  takeSourceAdoptionMaterial,
} from "../src/index.js";

const tempRoots: string[] = [];
const GIT_INTEGRATION_TIMEOUT_MS = 45_000;

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-core-sources-"));
  tempRoots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initAssayWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDir(), name);
  await initFramework({ target: root, name });
  return root;
}

/** A small Git repository on one commit, used as a checkout-backed source. */
async function gitSourceRepo(name: string, body: string): Promise<string> {
  const repo = path.join(await tempDir(), name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "assay@example.test"]);
  await git(repo, ["config", "user.name", "Assay Test"]);
  await writeFile(path.join(repo, "README.md"), body, "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  return repo;
}

describe("source observations", () => {
  it("exposes only the two content modes the material can have", () => {
    expect(SOURCE_CONTENT_MODES).toEqual(["checkout", "copy"]);
  });

  it("copies a plain directory source in once and records a cheap observation", async () => {
    const root = await initAssayWorkspace("SourceAdd");
    const source = path.join(await tempDir(), "source-project");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nUseful source.\n", "utf8");
    await writeFile(path.join(source, "package.json"), '{"name":"source"}\n', "utf8");
    await writeFile(path.join(source, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(source, "node_modules", "ignored", "cache.txt"), "ignore\n", "utf8");

    const result = await addSource({
      root,
      source,
      alias: "Source Project",
      now: new Date("2026-07-01T08:00:00"),
    });

    expect(result.path).toBe("sources/source-project");
    expect(result.contentMode).toBe("copy");
    expect(result.contentPath).toBe("sources/source-project/content");
    const entry = path.join(root, "sources", "source-project");
    expect(await exists(path.join(entry, "content", "README.md"))).toBe(true);
    expect(await exists(path.join(entry, "checkout"))).toBe(false);
    expect(await exists(path.join(entry, "content", "node_modules", "ignored", "cache.txt"))).toBe(
      false,
    );
    expect(await exists(path.join(entry, "materials", "structure.md"))).toBe(true);

    const sourceYaml = await readFile(path.join(entry, "source.yaml"), "utf8");
    expect(sourceYaml).toContain("lineage_id: source-project");
    expect(sourceYaml).toContain("content_mode: copy");
    expect(sourceYaml).toContain("latest_observation: observations/");
    expect(sourceYaml).not.toContain("mode: living");

    // The default record is the cheap tier: no tree was hashed to write it.
    const observationYaml = await readFile(path.join(root, result.observationFile), "utf8");
    expect(observationYaml).toContain("kind: add");
    expect(observationYaml).toContain("note: content copied once from");
    expect(observationYaml).not.toContain("fingerprint:");
    expect(observationYaml).not.toContain("manifest:");
    expect(await exists(path.join(entry, "manifests"))).toBe(false);

    const check = await checkFramework({ root });
    expect(check.ok).toBe(true);

    // A content pin is available on demand, and only then.
    const listing = await readSourceContentListing({ root, alias: "source-project" });
    expect(listing.origin).toBe("content");
    expect(listing.fingerprint.algorithm).toBe("sha256-tree-v1");
    expect(listing.files.map((file) => file.path)).toContain("src/index.ts");
    expect(listing.files.every((file) => !file.path.startsWith("node_modules"))).toBe(true);
  });

  it("checks out a Git source and pins its identity with the commit", async () => {
    const root = await initAssayWorkspace("SourceGitAdd");
    const repo = await gitSourceRepo("git-identity", "# Git identity\n\nv1\n");

    const result = await addSource({
      root,
      source: repo,
      alias: "Git Identity",
      branch: "main",
      now: new Date("2026-07-01T08:00:00"),
    });

    expect(result.contentMode).toBe("checkout");
    expect(result.contentPath).toBe("sources/git-identity/checkout");
    expect(result.observation.vcs?.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result.observation.capture).toBeUndefined();
    const lineage = await readFile(
      path.join(root, "sources", "git-identity", "source.yaml"),
      "utf8",
    );
    expect(lineage).toContain("content_mode: checkout");
    expect(lineage).toContain("checkout:");
    expect((await getSourceStatus({ root, alias: "git-identity" })).sources[0]?.contentMode).toBe(
      "checkout",
    );
  });

  it("captures bytes only when asked, with an integrity hash beside them", async () => {
    const root = await initAssayWorkspace("SourceCapture");
    const source = path.join(await tempDir(), "capture-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Capture\n\nv1\n", "utf8");
    await addSource({ root, source, alias: "capture-source" });

    const captured = await captureSource({
      root,
      alias: "capture-source",
      note: "bytes a decision will cite",
      now: new Date("2026-07-02T08:00:00"),
    });

    expect(captured.observation.kind).toBe("capture");
    expect(captured.observation.note).toBe("bytes a decision will cite");
    expect(captured.capture.algorithm).toBe("sha256-tree-v1");
    expect(captured.capture.value).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.capture.file_count).toBe(1);
    const entry = path.join(root, "sources", "capture-source");
    expect(await exists(path.join(entry, captured.capture.path, "README.md"))).toBe(true);
    expect(await exists(path.join(entry, captured.capture.manifest))).toBe(true);

    const listing = await readSourceContentListing({
      root,
      alias: "capture-source",
      observation: captured.observation.observation_id,
    });
    expect(listing.origin).toBe("capture");
    expect(listing.fingerprint.value).toBe(captured.capture.value);

    // Capturing unchanged bytes grades as `same` rather than inventing a delta.
    const again = await captureSource({
      root,
      alias: "capture-source",
      now: new Date("2026-07-03T08:00:00"),
    });
    expect(again.observation.change_class).toBe("same");
    expect(again.capture.value).toBe(captured.capture.value);
    expect((await getSourceStatus({ root, alias: "capture-source" })).sources[0]?.captures).toBe(2);
    expect(await checkFramework({ root })).toMatchObject({ ok: true });
  });

  it("preserves the bytes an import replaces", async () => {
    const root = await initAssayWorkspace("SourceImport");
    const source = path.join(await tempDir(), "import-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Import\n\nv1\n", "utf8");
    await addSource({ root, source, alias: "import-source" });

    const replacement = path.join(await tempDir(), "import-v2");
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(replacement, "README.md"), "# Import\n\nv2\n", "utf8");
    await writeFile(path.join(replacement, "NOTES.md"), "second file\n", "utf8");

    const imported = await importSourceContent({
      root,
      alias: "import-source",
      from: replacement,
      now: new Date("2026-07-04T08:00:00"),
    });

    expect(imported.observation.kind).toBe("import");
    expect(imported.preservedCapture).not.toBeNull();
    const entry = path.join(root, "sources", "import-source");
    expect(await readFile(path.join(entry, "content", "README.md"), "utf8")).toContain("v2");
    expect(await exists(path.join(entry, "content", "NOTES.md"))).toBe(true);
    const preserved = imported.preservedCapture;
    if (!preserved) throw new Error("import did not preserve the previous content");
    expect(await readFile(path.join(entry, preserved.path, "README.md"), "utf8")).toContain("v1");

    // Diff on copied content reads the preserved bytes against what stands now.
    const diff = await diffSource({ root, alias: "import-source" });
    expect(diff.from).toBe(preserved.path.split("/")[1]);
    expect(diff.to).toBe(imported.observation.observation_id);
    expect(diff.added).toEqual(["NOTES.md"]);
    expect(diff.changed).toEqual(["README.md"]);
    expect(diff.removed).toEqual([]);
    expect(await checkFramework({ root })).toMatchObject({ ok: true });
  });

  it("teaches the right command instead of syncing copied content", async () => {
    const root = await initAssayWorkspace("SourceCopyTeaching");
    const source = path.join(await tempDir(), "copy-only");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Copy only\n", "utf8");
    await addSource({ root, source, alias: "copy-only" });

    await expect(syncSource({ root, alias: "copy-only" })).rejects.toThrow(
      /no checkout to sync[\s\S]*assay source import/,
    );
    await expect(switchSource({ root, alias: "copy-only", target: "main" })).rejects.toThrow(
      /no checkout to switch[\s\S]*assay source import/,
    );
  });

  it("supports analysis and adoption against copied content", async () => {
    const root = await initAssayWorkspace("CopiedSourceUse");
    const source = path.join(await tempDir(), "copied-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Copied\n", "utf8");
    const added = await addSource({
      root,
      source,
      alias: "Copied Source",
      now: new Date("2026-07-01T08:00:00"),
    });

    expect((await getSourceLog({ root, alias: "copied-source" })).entries).toHaveLength(1);
    expect(
      (
        await resolveSourceObservation({
          root,
          alias: "copied-source",
          observation: added.observation.observation_id,
        })
      ).contentPath,
    ).toBe("sources/copied-source/content");

    const analysis = await createAnalysis({
      root,
      title: "Copied evidence",
      forSource: "copied-source",
      observation: added.observation.observation_id,
    });
    expect(await readFile(analysis.absolutePath, "utf8")).toContain("Source alias: copied-source");

    const systemRoot = path.join(root, "systems", "product");
    await mkdir(systemRoot, { recursive: true });
    await writeFile(path.join(systemRoot, "README.md"), "# Product\n", "utf8");
    await registerSystem(root, { name: "product", path: "systems/product", vcs: "none" });
    const adoption = await takeSourceAdoptionMaterial({
      root,
      sourceAlias: "copied-source",
      sourcePath: "README.md",
      targetSystem: "product",
      targetPath: "README.md",
    });
    expect(adoption.record.source.alias).toBe("copied-source");
    expect(adoption.record.source.observation).toBe(added.observation.observation_id);
    // Copied content still gets a tier-1 pin, from its content fingerprint.
    expect(adoption.record.source.pin?.kind).toBe("content-hash");
  });

  it("rejects retired lineage and observation fields", async () => {
    const root = await initAssayWorkspace("SourceStrictLedger");
    const source = path.join(await tempDir(), "strict-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Strict Source\n", "utf8");
    const added = await addSource({ root, source, alias: "strict-source" });
    const lineageFile = path.join(root, "sources", "strict-source", "source.yaml");
    const lineage = await readFile(lineageFile, "utf8");

    for (const retired of ["status: active", "mode: living", "default_capture_mode: checkout"]) {
      await writeFile(lineageFile, `${lineage}${retired}\n`, "utf8");
      await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
        /retired field/,
      );
    }
    await writeFile(lineageFile, lineage.replace(/^content_mode: copy\r?\n/m, ""), "utf8");
    await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
      /content mode must be one of/,
    );

    await writeFile(lineageFile, lineage, "utf8");
    const observationFile = path.join(root, added.observationFile);
    const observation = await readFile(observationFile, "utf8");
    for (const retired of ["analysis_status: closed", "capture_mode: archive", "fingerprint: x"]) {
      await writeFile(observationFile, `${observation}${retired}\n`, "utf8");
      await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
        /retired field/,
      );
    }
  });

  it("fails the structural check when a capture loses half of itself", async () => {
    const root = await initAssayWorkspace("SourceIntegrity");
    const source = path.join(await tempDir(), "integrity-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
    await addSource({ root, source, alias: "integrity-source" });
    const captured = await captureSource({ root, alias: "integrity-source" });
    await rm(path.join(root, "sources", "integrity-source", captured.capture.manifest), {
      force: true,
    });

    const check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) =>
          row.status === "error" &&
          row.path === `sources/integrity-source/${captured.capture.manifest}` &&
          row.message?.includes("missing its integrity manifest"),
      ),
    ).toBe(true);
  });

  it("rejects an old workspace tuple before Source coordination or data writes", async () => {
    const root = await initAssayWorkspace("OldTupleSource");
    const source = path.join(await tempDir(), "old-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Old\n", "utf8");
    const manifestFile = path.join(root, ".assay", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.framework_version = "0.9.0";
    manifest.minimum_assay_version = "0.9.0";
    manifest.layout_version = 6;
    manifest.layout.version = 6;
    const { sources: _currentSources, ...oldPaths } = manifest.layout.paths;
    manifest.layout.paths = { ...oldPaths, references: "references" };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(addSource({ root, source, alias: "old" })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      required: "0.14.0+s4+l8",
    });
    expect(await exists(path.join(root, ".assay", "coordination"))).toBe(false);
    expect(await exists(path.join(root, "sources", "old"))).toBe(false);
  });

  it(
    "syncs a local Git source without duplicating an unchanged observation",
    async () => {
      const root = await initAssayWorkspace("SourceLocalGitSync");
      const repo = await gitSourceRepo("local-git-source", "# Local Git\n\nv1\n");

      const added = await addSource({
        root,
        source: repo,
        alias: "Local Git",
        branch: "main",
        now: new Date("2026-07-01T08:00:00"),
      });

      const same = await syncSource({
        root,
        alias: "local-git",
        now: new Date("2026-07-01T08:30:00"),
      });
      expect(same.changeClass).toBe("same");
      expect(same.observation).toBeNull();
      expect(same.advisories).toEqual([]);

      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);
      const upstreamHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

      const changed = await syncSource({
        root,
        alias: "local-git",
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(changed.changeClass).not.toBe("same");
      expect(changed.observation?.previous_observation).toBe(
        `observations/${added.observation.observation_id}.yaml`,
      );
      expect(changed.observation?.vcs?.commit).toBe(upstreamHead);
      expect(changed.observation?.note).toBe(`moved to main ${upstreamHead.slice(0, 12)}`);
      expect(
        await readFile(path.join(root, "sources", "local-git", "checkout", "README.md"), "utf8"),
      ).toContain("v2");

      const diff = await diffSource({ root, alias: "local-git" });
      expect(diff.changed).toContain("README.md");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "fetches a remote Git checkout before syncing the current branch",
    async () => {
      const root = await initAssayWorkspace("SourceRemoteGitSync");
      const seed = await gitSourceRepo("remote-seed", "# Remote Git\n\nv1\n");
      const remote = path.join(await tempDir(), "remote.git");
      await git(path.dirname(remote), ["clone", "--bare", seed, remote]);

      await addSource({
        root,
        source: pathToFileURL(remote).href,
        alias: "Remote Git",
        branch: "main",
        now: new Date("2026-07-01T08:00:00"),
      });

      await git(seed, ["remote", "add", "origin", remote]);
      await writeFile(path.join(seed, "README.md"), "# Remote Git\n\nv2\n", "utf8");
      await git(seed, ["commit", "-am", "second"]);
      await git(seed, ["push", "origin", "main"]);

      const changed = await syncSource({
        root,
        alias: "remote-git",
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(changed.changeClass).not.toBe("same");
      expect(changed.observation).not.toBeNull();

      const diff = await diffSource({ root, alias: "remote-git" });
      expect(diff.changed).toContain("README.md");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "records a branch switch and keeps Git metadata in the checkout",
    async () => {
      const root = await initAssayWorkspace("SourceGit");
      const repo = await gitSourceRepo("git-source", "# Git Source\n\nmain\n");
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "README.md"), "# Git Source\n\nfeature\n", "utf8");
      await git(repo, ["commit", "-am", "feature"]);
      await git(repo, ["checkout", "main"]);

      await addSource({
        root,
        source: repo,
        alias: "Git Project",
        branch: "main",
        now: new Date("2026-07-01T08:00:00"),
      });

      const checkout = path.join(root, "sources", "git-project", "checkout");
      expect(await exists(path.join(checkout, ".git"))).toBe(true);

      const switched = await switchSource({
        root,
        alias: "git-project",
        target: "feature",
        sync: true,
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(switched.vcs.ref).toBe("feature");
      expect(switched.sync?.observation).not.toBeNull();

      const status = await getSourceStatus({ root, alias: "git-project" });
      expect(status.sources[0]?.checkout?.ref).toBe("feature");
      expect(status.sources[0]?.vcs?.commit).toBe(switched.vcs.commit);
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "records local modifications as an advisory instead of refusing to sync",
    async () => {
      const root = await initAssayWorkspace("SourceDirtySync");
      const repo = await gitSourceRepo("dirty-sync-source", "# Dirty sync\n\nv1\n");
      await addSource({ root, source: repo, alias: "dirty-sync", branch: "main" });

      const checkout = path.join(root, "sources", "dirty-sync", "checkout");
      const checkoutFile = path.join(checkout, "README.md");
      await writeFile(checkoutFile, "# Dirty sync\n\nlocal work\n", "utf8");
      await writeFile(path.join(checkout, "scratch.txt"), "untracked\n", "utf8");

      const dirty = await syncSource({
        root,
        alias: "dirty-sync",
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(dirty.advisories).toContain("observed with local modifications");
      expect(dirty.observation?.advisories).toContain("observed with local modifications");
      expect(dirty.observation?.note).toContain("observed with local modifications");
      // Proceeding is the point, and so is not touching the bytes to do it.
      expect(await readFile(checkoutFile, "utf8")).toContain("local work");
      expect(await exists(path.join(checkout, "scratch.txt"))).toBe(true);
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "records an unrecorded local commit and an upstream it cannot fast-forward",
    async () => {
      const root = await initAssayWorkspace("SourceDivergedSync");
      const repo = await gitSourceRepo("diverged-source", "# Diverged\n\nv1\n");
      await addSource({ root, source: repo, alias: "diverged", branch: "main" });

      const checkout = path.join(root, "sources", "diverged", "checkout");
      await git(checkout, ["config", "user.email", "assay@example.test"]);
      await git(checkout, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(checkout, "README.md"), "# Diverged\n\nlocal commit\n", "utf8");
      await git(checkout, ["commit", "-am", "local checkout commit"]);
      const localHead = (
        await execa("git", ["rev-parse", "HEAD"], { cwd: checkout })
      ).stdout.trim();

      await writeFile(path.join(repo, "README.md"), "# Diverged\n\nupstream v2\n", "utf8");
      await git(repo, ["commit", "-am", "upstream second"]);

      const diverged = await syncSource({
        root,
        alias: "diverged",
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(diverged.observation).not.toBeNull();
      expect(diverged.advisories.join(" ")).toContain("fast-forward");
      // The local commit is still the checkout's HEAD; nothing was reset.
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim()).toBe(
        localHead,
      );
      expect(await readFile(path.join(checkout, "README.md"), "utf8")).toContain("local commit");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );
});
