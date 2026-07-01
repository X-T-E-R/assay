import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(path.join(tmpdir(), "assay-cli-"));
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
        ASSAY_PROJECT_REGISTRY_ROOT: registryRoot,
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

describe("assay Commander registration", () => {
  it("registers compatibility commands in root help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: assay [options] [command]");
    for (const command of [
      "init",
      "adopt",
      "check",
      "status",
      "update",
      "projects",
      "migrate-layout",
      "archetype",
      "profile",
      "reference",
      "analysis",
      "iteration",
      "event",
      "adr",
    ]) {
      expect(help).toContain(command);
    }
  });

  it("exposes nested command help", async () => {
    const result = await runCli(["reference", "add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay reference add [options] <source-dir> <name>");
    expect(result.stdout).toContain("--root <target-dir>");
    expect(result.stderr).toBe("");
  });

  it("prints init help with archetype options and no core option", async () => {
    const result = await runCli(["init", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay init [options] [target-dir]");
    expect(result.stdout).toContain("--archetype <archetype>");
    expect(result.stdout).toContain("--profile <name>");
    expect(result.stdout).toContain("deprecated alias");
    expect(result.stdout).not.toContain("--core");
    expect(result.stderr).toBe("");
  });
});

describe("assay CLI subprocess behavior", () => {
  it("prints root help with exit code 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bootstrap and update an external-system-learning framework.");
    expect(result.stdout).toContain("adopt");
    expect(result.stdout).toContain("migrate-layout");
    expect(result.stderr).toBe("");
  });

  it("runs init, check, status, and update dry-run against a temporary workspace", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");

    const init = await runCli(["init", root, "--name", "Assay Smoke"]);
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("Initialized framework:");
    expect(init.stdout).toContain("Project: Assay Smoke");
    expect(init.stderr).toBe("");
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(true);

    const check = await runCli(["check", "--root", root]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("Framework check: ok");
    expect(check.stdout).toContain("[ok] .framework/VERSION");
    expect(check.stderr).toBe("");

    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");
    const addSourceResult = await runCli(["source", "add", source, "Smoke Source", "--root", root]);
    expect(addSourceResult.exitCode).toBe(0);

    const status = await runCli(["status", "--root", root]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Framework status");
    expect(status.stdout).toContain("Project: Assay Smoke");
    expect(status.stdout).toContain("Managed files:");
    expect(status.stdout).toContain("Living sources");
    expect(status.stdout).toContain("total: 1");
    expect(status.stdout).toContain("open observations: 1");
    expect(status.stdout).toContain("details: assay source status");
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
      name: "Assay Smoke",
      lastCommand: "update",
      status: "active",
    });
  });

  it("prints adopt help with dry-run and apply options", async () => {
    const result = await runCli(["adopt", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay adopt [options]");
    expect(result.stdout).toContain("--root <target-dir>");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).not.toContain("--core");
    expect(result.stderr).toBe("");
  });

  it("prints migrate-layout help with explicit backup mode", async () => {
    const result = await runCli(["migrate-layout", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay migrate-layout [options]");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("--backup");
    expect(result.stdout).toContain("with --apply, back up pre-existing files");
    expect(result.stderr).toBe("");
  });

  it("accepts init archetype and profile compatibility options", async () => {
    const contestRoot = path.join(await tempDir(), "contest");
    const contest = await runCli([
      "init",
      contestRoot,
      "--name",
      "Contest CLI",
      "--archetype",
      "contest",
    ]);

    expect(contest.exitCode).toBe(0);
    expect(contest.stdout).toContain("Initialized framework:");
    expect(contest.stdout).toContain("Project: Contest CLI");
    expect(contest.stdout).not.toContain("Core:");
    expect(contest.stderr).toBe("");
    expect(await exists(path.join(contestRoot, "problem"))).toBe(true);

    const profileRoot = path.join(await tempDir(), "profile");
    const profile = await runCli([
      "init",
      profileRoot,
      "--name",
      "Profile CLI",
      "--profile",
      "assay",
    ]);

    expect(profile.exitCode).toBe(0);
    expect(profile.stdout).toContain("Deprecated: --profile assay maps to --archetype research.");
    expect(profile.stderr).toBe("");

    const conflict = await runCli([
      "init",
      path.join(await tempDir(), "conflict"),
      "--archetype",
      "research",
      "--profile",
      "assay",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("cannot be used with option");
  });

  it("runs adopt as a dry-run by default without moving existing files", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# Existing\n", "utf8");

    const result = await runCli(["adopt", "--root", root, "--name", "Adopt CLI"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Existing project adoption: dry-run");
    expect(result.stdout).toContain("README.md -> .old/");
    expect(result.stdout).toContain("Adoption manifest: .old/");
    expect(result.stderr).toBe("");
    expect(await exists(path.join(root, ".old"))).toBe(false);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Existing\n");
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(false);
  });

  it("applies adopt, preserves .git, archives old files, and registers the new scaffold", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# Existing\n", "utf8");

    const result = await runCli(["adopt", "--root", root, "--name", "Adopt CLI Apply", "--apply"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Existing project adoption: applied");
    expect(result.stdout).toContain("Archive: .old/");
    expect(result.stdout).toContain("Scaffold:");
    expect(result.stdout).not.toContain("core:");
    expect(result.stdout).toContain("Adoption manifest: .old/");
    expect(result.stderr).toBe("");
    expect(await exists(path.join(root, ".git"))).toBe(true);
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(true);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# Adopt CLI Apply");

    const projects = await runCli(["projects", "show", root, "--json"]);
    expect(projects.exitCode).toBe(0);
    expect(JSON.parse(projects.stdout)).toMatchObject({
      path: path.resolve(root),
      name: "Adopt CLI Apply",
      lastCommand: "adopt",
      status: "active",
    });
  });

  it("shows manifest archetype and mode through the archetype command and profile alias", async () => {
    const root = path.join(await tempDir(), "demo");
    await runCli(["init", root, "--name", "Archetype CLI"]);
    await writeFile(
      path.join(root, ".framework", "config.yaml"),
      "profile: contest\nprofile_version: 99\nmode: absorption\n",
      "utf8",
    );

    const archetype = await runCli(["archetype", "--root", root]);
    expect(archetype.exitCode).toBe(0);
    expect(archetype.stdout).toContain("Project: Archetype CLI");
    expect(archetype.stdout).toContain("Archetype: research");
    expect(archetype.stdout).toContain("Mode: learning");
    expect(archetype.stdout).not.toContain("Version:");
    expect(archetype.stderr).toBe("");

    const profile = await runCli(["profile", "--root", root, "--json"]);
    expect(profile.exitCode).toBe(0);
    expect(JSON.parse(profile.stdout)).toMatchObject({
      project: "Archetype CLI",
      archetype: "research",
      mode: "learning",
      deprecated_alias: true,
    });
  });

  it("refuses adopt when a framework manifest already exists", async () => {
    const root = path.join(await tempDir(), "managed");
    await runCli(["init", root, "--name", "Already Managed"]);

    const result = await runCli(["adopt", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Assay framework manifest already exists");
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
    expect(iteration.exitCode).toBe(1);
    expect(iteration.stdout).toBe("");
    expect(iteration.stderr).toContain("capability not enabled in archetype research: iteration");

    const event = await runCliIn(workspace, [
      "event",
      "capture",
      "--kind",
      "note",
      "--text",
      "Captured from CLI test",
    ]);
    expect(event.exitCode).toBe(1);
    expect(event.stdout).toBe("");
    expect(event.stderr).toContain("capability not enabled in archetype research: events");
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
    expect(iteration.exitCode).toBe(1);
    expect(iteration.stdout).toBe("");
    expect(iteration.stderr).toContain("capability not enabled in archetype research: iteration");

    const contestRoot = path.join(await tempDir(), "contest");
    await runCli([
      "init",
      contestRoot,
      "--name",
      "Compatibility Contest",
      "--archetype",
      "contest",
    ]);
    const contestIteration = await runCli([
      "iteration",
      "start",
      "Try Pattern",
      "--root",
      contestRoot,
    ]);
    expect(contestIteration.exitCode).toBe(0);
    expect(contestIteration.stdout).toContain("Started iteration: iterations/");
    expect(contestIteration.stdout).toContain("Plan:");

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
    expect(event.exitCode).toBe(1);
    expect(event.stdout).toBe("");
    expect(event.stderr).toContain("capability not enabled in archetype research: events");

    const migration = await runCli(["migrate-layout", "--root", root, "--dry-run"]);
    expect(migration.exitCode).toBe(0);
    expect(migration.stdout).toContain("Layout migration: dry-run");
    expect(migration.stdout).toContain("Plan:");
  });

  it("applies migrate-layout without creating backups by default", async () => {
    const root = path.join(await tempDir(), "demo");
    await runCli(["init", root, "--name", "Migration Apply"]);
    await mkdir(path.join(root, "references", "202401"), { recursive: true });
    await writeFile(path.join(root, "references", "202401", "source.md"), "# Source\n", "utf8");

    const result = await runCli(["migrate-layout", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Layout migration: applied");
    expect(result.stdout).toContain("references/202401 -> references/frozen/202401");
    expect(result.stdout).not.toContain("Backup:");
    expect(result.stderr).toBe("");
    expect(
      await readFile(path.join(root, "references", "frozen", "202401", "source.md"), "utf8"),
    ).toBe("# Source\n");
    expect(await readdir(path.join(root, ".framework", "backups"))).toEqual([".gitkeep"]);
  });

  it("lists, shows, scans, forgets, and prunes project registry records", async () => {
    const root = path.join(await tempDir(), "demo");
    const siblingRoot = path.join(await tempDir(), "sibling");
    await runCli(["init", root, "--name", "Registry CLI"]);
    await runCli(["init", siblingRoot, "--name", "Registry Sibling"]);

    const bareList = await runCli(["projects"]);
    expect(bareList.exitCode).toBe(0);
    expect(bareList.stdout).toContain("tracked Assay projects");
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
