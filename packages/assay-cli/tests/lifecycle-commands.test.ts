import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

type Archetype = "study" | "solve" | "library" | "science" | "evaluation" | "explore";
const USER_FACING_BUILT_INS: readonly Archetype[] = [
  "library",
  "study",
  "solve",
  "science",
  "evaluation",
  "explore",
];

async function initWorkspace(name: string, archetype: Archetype = "study"): Promise<string> {
  const root = path.join(await tempDir(), name);
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
    content = content.replace("## Next iteration\n\n", `## Next iteration\n\n${sections.next}\n\n`);
  }
  await writeFile(absolutePath, content, "utf8");
}

describe("assay iteration close CLI", () => {
  it("closes an iteration with --result", async () => {
    const root = await initWorkspace("IterClose", "solve");
    const start = await runCli(["iteration", "start", "Test Pattern", "--root", root]);
    expect(start.exitCode).toBe(0);
    // Extract the created iteration path from stdout
    const match = start.stdout.match(/iterations\/[^\s]+/);
    expect(match).not.toBeNull();
    const iterPath = match?.[0] ?? "";

    const close = await runCli([
      "iteration",
      "close",
      iterPath,
      "--root",
      root,
      "--result",
      "applied",
      "--note",
      "verified",
    ]);

    expect(close.exitCode).toBe(0);
    expect(close.stdout).toContain("Closed iteration:");
    expect(close.stdout).toContain("Event:");
  });

  it("rejects invalid --result values", async () => {
    const root = await initWorkspace("IterCloseInvalid", "solve");
    await runCli(["iteration", "start", "X", "--root", root]);

    const close = await runCli(["iteration", "close", "x", "--root", root, "--result", "bogus"]);

    expect(close.exitCode).not.toBe(0);
  });

  it("starts iterations only when the archetype enables the iteration capability", async () => {
    const studyRoot = await initWorkspace("IterStudy");
    const libraryRoot = await initWorkspace("IterLibrary", "library");
    const evaluationRoot = await initWorkspace("IterEvaluation", "evaluation");
    const solveRoot = await initWorkspace("IterSolve", "solve");
    const scienceRoot = await initWorkspace("IterScience", "science");
    const exploreRoot = await initWorkspace("IterExplore", "explore");

    const study = await runCli(["iteration", "start", "Try Pattern", "--root", studyRoot]);
    expect(study.exitCode).toBe(1);
    expect(study.stdout).toBe("");
    expect(study.stderr).toContain("capability not enabled in archetype study: iteration");

    const library = await runCli(["iteration", "start", "Try Pattern", "--root", libraryRoot]);
    expect(library.exitCode).toBe(1);
    expect(library.stdout).toBe("");
    expect(library.stderr).toContain("capability not enabled in archetype library: iteration");

    const evaluation = await runCli([
      "iteration",
      "start",
      "Try Pattern",
      "--root",
      evaluationRoot,
    ]);
    expect(evaluation.exitCode).toBe(1);
    expect(evaluation.stdout).toBe("");
    expect(evaluation.stderr).toContain(
      "capability not enabled in archetype evaluation: iteration",
    );

    const solve = await runCli(["iteration", "start", "Try Pattern", "--root", solveRoot]);
    expect(solve.exitCode).toBe(0);
    expect(solve.stderr).toBe("");
    expect(solve.stdout).toContain("Started iteration: iterations/");

    const science = await runCli(["iteration", "start", "Try Pattern", "--root", scienceRoot]);
    expect(science.exitCode).toBe(0);
    expect(science.stderr).toBe("");
    expect(science.stdout).toContain("Started iteration: iterations/");

    const explore = await runCli(["iteration", "start", "Try Pattern", "--root", exploreRoot]);
    expect(explore.exitCode).toBe(0);
    expect(explore.stderr).toBe("");
    expect(explore.stdout).toContain("Started iteration: iterations/");
  });
});

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
      expect(result.stdout).toContain("Captured event: .framework/events/");
      expect(result.stderr).toBe("");
      expect(await exists(path.join(root, ".framework", "events", ".gitkeep"))).toBe(false);
    }
  });
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

  it("rejects empty analysis close by default", async () => {
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

    expect(close.exitCode).toBe(1);
    expect(close.stderr).toContain("non-empty ## Key observations");
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

  it("binds analysis to a frozen reference and marks it analyzed on close", async () => {
    const root = await initWorkspace("AnalForRef");
    // Create a source directory and freeze it as a reference.
    const source = path.join(root, "..", "anal-for-ref-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const freezeRes = await runCli(["reference", "add", source, "Source Project", "--root", root]);
    expect(freezeRes.exitCode).toBe(0);

    const refPathMatch = freezeRes.stdout.match(/references\/frozen\/\d{6}\/source-project/);
    expect(refPathMatch).not.toBeNull();
    const refPath = refPathMatch?.[0] ?? "";
    expect(await exists(path.join(root, refPath, "reference.yaml"))).toBe(true);

    // Create an analysis bound to the reference and confirm pre-fill.
    const newRes = await runCli([
      "analysis",
      "new",
      "Review Source Project",
      "--root",
      root,
      "--for-reference",
      refPath,
    ]);
    expect(newRes.exitCode).toBe(0);

    const match = newRes.stdout.match(/analyses\/references\/[^\s]+\.md/);
    const analysisPath = match?.[0] ?? "";
    const analysisContent = await readFile(path.join(root, analysisPath), "utf8");
    expect(analysisContent).toContain(`- Freeze path: ${refPath}`);
    await fillAnalysisSections(root, analysisPath, {
      key: "- The frozen reference was reviewed.",
      adopt: "- Adopt the useful reference detail.",
    });

    // Closing the analysis must flip reference.yaml analyzed to true.
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

    const yaml = await readFile(path.join(root, refPath, "reference.yaml"), "utf8");
    expect(yaml).toContain("analyzed: true");
  });

  it("binds analysis to a living source observation and clears major check warning", async () => {
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

    const checkBefore = await runCli(["check", "--root", root]);
    expect(checkBefore.stdout).toContain("needs revalidation analysis");

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
      path.join(root, "references", "live-src", ".assay", "observations", `${observationId}.yaml`),
      "utf8",
    );
    expect(observationYaml).toContain("analysis_status: closed");
    expect(observationYaml).toContain(`analysis_path: ${analysisPath}`);

    const checkAfter = await runCli(["check", "--root", root]);
    expect(checkAfter.stdout).not.toContain("needs revalidation analysis");
  }, 30_000);
});

describe("assay absorb CLI", () => {
  it("freezes a source and opens a pre-filled analysis in one step", async () => {
    const root = await initWorkspace("Absorb");
    const source = path.join(root, "..", "absorb-source");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "README.md"),
      "# Absorbed Proj\n\nA probed description.\n",
      "utf8",
    );
    await mkdir(path.join(source, "lib"), { recursive: true });

    const res = await runCli(["absorb", source, "--name", "Absorbed Proj", "--root", root]);
    expect(res.exitCode).toBe(0);
    const referencePathMatch = res.stdout.match(/references\/frozen\/\d{6}\/absorbed-proj/);
    expect(referencePathMatch).not.toBeNull();
    const referencePath = referencePathMatch?.[0] ?? "";
    expect(res.stdout).toContain(`Absorbed source: ${referencePath}`);
    expect(res.stdout).toContain("Opened analysis: analyses/references/");

    // reference.yaml case file present and unanalyzed.
    const yaml = await readFile(path.join(root, referencePath, "reference.yaml"), "utf8");
    expect(yaml).toContain("analyzed: false");

    // The opened analysis is pre-filled with the README lead.
    const match = res.stdout.match(/analyses\/references\/[^\s]+\.md/);
    const analysisPath = match?.[0] ?? "";
    const analysis = await readFile(path.join(root, analysisPath), "utf8");
    expect(analysis).toContain("A probed description.");
    expect(analysis).toContain("lib/");
  });

  it("routes absorption mode sources to the explicit intake outlet", async () => {
    const root = await initWorkspace("AbsorbSolve", "solve");
    const source = path.join(root, "..", "solve-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Solve Candidate\n", "utf8");

    const res = await runCli([
      "absorb",
      source,
      "--name",
      "Solve Candidate",
      "--as",
      "intake",
      "--root",
      root,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Absorbed source: intake/solve-candidate");
    expect(await exists(path.join(root, "intake", "solve-candidate", "source.yaml"))).toBe(true);
    expect(await exists(path.join(root, "problem", "solve-candidate"))).toBe(false);
    expect(await exists(path.join(root, "references", "frozen"))).toBe(false);
  });
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

  it("supports all four knowledge types", async () => {
    const root = await initWorkspace("KnowAllTypes");

    const typeDirs: Record<string, string> = {
      decision: "decisions",
      pattern: "patterns",
      guide: "guides",
      troubleshooting: "troubleshooting",
    };
    for (const type of ["decision", "pattern", "guide", "troubleshooting"] as const) {
      const result = await runCli(["knowledge", "add", type, `${type} entry`, "--root", root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Added knowledge: knowledge/${typeDirs[type]}/`);
    }
  });
});
