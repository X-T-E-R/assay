import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  checkFramework,
  diffSource,
  getSourceStatus,
  initFramework,
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
  it("adds a checkout-backed local directory source at a shallow reference path", async () => {
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

    expect(result.path).toBe("references/source-project");
    expect(result.checkoutPath).toBe("references/source-project/checkout");
    expect(
      await exists(path.join(root, "references", "source-project", "checkout", "README.md")),
    ).toBe(true);
    expect(
      await exists(
        path.join(
          root,
          "references",
          "source-project",
          "checkout",
          "node_modules",
          "ignored",
          "cache.txt",
        ),
      ),
    ).toBe(false);
    expect(
      await exists(path.join(root, "references", "source-project", "checkout", "source-project")),
    ).toBe(false);
    expect(
      await exists(path.join(root, "references", "source-project", "materials", "structure.md")),
    ).toBe(true);

    const sourceYaml = await readFile(
      path.join(root, "references", "source-project", "source.yaml"),
      "utf8",
    );
    expect(sourceYaml).toContain("lineage_id: source-project");
    expect(sourceYaml).toContain("latest_observation: .assay/observations/");

    const observationYaml = await readFile(
      path.join(
        root,
        "references",
        "source-project",
        ".assay",
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
        "references",
        "source-project",
        ".assay",
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
        (row) => row.path.includes("references/source-project") && row.status === "warning",
      ),
    ).toEqual([]);
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
      `.assay/observations/${added.observation.observation_id}.yaml`,
    );
    expect(changed.changeClass).not.toBe("same");
    expect(
      await exists(
        path.join(
          root,
          "references",
          "sync-source",
          ".assay",
          "observations",
          `${added.observation.observation_id}.yaml`,
        ),
      ),
    ).toBe(true);

    const diff = await diffSource({ root, alias: "sync-source" });
    expect(diff.changed).toContain("README.md");

    const check = await checkFramework({ root });
    expect(
      check.rows.some(
        (row) =>
          row.path.includes("references/sync-source/.assay/observations/") &&
          row.message?.includes("needs revalidation analysis"),
      ),
    ).toBe(true);
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
        `.assay/observations/${added.observation.observation_id}.yaml`,
      );
      expect(changed.observation?.vcs?.commit).toBe(sourceHeadBeforeSync);

      const sourceHeadAfterSync = (
        await execa("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();
      expect(sourceHeadAfterSync).toBe(sourceHeadBeforeSync);

      const checkoutReadme = await readFile(
        path.join(root, "references", "local-git", "checkout", "README.md"),
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

      const checkout = path.join(root, "references", "git-project", "checkout");
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
});
