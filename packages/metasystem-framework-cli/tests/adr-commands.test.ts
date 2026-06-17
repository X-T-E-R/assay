import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-adr-cli-"));
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
  const init = await runCli(["init", root, "--name", name]);
  expect(init.exitCode).toBe(0);
  return root;
}

function firstAdrId(stdout: string): string {
  const match = stdout.match(/ADR-\d{4}-[a-z0-9-]+/);
  if (!match?.[0]) {
    throw new Error(`ADR id not found in output:\n${stdout}`);
  }
  return match[0];
}

describe("metasystem adr CLI", () => {
  it("exposes adr command help with all subcommands", async () => {
    const result = await runCli(["adr", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Architecture decision record operations");
    for (const sub of ["new", "accept", "supersede", "deprecate", "list", "show"]) {
      expect(result.stdout).toContain(sub);
    }
    expect(result.stderr).toBe("");
  });

  it("creates, lists, and shows a proposed ADR", async () => {
    const root = await initWorkspace("AdrCliCreate");

    const created = await runCli([
      "adr",
      "new",
      "Use Decision Index",
      "--root",
      root,
      "--from-analysis",
      "analyses/references/example.md",
    ]);

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Created ADR: ADR-0001-use-decision-index");
    expect(created.stdout).toContain("Status: proposed");
    expect(created.stdout).toContain("Event: .framework/events/");
    expect(await exists(path.join(root, ".framework", "adrs.json"))).toBe(true);
    expect(
      await exists(path.join(root, "knowledge", "decisions", "ADR-0001-use-decision-index.md")),
    ).toBe(true);

    const list = await runCli(["adr", "list", "--root", root]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("ADR-0001-use-decision-index");
    expect(list.stdout).toContain("Use Decision Index");

    const show = await runCli(["adr", "show", "1", "--root", root, "--json"]);
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      id: "ADR-0001-use-decision-index",
      status: "proposed",
      related_analysis: "analyses/references/example.md",
    });
  });

  it("accepts and deprecates ADRs", async () => {
    const root = await initWorkspace("AdrCliAccept");
    const created = await runCli(["adr", "new", "Temporary Decision", "--root", root]);
    const id = firstAdrId(created.stdout);

    const accepted = await runCli(["adr", "accept", id, "--root", root]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain(`Accepted ADR: ${id}`);

    const deprecated = await runCli(["adr", "deprecate", id, "--root", root]);
    expect(deprecated.exitCode).toBe(0);
    expect(deprecated.stdout).toContain(`Deprecated ADR: ${id}`);

    const show = await runCli(["adr", "show", id, "--root", root, "--json"]);
    expect(JSON.parse(show.stdout)).toMatchObject({ id, status: "deprecated" });
  });

  it("supersedes one accepted ADR with another accepted ADR", async () => {
    const root = await initWorkspace("AdrCliSupersede");
    const oldCreated = await runCli(["adr", "new", "Old Decision", "--root", root]);
    const newCreated = await runCli(["adr", "new", "New Decision", "--root", root]);
    const oldId = firstAdrId(oldCreated.stdout);
    const newId = firstAdrId(newCreated.stdout);
    await runCli(["adr", "accept", oldId, "--root", root]);
    await runCli(["adr", "accept", newId, "--root", root]);

    const superseded = await runCli(["adr", "supersede", oldId, newId, "--root", root]);

    expect(superseded.exitCode).toBe(0);
    expect(superseded.stdout).toContain(`Superseded ADR: ${oldId}`);
    expect(superseded.stdout).toContain(`Replacement: ${newId}`);

    const list = await runCli(["adr", "list", "--root", root, "--status", "superseded"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(oldId);
    expect(list.stdout).not.toContain(newId);

    const newRecord = await runCli(["adr", "show", newId, "--root", root, "--json"]);
    expect(JSON.parse(newRecord.stdout).supersedes).toContain(oldId);

    const oldContent = await readFile(
      path.join(root, "knowledge", "decisions", `${oldId}.md`),
      "utf8",
    );
    expect(oldContent).toContain("status: superseded");
    expect(oldContent).toContain(`superseded_by: "${newId}"`);
  });

  it("rejects supersede when the replacement ADR is not accepted", async () => {
    const root = await initWorkspace("AdrCliReject");
    const oldCreated = await runCli(["adr", "new", "Old Decision", "--root", root]);
    const newCreated = await runCli(["adr", "new", "New Proposal", "--root", root]);
    const oldId = firstAdrId(oldCreated.stdout);
    const newId = firstAdrId(newCreated.stdout);
    await runCli(["adr", "accept", oldId, "--root", root]);

    const result = await runCli(["adr", "supersede", oldId, newId, "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot supersede with replacement");
  });
});
