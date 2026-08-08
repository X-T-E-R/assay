import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadManifest, recordManagedFile, saveManifest } from "assay-core";
import { BARE_ARCHETYPE, writeBareArchetype } from "assay-test-support";
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
  const root = await mkdtemp(path.join(tmpdir(), "assay-lifecycle-cli-"));
  tempRoots.push(root);
  return root;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ASSAY_PROJECT_REGISTRY_ROOT: registryRoot },
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

type Archetype = "study" | "solve" | "explore" | typeof BARE_ARCHETYPE;
const USER_FACING_BUILT_INS: readonly Archetype[] = ["study", "solve", "explore"];

async function initWorkspace(name: string, archetype: Archetype = "study"): Promise<string> {
  const root = path.join(await tempDir(), name);
  if (archetype === BARE_ARCHETYPE) {
    await writeBareArchetype(root);
  }
  await runCli(["init", root, "--name", name, "--archetype", archetype]);
  return root;
}

async function fillAnalysisSections(
  root: string,
  analysisPath: string,
  sections: {
    readonly key?: string;
    readonly adopt?: string;
    readonly reject?: string;
    readonly next?: string;
  },
): Promise<void> {
  const absolutePath = path.join(root, analysisPath);
  let content = await readFile(absolutePath, "utf8");
  if (sections.key) {
    content = content.replace(
      "## Key observations\n\n",
      `## Key observations\n\n${sections.key}\n\n`,
    );
  }
  if (sections.adopt) {
    content = content.replace("## Adopt\n\n", `## Adopt\n\n${sections.adopt}\n\n`);
  }
  if (sections.reject) {
    content = content.replace("## Reject\n\n", `## Reject\n\n${sections.reject}\n\n`);
  }
  if (sections.next) {
    content = content.replace("## Next step\n\n", `## Next step\n\n${sections.next}\n\n`);
  }
  await writeFile(absolutePath, content, "utf8");
}

describe("assay event capture CLI", () => {
  it("captures events for every archetype without scaffolding event templates", async () => {
    for (const archetype of USER_FACING_BUILT_INS) {
      const root = await initWorkspace(`Event${archetype}`, archetype);

      const result = await runCli([
        "event",
        "capture",
        "--kind",
        "note",
        "--text",
        "Captured from CLI test",
        "--root",
        root,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Captured event: .assay/events/");
      expect(result.stderr).toBe("");
      expect(await exists(path.join(root, ".assay", "events", ".gitkeep"))).toBe(false);
    }
  }, 30_000);
});

describe("assay analysis close CLI", () => {
  it("closes an analysis with adopt exit", async () => {
    const root = await initWorkspace("AnalClose");
    const newRes = await runCli(["analysis", "new", "Review Source", "--root", root]);
    expect(newRes.exitCode).toBe(0);

    // Extract the created path from stdout
    const match = newRes.stdout.match(/analyses\/references\/[^\s]+\.md/);
    expect(match).not.toBeNull();
    const analysisPath = match?.[0] ?? "";
    await fillAnalysisSections(root, analysisPath, {
      key: "- The CLI close path was reviewed.",
      adopt: "- Adopt the reviewed pattern.",
    });

    const close = await runCli([
      "analysis",
      "close",
      analysisPath,
      "--root",
      root,
      "--exit",
      "adopt",
    ]);

    expect(close.exitCode).toBe(0);
    expect(close.stdout).toContain("Closed analysis:");
    expect(close.stdout).toContain("Exit: adopt");

    const content = await readFile(path.join(root, analysisPath), "utf8");
    expect(content).toContain("Status: applied");
    expect(content).toContain("[x] adopt");
  });

  it("records an explicit close without mechanically gating analysis content", async () => {
    const root = await initWorkspace("AnalCloseEmpty");
    const newRes = await runCli(["analysis", "new", "Empty Review", "--root", root]);
    const match = newRes.stdout.match(/analyses\/references\/[^\s]+\.md/);
    const analysisPath = match?.[0] ?? "";

    const close = await runCli([
      "analysis",
      "close",
      analysisPath,
      "--root",
      root,
      "--exit",
      "adopt",
    ]);

    expect(close.exitCode).toBe(0);
    expect(close.stdout).toContain("Closed analysis:");
    const content = await readFile(path.join(root, analysisPath), "utf8");
    expect(content).toContain("Status: applied");
    expect(content).toContain("[x] adopt");
  });

  it("rejects invalid --exit values", async () => {
    const root = await initWorkspace("AnalCloseInvalid");
    const newRes = await runCli(["analysis", "new", "X", "--root", root]);
    const match = newRes.stdout.match(/analyses\/references\/[^\s]+\.md/);
    const analysisPath = match?.[0] ?? "";

    const close = await runCli([
      "analysis",
      "close",
      analysisPath,
      "--root",
      root,
      "--exit",
      "bogus",
    ]);

    expect(close.exitCode).not.toBe(0);
  });

  it("keeps Source observations immutable when a Source-bound Analysis closes", async () => {
    const root = await initWorkspace("AnalForSource");
    const source = path.join(root, "..", "anal-for-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");

    const add = await runCli(["source", "add", source, "live-src", "--root", root]);
    expect(add.exitCode).toBe(0);
    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");
    const sync = await runCli(["source", "sync", "live-src", "--root", root, "--class", "major"]);
    expect(sync.exitCode).toBe(0);
    const observationMatch = sync.stdout.match(/observations\/([^/\\\s]+)\.yaml/);
    expect(observationMatch).not.toBeNull();
    const observationId = observationMatch?.[1] ?? "";

    const newRes = await runCli([
      "analysis",
      "new",
      "Revalidate Source",
      "--root",
      root,
      "--for-source",
      "live-src",
      "--observation",
      observationId,
    ]);
    expect(newRes.exitCode).toBe(0);
    const analysisPath = newRes.stdout.match(/analyses\/references\/[^\s]+\.md/)?.[0] ?? "";
    const analysisContent = await readFile(path.join(root, analysisPath), "utf8");
    expect(analysisContent).toContain("- Source alias: live-src");
    expect(analysisContent).toContain(`- Source observation: ${observationId}`);

    await fillAnalysisSections(root, analysisPath, {
      key: "- The major source change was revalidated.",
      adopt: "- Adopt the updated source assumption.",
    });
    const close = await runCli([
      "analysis",
      "close",
      analysisPath,
      "--root",
      root,
      "--exit",
      "adopt",
    ]);
    expect(close.exitCode).toBe(0);

    const observationYaml = await readFile(
      path.join(root, "sources", "live-src", "observations", `${observationId}.yaml`),
      "utf8",
    );
    expect(observationYaml).not.toContain("analysis_status:");
    expect(observationYaml).not.toContain("analysis_path:");
  }, 30_000);
});

describe("assay knowledge add CLI", () => {
  it("adds a knowledge pattern entry with from-analysis link", async () => {
    const root = await initWorkspace("KnowAdd");

    const result = await runCli([
      "knowledge",
      "add",
      "pattern",
      "Config-Driven Design",
      "--root",
      root,
      "--from-analysis",
      "analyses/references/example.md",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added knowledge: knowledge/patterns/");
    expect(result.stdout).toContain("Event:");

    const match = result.stdout.match(/knowledge\/patterns\/[^\s]+\.md/);
    expect(match).not.toBeNull();
    const file = path.join(root, match?.[0] ?? "");
    expect(await exists(file)).toBe(true);

    const content = await readFile(file, "utf8");
    expect(content).toContain("# Config-Driven Design");
    expect(content).toContain("Type: pattern");
    expect(content).toContain("from analysis: analyses/references/example.md");
  });

  it("rejects invalid knowledge type", async () => {
    const root = await initWorkspace("KnowInvalid");

    const result = await runCli(["knowledge", "add", "bogus", "Title", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid type 'bogus'");
  });

  it("supports all current knowledge types", async () => {
    const root = await initWorkspace("KnowAllTypes");

    const typeDirs: Record<string, string> = {
      pattern: "patterns",
      guide: "guides",
      troubleshooting: "troubleshooting",
    };
    for (const type of ["pattern", "guide", "troubleshooting"] as const) {
      const result = await runCli(["knowledge", "add", type, `${type} entry`, "--root", root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Added knowledge: knowledge/${typeDirs[type]}/`);
    }
  });
});

describe("assay plugin CLI", () => {
  it("does not accept plugin installation on fresh init", async () => {
    const root = path.join(await tempDir(), "UnknownPlugin");

    const result = await runCli(["init", root, "--plugin", "assay.unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option '--plugin'");
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(false);
  });

  it("installs the built-in Trellis runtime only through an explicit later operation", async () => {
    const root = path.join(await tempDir(), "BuiltInTrellis");
    const initialized = await runCli(["init", root, "--name", "BuiltInTrellis"]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(await exists(path.join(root, ".assay", "plugins.json"))).toBe(false);
    const result = await runCli(["plugin", "add", "assay.trellis", "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await exists(path.join(root, ".assay", "trellis", "state.json"))).toBe(true);
    expect(await exists(path.join(root, ".trellis"))).toBe(false);
  });

  it("exposes neither capability nor native intent commands", async () => {
    const help = await runCli(["--help"]);
    expect(help.stdout).not.toMatch(/^\s+(capability|intent)\b/m);
    expect((await runCli(["capability", "list"])).exitCode).toBe(1);
    expect((await runCli(["intent", "list"])).exitCode).toBe(1);
  });
});

/**
 * Every write command an agent actually reaches for ends by naming the command
 * that continues the loop. The lines are the only in-product guidance most
 * runs ever see, so a missing one is a real regression rather than cosmetic.
 */
describe("Next: hints on high-adoption write commands", () => {
  it("points source add at status rather than at a sync nobody runs", async () => {
    const root = await initWorkspace("NextSourceAdd", "study");
    const sourceDirectory = await tempDir();
    await writeFile(path.join(sourceDirectory, "README.md"), "# Source\n", "utf8");

    const added = await runCli([
      "source",
      "add",
      sourceDirectory,
      "example-source",
      "--root",
      root,
    ]);

    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("Next: `assay status` reports when this source moves upstream");
    expect(added.stdout).not.toContain("assay source sync");
  });

  it("carries an analysis from new through close to the exit's own next command", async () => {
    const root = await initWorkspace("NextAnalysis", "study");

    const created = await runCli(["analysis", "new", "Review Source", "--root", root]);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).toContain("Next: fill ## Key observations");
    expect(created.stdout).toContain("assay analysis close analyses/references/");

    const analysisPath = created.stdout.match(/analyses\/references\/[^\s]+\.md/)?.[0];
    if (!analysisPath) {
      throw new Error(`analysis path not found in output:\n${created.stdout}`);
    }
    await fillAnalysisSections(root, analysisPath, { key: "Observed the loop." });

    const closed = await runCli([
      "analysis",
      "close",
      analysisPath,
      "--exit",
      "adopt",
      "--root",
      root,
    ]);
    expect(closed.exitCode, closed.stderr).toBe(0);
    expect(closed.stdout).toContain("Next: `assay knowledge add pattern");
    expect(closed.stdout).toContain(`--from-analysis ${analysisPath}`);

    const experiment = await runCli(["analysis", "new", "Try Another Way", "--root", root]);
    const experimentPath = experiment.stdout.match(/analyses\/references\/[^\s]+\.md/)?.[0];
    if (!experimentPath)
      throw new Error(`analysis path not found in output:\n${experiment.stdout}`);
    const experimented = await runCli([
      "analysis",
      "close",
      experimentPath,
      "--exit",
      "experiment",
      "--root",
      root,
    ]);
    expect(experimented.exitCode, experimented.stderr).toBe(0);
    expect(experimented.stdout).toContain("Next: `assay status`");
    expect(experimented.stdout).not.toContain("assay iteration");
  });

  it("names what to do after registering a system and adding knowledge", async () => {
    const root = await initWorkspace("NextSystemKnowledge", "solve");
    await mkdir(path.join(root, "systems", "engine"), { recursive: true });

    const registered = await runCli(["system", "register", "systems/engine", "--root", root]);
    expect(registered.exitCode, registered.stderr).toBe(0);
    expect(registered.stdout).toContain("Next: `assay system promote engine`");

    await mkdir(path.join(root, "systems", "core"), { recursive: true });
    const primary = await runCli([
      "system",
      "register",
      "systems/core",
      "--primary",
      "--root",
      root,
    ]);
    expect(primary.exitCode, primary.stderr).toBe(0);
    expect(primary.stdout).toContain("Next: describe what core does in systems/core/system.yaml.");

    const knowledge = await runCli([
      "knowledge",
      "add",
      "pattern",
      "Retry With Backoff",
      "--root",
      root,
    ]);
    expect(knowledge.exitCode, knowledge.stderr).toBe(0);
    expect(knowledge.stdout).toContain("Next: write the entry in knowledge/patterns/");
  });
});
