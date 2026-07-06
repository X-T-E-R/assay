import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
  pathExists,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs = createTempDirectoryFixture("assay-source-cli");
let registryRoot = "";
let cliRunner: BuiltCliRunner;
const GIT_SOURCE_CLI_TIMEOUT_MS = 60_000;

async function tempDir(): Promise<string> {
  return tempDirs.createTempDir();
}

async function runCli(args: readonly string[]) {
  return cliRunner.runCli(args);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  try {
    await execFileAsync("git", [...args], { cwd });
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : String(error);
    expect.fail(message);
  }
}

beforeEach(async () => {
  registryRoot = await createIsolatedRegistryRoot(tempDirs);
  cliRunner = createBuiltCliRunner({ registryRoot });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function initWorkspace(name: string): Promise<string> {
  return createInitializedCliWorkspace({ tempDirs, runner: cliRunner, directoryName: name });
}

describe("assay source CLI", () => {
  it("adds, syncs, diffs, and logs a checkout-backed directory source", async () => {
    const root = await initWorkspace("SourceCli");
    const source = path.join(await tempDir(), "demo-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Demo\n\nv1\n", "utf8");

    const add = await runCli(["source", "add", source, "Demo Source", "--root", root]);
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("Added source: references/demo-source");
    expect(add.stdout).toContain("Checkout: references/demo-source/checkout");
    expect(
      await pathExists(path.join(root, "references", "demo-source", "checkout", "README.md")),
    ).toBe(true);

    const status = await runCli(["source", "status", "demo-source", "--root", root]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("demo-source");
    expect(status.stdout).toContain("checkout");

    await writeFile(path.join(source, "README.md"), "# Demo\n\nv2\n", "utf8");
    const sync = await runCli(["source", "sync", "demo-source", "--root", root]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain("Source sync: demo-source");
    expect(sync.stdout).toContain("Observation: references/demo-source/observations/");

    const diff = await runCli(["source", "diff", "demo-source", "--root", root]);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain("Changed:");
    expect(diff.stdout).toContain("* README.md");

    const log = await runCli(["source", "log", "demo-source", "--root", root]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("Source log: demo-source");
  });

  it("rejects removed source capture modes", async () => {
    const root = await initWorkspace("SourceCaptureCli");
    const source = path.join(await tempDir(), "demo-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Demo\n\nv1\n", "utf8");

    const result = await runCli([
      "source",
      "add",
      source,
      "Demo Source",
      "--root",
      root,
      "--capture",
      "metadata",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Allowed choices are");
    expect(result.stderr).toContain("checkout");
    expect(result.stderr).toContain("archive");
    expect(result.stderr).not.toContain("thin");
  });

  it(
    "syncs a local Git source after the source repository receives a new commit",
    async () => {
      const root = await initWorkspace("SourceLocalGitCli");
      const repo = path.join(await tempDir(), "local-git-source");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "assay@example.test"]);
      await git(repo, ["config", "user.name", "Assay Test"]);
      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv1\n", "utf8");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await git(repo, ["branch", "-M", "main"]);

      const add = await runCli([
        "source",
        "add",
        repo,
        "local-git",
        "--root",
        root,
        "--branch",
        "main",
      ]);
      expect(add.exitCode).toBe(0);
      expect(add.stdout).toContain("Added source: references/local-git");

      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);

      const sync = await runCli(["source", "sync", "local-git", "--root", root]);
      expect(sync.exitCode).toBe(0);
      expect(sync.stdout).toContain("Source sync: local-git");
      expect(sync.stdout).not.toContain("Change: same");
      expect(sync.stdout).toContain("Observation: references/local-git/observations/");

      const diff = await runCli(["source", "diff", "local-git", "--root", root]);
      expect(diff.exitCode).toBe(0);
      expect(diff.stdout).toContain("Changed:");
      expect(diff.stdout).toContain("* README.md");
    },
    GIT_SOURCE_CLI_TIMEOUT_MS,
  );

  it(
    "switches a Git-backed checkout and records the switched commit",
    async () => {
      const root = await initWorkspace("SourceGitCli");
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

      const add = await runCli([
        "source",
        "add",
        repo,
        "git-proj",
        "--root",
        root,
        "--branch",
        "main",
      ]);
      expect(add.exitCode).toBe(0);
      expect(await pathExists(path.join(root, "references", "git-proj", "checkout", ".git"))).toBe(
        true,
      );

      const switched = await runCli([
        "source",
        "switch",
        "git-proj",
        "feature",
        "--root",
        root,
        "--sync",
      ]);
      expect(switched.exitCode).toBe(0);
      expect(switched.stdout).toContain("Switched source: references/git-proj");
      expect(switched.stdout).toContain("Ref: feature");
      expect(switched.stdout).toContain("Source sync: git-proj");

      const sourceYaml = await readFile(
        path.join(root, "references", "git-proj", "source.yaml"),
        "utf8",
      );
      expect(sourceYaml).toContain("ref: feature");
    },
    GIT_SOURCE_CLI_TIMEOUT_MS,
  );
});
