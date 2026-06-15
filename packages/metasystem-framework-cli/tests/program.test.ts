import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = process.cwd();
const cliPath = path.join(packageRoot, "dist", "cli.js");
const tempRoots: string[] = [];
let registryRoot = "";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-cli-"));
  tempRoots.push(root);
  return root;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  return runCliIn(packageRoot, args);
}

async function runCliIn(cwd: string, args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        METASYSTEM_PROJECT_REGISTRY_ROOT: registryRoot,
      },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      return {
        exitCode: error.code,
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  registryRoot = path.join(await tempDir(), "registry");
});

describe("metasystem Commander registration", () => {
  it("registers compatibility commands in root help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: metasystem [options] [command]");
    for (const command of [
      "init",
      "check",
      "status",
      "update",
      "projects",
      "migrate-layout",
      "reference",
      "analysis",
      "iteration",
      "event",
    ]) {
      expect(help).toContain(command);
    }
  });

  it("exposes nested command help", async () => {
    const result = await runCli(["reference", "add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Usage: metasystem reference add [options] <source-dir> <name>",
    );
    expect(result.stdout).toContain("--root <target-dir>");
    expect(result.stderr).toBe("");
  });
});

describe("metasystem CLI subprocess behavior", () => {
  it("prints root help with exit code 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bootstrap and update an external-system-learning framework.");
    expect(result.stdout).toContain("migrate-layout");
    expect(result.stderr).toBe("");
  });

  it("runs init, check, status, and update dry-run against a temporary workspace", async () => {
    const root = path.join(await tempDir(), "demo");

    const init = await runCli(["init", root, "--name", "MetaSystem Smoke"]);
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("Initialized framework:");
    expect(init.stdout).toContain("Project: MetaSystem Smoke");
    expect(init.stderr).toBe("");
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(true);

    const check = await runCli(["check", "--root", root]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("Framework check: ok");
    expect(check.stdout).toContain("[ok] .framework/VERSION");
    expect(check.stderr).toBe("");

    const status = await runCli(["status", "--root", root]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Framework status");
    expect(status.stdout).toContain("Project: MetaSystem Smoke");
    expect(status.stdout).toContain("Managed files:");
    expect(status.stderr).toBe("");

    const update = await runCli(["update", "--root", root, "--dry-run"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("Framework update: dry-run");
    expect(update.stdout).toContain("dry-run: no changes applied");
    expect(update.stderr).toBe("");

    const projects = await runCli(["projects", "show", root, "--json"]);
    expect(projects.exitCode).toBe(0);
    expect(JSON.parse(projects.stdout)).toMatchObject({
      path: path.resolve(root),
      name: "MetaSystem Smoke",
      lastCommand: "update",
      status: "active",
    });
  });

  it("defaults root-scoped commands to the current working directory", async () => {
    const workspace = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const init = await runCli(["init", workspace, "--name", "Default Root"]);
    expect(init.exitCode).toBe(0);

    const check = await runCliIn(workspace, ["check"]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("Framework check: ok");

    const status = await runCliIn(workspace, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Project: Default Root");

    const update = await runCliIn(workspace, ["update", "--dry-run"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("Framework update: dry-run");

    const migration = await runCliIn(workspace, ["migrate-layout", "--dry-run"]);
    expect(migration.exitCode).toBe(0);
    expect(migration.stdout).toContain("Layout migration: dry-run");

    const reference = await runCliIn(workspace, ["reference", "add", source, "Source Project"]);
    expect(reference.exitCode).toBe(0);
    expect(reference.stdout).toContain("Frozen reference: references/frozen/");

    const analysis = await runCliIn(workspace, ["analysis", "new", "Review Source"]);
    expect(analysis.exitCode).toBe(0);
    expect(analysis.stdout).toContain("Created analysis: analyses/references/");

    const iteration = await runCliIn(workspace, ["iteration", "start", "Try Pattern"]);
    expect(iteration.exitCode).toBe(0);
    expect(iteration.stdout).toContain("Started iteration: iterations/");

    const event = await runCliIn(workspace, [
      "event",
      "capture",
      "--kind",
      "note",
      "--text",
      "Captured from CLI test",
    ]);
    expect(event.exitCode).toBe(0);
    expect(event.stdout).toContain("Captured event: .framework/events/");
  });

  it("returns non-zero for failed checks", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, ".framework"), { recursive: true });

    const result = await runCli(["check", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Framework check: failed");
    expect(result.stdout).toContain("[missing] .framework/VERSION");
    expect(result.stderr).toBe("");
  });

  it("maps core user errors to stderr and non-zero exit", async () => {
    const root = await tempDir();

    const result = await runCli(["analysis", "new", "No Manifest", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error: No framework manifest found");
  });

  it("returns non-zero for mutually exclusive update action flags", async () => {
    const root = path.join(await tempDir(), "demo");
    await runCli(["init", root, "--name", "Flag Conflict"]);

    const result = await runCli(["update", "--root", root, "--force", "--create-new"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cannot be used with option");
    expect(result.stderr).toContain("--force");
    expect(result.stderr).toContain("--create-new");
  });

  it("returns non-zero for unsupported event kinds", async () => {
    const root = path.join(await tempDir(), "demo");
    await runCli(["init", root, "--name", "Event Choices"]);

    const result = await runCli([
      "event",
      "capture",
      "--kind",
      "unsupported",
      "--text",
      "Bad kind",
      "--root",
      root,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Allowed choices are");
  });

  it("runs the remaining compatibility commands", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
    await runCli(["init", root, "--name", "Compatibility"]);

    const reference = await runCli(["reference", "add", source, "Source Project", "--root", root]);
    expect(reference.exitCode).toBe(0);
    expect(reference.stdout).toContain("Frozen reference: references/frozen/");

    const analysis = await runCli(["analysis", "new", "Review Source", "--root", root]);
    expect(analysis.exitCode).toBe(0);
    expect(analysis.stdout).toContain("Created analysis: analyses/references/");

    const iteration = await runCli(["iteration", "start", "Try Pattern", "--root", root]);
    expect(iteration.exitCode).toBe(0);
    expect(iteration.stdout).toContain("Started iteration: iterations/");
    expect(iteration.stdout).toContain("Plan:");

    const event = await runCli([
      "event",
      "capture",
      "--kind",
      "note",
      "--text",
      "Captured from CLI test",
      "--root",
      root,
    ]);
    expect(event.exitCode).toBe(0);
    expect(event.stdout).toContain("Captured event: .framework/events/");

    const migration = await runCli(["migrate-layout", "--root", root, "--dry-run"]);
    expect(migration.exitCode).toBe(0);
    expect(migration.stdout).toContain("Layout migration: dry-run");
    expect(migration.stdout).toContain("Plan:");
  });

  it("lists, shows, scans, forgets, and prunes project registry records", async () => {
    const root = path.join(await tempDir(), "demo");
    const siblingRoot = path.join(await tempDir(), "sibling");
    await runCli(["init", root, "--name", "Registry CLI"]);
    await runCli(["init", siblingRoot, "--name", "Registry Sibling"]);

    const bareList = await runCli(["projects"]);
    expect(bareList.exitCode).toBe(0);
    expect(bareList.stdout).toContain("tracked MetaSystem projects");
    expect(bareList.stdout).toContain("Registry CLI");

    const list = await runCli(["projects", "list", "--json"]);
    expect(list.exitCode).toBe(0);
    const records = JSON.parse(list.stdout);
    expect(records).toHaveLength(2);
    const record = records.find(
      (candidate: { path?: string }) => candidate.path === path.resolve(root),
    );
    expect(record).toMatchObject({
      name: "Registry CLI",
      core: "registry-cli-core",
      status: "active",
      lastCommand: "init",
    });

    const byId = await runCli(["projects", "show", record.id, "--json"]);
    expect(byId.exitCode).toBe(0);
    expect(JSON.parse(byId.stdout)).toMatchObject({ id: record.id });

    const byPrefix = await runCli(["projects", "show", record.id.slice(0, 10), "--json"]);
    expect(byPrefix.exitCode).toBe(0);
    expect(JSON.parse(byPrefix.stdout)).toMatchObject({ id: record.id });

    const byPath = await runCli(["projects", "show", path.join(root, "."), "--json"]);
    expect(byPath.exitCode).toBe(0);
    expect(JSON.parse(byPath.stdout)).toMatchObject({ id: record.id });

    const forget = await runCli(["projects", "forget", record.id]);
    expect(forget.exitCode).toBe(0);
    expect(forget.stdout).toContain(`Forgot ${record.id}`);
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(true);

    const scan = await runCli(["projects", "scan", path.dirname(root), "--json"]);
    expect(scan.exitCode).toBe(0);
    const scanned = JSON.parse(scan.stdout);
    expect(
      scanned.some((candidate: { path?: string }) => candidate.path === path.resolve(root)),
    ).toBe(true);

    await rm(path.join(root, ".framework"), { recursive: true, force: true });
    const dryRunPrune = await runCli(["projects", "prune", "--dry-run", "--json"]);
    expect(dryRunPrune.exitCode).toBe(0);
    expect(JSON.parse(dryRunPrune.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: record.id, status: "missing" })]),
    );

    const stillListed = await runCli(["projects", "list", "--status", "missing", "--json"]);
    expect(JSON.parse(stillListed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: record.id, status: "missing" })]),
    );

    const prune = await runCli(["projects", "prune", "--json"]);
    expect(prune.exitCode).toBe(0);
    expect(JSON.parse(prune.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: record.id, status: "missing" })]),
    );
    expect(await exists(path.join(root, "README.md"))).toBe(true);
  });
});
