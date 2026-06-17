import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-system-cli-"));
  tempRoots.push(root);
  return root;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, METASYSTEM_PROJECT_REGISTRY_ROOT: registryRoot },
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
  registryRoot = await tempDir();
});

async function initWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDir(), name);
  await runCli(["init", root, "--name", name]);
  return root;
}

describe("metasystem system CLI", () => {
  it("exposes system command help with all subcommands", async () => {
    const result = await runCli(["system", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("System registry operations");
    for (const sub of ["register", "promote", "archive", "list", "show"]) {
      expect(result.stdout).toContain(sub);
    }
    expect(result.stderr).toBe("");
  });

  it("register creates a registry entry and writes an event", async () => {
    const root = await initWorkspace("Register");
    const systemPath = path.join(root, "systems", "demo-core");
    await mkdir(systemPath, { recursive: true });

    const result = await runCli([
      "system",
      "register",
      "systems/demo-core",
      "--root",
      root,
      "--vcs",
      "embedded",
      "--system-version",
      "0.2.0",
      "--primary",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Registered system: demo-core");
    expect(result.stdout).toContain("Status: primary");
    expect(result.stdout).toContain("Event: .framework/events/");
    expect(await exists(path.join(root, ".framework", "systems-registry.json"))).toBe(true);
  });

  it("register rejects duplicate system names", async () => {
    const root = await initWorkspace("Dupe");
    await mkdir(path.join(root, "systems", "dupe"), { recursive: true });
    await runCli(["system", "register", "systems/dupe", "--root", root, "--name", "dupe"]);

    const second = await runCli([
      "system",
      "register",
      "systems/dupe-2",
      "--root",
      root,
      "--name",
      "dupe",
    ]);

    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already registered");
  });

  it("list shows systems sorted with primary marked", async () => {
    const root = await initWorkspace("ListSystems");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await mkdir(path.join(root, "systems", "beta"), { recursive: true });
    await runCli(["system", "register", "systems/beta", "--root", root, "--name", "beta"]);
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
      "--supersedes",
      "beta",
    ]);

    const result = await runCli(["system", "list", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("* primary");
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("supersedes beta");
    // alpha (primary) should appear before beta (active)
    expect(result.stdout.indexOf("alpha")).toBeLessThan(result.stdout.indexOf("beta"));
  });

  it("list --json emits structured output", async () => {
    const root = await initWorkspace("ListJson");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "list", "--root", root, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.primary).toBe("alpha");
    expect(parsed.systems).toHaveLength(1);
    expect(parsed.systems[0]).toMatchObject({ name: "alpha", status: "primary" });
  });

  it("list --status filters by status", async () => {
    const root = await initWorkspace("ListFilter");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await mkdir(path.join(root, "systems", "beta"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/beta", "--root", root, "--name", "beta"]);

    const result = await runCli(["system", "list", "--root", root, "--status", "primary"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).not.toContain("beta\n");
  });

  it("show returns details by full name and by prefix", async () => {
    const root = await initWorkspace("Show");
    await mkdir(path.join(root, "systems", "alpha-core"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha-core",
      "--root",
      root,
      "--name",
      "alpha-core",
      "--primary",
      "--vcs",
      "independent-git",
      "--vcs-ref",
      "main",
    ]);

    const byName = await runCli(["system", "show", "alpha-core", "--root", root]);
    expect(byName.exitCode).toBe(0);
    expect(byName.stdout).toContain("alpha-core (primary)");
    expect(byName.stdout).toContain("independent-git@main");

    const byPrefix = await runCli(["system", "show", "alpha", "--root", root]);
    expect(byPrefix.exitCode).toBe(0);
    expect(byPrefix.stdout).toContain("alpha-core");
  });

  it("show --json emits structured output", async () => {
    const root = await initWorkspace("ShowJson");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "show", "alpha", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "alpha", status: "primary" });
  });

  it("promote demotes the previous primary to superseded", async () => {
    const root = await initWorkspace("Promote");
    await mkdir(path.join(root, "systems", "a"), { recursive: true });
    await mkdir(path.join(root, "systems", "b"), { recursive: true });
    await runCli(["system", "register", "systems/a", "--root", root, "--name", "a", "--primary"]);
    await runCli(["system", "register", "systems/b", "--root", root, "--name", "b"]);

    const result = await runCli(["system", "promote", "b", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Promoted: b");
    expect(result.stdout).toContain("Previous primary: a (now superseded)");

    const list = await runCli(["system", "list", "--root", root, "--json"]);
    const parsed = JSON.parse(list.stdout);
    expect(parsed.primary).toBe("b");
    const a = parsed.systems.find((s: { name: string }) => s.name === "a");
    expect(a.status).toBe("superseded");
  });

  it("archive dry-run reports destination without moving files", async () => {
    const root = await initWorkspace("ArchiveDry");
    await mkdir(path.join(root, "systems", "active"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await writeFile(path.join(root, "systems", "old", "marker.txt"), "x", "utf8");
    await runCli([
      "system",
      "register",
      "systems/active",
      "--root",
      root,
      "--name",
      "active",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/old", "--root", root, "--name", "old"]);

    const result = await runCli(["system", "archive", "old", "--root", root, "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("Would move to");
    expect(result.stdout).toContain("systems/archive/");
    // Source still present
    expect(await exists(path.join(root, "systems", "old", "marker.txt"))).toBe(true);
  });

  it("archive apply moves the directory and marks system archived", async () => {
    const root = await initWorkspace("ArchiveApply");
    await mkdir(path.join(root, "systems", "active"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await writeFile(path.join(root, "systems", "old", "marker.txt"), "x", "utf8");
    await runCli([
      "system",
      "register",
      "systems/active",
      "--root",
      root,
      "--name",
      "active",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/old", "--root", root, "--name", "old"]);

    const result = await runCli(["system", "archive", "old", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applied");
    expect(result.stdout).toContain("Moved to");
    // Source removed
    expect(await exists(path.join(root, "systems", "old"))).toBe(false);

    const list = await runCli(["system", "list", "--root", root, "--json"]);
    const parsed = JSON.parse(list.stdout);
    const old = parsed.systems.find((s: { name: string }) => s.name === "old");
    expect(old.status).toBe("archived");
    expect(old.archive_path).toContain("systems/archive/");
  });

  it("archive refuses to archive the primary system", async () => {
    const root = await initWorkspace("ArchivePrimary");
    await mkdir(path.join(root, "systems", "only"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/only",
      "--root",
      root,
      "--name",
      "only",
      "--primary",
    ]);

    const result = await runCli(["system", "archive", "only", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot archive the primary system");
  });

  it("show returns non-zero for unknown system", async () => {
    const root = await initWorkspace("ShowMissing");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "show", "nope", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("system not found");
  });

  it("list returns non-zero when no registry exists", async () => {
    const root = await initWorkspace("NoRegistry");

    const result = await runCli(["system", "list", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No systems registry");
  });
});
