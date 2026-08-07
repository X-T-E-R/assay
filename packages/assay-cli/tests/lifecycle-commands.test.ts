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
    const bareRoot = await initWorkspace("IterBare", BARE_ARCHETYPE);
    const solveRoot = await initWorkspace("IterSolve", "solve");
    const exploreRoot = await initWorkspace("IterExplore", "explore");

    const study = await runCli(["iteration", "start", "Try Pattern", "--root", studyRoot]);
    expect(study.exitCode).toBe(1);
    expect(study.stdout).toBe("");
    expect(study.stderr).toContain("capability not enabled in archetype study: iteration");

    const bare = await runCli(["iteration", "start", "Try Pattern", "--root", bareRoot]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain(
      `capability not enabled in archetype ${BARE_ARCHETYPE}: iteration`,
    );

    const solve = await runCli(["iteration", "start", "Try Pattern", "--root", solveRoot]);
    expect(solve.exitCode).toBe(0);
    expect(solve.stderr).toBe("");
    expect(solve.stdout).toContain("Started iteration: iterations/");

    const explore = await runCli(["iteration", "start", "Try Pattern", "--root", exploreRoot]);
    expect(explore.exitCode).toBe(0);
    expect(explore.stderr).toBe("");
    expect(explore.stdout).toContain("Started iteration: iterations/");
  }, 30_000);
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

  it("binds analysis to a frozen reference and leaves its case file untouched on close", async () => {
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

    const yamlBefore = await readFile(path.join(root, refPath, "reference.yaml"), "utf8");
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

    // The frozen case file records provenance only; closing an analysis no
    // longer writes a gate flag into it.
    const yaml = await readFile(path.join(root, refPath, "reference.yaml"), "utf8");
    expect(yaml).toBe(yamlBefore);
    expect(yaml).not.toContain("analyzed:");
  });

  it("keeps major revalidation optional and clears the requested advisory on close", async () => {
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

    const structuralBefore = await runCli(["check", "--root", root]);
    expect(structuralBefore.stdout).not.toContain("needs revalidation analysis");
    const advisoryBefore = await runCli(["check", "--root", root, "--advisories"]);
    expect(advisoryBefore.stdout).toContain("needs revalidation analysis");

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
      path.join(root, "references", "live-src", "observations", `${observationId}.yaml`),
      "utf8",
    );
    expect(observationYaml).toContain("analysis_status: closed");
    expect(observationYaml).toContain(`analysis_path: ${analysisPath}`);

    const checkAfter = await runCli(["check", "--root", root, "--advisories"]);
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

    // reference.yaml case file present with provenance.
    const yaml = await readFile(path.join(root, referencePath, "reference.yaml"), "utf8");
    expect(yaml).toContain(`freeze_path: ${referencePath}`);

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

describe("assay capability CLI", () => {
  it("adds a module the archetype lacks and reports the scaffolded files", async () => {
    const root = await initWorkspace("CapAdd", BARE_ARCHETYPE);

    const added = await runCli(["capability", "add", "adr", "--root", root]);

    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe("");
    expect(added.stdout).toContain("Added capability: adr");
    expect(added.stdout).toContain("Enabled capabilities: adr");
    expect(added.stdout).toContain("knowledge/decisions/ADR-TEMPLATE.md");
    expect(added.stdout).toContain("Event:");
    expect(await exists(path.join(root, "knowledge", "decisions", "README.md"))).toBe(true);

    const adr = await runCli(["adr", "new", "First Decision", "--root", root]);
    expect(adr.exitCode).toBe(0);
    expect(adr.stdout).toContain("Created ADR: ADR-0001-first-decision");

    const check = await runCli(["check", "--root", root]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("Framework check: ok");
  });

  it("reports an already-enabled module without failing", async () => {
    const root = await initWorkspace("CapRerun", BARE_ARCHETYPE);
    await runCli(["capability", "add", "iteration", "--root", root]);

    const rerun = await runCli(["capability", "add", "iteration", "--root", root]);

    expect(rerun.exitCode).toBe(0);
    expect(rerun.stderr).toBe("");
    expect(rerun.stdout).toContain("Capability already enabled: iteration");

    const provided = await runCli([
      "capability",
      "add",
      "adr",
      "--root",
      await initWorkspace("CapStudy"),
    ]);
    expect(provided.exitCode).toBe(0);
    expect(provided.stdout).toContain("Capability already enabled: adr (provided by archetype)");
  });

  it("rejects an unsupported module name", async () => {
    const root = await initWorkspace("CapUnknown", BARE_ARCHETYPE);

    const result = await runCli(["capability", "add", "telepathy", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: unsupported capability module 'telepathy'");
    expect(result.stderr).toContain("supported modules: adr, intent, iteration");
  });

  it("lists modules and distinguishes archetype-provided from added", async () => {
    const root = await initWorkspace("CapList");
    await runCli(["capability", "add", "iteration", "--root", root]);

    const listed = await runCli(["capability", "list", "--root", root]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Capability modules for CapList (archetype study):");
    expect(listed.stdout).toContain("adr: enabled (archetype)");
    expect(listed.stdout).toContain("intent: not enabled");
    expect(listed.stdout).toContain("iteration: enabled (added)");

    const json = await runCli(["capability", "list", "--root", root, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).capabilities).toEqual([
      { module: "adr", enabled: true, source: "archetype", supported: true },
      { module: "intent", enabled: false, source: null, supported: true },
      { module: "iteration", enabled: true, source: "added", supported: true },
    ]);
  });

  it("marks modules that are not enabled", async () => {
    const root = await initWorkspace("CapListNone", BARE_ARCHETYPE);

    const listed = await runCli(["capability", "list", "--root", root]);

    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("adr: not enabled");
    expect(listed.stdout).toContain("iteration: not enabled");
  });
});

describe("assay native Project migration CLI", () => {
  it("previews and applies the retired project-authority migration without deleting source", async () => {
    const root = await initWorkspace("ProjectMigration", "solve");
    await rm(path.join(root, "project"), { recursive: true });
    await mkdir(path.join(root, "project-authority", "specs"), { recursive: true });
    const placeholder = "# Managed legacy placeholder\n";
    await writeFile(path.join(root, "project-authority", "README.md"), placeholder, "utf8");
    await writeFile(path.join(root, "project-authority", "specs", "api.md"), "# API\n", "utf8");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.project.capabilities = ["project-authority"];
    recordManagedFile(manifest, {
      path: "project-authority/README.md",
      templateId: "project.authority.readme",
      content: placeholder,
    });
    await saveManifest(root, manifest);

    const preview = await runCli(["project", "migrate-authority", "--root", root, "--dry-run"]);
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Project authority migration: dry-run");
    expect(await exists(path.join(root, "project"))).toBe(false);

    const applied = await runCli(["project", "migrate-authority", "--root", root, "--apply"]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Project authority migration: applied");
    expect(await readFile(path.join(root, "project", "specs", "api.md"), "utf8")).toBe("# API\n");
    expect(await readFile(path.join(root, "project-authority", "specs", "api.md"), "utf8")).toBe(
      "# API\n",
    );
  });
});

describe("assay plugin CLI", () => {
  it("installs intent during init without changing the init verb", async () => {
    const root = path.join(await tempDir(), "InitIntentPlugin");
    await writeBareArchetype(root);

    const result = await runCli([
      "init",
      root,
      "--name",
      "InitIntentPlugin",
      "--archetype",
      BARE_ARCHETYPE,
      "--plugin",
      "assay.intent",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Initialized framework:");
    expect(result.stdout).toContain("Added plugin: assay.intent");
    expect(await exists(path.join(root, "intent", "original", "README.md"))).toBe(true);

    const manifest = JSON.parse(
      await readFile(path.join(root, ".assay", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.plugins).toEqual({
      "assay.intent": { kind: "workspace-module" },
    });
    expect(JSON.parse(await readFile(path.join(root, ".assay", "plugins.json"), "utf8"))).toEqual(
      expect.objectContaining({
        __schema: 1,
        plugins: {
          "assay.intent": expect.objectContaining({
            kind: "workspace-module",
            state_version: 1,
          }),
        },
      }),
    );
  });

  it("keeps reconcile dry-run by default and applies legacy adoption explicitly", async () => {
    const root = await initWorkspace("ReconcileLegacy", BARE_ARCHETYPE);
    await runCli(["capability", "add", "intent", "--root", root]);

    const preview = await runCli(["reconcile", "--root", root]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Plugin reconcile: dry-run");
    expect(preview.stdout).toContain("[adopt] assay.intent");
    expect(await exists(path.join(root, ".assay", "plugins.json"))).toBe(false);

    const applied = await runCli(["reconcile", "--root", root, "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Plugin reconcile: applied");
    expect(await exists(path.join(root, ".assay", "plugins.json"))).toBe(true);

    const listed = await runCli(["plugin", "list", "--root", root, "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).plugins).toContainEqual(
      expect.objectContaining({
        id: "assay.intent",
        desired: true,
        installed: true,
        action: "noop",
      }),
    );
    const checked = await runCli(["plugin", "check", "--root", root]);
    expect(checked.exitCode).toBe(0);
    expect(checked.stdout).toContain("Plugin check: ok");
  });

  it("rejects an unknown plugin before init creates a workspace", async () => {
    const root = path.join(await tempDir(), "UnknownPlugin");

    const result = await runCli(["init", root, "--plugin", "assay.unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported plugin 'assay.unknown'");
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(false);
  });

  it("installs the built-in Trellis runtime without an external sidecar", async () => {
    const root = path.join(await tempDir(), "BuiltInTrellis");

    const result = await runCli([
      "init",
      root,
      "--name",
      "BuiltInTrellis",
      "--plugin",
      "assay.trellis",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await exists(path.join(root, ".assay", "trellis", "state.json"))).toBe(true);
    expect(await exists(path.join(root, ".trellis"))).toBe(false);
  });

  it("shows Trellis runtime capabilities while native decision governance stays active", async () => {
    const root = path.join(await tempDir(), "CliTrellis");

    const initialized = await runCli(["init", root, "--name", "CliTrellis", "--plugin", "trellis"]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(initialized.stdout).toContain("Added plugin: assay.trellis");

    const plugins = await runCli(["plugin", "list", "--root", root]);
    expect(plugins.exitCode, plugins.stderr).toBe(0);
    expect(plugins.stdout).toContain("workspace-runtime");
    expect(plugins.stdout).toContain(
      "runtime task-store, session-store, journal-store, runtime-config, durable-channel, external-worker-protocol, codex-memory-reader, legacy-migration, context-provider, host-hook-registration",
    );
    expect(plugins.stdout).toContain("decision-governance: desired assay.native");

    const status = await runCli(["status", "--root", root]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("Decision governance");
    expect(status.stdout).toContain("active provider: assay.native");

    const analysis = await runCli(["analysis", "new", "Provider decision", "--root", root]);
    const analysisPath = analysis.stdout.match(/Created analysis: (.+)/)?.[1]?.trim();
    expect(analysisPath).toBeDefined();
    const closed = await runCli([
      "analysis",
      "close",
      analysisPath as string,
      "--exit",
      "adr",
      "--allow-empty",
      "--root",
      root,
    ]);
    expect(closed.exitCode, closed.stderr).toBe(0);
    expect(closed.stdout).toContain("Next: `assay adr new");
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
    const donor = await tempDir();
    await writeFile(path.join(donor, "README.md"), "# Donor\n", "utf8");

    const added = await runCli(["source", "add", donor, "donor", "--root", root]);

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
  });

  it("carries an iteration from start through close", async () => {
    const root = await initWorkspace("NextIteration", "solve");

    const started = await runCli(["iteration", "start", "Try Pattern", "--root", root]);
    expect(started.exitCode, started.stderr).toBe(0);
    expect(started.stdout).toContain("Next: fill iterations/");
    expect(started.stdout).toContain("assay iteration close iterations/");

    const iterationPath = started.stdout.match(/Started iteration: (\S+)/)?.[1];
    if (!iterationPath) {
      throw new Error(`iteration path not found in output:\n${started.stdout}`);
    }

    const closed = await runCli([
      "iteration",
      "close",
      iterationPath,
      "--result",
      "applied",
      "--root",
      root,
    ]);
    expect(closed.exitCode, closed.stderr).toBe(0);
    expect(closed.stdout).toContain("Next: `assay knowledge add pattern");
    expect(closed.stdout).toContain(`--from-iteration ${iterationPath}`);
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

  it("names the first command a newly added capability makes available", async () => {
    const root = await initWorkspace("NextCapability", BARE_ARCHETYPE);

    const added = await runCli(["capability", "add", "adr", "--root", root]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("Next: `assay adr new");

    const rerun = await runCli(["capability", "add", "adr", "--root", root]);
    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(rerun.stdout).not.toContain("Next:");
  });
});
