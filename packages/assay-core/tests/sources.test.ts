import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  SOURCE_CAPTURE_MODES,
  addSource,
  checkFramework,
  createAnalysis,
  diffSource,
  getSourceLog,
  getSourceStatus,
  initFramework,
  registerSourceAdoption,
  registerSystem,
  resolveSourceObservation,
  switchSource,
  syncSource,
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

describe("source observations", () => {
  it("exposes only behaviorally distinct capture modes", () => {
    expect(SOURCE_CAPTURE_MODES).toEqual(["checkout", "archive"]);
  });

  it("adds a checkout-backed local directory source at a shallow Source path", async () => {
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
    expect(result.checkoutPath).toBe("sources/source-project/checkout");
    expect(
      await exists(path.join(root, "sources", "source-project", "checkout", "README.md")),
    ).toBe(true);
    expect(
      await exists(
        path.join(
          root,
          "sources",
          "source-project",
          "checkout",
          "node_modules",
          "ignored",
          "cache.txt",
        ),
      ),
    ).toBe(false);
    expect(
      await exists(path.join(root, "sources", "source-project", "checkout", "source-project")),
    ).toBe(false);
    expect(
      await exists(path.join(root, "sources", "source-project", "materials", "structure.md")),
    ).toBe(true);

    const sourceYaml = await readFile(
      path.join(root, "sources", "source-project", "source.yaml"),
      "utf8",
    );
    expect(sourceYaml).toContain("lineage_id: source-project");
    expect(sourceYaml).toContain("latest_observation: observations/");

    const observationYaml = await readFile(
      path.join(
        root,
        "sources",
        "source-project",
        "observations",
        `${result.observation.observation_id}.yaml`,
      ),
      "utf8",
    );
    expect(observationYaml).toContain("capture_mode: checkout");
    expect(observationYaml).toContain("fingerprint:");

    const manifest = await readFile(
      path.join(
        root,
        "sources",
        "source-project",
        "manifests",
        `${result.observation.observation_id}.json`,
      ),
      "utf8",
    );
    expect(manifest).toContain('"src/index.ts"');
    expect(manifest).not.toContain('"path": "node_modules');

    const check = await checkFramework({ root });
    expect(
      check.rows.filter(
        (row) => row.path.includes("sources/source-project") && row.status === "warning",
      ),
    ).toEqual([]);
  });

  it("adds an archive-backed local directory source without creating a checkout", async () => {
    const root = await initAssayWorkspace("SourceArchive");
    const source = path.join(await tempDir(), "archive-source");
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Archive Source\n\nUseful source.\n", "utf8");
    await writeFile(path.join(source, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const result = await addSource({
      root,
      source,
      alias: "Archive Source",
      capture: "archive",
      now: new Date("2026-07-01T08:00:00"),
    });

    expect(result.path).toBe("sources/archive-source");
    expect(result.checkoutPath).toBeNull();
    expect(result.observation.capture_mode).toBe("archive");
    expect(result.observation.capture_path).toBe(
      `captures/${result.observation.observation_id}/source`,
    );
    expect(
      await exists(path.join(root, "sources", "archive-source", "checkout", "README.md")),
    ).toBe(false);
    expect(
      await exists(
        path.join(
          root,
          "sources",
          "archive-source",
          "captures",
          result.observation.observation_id,
          "source",
          "README.md",
        ),
      ),
    ).toBe(true);

    const observationYaml = await readFile(
      path.join(
        root,
        "sources",
        "archive-source",
        "observations",
        `${result.observation.observation_id}.yaml`,
      ),
      "utf8",
    );
    expect(observationYaml).toContain("capture_mode: archive");
    expect(observationYaml).toContain(
      `capture_path: captures/${result.observation.observation_id}/source`,
    );
    expect(observationYaml).not.toContain("checkout_path:");

    const status = await getSourceStatus({ root, alias: "archive-source" });
    expect(status.sources[0]?.captureMode).toBe("archive");

    const check = await checkFramework({ root });
    expect(
      check.rows.filter(
        (row) => row.path.includes("sources/archive-source") && row.status === "warning",
      ),
    ).toEqual([]);
  });

  it("creates immutable frozen Sources in the same namespace without derived history", async () => {
    const root = await initAssayWorkspace("FrozenSource");
    const source = path.join(await tempDir(), "frozen-source");
    await mkdir(source, { recursive: true });
    await git(source, ["init"]);
    await git(source, ["config", "user.email", "assay@example.test"]);
    await git(source, ["config", "user.name", "Assay Test"]);
    await writeFile(path.join(source, "README.md"), "# Frozen\n", "utf8");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "frozen"]);

    const added = await addSource({
      root,
      source,
      alias: "Frozen Source",
      mode: "frozen",
      now: new Date("2026-07-01T08:00:00"),
    });

    expect(added.path).toBe("sources/frozen-source");
    expect(added.observation.capture_mode).toBe("archive");
    expect(added.observation.vcs?.commit).toMatch(/^[0-9a-f]{40,64}$/);
    const frozenStatus = (await getSourceStatus({ root, alias: "frozen-source" })).sources[0];
    expect(frozenStatus?.mode).toBe("frozen");
    expect(frozenStatus?.checkout).toBeUndefined();
    const frozenLineage = await readFile(
      path.join(root, "sources", "frozen-source", "source.yaml"),
      "utf8",
    );
    expect(frozenLineage).not.toContain("checkout:");
    expect(await readFile(path.join(root, added.observationFile), "utf8")).toContain("vcs:");
    expect((await getSourceLog({ root, alias: "frozen-source" })).entries).toHaveLength(1);
    expect((await diffSource({ root, alias: "frozen-source" })).added).toContain("README.md");
    expect(
      (
        await resolveSourceObservation({
          root,
          alias: "frozen-source",
          observation: added.observation.observation_id,
        })
      ).observation.observation_id,
    ).toBe(added.observation.observation_id);
    const analysis = await createAnalysis({
      root,
      title: "Frozen evidence",
      forSource: "frozen-source",
      observation: added.observation.observation_id,
    });
    expect(await readFile(analysis.absolutePath, "utf8")).toContain("Source alias: frozen-source");
    const systemRoot = path.join(root, "systems", "product");
    await mkdir(systemRoot, { recursive: true });
    await writeFile(path.join(systemRoot, "README.md"), "# Product\n", "utf8");
    await registerSystem(root, { name: "product", path: "systems/product", vcs: "none" });
    const adoption = await registerSourceAdoption({
      root,
      definition: {
        schema: "assay.donor-adoption/v1",
        id: "frozen-product",
        source: { alias: "frozen-source", observation: added.observation.observation_id },
        targets: [{ id: "product", system: "product" }],
        mappings: [
          {
            id: "readme",
            source: { path: "README.md" },
            target: { target_id: "product", path: "README.md" },
            evidence: [],
          },
        ],
        evidence: [],
      },
    });
    expect(adoption.definition.source.alias).toBe("frozen-source");
    expect(await exists(path.join(root, added.path, "history.md"))).toBe(false);
    expect(await exists(path.join(root, added.path, "comparisons"))).toBe(false);
    await expect(syncSource({ root, alias: "frozen-source" })).rejects.toThrow(/frozen.*sync/i);
    await expect(switchSource({ root, alias: "frozen-source", target: "main" })).rejects.toThrow(
      /frozen.*switch/i,
    );
    await expect(
      addSource({ root, source, alias: "Invalid Frozen", mode: "frozen", capture: "checkout" }),
    ).rejects.toThrow(/require archive/i);
  });

  it("requires explicit Source mode and rejects retired lineage and observation fields", async () => {
    const root = await initAssayWorkspace("SourceStrictLedger");
    const source = path.join(await tempDir(), "strict-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Strict Source\n", "utf8");
    const added = await addSource({ root, source, alias: "strict-source" });
    const lineageFile = path.join(root, "sources", "strict-source", "source.yaml");
    const lineage = await readFile(lineageFile, "utf8");

    await writeFile(lineageFile, `${lineage}status: active\n`, "utf8");
    await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
      /retired field 'status'/,
    );
    await writeFile(lineageFile, lineage.replace(/^mode: living\r?\n/m, ""), "utf8");
    await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
      /lineage mode must be one of/,
    );

    await writeFile(lineageFile, lineage, "utf8");
    const observationFile = path.join(root, added.observationFile);
    const observation = await readFile(observationFile, "utf8");
    await writeFile(observationFile, `${observation}analysis_status: closed\n`, "utf8");
    await expect(getSourceStatus({ root, alias: "strict-source" })).rejects.toThrow(
      /retired field 'analysis_status'/,
    );
  });

  it("fails the structural check when a latest source manifest is missing", async () => {
    const root = await initAssayWorkspace("SourceIntegrity");
    const source = path.join(await tempDir(), "integrity-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
    const added = await addSource({
      root,
      source,
      alias: "integrity-source",
    });
    await rm(path.join(root, added.manifestFile), { force: true });

    const check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) =>
          row.status === "error" &&
          row.path === added.manifestFile &&
          row.message?.includes("no capture manifest"),
      ),
    ).toBe(true);
  });

  it("rejects removed source capture modes", async () => {
    const root = await initAssayWorkspace("SourceCaptureModes");
    const source = path.join(await tempDir(), "capture-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Capture Source\n", "utf8");

    for (const capture of ["thin", "metadata"] as const) {
      await expect(
        addSource({
          root,
          source,
          alias: capture,
          capture: capture as (typeof SOURCE_CAPTURE_MODES)[number],
        }),
      ).rejects.toThrow("capture mode must be one of: checkout, archive");
    }
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
      required: "0.11.0+s3+l7",
    });
    expect(await exists(path.join(root, ".assay", "coordination"))).toBe(false);
    expect(await exists(path.join(root, "sources", "old"))).toBe(false);
  });

  it("rejects a custom retired Source path before the first Source write", async () => {
    const root = await initAssayWorkspace("RetiredSourcePath");
    const source = path.join(await tempDir(), "custom-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Custom\n", "utf8");
    await mkdir(path.join(root, ".assay", "archetypes"), { recursive: true });
    await writeFile(
      path.join(root, ".assay", "archetypes", "retired.yaml"),
      "extends: base\nmode: learning\ndirs:\n  - references\ntemplates: []\n",
      "utf8",
    );
    const manifestFile = path.join(root, ".assay", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.project.archetype = "retired";
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(addSource({ root, source, alias: "custom" })).rejects.toMatchObject({
      code: "RETIRED_ARCHETYPE_PATH",
    });
    expect(await exists(path.join(root, ".assay", "coordination"))).toBe(false);
    expect(await exists(path.join(root, "sources", "custom"))).toBe(false);
  });

  it("rejects a custom retired path before diff reads Source ledger bytes", async () => {
    const root = await initAssayWorkspace("RetiredSourceDiff");
    const source = path.join(await tempDir(), "diff-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Diff Source\n", "utf8");
    await addSource({ root, source, alias: "diff-source" });
    await mkdir(path.join(root, ".assay", "archetypes"), { recursive: true });
    await writeFile(
      path.join(root, ".assay", "archetypes", "retired-diff.yaml"),
      "extends: base\nmode: learning\ndirs:\n  - references\ntemplates: []\n",
      "utf8",
    );
    const manifestFile = path.join(root, ".assay", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.project.archetype = "retired-diff";
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "sources", "diff-source", "source.yaml"), "not: [yaml", "utf8");

    await expect(diffSource({ root, alias: "diff-source" })).rejects.toMatchObject({
      code: "RETIRED_ARCHETYPE_PATH",
    });
  });

  it("syncs a directory source without duplicating same observations and diffs changed files", async () => {
    const root = await initAssayWorkspace("SourceSync");
    const source = path.join(await tempDir(), "sync-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Sync\n\nv1\n", "utf8");

    const added = await addSource({
      root,
      source,
      alias: "Sync Source",
      now: new Date("2026-07-01T08:00:00"),
    });

    const same = await syncSource({
      root,
      alias: "sync-source",
      now: new Date("2026-07-01T09:00:00"),
    });
    expect(same.changeClass).toBe("same");
    expect(same.observation).toBeNull();

    await writeFile(path.join(source, "README.md"), "# Sync\n\nv2\n", "utf8");
    const changed = await syncSource({
      root,
      alias: "sync-source",
      now: new Date("2026-07-01T10:00:00"),
    });
    expect(changed.observation?.previous_observation).toBe(
      `observations/${added.observation.observation_id}.yaml`,
    );
    expect(changed.changeClass).not.toBe("same");
    expect(
      await exists(
        path.join(
          root,
          "sources",
          "sync-source",
          "observations",
          `${added.observation.observation_id}.yaml`,
        ),
      ),
    ).toBe(true);

    const diff = await diffSource({ root, alias: "sync-source" });
    expect(diff.changed).toContain("README.md");

    const check = await checkFramework({ root, includeAdvisories: true });
    expect(
      check.rows.some(
        (row) =>
          row.path.includes("sources/sync-source/observations/") &&
          row.message?.includes("needs revalidation analysis"),
      ),
    ).toBe(false);
  });

  it(
    "refreshes a local Git source checkout before syncing",
    async () => {
      const root = await initAssayWorkspace("SourceLocalGitSync");
      const repo = path.join(await tempDir(), "local-git-source");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "assay@example.test"]);
      await git(repo, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv1\n", "utf8");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await git(repo, ["branch", "-M", "main"]);

      const added = await addSource({
        root,
        source: repo,
        alias: "Local Git",
        branch: "main",
        now: new Date("2026-07-01T08:00:00"),
      });
      expect(
        await readFile(path.join(root, "sources", "local-git", "source.yaml"), "utf8"),
      ).toContain("checkout:");
      expect((await getSourceStatus({ root, alias: "local-git" })).sources[0]?.checkout?.path).toBe(
        "checkout",
      );

      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);
      const sourceHeadBeforeSync = (
        await execa("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();

      const changed = await syncSource({
        root,
        alias: "local-git",
        now: new Date("2026-07-01T09:00:00"),
      });
      expect(changed.changeClass).not.toBe("same");
      expect(changed.observation).not.toBeNull();
      expect(changed.observation?.previous_observation).toBe(
        `observations/${added.observation.observation_id}.yaml`,
      );
      expect(changed.observation?.vcs?.commit).toBe(sourceHeadBeforeSync);

      const sourceHeadAfterSync = (
        await execa("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();
      expect(sourceHeadAfterSync).toBe(sourceHeadBeforeSync);

      const checkoutReadme = await readFile(
        path.join(root, "sources", "local-git", "checkout", "README.md"),
        "utf8",
      );
      expect(checkoutReadme).toContain("v2");

      const diff = await diffSource({ root, alias: "local-git" });
      expect(diff.changed).toContain("README.md");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "fetches a remote Git checkout before syncing the current branch",
    async () => {
      const root = await initAssayWorkspace("SourceRemoteGitSync");
      const seed = path.join(await tempDir(), "remote-seed");
      const remote = path.join(await tempDir(), "remote.git");
      await mkdir(seed, { recursive: true });
      await git(seed, ["init"]);
      await git(seed, ["config", "user.email", "assay@example.test"]);
      await git(seed, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(seed, "README.md"), "# Remote Git\n\nv1\n", "utf8");
      await git(seed, ["add", "README.md"]);
      await git(seed, ["commit", "-m", "initial"]);
      await git(seed, ["branch", "-M", "main"]);
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
    "preserves Git metadata in checkout and records branch switches",
    async () => {
      const root = await initAssayWorkspace("SourceGit");
      const repo = path.join(await tempDir(), "git-source");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "assay@example.test"]);
      await git(repo, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(repo, "README.md"), "# Git Source\n\nmain\n", "utf8");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await git(repo, ["branch", "-M", "main"]);
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

  it("refuses to replace a directory checkout with unrecorded local changes", async () => {
    const root = await initAssayWorkspace("SourceDirectorySafety");
    const source = path.join(await tempDir(), "directory-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");
    await addSource({ root, source, alias: "directory-source" });

    const checkoutFile = path.join(root, "sources", "directory-source", "checkout", "README.md");
    await writeFile(checkoutFile, "# Source\n\nlocal work\n", "utf8");
    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");

    await expect(syncSource({ root, alias: "directory-source" })).rejects.toThrow(
      "managed source checkout has unrecorded changes",
    );
    expect(await readFile(checkoutFile, "utf8")).toContain("local work");
  });

  it(
    "refuses to reset dirty files or unrecorded commits in a managed Git checkout",
    async () => {
      const root = await initAssayWorkspace("SourceGitSafety");
      const repo = path.join(await tempDir(), "git-safety-source");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "assay@example.test"]);
      await git(repo, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(repo, "README.md"), "# Git safety\n\nv1\n", "utf8");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await git(repo, ["branch", "-M", "main"]);
      await addSource({ root, source: repo, alias: "git-safety", branch: "main" });

      const checkout = path.join(root, "sources", "git-safety", "checkout");
      const checkoutFile = path.join(checkout, "README.md");
      await writeFile(checkoutFile, "# Git safety\n\nlocal dirty\n", "utf8");
      await expect(syncSource({ root, alias: "git-safety" })).rejects.toThrow(
        "managed source checkout has unrecorded changes",
      );
      expect(await readFile(checkoutFile, "utf8")).toContain("local dirty");

      await git(checkout, ["config", "user.email", "assay@example.test"]);
      await git(checkout, ["config", "user.name", "Assay Test"]);
      await git(checkout, ["add", "README.md"]);
      await git(checkout, ["commit", "-m", "local checkout commit"]);
      const localHead = (
        await execa("git", ["rev-parse", "HEAD"], { cwd: checkout })
      ).stdout.trim();

      await expect(syncSource({ root, alias: "git-safety" })).rejects.toThrow(
        "managed source checkout has an unrecorded revision",
      );
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim()).toBe(
        localHead,
      );
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );
});
