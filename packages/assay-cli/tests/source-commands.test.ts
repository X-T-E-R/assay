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
  it("copies in, captures, imports, diffs, and logs a plain directory source", async () => {
    const root = await initWorkspace("SourceCli");
    const source = path.join(await tempDir(), "demo-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Demo\n\nv1\n", "utf8");

    const add = await runCli(["source", "add", source, "Demo Source", "--root", root]);
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("Added source: sources/demo-source");
    expect(add.stdout).toContain("Content: sources/demo-source/content");
    expect(add.stdout).not.toContain("Checkout:");
    expect(
      await pathExists(path.join(root, "sources", "demo-source", "content", "README.md")),
    ).toBe(true);

    const status = await runCli(["source", "status", "demo-source", "--root", root]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("demo-source");
    expect(status.stdout).toContain("copy");

    const capture = await runCli([
      "source",
      "capture",
      "demo-source",
      "--root",
      root,
      "--note",
      "before the decision",
    ]);
    expect(capture.exitCode).toBe(0);
    expect(capture.stdout).toContain("Captured source: sources/demo-source");
    expect(capture.stdout).toContain("Capture: sources/demo-source/captures/");
    expect(capture.stdout).toContain("Integrity: sha256-tree-v1:");

    // Sync is the wrong tool for copied content, and says which one is right.
    const refused = await runCli(["source", "sync", "demo-source", "--root", root]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("keeps copied content");
    expect(refused.stderr).toContain("assay source import");

    await writeFile(path.join(source, "README.md"), "# Demo\n\nv2\n", "utf8");
    const imported = await runCli(["source", "import", "demo-source", source, "--root", root]);
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toContain("Imported content: sources/demo-source/content");
    expect(imported.stdout).toContain("Preserved: captures/");
    expect(imported.stdout).toContain("Observation: sources/demo-source/observations/");

    const diff = await runCli(["source", "diff", "demo-source", "--root", root]);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain("Changed:");
    expect(diff.stdout).toContain("* README.md");

    const log = await runCli(["source", "log", "demo-source", "--root", root]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("Source log: demo-source");
    expect(log.stdout).toContain("capture");
  });

  it("no longer offers the retired mode and capture flags", async () => {
    const root = await initWorkspace("SourceRetiredFlagsCli");
    const source = path.join(await tempDir(), "demo-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Demo\n\nv1\n", "utf8");

    for (const [flag, value] of [
      ["--mode", "frozen"],
      ["--capture", "archive"],
    ]) {
      const result = await runCli([
        "source",
        "add",
        source,
        "Demo Source",
        "--root",
        root,
        flag as string,
        value as string,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`unknown option '${flag}'`);
    }

    const help = await runCli(["source", "add", "--help"]);
    expect(help.stdout).not.toContain("--mode");
    expect(help.stdout).not.toContain("--capture");
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
      expect(add.stdout).toContain("Added source: sources/local-git");

      await writeFile(path.join(repo, "README.md"), "# Local Git\n\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);

      const sync = await runCli(["source", "sync", "local-git", "--root", root]);
      expect(sync.exitCode).toBe(0);
      expect(sync.stdout).toContain("Source sync: local-git");
      expect(sync.stdout).not.toContain("Change: same");
      expect(sync.stdout).toContain("Observation: sources/local-git/observations/");

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
      expect(await pathExists(path.join(root, "sources", "git-proj", "checkout", ".git"))).toBe(
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
      expect(switched.stdout).toContain("Switched source: sources/git-proj");
      expect(switched.stdout).toContain("Ref: feature");
      expect(switched.stdout).toContain("Source sync: git-proj");

      const sourceYaml = await readFile(
        path.join(root, "sources", "git-proj", "source.yaml"),
        "utf8",
      );
      expect(sourceYaml).toContain("ref: feature");
    },
    GIT_SOURCE_CLI_TIMEOUT_MS,
  );
});
