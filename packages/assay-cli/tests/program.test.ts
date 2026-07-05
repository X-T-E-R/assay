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
const USER_FACING_BUILT_INS = ["evaluation", "explore", "library", "science", "solve", "study"];
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

async function writeCustomArchetype(
  file: string,
  options: {
    readonly mode?: string;
    readonly dirs: readonly string[];
    readonly modules?: readonly string[];
  },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "extends: base",
      `mode: ${options.mode ?? "learning"}`,
      "modules:",
      ...((options.modules ?? []).length === 0
        ? []
        : (options.modules ?? []).map((module) => `  - ${module}`)),
      "",
      "dirs:",
      ...options.dirs.map((directory) => `  - ${directory}`),
      "",
      "dirs_learning: []",
      "dirs_absorption: []",
      "templates: []",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return runCliIn(packageRoot, args, env);
}

async function runCliIn(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ASSAY_PROJECT_REGISTRY_ROOT: registryRoot,
        ...env,
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
  it("registers root commands in help", () => {
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
    const removedProfileFlag = `--${"profile"}`;
    const removedModeFlag = `--${"mode"}`;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay init [options] [target-dir]");
    expect(result.stdout).toContain("--archetype <archetype>");
    expect(result.stdout).not.toContain(removedProfileFlag);
    expect(result.stdout).not.toContain(removedModeFlag);
    expect(result.stdout).not.toContain("deprecated alias");
    expect(result.stdout).toContain("--no-track");
    expect(result.stdout).toContain("--no-agents");
    expect(result.stdout).not.toContain("--core");
    expect(result.stderr).toBe("");
  });
});

describe("assay CLI subprocess behavior", () => {
  it("prints root help with exit code 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bootstrap and update an Assay evidence workbench.");
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
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(true);

    const check = await runCli(["check", "--root", root]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("Framework check: ok");
    expect(check.stdout).toContain("[ok] .assay/VERSION");
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
    expect(result.stdout).toContain("--no-track");
    expect(result.stdout).toContain("--no-agents");
    expect(result.stdout).not.toContain("--core");
    expect(result.stderr).toBe("");
  });

  it("prints update help with explicit agents installation option", async () => {
    const result = await runCli(["update", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: assay update [options]");
    expect(result.stdout).toContain("--agents");
    expect(result.stdout).toContain("--no-track");
    expect(result.stderr).toBe("");
  });

  it("supports lifecycle registry opt-out for init, update, and adopt", async () => {
    const untrackedInitRoot = path.join(await tempDir(), "untracked-init");
    const init = await runCli([
      "init",
      untrackedInitRoot,
      "--name",
      "Untracked Init",
      "--no-track",
    ]);
    expect(init.exitCode).toBe(0);
    expect(await exists(registryRoot)).toBe(false);

    const envUntrackedRoot = path.join(await tempDir(), "env-untracked-init");
    const envInit = await runCli(["init", envUntrackedRoot, "--name", "Env Untracked Init"], {
      ASSAY_NO_TRACK: "1",
    });
    expect(envInit.exitCode).toBe(0);
    expect(await exists(registryRoot)).toBe(false);

    const trackedRoot = path.join(await tempDir(), "tracked");
    const trackedInit = await runCli(["init", trackedRoot, "--name", "Tracked Init"]);
    expect(trackedInit.exitCode).toBe(0);
    const beforeUpdate = await runCli(["projects", "show", trackedRoot, "--json"]);
    expect(JSON.parse(beforeUpdate.stdout)).toMatchObject({ lastCommand: "init" });

    const untrackedUpdate = await runCli(["update", "--root", trackedRoot, "--no-track"]);
    expect(untrackedUpdate.exitCode).toBe(0);
    const afterUpdate = await runCli(["projects", "show", trackedRoot, "--json"]);
    expect(JSON.parse(afterUpdate.stdout)).toMatchObject({ lastCommand: "init" });

    const adoptRoot = path.join(await tempDir(), "adopt-untracked");
    await mkdir(path.join(adoptRoot, "src"), { recursive: true });
    await writeFile(path.join(adoptRoot, "src", "index.ts"), "export {};\n", "utf8");
    const adopt = await runCli([
      "adopt",
      "--root",
      adoptRoot,
      "--name",
      "Untracked Adopt",
      "--apply",
      "--no-track",
    ]);
    expect(adopt.exitCode).toBe(0);
    const adoptRecord = await runCli(["projects", "show", adoptRoot, "--json"]);
    expect(adoptRecord.exitCode).toBe(1);
    expect(adoptRecord.stderr).toContain("project not found");
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

  it("accepts init archetype and rejects the removed profile option", async () => {
    const removedProfileFlag = `--${"profile"}`;
    const solveRoot = path.join(await tempDir(), "solve");
    const solve = await runCli(["init", solveRoot, "--name", "Solve CLI", "--archetype", "solve"]);

    expect(solve.exitCode).toBe(0);
    expect(solve.stdout).toContain("Initialized framework:");
    expect(solve.stdout).toContain("Project: Solve CLI");
    expect(solve.stdout).not.toContain("Core:");
    expect(solve.stderr).toBe("");
    expect(await exists(path.join(solveRoot, "problem"))).toBe(true);
    expect(await exists(path.join(solveRoot, "attempts"))).toBe(true);
    expect(await exists(path.join(solveRoot, "objective.json"))).toBe(true);

    const profile = await runCli([
      "init",
      path.join(await tempDir(), "profile"),
      "--name",
      "Profile CLI",
      removedProfileFlag,
      "assay",
    ]);

    expect(profile.exitCode).toBe(1);
    expect(profile.stdout).toBe("");
    expect(profile.stderr).toContain(`unknown option '${removedProfileFlag}'`);
  });

  it("rejects removed archetype names and lists current built-ins", async () => {
    const home = path.join(await tempDir(), "empty-home");
    for (const removedName of [`re${"search"}`, `con${"test"}`]) {
      const result = await runCli(
        [
          "init",
          path.join(await tempDir(), removedName),
          "--name",
          "Removed",
          "--archetype",
          removedName,
        ],
        {
          HOME: home,
          USERPROFILE: home,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`archetype not found: ${removedName}`);
      expect(result.stderr).toContain("Available archetypes:");
      for (const archetype of USER_FACING_BUILT_INS) {
        expect(result.stderr).toContain(`${archetype} (built-in)`);
      }
    }
  });

  it("initializes new built-in archetypes and each passes check", async () => {
    const expectations = {
      science: {
        mode: "absorption",
        paths: ["hypotheses", "experiments", "datasets", "findings", "papers"],
      },
      evaluation: {
        mode: "learning",
        paths: ["candidates", "scorecards", "criteria.md", path.join("knowledge", "decisions")],
      },
      explore: {
        mode: "absorption",
        paths: ["approaches", "trials", "comparison.md"],
      },
    } as const;

    for (const [archetype, expectation] of Object.entries(expectations)) {
      const root = path.join(await tempDir(), archetype);
      const init = await runCli([
        "init",
        root,
        "--name",
        `${archetype} CLI`,
        "--archetype",
        archetype,
      ]);

      expect(init.exitCode).toBe(0);
      expect(init.stderr).toBe("");
      for (const expectedPath of expectation.paths) {
        expect(await exists(path.join(root, expectedPath))).toBe(true);
      }
      const manifest = JSON.parse(
        await readFile(path.join(root, ".assay", "manifest.json"), "utf8"),
      );
      expect(manifest.project).toMatchObject({ archetype, mode: expectation.mode });

      const check = await runCli(["check", "--root", root]);
      expect(check.exitCode).toBe(0);
      expect(check.stdout).toContain("Framework check: ok");
      expect(check.stderr).toBe("");
    }
  });

  it("accepts project-local and user-global custom init archetypes", async () => {
    const projectRoot = path.join(await tempDir(), "project-custom");
    await writeCustomArchetype(path.join(projectRoot, ".assay", "archetypes", "foo.yaml"), {
      dirs: ["project-zone"],
      mode: "absorption",
      modules: ["iteration"],
    });

    const project = await runCli([
      "init",
      projectRoot,
      "--name",
      "Project Custom",
      "--archetype",
      "foo",
    ]);

    expect(project.exitCode).toBe(0);
    expect(project.stderr).toBe("");
    expect(await exists(path.join(projectRoot, "project-zone"))).toBe(true);
    const projectManifest = JSON.parse(
      await readFile(path.join(projectRoot, ".assay", "manifest.json"), "utf8"),
    );
    expect(projectManifest.project).toMatchObject({ archetype: "foo", mode: "absorption" });

    const home = path.join(await tempDir(), "home");
    await writeCustomArchetype(path.join(home, ".assay", "archetypes", "bar.yaml"), {
      dirs: ["user-zone"],
      mode: "learning",
    });
    const userRoot = path.join(await tempDir(), "user-custom");
    const homeEnv = { HOME: home, USERPROFILE: home };

    const user = await runCli(
      ["init", userRoot, "--name", "User Custom", "--archetype", "bar"],
      homeEnv,
    );

    expect(user.exitCode).toBe(0);
    expect(user.stderr).toBe("");
    expect(await exists(path.join(userRoot, "user-zone"))).toBe(true);
    const userManifest = JSON.parse(
      await readFile(path.join(userRoot, ".assay", "manifest.json"), "utf8"),
    );
    expect(userManifest.project).toMatchObject({ archetype: "bar", mode: "learning" });
  });

  it("reports invalid init archetypes with available choices from core", async () => {
    const root = path.join(await tempDir(), "invalid-archetype");
    const home = path.join(await tempDir(), "empty-home");

    const result = await runCli(["init", root, "--name", "Invalid", "--archetype", "missing"], {
      HOME: home,
      USERPROFILE: home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("archetype not found: missing");
    expect(result.stderr).toContain("Available archetypes:");
    for (const archetype of USER_FACING_BUILT_INS) {
      expect(result.stderr).toContain(`${archetype} (built-in)`);
    }
    expect(result.stderr).not.toContain("base");
  });

  it("surfaces invalid custom archetype mode errors from core", async () => {
    const root = path.join(await tempDir(), "invalid-custom-mode");
    const home = path.join(await tempDir(), "home");
    await writeCustomArchetype(path.join(home, ".assay", "archetypes", "badmode.yaml"), {
      dirs: ["user-zone"],
      mode: "typo",
    });

    const result = await runCli(
      ["init", root, "--name", "Invalid Custom", "--archetype", "badmode"],
      {
        HOME: home,
        USERPROFILE: home,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unsupported mode 'typo'");
    expect(result.stderr).toContain("supported modes: learning, absorption");
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(false);
  });

  it("lists built-in and custom archetypes with source labels", async () => {
    const root = path.join(await tempDir(), "list-root");
    const home = path.join(await tempDir(), "home");
    await writeCustomArchetype(path.join(root, ".assay", "archetypes", "foo.yaml"), {
      dirs: ["project-zone"],
    });
    await writeCustomArchetype(path.join(home, ".assay", "archetypes", "bar.yaml"), {
      dirs: ["user-zone"],
    });
    const homeEnv = { HOME: home, USERPROFILE: home };

    const result = await runCli(["archetype", "list", "--root", root], homeEnv);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Available archetypes:");
    for (const archetype of USER_FACING_BUILT_INS) {
      expect(result.stdout).toContain(`- ${archetype} (built-in):`);
    }
    expect(result.stdout).toContain("- foo (project):");
    expect(result.stdout).toContain("- bar (user):");
    expect(result.stdout).not.toContain("base");

    const json = await runCli(["archetype", "list", "--root", root, "--json"], homeEnv);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "foo", source: "project" }),
        expect.objectContaining({ name: "bar", source: "user" }),
        expect.objectContaining({ name: "study", source: "built-in" }),
        expect.objectContaining({ name: "science", source: "built-in" }),
      ]),
    );
    expect(
      (JSON.parse(json.stdout) as Array<{ name: string; source: string }>)
        .filter((archetype) => archetype.source === "built-in")
        .map((archetype) => archetype.name),
    ).toEqual(USER_FACING_BUILT_INS);
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
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(false);
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
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(true);
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

  it("maps AGENTS.md lifecycle options to core behavior", async () => {
    const root = path.join(await tempDir(), "agents");

    const noAgentsInit = await runCli(["init", root, "--name", "Agents CLI", "--no-agents"]);
    expect(noAgentsInit.exitCode).toBe(0);
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(false);

    const dryRun = await runCli(["update", "--root", root, "--agents", "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("AGENTS.md: would create Assay managed block");
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(false);

    const updateAgents = await runCli(["update", "--root", root, "--agents"]);
    expect(updateAgents.exitCode).toBe(0);
    expect(updateAgents.stdout).toContain("Created files");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("<!-- ASSAY:START -->");

    await writeFile(
      path.join(root, "AGENTS.md"),
      "# Local\n\n<!-- ASSAY:START -->\npartial\n",
      "utf8",
    );
    const malformed = await runCli(["update", "--root", root, "--agents"]);
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stdout).toContain("AGENTS.md has incomplete Assay managed block markers");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(
      "# Local\n\n<!-- ASSAY:START -->\npartial\n",
    );

    await rm(path.join(root, "AGENTS.md"));
    const ordinaryUpdate = await runCli(["update", "--root", root]);
    expect(ordinaryUpdate.exitCode).toBe(0);
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(false);

    const adoptRoot = path.join(await tempDir(), "adopt-no-agents");
    await mkdir(path.join(adoptRoot, "src"), { recursive: true });
    await writeFile(path.join(adoptRoot, "src", "index.ts"), "export {};\n", "utf8");
    const adopt = await runCli([
      "adopt",
      "--root",
      adoptRoot,
      "--name",
      "Adopt No Agents",
      "--apply",
      "--no-agents",
    ]);
    expect(adopt.exitCode).toBe(0);
    expect(await exists(path.join(adoptRoot, "AGENTS.md"))).toBe(false);
  });

  it("shows manifest archetype and mode through the archetype command only", async () => {
    const root = path.join(await tempDir(), "demo");
    await runCli(["init", root, "--name", "Archetype CLI"]);
    await writeFile(
      path.join(root, ".assay", "config.yaml"),
      "profile: solve\nprofile_version: 99\nmode: absorption\n",
      "utf8",
    );

    const archetype = await runCli(["archetype", "--root", root]);
    expect(archetype.exitCode).toBe(0);
    expect(archetype.stdout).toContain("Project: Archetype CLI");
    expect(archetype.stdout).toContain("Archetype: study");
    expect(archetype.stdout).toContain("Mode: learning");
    expect(archetype.stdout).not.toContain("Version:");
    expect(archetype.stderr).toBe("");

    const archetypeJson = await runCli(["archetype", "--root", root, "--json"]);
    expect(archetypeJson.exitCode).toBe(0);
    expect(JSON.parse(archetypeJson.stdout)).toMatchObject({
      project: "Archetype CLI",
      archetype: "study",
      mode: "learning",
    });

    const profile = await runCli(["profile", "--root", root]);
    expect(profile.exitCode).toBe(1);
    expect(profile.stdout).toBe("");
    expect(profile.stderr).toContain("unknown command 'profile'");
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
    expect(iteration.stderr).toContain("capability not enabled in archetype study: iteration");

    const event = await runCliIn(workspace, [
      "event",
      "capture",
      "--kind",
      "note",
      "--text",
      "Captured from CLI test",
    ]);
    expect(event.exitCode).toBe(0);
    expect(event.stdout).toContain("Captured event: .assay/events/");
    expect(event.stderr).toBe("");
  });

  it("returns non-zero for failed checks", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, ".assay"), { recursive: true });

    const result = await runCli(["check", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Framework check: failed");
    expect(result.stdout).toContain("[missing] .assay/VERSION");
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

  it("runs the remaining cross-feature commands", async () => {
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
    expect(iteration.stderr).toContain("capability not enabled in archetype study: iteration");

    const solveRoot = path.join(await tempDir(), "solve");
    await runCli(["init", solveRoot, "--name", "Compatibility Solve", "--archetype", "solve"]);
    const solveIteration = await runCli(["iteration", "start", "Try Pattern", "--root", solveRoot]);
    expect(solveIteration.exitCode).toBe(0);
    expect(solveIteration.stdout).toContain("Started iteration: iterations/");
    expect(solveIteration.stdout).toContain("Plan:");

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
    expect(event.stdout).toContain("Captured event: .assay/events/");
    expect(event.stderr).toBe("");

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
    expect(await readdir(path.join(root, ".assay", "backups"))).toEqual([".gitkeep"]);
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
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(true);

    const scan = await runCli(["projects", "scan", path.dirname(root), "--json"]);
    expect(scan.exitCode).toBe(0);
    const scanned = JSON.parse(scan.stdout);
    expect(
      scanned.some((candidate: { path?: string }) => candidate.path === path.resolve(root)),
    ).toBe(true);

    await rm(path.join(root, ".assay"), { recursive: true, force: true });
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
