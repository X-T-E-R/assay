import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const tempDirs = createTempDirectoryFixture("assay-upstream-cli");
let cliRunner: BuiltCliRunner;
const UPSTREAM_CLI_TIMEOUT_MS = 90_000;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({
    registryRoot: await createIsolatedRegistryRoot(tempDirs),
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function gitOrigin(name: string): Promise<string> {
  const repo = path.join(await tempDirs.createTempDir(), name);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "assay@example.test"]);
  await git(repo, ["config", "user.name", "Assay Test"]);
  await writeFile(path.join(repo, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  return repo;
}

describe("assay status upstream", () => {
  it(
    "prints the upstream block and keeps exit 0 when --fetch cannot reach the remote",
    async () => {
      const root = await createInitializedCliWorkspace({
        tempDirs,
        runner: cliRunner,
        directoryName: "StatusFetchOffline",
      });
      const origin = await gitOrigin("status-fetch-origin");
      const added = await cliRunner.runCli([
        "source",
        "add",
        origin,
        "upstream",
        "--branch",
        "main",
        "--root",
        root,
      ]);
      expect(added.exitCode).toBe(0);

      const clean = await cliRunner.runCli(["status", "--root", root]);
      expect(clean.exitCode).toBe(0);
      expect(clean.stdout).toContain("Upstream");
      expect(clean.stdout).toContain("- upstream   no change");

      // A hand edit inside the managed checkout: previously invisible, because
      // only `source sync` guarded against it and sync is never run.
      await writeFile(
        path.join(root, "references", "upstream", "checkout", "src", "alpha.txt"),
        "alpha-edited\n",
        "utf8",
      );
      const dirty = await cliRunner.runCli(["status", "--root", root]);
      expect(dirty.exitCode).toBe(0);
      expect(dirty.stdout).toContain("local checkout modified (1 uncommitted file)");

      await rm(origin, { recursive: true, force: true });
      const fetched = await cliRunner.runCli(["status", "--root", root, "--fetch"]);
      expect(fetched.exitCode).toBe(0);
      expect(fetched.stdout).toContain("upstream not checked this run");
      expect(fetched.stderr).toBe("");

      const json = await cliRunner.runCli(["status", "--root", root, "--fetch", "--json"]);
      expect(json.exitCode).toBe(0);
      const payload = JSON.parse(json.stdout);
      expect(payload.upstream).toMatchObject({ fetched: true, total: 1 });
      expect(payload.upstream.sources[0]).toMatchObject({
        alias: "upstream",
        signal: "local-modified",
      });
      expect(payload.upstream.sources[0].upstreamNote).toContain("git fetch failed");
    },
    UPSTREAM_CLI_TIMEOUT_MS,
  );

  it(
    "suggests a decision record for a major-graded sync in both sync and status output",
    async () => {
      const root = await createInitializedCliWorkspace({
        tempDirs,
        runner: cliRunner,
        directoryName: "StatusAdrSuggestion",
      });
      const source = path.join(await tempDirs.createTempDir(), "graded");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "README.md"), "# Graded\n\nv1\n", "utf8");
      expect(
        (await cliRunner.runCli(["source", "add", source, "graded", "--root", root])).exitCode,
      ).toBe(0);

      await writeFile(path.join(source, "README.md"), "# Graded\n\nv2\n", "utf8");
      const sync = await cliRunner.runCli([
        "source",
        "sync",
        "graded",
        "--root",
        root,
        "--class",
        "major",
      ]);
      expect(sync.exitCode).toBe(0);
      expect(sync.stdout).toContain("Advisory: graded 'major'");
      expect(sync.stdout).toContain('assay adr new "<decision>"');

      const status = await cliRunner.runCli(["status", "--root", root]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Decision records");
      expect(status.stdout).toContain("source 'graded' last changed at grade 'major'");
    },
    UPSTREAM_CLI_TIMEOUT_MS,
  );
});

describe("assay reference backfill", () => {
  it(
    "writes the case file the check advisory asked for",
    async () => {
      const root = await createInitializedCliWorkspace({
        tempDirs,
        runner: cliRunner,
        directoryName: "ReferenceBackfill",
      });
      const frozen = "references/frozen/202512/legacy-freeze";
      await mkdir(path.join(root, frozen), { recursive: true });
      await writeFile(path.join(root, frozen, "README.md"), "# Legacy\n", "utf8");

      const advised = await cliRunner.runCli(["check", "--root", root, "--advisories"]);
      expect(advised.exitCode).toBe(0);
      expect(advised.stdout).toContain(`assay reference backfill ${frozen}`);

      const backfilled = await cliRunner.runCli([
        "reference",
        "backfill",
        frozen,
        "--source",
        "https://example.test/legacy",
        "--root",
        root,
      ]);
      expect(backfilled.exitCode).toBe(0);
      expect(backfilled.stdout).toContain(`Wrote reference case file: ${frozen}/reference.yaml`);

      const after = await cliRunner.runCli(["check", "--root", root, "--advisories"]);
      expect(after.exitCode).toBe(0);
      expect(after.stdout).not.toContain("has no reference.yaml");
    },
    UPSTREAM_CLI_TIMEOUT_MS,
  );
});
