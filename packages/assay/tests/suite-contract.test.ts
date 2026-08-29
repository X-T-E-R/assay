import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ASSAY_TOPICS, createProgram } from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const assayCli = path.join(packageRoot, "dist", "cli.js");
// The halves are spawned from their sibling checkouts, the same way CI builds
// them: a package-manager link path would make each CLI's own entry guard
// compare two different URLs for the main module and then do nothing.
const studyRepository = path.resolve(packageRoot, "../../../absorb-anything");
const buildRepository = path.resolve(packageRoot, "../../../own-work");
const studyCli = path.join(studyRepository, "packages", "absorb-anything", "dist", "cli.js");
const buildCli = path.join(buildRepository, "packages", "own-work", "dist", "cli.js");
// The committed workspace assay 0.14 wrote, kept by the study half.
const legacyFixture = path.join(studyRepository, "tests", "fixtures", "v014-workspace");

const roots: string[] = [];

async function temporary(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cli: string, args: readonly string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args]);
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number")
      return {
        exitCode: error.code,
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
      };
    throw error;
  }
}

async function json(cli: string, args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await run(cli, args);
  expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function byteLedger(
  root: string,
  relativeRoots: readonly string[],
): Promise<Record<string, string>> {
  const ledger: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const child = path.join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        ledger[child] = createHash("sha256")
          .update(await readFile(path.join(root, child)))
          .digest("hex");
    }
  };
  for (const relative of relativeRoots) await visit(relative);
  return ledger;
}

async function materialDirectory(name: string, contents: string): Promise<string> {
  const directory = await temporary(name);
  await writeFile(path.join(directory, "note.txt"), contents, "utf8");
  return directory;
}

const SPEC_BODY =
  "## Purpose\n\nSuite contract.\n\n## Scope\n\nWorkspace.\n\n## Requirements\n\n- Keep both halves.\n\n## Constraints\n\n- One envelope.\n\n## Acceptance Criteria\n\n- Checks pass.\n\n## Non-Goals\n\n- Publish.\n";

describe("the suite command surface", () => {
  it("mounts both halves except the names the suite answers itself", () => {
    const program = createProgram({
      output: { stdout: () => {}, stderr: () => {}, setExitCode: () => {} },
    });

    expect(program.commands.map((command) => command.name()).sort()).toEqual(
      [
        "init",
        "check",
        "status",
        "prime",
        "explain",
        "update",
        "add",
        "link",
        "home",
        "unlink",
        "capture",
        "import",
        "sync",
        "switch",
        "log",
        "diff",
        "analysis",
        "knowledge",
        "task",
        "roadmap",
        "spec",
        "system",
      ].sort(),
    );
  });
});

describe("the .assay envelope assay creates", () => {
  it("has both halves' built CLIs available to test against", async () => {
    for (const cli of [assayCli, studyCli, buildCli])
      expect(await exists(cli), `missing built CLI: ${cli}`).toBe(true);
  });

  it("is standalone, and both halves read and write it in place", async () => {
    const root = await temporary("assay-default");
    const material = await materialDirectory("assay-default-material", "evidence\n");

    expect(
      await json(assayCli, ["init", root, "--name", "Suite", "--no-agents", "--json"]),
    ).toMatchObject({
      mode: "standalone",
      envelope: ".assay",
      createdEnvelope: true,
      project: "Suite",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, ".assay", "manifest.json"), "utf8"),
    ) as { layout: { version: number; paths: Record<string, string> } };
    expect(manifest).toMatchObject({
      __schema: 4,
      layout: { version: 8, mode: "standalone", state_root: ".assay", work_root: "." },
    });
    expect(manifest.layout.paths.manifest).toBe(".assay/manifest.json");
    // The persisted logical token is `.assay`; nothing records the other name.
    expect(JSON.stringify(manifest)).not.toContain(".absorb");
    expect(await exists(path.join(root, "sources"))).toBe(true);
    expect(await exists(path.join(root, "tasks"))).toBe(true);
    expect(await exists(path.join(root, ".absorb"))).toBe(false);

    for (const [cli, args] of [
      [studyCli, ["add", material, "sample", "--root", root]],
      [studyCli, ["capture", "sample", "--root", root]],
      [studyCli, ["knowledge", "add", "guide", "Kept", "--root", root]],
      [buildCli, ["task", "create", "--title", "Build", "--root", root]],
      [buildCli, ["roadmap", "create", "--title", "Ship", "--root", root]],
    ] as const) {
      const result = await run(cli, args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
    }

    for (const cli of [studyCli, buildCli, assayCli]) {
      const status = await run(cli, ["status", "--root", root]);
      expect(status.exitCode, status.stderr).toBe(0);
      expect(status.stdout).toContain(".assay");
      // Reading the native envelope must not read as a workspace needing work.
      expect(`${status.stdout}${status.stderr}`.toLowerCase()).not.toContain("migrate");
      const check = await run(cli, ["check", "--root", root]);
      expect(check.exitCode, check.stdout).toBe(0);
    }
    expect(await exists(path.join(root, ".absorb"))).toBe(false);
  });

  it("keeps overlay work inside .assay and leaves the repository root alone", async () => {
    const root = await temporary("assay-overlay");
    await writeFile(path.join(root, "README.md"), "existing product readme\n", "utf8");

    expect(
      await json(assayCli, [
        "init",
        root,
        "--overlay",
        "--name",
        "Overlay",
        "--no-agents",
        "--json",
      ]),
    ).toMatchObject({ mode: "overlay", envelope: ".assay", createdRegistry: true });

    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("existing product readme\n");
    const manifest = JSON.parse(await readFile(path.join(root, ".assay", "manifest.json"), "utf8"));
    expect(manifest.layout).toMatchObject({
      version: 8,
      mode: "overlay",
      state_root: ".assay",
      work_root: ".assay",
    });
    expect(await exists(path.join(root, ".assay", "sources"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "tasks"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "systems-registry.json"))).toBe(true);
    expect(await exists(path.join(root, "sources"))).toBe(false);
    expect(await exists(path.join(root, ".absorb"))).toBe(false);
    expect((await run(assayCli, ["check", "--root", root])).exitCode).toBe(0);
  });
});

describe("a workspace assay 0.14 created", () => {
  it("takes the whole 0.15 surface in place, and init completes it without breaking it", async () => {
    expect(await exists(legacyFixture), `missing sibling fixture: ${legacyFixture}`).toBe(true);
    const root = await temporary("assay-legacy");
    await cp(legacyFixture, root, { recursive: true });
    const studyAreas = ["sources", "analyses", "knowledge"] as const;
    const studyBefore = await byteLedger(root, studyAreas);
    const identityBefore = await readFile(path.join(root, "project", "project.yaml"), "utf8");
    const material = await materialDirectory("assay-legacy-material", "legacy evidence\n");

    // Reuse and fill in; an existing envelope is never re-scaffolded.
    expect(await json(assayCli, ["init", root, "--no-agents", "--json"])).toMatchObject({
      mode: "standalone",
      envelope: ".assay",
      createdEnvelope: false,
      template: null,
    });
    expect(await byteLedger(root, studyAreas)).toEqual(studyBefore);
    expect(await readFile(path.join(root, "project", "project.yaml"), "utf8")).toBe(identityBefore);
    // Only the build half's missing directories are filled in.
    expect(await exists(path.join(root, "tasks"))).toBe(true);
    expect(await exists(path.join(root, "project", "specs"))).toBe(true);

    const analysis = await json(assayCli, [
      "analysis",
      "new",
      "Legacy review",
      "--root",
      root,
      "--json",
    ]);
    const task = (await json(assayCli, [
      "task",
      "create",
      "--title",
      "Legacy build",
      "--root",
      root,
      "--json",
    ])) as { task: { id: string } };
    const body = path.join(await temporary("assay-legacy-spec"), "spec.md");
    await writeFile(body, SPEC_BODY, "utf8");

    for (const args of [
      ["add", material, "legacy", "--root", root],
      ["capture", "legacy", "--root", root],
      ["log", "legacy", "--root", root],
      ["diff", "legacy", "--root", root],
      ["status", "legacy", "--root", root],
      ["analysis", "close", String(analysis.path), "--exit", "adopt", "--root", root],
      ["knowledge", "add", "pattern", "Legacy pattern", "--root", root],
      ["task", "list", "--root", root],
      ["roadmap", "create", "--title", "Legacy outcome", "--root", root],
      [
        "spec",
        "promote",
        "--title",
        "Legacy Spec",
        "--scope",
        "project",
        "--strength",
        "required",
        "--from-task",
        task.task.id,
        "--task-file",
        "prd.md",
        "--body",
        body,
        "--root",
        root,
      ],
      ["system", "register", ".", "--root", root, "--name", "Legacy System", "--primary"],
      ["system", "list", "--root", root],
      ["update", "--root", root, "--dry-run"],
      ["prime", "--root", root],
      ["status", "--root", root],
      ["check", "--root", root],
    ] as const) {
      const result = await run(assayCli, args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
    }

    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(true);
    expect(await exists(path.join(root, ".absorb"))).toBe(false);
  });
});

describe("after the study half renames the envelope", () => {
  it("keeps operating on .absorb without losing either half's records", async () => {
    const root = await temporary("assay-migrated");
    const material = await materialDirectory("assay-migrated-material", "before rename\n");
    expect(
      (await run(assayCli, ["init", root, "--name", "Migrated", "--no-agents"])).exitCode,
    ).toBe(0);
    expect((await run(assayCli, ["add", material, "before", "--root", root])).exitCode).toBe(0);
    expect(
      (await run(assayCli, ["task", "create", "--title", "Before rename", "--root", root]))
        .exitCode,
    ).toBe(0);

    const migrated = await run(studyCli, ["migrate-envelope", "--root", root]);
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    expect(await exists(path.join(root, ".absorb"))).toBe(true);
    expect(await exists(path.join(root, ".assay"))).toBe(false);

    expect(await json(assayCli, ["status", "--root", root, "--json"])).toMatchObject({
      common: { envelope: ".absorb" },
    });
    const tasks = await run(assayCli, ["task", "list", "--root", root]);
    expect(tasks.exitCode, tasks.stderr).toBe(0);
    expect(tasks.stdout).toContain("Before rename");

    for (const args of [
      ["knowledge", "add", "guide", "After rename", "--root", root],
      ["task", "create", "--title", "After rename", "--root", root],
      ["prime", "--root", root],
      ["check", "--root", root],
    ] as const) {
      const result = await run(assayCli, args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
    }

    const again = await run(studyCli, ["migrate-envelope", "--root", root]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already current");
  });
});

describe("the suite check and the merged object table", () => {
  it("reports each row once, fails for either half, and ignores records owned by neither", async () => {
    const root = await temporary("assay-merged");
    const material = await materialDirectory("assay-merged-material", "shared evidence\n");
    expect((await run(assayCli, ["init", root, "--name", "Merged", "--no-agents"])).exitCode).toBe(
      0,
    );
    expect((await run(assayCli, ["add", material, "sample", "--root", root])).exitCode).toBe(0);
    expect(
      (await run(assayCli, ["task", "create", "--title", "Merged build", "--root", root])).exitCode,
    ).toBe(0);

    const checked = (await json(assayCli, ["check", "--root", root, "--json"])) as {
      ok: boolean;
      rows: { path: string; status: string; message?: string }[];
    };
    expect(checked.ok).toBe(true);
    const keys = checked.rows.map((row) => `${row.status}|${row.path}|${row.message ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(checked.rows.some((row) => row.path.startsWith("sources"))).toBe(true);
    expect(checked.rows.some((row) => row.message === "Task")).toBe(true);

    // A record owned by neither half must not be read as either half's failure.
    await mkdir(path.join(root, ".assay", "source-adoptions"), { recursive: true });
    await writeFile(path.join(root, ".assay", "source-adoptions", "foreign.yaml"), ": bad", "utf8");
    expect((await run(assayCli, ["check", "--root", root])).exitCode).toBe(0);

    const record = path.join(root, "sources", "sample", "source.yaml");
    const validRecord = await readFile(record);
    await writeFile(record, "bad", "utf8");
    expect((await run(assayCli, ["check", "--root", root])).exitCode).toBe(1);
    await writeFile(record, validRecord);
    expect((await run(assayCli, ["check", "--root", root])).exitCode).toBe(0);

    await mkdir(path.join(root, "tasks", "task-9999-bad"), { recursive: true });
    await writeFile(path.join(root, "tasks", "task-9999-bad", "task.json"), "bad", "utf8");
    const broken = await run(assayCli, ["check", "--root", root]);
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout).toContain("task-9999-bad");
    await rm(path.join(root, "tasks", "task-9999-bad"), { recursive: true, force: true });

    const primed = (await json(assayCli, ["prime", "--root", root, "--json"])) as {
      topics: string[];
      semantics: { topic: string }[];
      workspace: { envelope: string; sources: number; tasks: number };
    };
    expect(primed.topics).toEqual([...ASSAY_TOPICS]);
    expect(primed.semantics.map((entry) => entry.topic)).toEqual([...ASSAY_TOPICS]);
    expect(primed.workspace).toMatchObject({ envelope: ".assay", sources: 1, tasks: 1 });

    for (const topic of ASSAY_TOPICS) {
      const entry = (await json(assayCli, ["explain", topic, "--json"])) as {
        topic: string;
        commands: string[];
      };
      expect(entry.topic).toBe(topic);
      expect(entry.commands.length).toBeGreaterThan(0);
      for (const command of entry.commands) expect(command.startsWith("assay ")).toBe(true);
    }
    expect((await run(assayCli, ["explain", "not-a-topic"])).exitCode).toBe(1);
  });
});
