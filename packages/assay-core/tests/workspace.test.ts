import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BARE_ARCHETYPE,
  createTempDirectoryFixture,
  pathExists as exists,
  writeBareArchetype,
} from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILE,
  absorbReference,
  acceptAdr,
  addKnowledge,
  addReference,
  addSource,
  attachExistingRepo,
  backfillReferenceCaseFile,
  captureEvent,
  checkFramework,
  closeAnalysis,
  closeIteration,
  createAdr,
  createAnalysis,
  desiredRuntimeTemplates,
  dirsForArchetype,
  getFrameworkStatus,
  initFramework,
  loadAdrIndex,
  loadArchetype,
  loadManifest,
  loadSystemsRegistry,
  projectIdForPath,
  projectRecordPath,
  readFrameworkMode,
  readInstalledArchetype,
  registerSystem,
  saveAdrIndex,
  saveSystemsRegistry,
  startIteration,
  syncSource,
} from "../src/index.js";

const USER_FACING_BUILT_INS = ["study", "solve", "explore"] as const;
const tempDirs = createTempDirectoryFixture("assay-core-workspace");

async function tempDir(): Promise<string> {
  return tempDirs.createTempDir();
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

/** Product repository with one tracked file and a committed history. */
async function productRepo(name: string): Promise<string> {
  const root = path.join(await tempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function fillAnalysisSections(
  analysisPath: string,
  sections: {
    readonly key?: string;
    readonly adopt?: string;
    readonly reject?: string;
    readonly next?: string;
  },
): Promise<void> {
  let content = await readFile(analysisPath, "utf8");
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
  await writeFile(analysisPath, content, "utf8");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("desiredRuntimeTemplates", () => {
  it("returns deterministic template paths and ids from the registry", async () => {
    const first = await desiredRuntimeTemplates("Demo", "study", "learning");
    const second = await desiredRuntimeTemplates("Demo", "study", "learning");

    expect(second).toEqual(first);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      ".assay/VERSION",
      "framework.version",
    ]);
    expect(first.map((template) => template.path)).toContain("systems/README.md");
    expect(first.map((template) => template.path)).not.toContain("systems/demo-core/system.yaml");
    expect(first.map((template) => template.template_id)).not.toContain("system.core.contract");
    expect(first.map((template) => template.path)).not.toContain(".assay/config.yaml");
    expect(first.map((template) => template.template_id)).not.toContain("framework.config");
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      "knowledge/README.md",
      "knowledge.readme",
    ]);
    expect(first.map((template) => template.path)).not.toContain("systems/demo-core/README.md");
    expect(first.map((template) => template.path)).not.toContain(
      "systems/demo-core/framework.yaml",
    );
    expect(first.map((template) => template.path)).not.toContain(
      "systems/demo-core/docs/update-mechanism.md",
    );
    expect(first.every((template) => template.executable === false)).toBe(true);
    expect(first.every((template) => template.protected === false)).toBe(true);
  });
});

describe("initFramework", () => {
  it("creates .assay version, manifest, primary directories, and managed records", async () => {
    const root = path.join(await tempDir(), "demo");
    const result = await initFramework({ target: root, name: "Demo" });

    expect(result.project).toBe("Demo");
    expect(result.archetype).toBe("study");
    expect(result.mode).toBe("learning");
    expect(await exists(path.join(root, ".assay", "VERSION"))).toBe(true);
    expect(await exists(path.join(root, MANIFEST_FILE))).toBe(true);
    const archetype = await loadArchetype("study");
    for (const directory of dirsForArchetype(archetype, "learning")) {
      expect(await exists(path.join(root, directory))).toBe(true);
    }
    expect(await exists(path.join(root, "systems", "demo-core"))).toBe(false);
    expect(await exists(path.join(root, ".assay", "config.yaml"))).toBe(false);
    expect(await exists(path.join(root, "knowledge", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "knowledge", "decisions", "ADR-TEMPLATE.md"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "adrs.json"))).toBe(true);
    expect(await exists(path.join(root, "iterations"))).toBe(false);
    expect(result.report.created_dirs).not.toContain(".assay/events");

    const manifest = await loadManifest(root);
    expect(manifest).not.toBeNull();
    expect(manifest?.project).toMatchObject({
      name: "Demo",
      archetype: "study",
      mode: "learning",
    });
    expect(manifest?.project.core).toBeUndefined();
    expect(Object.keys(manifest?.managed_files ?? {})).toContain(".assay/VERSION");
    expect(Object.keys(manifest?.managed_files ?? {})).not.toContain(".assay/config.yaml");
    expect(Object.keys(manifest?.managed_files ?? {})).not.toContain(
      "systems/demo-core/system.yaml",
    );
    expect(Object.keys(manifest?.managed_files ?? {})).toHaveLength(
      (await desiredRuntimeTemplates("Demo", "study", "learning")).length,
    );
  });

  it("skips existing files by default and leaves them untracked for a new workspace", async () => {
    const root = path.join(await tempDir(), "demo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "# user readme\n", "utf8");

    const result = await initFramework({ target: root, name: "Demo" });
    const manifest = await loadManifest(root);

    expect(result.report.skipped_files).toContain("README.md");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# user readme\n");
    expect(manifest?.managed_files["README.md"]).toBeUndefined();
  });

  it("force overwrites existing template paths and records them as managed", async () => {
    const root = path.join(await tempDir(), "demo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "# user readme\n", "utf8");

    const result = await initFramework({ target: root, name: "Demo", force: true });
    const manifest = await loadManifest(root);

    expect(result.report.updated_files).toContain("README.md");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# Demo");
    expect(manifest?.managed_files["README.md"]?.template_id).toBe("root.readme");
  });

  it("createNew writes .new copies without changing existing files", async () => {
    const root = path.join(await tempDir(), "demo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "# user readme\n", "utf8");

    const result = await initFramework({ target: root, name: "Demo", createNew: true });

    expect(result.report.new_copies).toContain("README.md.new");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# user readme\n");
    expect(await readFile(path.join(root, "README.md.new"), "utf8")).toContain("# Demo");
  });
});

describe("checkFramework and getFrameworkStatus", () => {
  it("returns pass/fail rows and manifest details", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    const passing = await checkFramework({ root });
    expect(passing.ok).toBe(true);
    expect(passing.manifest?.managedFiles).toBeGreaterThan(5);
    expect(passing.rows.some((row) => row.path === ".assay/VERSION" && row.status === "ok")).toBe(
      true,
    );

    await rm(path.join(root, "knowledge"), { recursive: true, force: true });
    const failing = await checkFramework({ root });
    expect(failing.ok).toBe(false);
    expect(failing.rows).toContainEqual({
      path: "knowledge",
      status: "missing",
      message: "knowledge directory",
    });
  });

  it("returns framework status counts", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(root, "knowledge", "guides"), { recursive: true });
    await writeFile(path.join(root, "knowledge", "guides", "extra.md"), "# Extra\n", "utf8");

    const status = await getFrameworkStatus({ root });

    expect(status).toMatchObject({
      hasManifest: true,
      project: "Demo",
      archetype: "study",
      mode: "learning",
      manifestFormat: "schema 1; archetype study; mode learning",
      managedFiles: (await desiredRuntimeTemplates("Demo", "study", "learning")).length,
    });
    expect(status.zones.find((zone) => zone.path === "knowledge")?.files).toBeGreaterThan(0);
  });

  it("derives status zones from the installed archetype, with purposes", async () => {
    const solveRoot = path.join(await tempDir(), "solve");
    await initFramework({ target: solveRoot, name: "Solve", archetype: "solve" });

    const solve = await getFrameworkStatus({ root: solveRoot });

    expect(solve.archetypeDescription).toContain("measurable success criterion");
    expect(solve.zones.map((zone) => zone.path)).toEqual([
      "problem",
      "intake",
      "benchmarks",
      "attempts",
      "tools",
      "iterations",
      "systems",
      "knowledge",
    ]);
    expect(solve.zones.find((zone) => zone.path === "problem")?.purpose).toBe(
      "Task statement, official rules, scoring definition",
    );
    // Study's directories are dead zones for a solve workspace.
    expect(solve.zones.some((zone) => zone.path.startsWith("analyses"))).toBe(false);

    const studyRoot = path.join(await tempDir(), "study");
    await initFramework({ target: studyRoot, name: "Study" });

    const study = await getFrameworkStatus({ root: studyRoot });
    const studyZones = study.zones.map((zone) => zone.path);

    expect(studyZones).toEqual(
      expect.arrayContaining([
        "analyses/references",
        "analyses/patterns",
        "references/frozen",
        "knowledge",
      ]),
    );
    expect(studyZones.some((zone) => zone.startsWith("problem"))).toBe(false);
    expect(study.zones.every((zone) => zone.purpose !== "")).toBe(true);
  });

  it("still reports a work area that holds content the archetype never declared", async () => {
    const root = path.join(await tempDir(), "legacy-iterations");
    await initFramework({ target: root, name: "Legacy" });

    expect(
      (await getFrameworkStatus({ root })).zones.some((zone) => zone.path === "iterations"),
    ).toBe(false);

    await mkdir(path.join(root, "iterations", "2026-07-01-topic"), { recursive: true });
    await writeFile(
      path.join(root, "iterations", "2026-07-01-topic", "plan.md"),
      "# Topic\n\n- Status: open\n",
      "utf8",
    );

    const iterations = (await getFrameworkStatus({ root })).zones.find(
      (zone) => zone.path === "iterations",
    );
    expect(iterations?.files).toBe(1);
    expect(iterations?.purpose).not.toBe("");
  });
});

describe("checkFramework placement advisories", () => {
  it("reports undeclared top-level directories and statusless analyses without failing", async () => {
    const root = path.join(await tempDir(), "placement");
    await initFramework({ target: root, name: "Placement" });

    expect((await checkFramework({ root, includeAdvisories: true })).rows).not.toContainEqual(
      expect.objectContaining({ status: "warning", path: "scratch" }),
    );

    await mkdir(path.join(root, "scratch"), { recursive: true });
    await writeFile(path.join(root, "scratch", "note.md"), "# note\n", "utf8");
    await writeFile(
      path.join(root, "analyses", "references", "hand-written.md"),
      "# Hand written\n\nSome observations.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "analyses", "references", "proper.md"),
      "# Proper\n\n- Date: 2026-07-26\n- Status: draft\n\n## Key observations\n\nSomething.\n",
      "utf8",
    );

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(result.ok).toBe(true);
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        path: "scratch",
        status: "warning",
        message: expect.stringContaining("is not declared by archetype study"),
      }),
    );
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        path: "analyses/references/hand-written.md",
        status: "warning",
        message: expect.stringContaining("no `Status:` header"),
      }),
    );
    expect(result.rows.some((row) => row.path === "analyses/references/proper.md")).toBe(false);

    // Placement rows are advisory-only: the default check never sees them.
    const withoutAdvisories = await checkFramework({ root });
    expect(withoutAdvisories.ok).toBe(true);
    expect(withoutAdvisories.rows.some((row) => row.path === "scratch")).toBe(false);
  });
});

describe("checkFramework semantic validation", () => {
  it("reports error when a managed file is missing from disk", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // Delete a managed file
    await rm(path.join(root, ".assay", "VERSION"), { force: true });

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) =>
          row.path === ".assay/VERSION" &&
          row.status === "error" &&
          row.message?.includes("managed file missing"),
      ),
    ).toBe(true);
  });

  it("reports warning when a managed file is modified by user", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // Modify a managed file
    await writeFile(path.join(root, "README.md"), "# Modified by user\n", "utf8");

    const result = await checkFramework({ root });

    // warning does not fail the check
    expect(result.ok).toBe(true);
    expect(
      result.rows.some(
        (row) =>
          row.path === "README.md" &&
          row.status === "warning" &&
          row.message?.includes("modified by user"),
      ),
    ).toBe(true);
  });

  it("includes systems summary when a systems registry exists", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });
    await registerSystem(root, {
      path: "systems/demo-core",
      name: "demo-core",
      primary: true,
      vcs: "embedded",
    });

    const result = await checkFramework({ root });

    expect(result.systems).toBeDefined();
    expect(result.systems?.primary).toBe("demo-core");
    expect(result.systems?.total).toBe(1);
  });

  it("reports error for duplicate primary systems in registry", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await mkdir(path.join(root, "systems", "beta"), { recursive: true });
    await registerSystem(root, { path: "systems/alpha", name: "alpha", primary: true });
    await registerSystem(root, { path: "systems/beta", name: "beta" });

    // Manually corrupt: set both to primary
    const registry = await loadSystemsRegistry(root);
    const beta = registry?.systems.beta;
    if (!registry || !beta) {
      throw new Error("beta system missing from registry");
    }
    registry.systems.beta = { ...beta, status: "primary" };
    await saveSystemsRegistry(root, registry);

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) =>
          row.path === ".assay/systems-registry.json" &&
          row.status === "error" &&
          row.message?.includes("exactly one primary"),
      ),
    ).toBe(true);
  });

  it("reports open iterations only when advisories are requested", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", archetype: "solve" });
    await startIteration({ root, title: "Open Iteration" });

    const structural = await checkFramework({ root });
    expect(structural.rows.some((row) => row.message?.includes("not closed"))).toBe(false);
    expect(structural.systems?.openIterations).toBe(1);

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(result.ok).toBe(true);
    expect(
      result.rows.some(
        (row) =>
          row.path === "iterations/" &&
          row.status === "warning" &&
          row.message?.includes("not closed"),
      ),
    ).toBe(true);
    expect(result.systems?.openIterations).toBe(1);
  });

  it("reports error when a registered active system is missing on disk", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await registerSystem(root, { path: "systems/ghost", name: "ghost", primary: true });

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some((row) => row.status === "error" && row.message?.includes("missing on disk")),
    ).toBe(true);
  });

  it("reports warning when an indexed ADR is missing required frontmatter fields", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAdr(root, { title: "Needs Frontmatter" });
    await writeFile(path.join(root, created.adr.path), "# No frontmatter\n", "utf8");

    const result = await checkFramework({ root });

    expect(result.ok).toBe(true);
    expect(
      result.rows.some(
        (row) =>
          row.path === created.adr.path &&
          row.status === "warning" &&
          row.message?.includes("ADR frontmatter missing"),
      ),
    ).toBe(true);
  });

  it("reports error for dangling ADR superseded_by references", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAdr(root, { title: "Dangling ADR" });
    await acceptAdr(root, created.adr.id);
    const index = await loadAdrIndex(root);
    if (!index) {
      throw new Error("ADR index missing");
    }
    const record = index.adrs[created.adr.id];
    if (!record) {
      throw new Error("ADR record missing");
    }
    index.adrs[created.adr.id] = { ...record, superseded_by: "ADR-9999-missing" };
    await saveAdrIndex(root, index);

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) => row.status === "error" && row.message?.includes("missing superseded_by"),
      ),
    ).toBe(true);
  });

  it("reports error for non-bidirectional ADR supersede links", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const oldAdr = await createAdr(root, { title: "Old ADR" });
    const newAdr = await createAdr(root, { title: "New ADR" });
    await acceptAdr(root, oldAdr.adr.id);
    await acceptAdr(root, newAdr.adr.id);
    const index = await loadAdrIndex(root);
    if (!index) {
      throw new Error("ADR index missing");
    }
    const oldRecord = index.adrs[oldAdr.adr.id];
    if (!oldRecord) {
      throw new Error("old ADR record missing");
    }
    index.adrs[oldAdr.adr.id] = {
      ...oldRecord,
      status: "superseded",
      superseded_by: newAdr.adr.id,
    };
    await saveAdrIndex(root, index);

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) =>
          row.status === "error" &&
          row.message?.includes("superseded_by link is not bidirectional"),
      ),
    ).toBe(true);
  });

  it("reports error for ADR supersede cycles", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const first = await createAdr(root, { title: "First ADR" });
    const second = await createAdr(root, { title: "Second ADR" });
    await acceptAdr(root, first.adr.id);
    await acceptAdr(root, second.adr.id);
    const index = await loadAdrIndex(root);
    if (!index) {
      throw new Error("ADR index missing");
    }
    const firstRecord = index.adrs[first.adr.id];
    const secondRecord = index.adrs[second.adr.id];
    if (!firstRecord || !secondRecord) {
      throw new Error("ADR records missing");
    }
    index.adrs[first.adr.id] = {
      ...firstRecord,
      status: "superseded",
      supersedes: [second.adr.id],
      superseded_by: second.adr.id,
    };
    index.adrs[second.adr.id] = {
      ...secondRecord,
      status: "superseded",
      supersedes: [first.adr.id],
      superseded_by: first.adr.id,
    };
    await saveAdrIndex(root, index);

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) => row.status === "error" && row.message?.includes("supersede chain has a cycle"),
      ),
    ).toBe(true);
  });

  it("warns on an unexpected knowledge subdirectory (e.g. troubleshootings)", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // Simulate the legacy bug: a parallel "knowledge/troubleshootings/" dir
    await mkdir(path.join(root, "knowledge", "troubleshootings"), { recursive: true });

    const result = await checkFramework({ root });

    // warning does not fail the check, but must be surfaced
    expect(
      result.rows.some(
        (row) =>
          row.path === "knowledge/troubleshootings" &&
          row.status === "warning" &&
          row.message?.includes("troubleshootings"),
      ),
    ).toBe(true);
  });

  it("reports a frozen reference only for missing provenance, not for missing citations", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    // A properly frozen reference no analysis mentions. Nothing to report:
    // whether a reference was read is not something the tool can observe.
    const frozen = await addReference({ root, source, name: "Lonely Ref" });
    // A hand-made freeze with no case file: real, checkable, and reported.
    await mkdir(path.join(root, "references", "frozen", "202606", "handmade"), {
      recursive: true,
    });

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(result.rows.filter((row) => row.path === frozen.path)).toEqual([]);
    expect(
      result.rows.find((row) => row.path === "references/frozen/202606/handmade"),
    ).toMatchObject({ status: "warning" });
  });

  it("warns on a draft analysis with empty Key observations", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // A draft analysis whose Key observations section is empty.
    await writeFile(
      path.join(root, "analyses", "references", "2026-06-20-shell.md"),
      "# Shell\n\n- Status: draft\n\n## Reference\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Decision exit\n\n- [ ] adopt\n",
      "utf8",
    );

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(
      result.rows.some(
        (row) =>
          row.path === "analyses/references/2026-06-20-shell.md" &&
          row.status === "warning" &&
          row.message?.includes("empty 'Key observations'"),
      ),
    ).toBe(true);
  });

  it("warns on a stale .old/ adoption archive", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    await mkdir(path.join(root, ".old", "20260620-120000"), { recursive: true });

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(
      result.rows.some(
        (row) =>
          row.path === ".old" &&
          row.status === "warning" &&
          row.message?.includes("adoption archive .old/"),
      ),
    ).toBe(true);
  });

  it("warns on pending queue entries (freeze-then-forget)", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    await writeFile(
      path.join(root, ".assay", "queue.json"),
      JSON.stringify([
        { id: "r1", status: "pending", summary: "Analyze ref A" },
        { id: "r2", status: "done", summary: "Analyze ref B" },
        { id: "r3", status: "pending", summary: "Analyze ref C" },
      ]),
      "utf8",
    );

    const result = await checkFramework({ root, includeAdvisories: true });

    expect(
      result.rows.some(
        (row) => row.status === "warning" && row.message?.includes("2 pending entry/entries"),
      ),
    ).toBe(true);
  });
});

describe("getFrameworkStatus systems section", () => {
  it("includes systems, openIterations, and knowledgeEntries", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", archetype: "solve" });
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });
    await registerSystem(root, {
      path: "systems/demo-core",
      name: "demo-core",
      primary: true,
      vcs: "independent-git",
      version: "0.2.0",
    });
    await startIteration({ root, title: "Open Work" });

    const status = await getFrameworkStatus({ root });

    expect(status.systems).toBeDefined();
    expect(status.systems).toHaveLength(1);
    expect(status.systems?.[0]).toMatchObject({
      name: "demo-core",
      status: "primary",
      vcs: "independent-git",
      version: "0.2.0",
    });
    expect(status.openIterations).toBe(1);
    expect(status.knowledgeEntries).toBe(0);
  });

  it("omits systems section when no registry exists", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    const status = await getFrameworkStatus({ root });

    expect(status.systems).toBeUndefined();
  });

  it("summarizes living source observations", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");

    await addSource({
      root,
      source,
      alias: "Source",
      now: new Date("2026-07-01T08:00:00"),
    });

    let status = await getFrameworkStatus({ root });
    expect(status.livingSources).toEqual({
      total: 1,
      openObservations: 1,
      suggestedAnalyses: 0,
      closedObservations: 0,
      majorRevalidations: 0,
    });

    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");
    await syncSource({
      root,
      alias: "source",
      changeClass: "major",
      now: new Date("2026-07-01T09:00:00"),
    });

    status = await getFrameworkStatus({ root });
    expect(status.livingSources).toMatchObject({
      total: 1,
      openObservations: 1,
      majorRevalidations: 1,
    });
  });
});

describe("workspace operations", () => {
  it("keeps overlay work folders under .assay and out of product git", async () => {
    const root = path.join(await tempDir(), "product");
    const source = path.join(await tempDir(), "source");
    await mkdir(root, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
    await writeFile(path.join(source, "README.md"), "# Source\n\nUseful source.\n", "utf8");

    await git(root, ["init"]);
    await git(root, ["config", "user.email", "assay@example.test"]);
    await git(root, ["config", "user.name", "Assay Test"]);
    await git(root, ["add", "package.json"]);
    await git(root, ["commit", "-m", "initial"]);

    await attachExistingRepo({
      root,
      name: "Product",
      archetype: "study",
      privacy: "private",
      now: new Date("2026-07-06T08:00:00"),
    });
    const analysis = await createAnalysis({
      root,
      title: "Overlay Analysis",
      now: new Date("2026-07-06T09:00:00"),
    });
    const sourceResult = await addSource({
      root,
      source,
      alias: "Sample",
      now: new Date("2026-07-06T10:00:00"),
    });
    const knowledge = await addKnowledge({
      root,
      type: "pattern",
      title: "Overlay Pattern",
      now: new Date("2026-07-06T11:00:00"),
    });
    const check = await checkFramework({ root });

    expect(analysis.path).toBe(".assay/analyses/references/2026-07-06-overlay-analysis.md");
    expect(sourceResult.path).toBe(".assay/references/sample");
    expect(knowledge.path).toBe(".assay/knowledge/patterns/2026-07-06-overlay-pattern.md");
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "references"))).toBe(false);
    expect(await exists(path.join(root, "knowledge"))).toBe(false);
    expect(await exists(path.join(root, ".assay", "analyses"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "references", "sample", "source.yaml"))).toBe(
      true,
    );
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.path === ".assay/references" && row.status === "ok")).toBe(
      true,
    );
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
  });

  it("records the attached workspace in the project registry unless tracking is disabled", async () => {
    const registryRoot = path.join(await tempDir(), "registry");
    const previousRegistryRoot = process.env.ASSAY_PROJECT_REGISTRY_ROOT;

    try {
      process.env.ASSAY_PROJECT_REGISTRY_ROOT = registryRoot;

      const tracked = await productRepo("tracked-attach");
      await attachExistingRepo({
        root: tracked,
        name: "Tracked Attach",
        privacy: "private",
        now: new Date("2026-07-06T08:00:00"),
      });
      expect(await exists(projectRecordPath(projectIdForPath(tracked), { registryRoot }))).toBe(
        true,
      );

      const untracked = await productRepo("untracked-attach");
      await attachExistingRepo({
        root: untracked,
        name: "Untracked Attach",
        privacy: "private",
        noTrack: true,
        now: new Date("2026-07-06T08:00:00"),
      });
      expect(await exists(projectRecordPath(projectIdForPath(untracked), { registryRoot }))).toBe(
        false,
      );
    } finally {
      if (previousRegistryRoot === undefined) {
        Reflect.deleteProperty(process.env, "ASSAY_PROJECT_REGISTRY_ROOT");
      } else {
        process.env.ASSAY_PROJECT_REGISTRY_ROOT = previousRegistryRoot;
      }
    }
  });

  it("adds references while ignoring common generated directories and appending an event", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(source, "dist"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
    await writeFile(path.join(source, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(
      path.join(source, "node_modules", "pkg", "index.js"),
      "module.exports = {};\n",
      "utf8",
    );
    await writeFile(path.join(source, "dist", "bundle.js"), "bundle\n", "utf8");

    const result = await addReference({
      root,
      source,
      name: "Source Project",
      now: new Date("2026-06-14T10:00:00"),
    });

    expect(result.path).toBe("references/frozen/202606/source-project");
    expect(await exists(path.join(result.absolutePath, "README.md"))).toBe(true);
    expect(await exists(path.join(result.absolutePath, "src", "index.ts"))).toBe(true);
    expect(await exists(path.join(result.absolutePath, "node_modules"))).toBe(false);
    expect(await exists(path.join(result.absolutePath, "dist"))).toBe(false);
    expect(await readFile(path.join(root, result.eventFile), "utf8")).toContain("reference.frozen");
  });

  it("writes a reference.yaml case file recording provenance on freeze", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const result = await addReference({
      root,
      source,
      name: "Source Project",
      now: new Date("2026-06-14T10:00:00"),
    });

    const yamlPath = path.join(result.absolutePath, "reference.yaml");
    expect(await exists(yamlPath)).toBe(true);
    const yaml = await readFile(yamlPath, "utf8");
    expect(yaml).toContain("name: Source Project");
    expect(yaml).toContain("freeze_path: references/frozen/202606/source-project");
    // The removed gate must not come back as a field nothing reads.
    expect(yaml).not.toContain("analyzed:");

    const event = await readFile(path.join(root, result.eventFile), "utf8");
    expect(event).toContain('"reference.frozen"');
    expect(event).not.toContain('"analyzed"');
  });

  it("createAnalysis --forReference pre-fills provenance from reference.yaml", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const ref = await addReference({
      root,
      source,
      name: "Source Project",
      now: new Date("2026-06-14T10:00:00"),
    });

    const analysis = await createAnalysis({
      root,
      title: "Review Source Project",
      forReference: ref.path,
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Reference: Source Project");
    expect(content).toContain("- Freeze path: references/frozen/202606/source-project");
  });

  it("closeAnalysis leaves a bound reference case file untouched", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const ref = await addReference({
      root,
      source,
      name: "Source Project",
      now: new Date("2026-06-14T10:00:00"),
    });
    const yamlPath = path.join(ref.absolutePath, "reference.yaml");
    const before = await readFile(yamlPath, "utf8");
    const analysis = await createAnalysis({
      root,
      title: "Review Source Project",
      forReference: ref.path,
      now: new Date("2026-06-15T10:00:00"),
    });
    await fillAnalysisSections(analysis.absolutePath, {
      key: "- Source Project keeps the useful pattern.",
      adopt: "- Adopt the pattern.",
    });

    const closed = await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-06-16T10:00:00"),
    });

    expect(await readFile(yamlPath, "utf8")).toBe(before);
    const content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Status: applied");
    expect(content).not.toContain("- Source analysis status:");
    expect(await readFile(path.join(root, closed.eventFile), "utf8")).not.toContain(
      "marked_reference_analyzed",
    );
  });

  it("reads a legacy reference.yaml that still carries the removed analyzed flag", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");

    const ref = await addReference({
      root,
      source,
      name: "Legacy Ref",
      now: new Date("2026-06-14T10:00:00"),
    });
    const yamlPath = path.join(ref.absolutePath, "reference.yaml");
    await writeFile(yamlPath, `${await readFile(yamlPath, "utf8")}analyzed: false\n`, "utf8");

    const analysis = await createAnalysis({
      root,
      title: "Review Legacy Ref",
      forReference: ref.path,
      now: new Date("2026-06-15T10:00:00"),
    });
    const content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Reference: Legacy Ref");
    expect(content).toContain(`- Freeze path: ${ref.path}`);

    const check = await checkFramework({ root, includeAdvisories: true });
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.message?.includes("analyzed"))).toBe(false);
  });

  it("reports a frozen reference with no case file and names the backfill command", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const legacyPath = "references/frozen/202512/hand-frozen";
    await mkdir(path.join(root, legacyPath), { recursive: true });
    await writeFile(path.join(root, legacyPath, "README.md"), "# Hand frozen\n", "utf8");

    const check = await checkFramework({ root, includeAdvisories: true });
    const row = check.rows.find((candidate) => candidate.path === legacyPath);
    expect(row?.status).toBe("warning");
    expect(row?.message).toContain(`assay reference backfill ${legacyPath}`);
    // Advisories never fail the check.
    expect(check.ok).toBe(true);

    const backfilled = await backfillReferenceCaseFile({ root, path: legacyPath });
    expect(backfilled.created).toBe(true);
    const yaml = await readFile(path.join(root, backfilled.referenceFile), "utf8");
    expect(yaml).toContain("name: hand-frozen");
    expect(yaml).toContain(`freeze_path: ${legacyPath}`);

    const after = await checkFramework({ root, includeAdvisories: true });
    expect(after.rows.some((candidate) => candidate.path === legacyPath)).toBe(false);
    // Re-running never overwrites recorded provenance.
    expect((await backfillReferenceCaseFile({ root, path: legacyPath })).created).toBe(false);
  });

  it("absorbReference freezes, opens a bound analysis, and pre-fills it", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "README.md"),
      "# Source Project\n\nA short description of the source.\n",
      "utf8",
    );
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "index.ts"), "export {};\n", "utf8");

    const result = await absorbReference({
      root,
      source,
      name: "Source Project",
      now: new Date("2026-06-14T10:00:00"),
    });

    // Reference frozen with a case file.
    expect(result.referencePath).toBe("references/frozen/202606/source-project");
    const yaml = await readFile(path.join(root, result.referencePath, "reference.yaml"), "utf8");
    expect(yaml).toContain("freeze_path: references/frozen/202606/source-project");

    // An analysis was opened and bound.
    expect(result.analysisPath).toBe("analyses/references/2026-06-14-absorb-source-project.md");
    const analysis = await readFile(path.join(root, result.analysisPath), "utf8");
    expect(analysis).toContain("- Freeze path: references/frozen/202606/source-project");

    // The analysis is pre-filled with a README lead and a top-level layout.
    expect(analysis).toContain("## Architecture / structure");
    expect(analysis).toContain("A short description of the source.");
    expect(analysis).toContain("src/");
    expect(analysis).toContain("README.md");

    // The freeze wrote a case file, so no provenance advisory fires for it.
    const check = await checkFramework({ root, includeAdvisories: true });
    expect(
      check.rows.some(
        (row) => row.path === result.referencePath && row.message?.includes("no reference.yaml"),
      ),
    ).toBe(false);
  });

  it("absorbReference rejects a file source (expects a directory)", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source.txt");
    await initFramework({ target: root, name: "Demo" });
    await writeFile(source, "not a dir\n", "utf8");

    await expect(
      absorbReference({ root, source, now: new Date("2026-06-14T10:00:00") }),
    ).rejects.toThrow(/directory source/);
  });

  it("init writes the mode declared by each built-in archetype yaml", async () => {
    const expectedModes = {
      study: "learning",
      solve: "absorption",
      explore: "absorption",
    } as const;

    for (const archetype of USER_FACING_BUILT_INS) {
      const root = path.join(await tempDir(), `${archetype}-mode`);
      await initFramework({ target: root, name: `${archetype} Project`, archetype });

      expect(await exists(path.join(root, ".assay", "config.yaml"))).toBe(false);
      expect((await loadManifest(root))?.project).toMatchObject({
        archetype,
        mode: expectedModes[archetype],
      });
      expect(await readFrameworkMode(root)).toBe(expectedModes[archetype]);
    }
  });

  it("absorbReference routes to problem/ (not references/frozen/) in absorption mode", async () => {
    const root = path.join(await tempDir(), "absorb-mode-ws");
    const source = path.join(await tempDir(), "absorb-src");
    await initFramework({ target: root, name: "AbsorbProj", archetype: "solve" });
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "README.md"),
      "# Real Project\n\nThe project itself.\n",
      "utf8",
    );
    await mkdir(path.join(source, "src"), { recursive: true });

    const result = await absorbReference({
      root,
      source,
      name: "Real Project",
      now: new Date("2026-06-14T10:00:00"),
    });

    // Landed under problem/, not references/frozen/.
    expect(result.referencePath).toBe("problem/real-project");
    expect(await exists(path.join(root, "problem", "real-project", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "problem", "real-project", "source.yaml"))).toBe(true);
    expect(await exists(path.join(root, "references", "frozen", "202606", "real-project"))).toBe(
      false,
    );

    // No reference.yaml (it is not a reference), but an analysis was opened.
    expect(await exists(path.join(root, "problem", "real-project", "reference.yaml"))).toBe(false);
    expect(result.analysisPath).toBe("analyses/references/2026-06-14-absorb-real-project.md");

    // The analysis is pre-filled with the README lead.
    const analysis = await readFile(path.join(root, result.analysisPath), "utf8");
    expect(analysis).toContain("The project itself.");
    expect(analysis).toContain("src/");
  });

  it("absorbReference can route absorption mode to intake/ explicitly", async () => {
    const root = path.join(await tempDir(), "absorb-intake-ws");
    const source = path.join(await tempDir(), "intake-src");
    await initFramework({ target: root, name: "AbsorbIntake", archetype: "solve" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Candidate\n\nNeeds triage.\n", "utf8");

    const result = await absorbReference({
      root,
      source,
      name: "Candidate Source",
      outlet: "intake",
      now: new Date("2026-06-14T10:00:00"),
    });

    expect(result.referencePath).toBe("intake/candidate-source");
    expect(await exists(path.join(root, "intake", "candidate-source", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intake", "candidate-source", "source.yaml"))).toBe(true);
    expect(await exists(path.join(root, "problem", "candidate-source"))).toBe(false);
    expect(
      await exists(path.join(root, "references", "frozen", "202606", "candidate-source")),
    ).toBe(false);

    const sourceYaml = await readFile(
      path.join(root, "intake", "candidate-source", "source.yaml"),
      "utf8",
    );
    expect(sourceYaml).toContain("absorb_path: intake/candidate-source");
  });

  it("a bare archetype scaffolds only systems/knowledge, no references or analyses", async () => {
    const root = path.join(await tempDir(), "bare-archetype");
    await writeBareArchetype(root);
    await initFramework({ target: root, name: "BareProj", archetype: BARE_ARCHETYPE });

    // Core dirs present
    expect(await exists(path.join(root, "systems"))).toBe(true);
    expect(await exists(path.join(root, "knowledge"))).toBe(true);

    // Governance dirs absent — a bare archetype does not scaffold them
    expect(await exists(path.join(root, "data"))).toBe(false);
    expect(await exists(path.join(root, "references"))).toBe(false);
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "iterations"))).toBe(false);
    expect(await exists(path.join(root, "knowledge", "decisions", "ADR-TEMPLATE.md"))).toBe(false);
    expect(await exists(path.join(root, ".assay", "adrs.json"))).toBe(false);
    expect(await exists(path.join(root, "releases"))).toBe(false);

    // Manifest records the archetype.
    expect(await exists(path.join(root, ".assay", "config.yaml"))).toBe(false);
    expect((await loadManifest(root))?.project.archetype).toBe(BARE_ARCHETYPE);
    expect(await readInstalledArchetype(root)).toBe(BARE_ARCHETYPE);
  });

  it("solve archetype scaffolds problem/ + intake/benchmarks/attempts + tools/iterations", async () => {
    const root = path.join(await tempDir(), "solve-archetype");
    await initFramework({ target: root, name: "ConProj", archetype: "solve" });

    // Core solve dirs
    expect(await exists(path.join(root, "problem"))).toBe(true);
    expect(await exists(path.join(root, "systems"))).toBe(true);
    expect(await exists(path.join(root, "data"))).toBe(false);

    // Three immutable-object layers for objective-driven work.
    expect(await exists(path.join(root, "intake"))).toBe(true);
    expect(await exists(path.join(root, "benchmarks"))).toBe(true);
    expect(await exists(path.join(root, "attempts"))).toBe(true);

    // Iteration and tooling support are part of solve workspaces.
    expect(await exists(path.join(root, "iterations"))).toBe(true);
    expect(await exists(path.join(root, "iterations", "templates"))).toBe(true);
    expect(await exists(path.join(root, "tools"))).toBe(true);

    // Solve does not inherit study analyses or frozen-reference outlets.
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "references"))).toBe(false);
    expect(await exists(path.join(root, ".assay", ["hand", "offs"].join("")))).toBe(false);

    // Mode + archetype are manifest-owned.
    expect(await exists(path.join(root, ".assay", "config.yaml"))).toBe(false);
    expect((await loadManifest(root))?.project).toMatchObject({
      archetype: "solve",
      mode: "absorption",
    });
  });

  it("solve archetype writes objective and current attempt metadata", async () => {
    const root = path.join(await tempDir(), "solve-objective");
    await initFramework({ target: root, name: "Solve Demo", archetype: "solve" });

    const objective = JSON.parse(await readFile(path.join(root, "objective.json"), "utf8"));
    expect(objective.kind).toBe("objective");
    expect(objective.objective_id).toBe("solve-demo");
    expect(objective.current_attempt_path).toBe("systems/current.json");
    expect(objective.success_criteria).toEqual([]);

    const currentAttempt = JSON.parse(
      await readFile(path.join(root, "systems", "current.json"), "utf8"),
    );
    expect(currentAttempt.kind).toBe("current_attempt");
    expect(currentAttempt.attempts).toEqual([]);
    expect(currentAttempt).not.toHaveProperty("questions");
    expect(currentAttempt).not.toHaveProperty("q1");
    expect(currentAttempt).not.toHaveProperty("q2");
    expect(currentAttempt.schema_version).toBe(1);

    // Assay ships no runs.jsonl: the observed fill rate of the template file
    // was zero. The append convention is documented instead, so a harness that
    // wants a run log knows the shape without a command to remember.
    expect(await exists(path.join(root, "runs.jsonl"))).toBe(false);
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("## Run records");
    expect(readme).toContain("one JSON object per line");
    expect(readme).toContain("runs.jsonl");

    const toolsReadme = await readFile(path.join(root, "tools", "README.md"), "utf8");
    expect(toolsReadme).toContain("tools/evaluate/");
  });

  it("counts an externally appended runs.jsonl in status", async () => {
    const root = path.join(await tempDir(), "solve-runs");
    await initFramework({ target: root, name: "Solve Runs", archetype: "solve" });

    expect((await getFrameworkStatus({ root })).runRecords).toBeUndefined();

    await writeFile(
      path.join(root, "runs.jsonl"),
      '{"run_id":"a","score":0.1}\n{"run_id":"b","score":0.2}\n\n',
      "utf8",
    );

    expect((await getFrameworkStatus({ root })).runRecords).toBe(2);
  });

  it("explore archetype creates compare-and-converge structure and passes check", async () => {
    const root = path.join(await tempDir(), "explore-archetype");
    await initFramework({ target: root, name: "Explore Project", archetype: "explore" });

    for (const directory of [
      "systems",
      "knowledge",
      "approaches",
      "trials",
      "iterations",
      path.join("iterations", "templates"),
    ]) {
      expect(await exists(path.join(root, directory))).toBe(true);
    }
    expect(await exists(path.join(root, "comparison.md"))).toBe(true);
    expect(await exists(path.join(root, "problem"))).toBe(false);
    expect(await exists(path.join(root, "candidates"))).toBe(false);
    expect(await exists(path.join(root, "scorecards"))).toBe(false);

    const approaches = await readFile(path.join(root, "approaches", "README.md"), "utf8");
    const comparison = await readFile(path.join(root, "comparison.md"), "utf8");
    expect(approaches).toContain("Parallel local approaches");
    expect(comparison).toContain("horse-race");
    expect(comparison).toContain("Convergence decision");
    expect(`${approaches}\n${comparison}`).not.toMatch(
      new RegExp(
        [["con", "test"].join(""), "selection", "scorecards", "single goal"].join("|"),
        "i",
      ),
    );

    expect((await loadManifest(root))?.project).toMatchObject({
      archetype: "explore",
      mode: "absorption",
    });
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("creates deterministic analysis and iteration artifacts for a supplied date", async () => {
    const root = path.join(await tempDir(), "demo");
    const iterationRoot = path.join(await tempDir(), "demo-iteration");
    const now = new Date("2026-06-14T10:00:00");
    await initFramework({ target: root, name: "Demo" });
    await initFramework({ target: iterationRoot, name: "Demo Iteration", archetype: "solve" });

    const analysis = await createAnalysis({ root, title: "Review Source", now });
    const iteration = await startIteration({ root: iterationRoot, title: "Try Pattern", now });

    expect(analysis.path).toBe("analyses/references/2026-06-14-review-source.md");
    expect(await readFile(analysis.absolutePath, "utf8")).toContain("# Review Source");
    expect(iteration.path).toBe("iterations/2026-06-14-try-pattern");
    expect(iteration.planPath).toBe("iterations/2026-06-14-try-pattern/plan.md");
    expect(await readFile(path.join(iterationRoot, iteration.planPath), "utf8")).toContain(
      "# Try Pattern",
    );
  });

  it("gates iteration operations by archetype capability modules", async () => {
    const studyRoot = path.join(await tempDir(), "study-iteration-disabled");
    const bareRoot = path.join(await tempDir(), "bare-iteration-disabled");
    const solveRoot = path.join(await tempDir(), "solve-iteration-enabled");
    const exploreRoot = path.join(await tempDir(), "explore-iteration-enabled");
    await initFramework({ target: studyRoot, name: "Study" });
    await writeBareArchetype(bareRoot);
    await initFramework({ target: bareRoot, name: "Bare", archetype: BARE_ARCHETYPE });
    await initFramework({ target: solveRoot, name: "Solve", archetype: "solve" });
    await initFramework({ target: exploreRoot, name: "Explore", archetype: "explore" });

    await expect(startIteration({ root: studyRoot, title: "Try Pattern" })).rejects.toThrow(
      /capability not enabled in archetype study: iteration/,
    );
    await expect(startIteration({ root: bareRoot, title: "Try Pattern" })).rejects.toThrow(
      `capability not enabled in archetype ${BARE_ARCHETYPE}: iteration`,
    );

    const started = await startIteration({ root: solveRoot, title: "Try Pattern" });
    const exploreIteration = await startIteration({ root: exploreRoot, title: "Try Pattern" });
    await expect(
      closeIteration({ root: studyRoot, selector: started.path, result: "rejected" }),
    ).rejects.toThrow(/capability not enabled in archetype study: iteration/);
    await expect(
      closeIteration({ root: solveRoot, selector: started.path, result: "applied" }),
    ).resolves.toMatchObject({ path: started.path });
    expect(exploreIteration.path).toContain("iterations/");
  });

  it("keeps event scaffolding disabled while event capture remains core behavior", async () => {
    for (const archetype of USER_FACING_BUILT_INS) {
      const root = path.join(await tempDir(), `${archetype}-events-default-off`);
      const result = await initFramework({
        target: root,
        name: `${archetype} Events`,
        archetype,
      });

      expect(result.report.created_dirs).not.toContain(".assay/events");
      expect(result.report.created_files).not.toContain(".assay/events/.gitkeep");
      expect(await exists(path.join(root, ".assay", "events", ".gitkeep"))).toBe(false);

      const eventFiles = (await readdir(path.join(root, ".assay", "events"))).filter((file) =>
        file.endsWith(".jsonl"),
      );
      expect(eventFiles.length).toBeGreaterThan(0);
      const firstEventFile = eventFiles[0];
      if (!firstEventFile) {
        throw new Error("expected init audit event file");
      }
      const initAudit = await readFile(path.join(root, ".assay", "events", firstEventFile), "utf8");
      expect(initAudit).toContain('"event":"framework.initialized"');

      const captured = await captureEvent({
        root,
        kind: "note",
        text: "Captured from test",
        now: new Date("2026-06-14T10:00:00"),
      });
      expect(captured.eventFile).toBe(".assay/events/2026-06.jsonl");
      expect(await readFile(path.join(root, captured.eventFile), "utf8")).toContain(
        '"event":"capture.created"',
      );
    }
  });

  it("allows explicit event capture while internal audit events still write", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await writeBareArchetype(root);
    await initFramework({ target: root, name: "Demo", archetype: BARE_ARCHETYPE });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nUseful material.\n", "utf8");

    const captured = await captureEvent({
      root,
      kind: "note",
      text: "Captured from test",
      now: new Date("2026-06-14T10:00:00"),
    });
    expect(captured.eventFile).toBe(".assay/events/2026-06.jsonl");

    const result = await absorbReference({
      root,
      source,
      name: "Source",
      now: new Date("2026-06-14T10:00:00"),
    });

    const lines = (await readFile(path.join(root, result.eventFile), "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      event: "reference.absorbed",
      name: "Source",
    });
  });

  it("keeps ADR audit append enabled even when event capture is not scaffolded", async () => {
    const root = path.join(await tempDir(), "adr-audit-events");
    await initFramework({ target: root, name: "ADR Audit", archetype: "study" });

    const created = await createAdr(
      root,
      { title: "Record Architecture Decision" },
      { now: new Date("2026-06-14T10:00:00") },
    );

    expect(created.eventFile).toBe(".assay/events/2026-06.jsonl");
    expect(await exists(path.join(root, ".assay", "events", ".gitkeep"))).toBe(false);
    const lines = (await readFile(path.join(root, created.eventFile), "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      event: "adr.created",
      title: "Record Architecture Decision",
    });
  });
});

describe("closeIteration", () => {
  it("closes an open iteration and writes an event", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", archetype: "solve" });
    const started = await startIteration({
      root,
      title: "Test Pattern",
      now: new Date("2026-06-14T10:00:00"),
    });

    const result = await closeIteration({
      root,
      selector: started.path,
      result: "applied",
      note: "works as expected",
      now: new Date("2026-06-15T10:00:00"),
    });

    expect(result.path).toBe(started.path);

    const planContent = await readFile(path.join(root, started.planPath), "utf8");
    expect(planContent).toContain("Status: closed");
    expect(planContent).toContain("applied on 2026-06-15");
    expect(planContent).toContain("works as expected");

    // Verify the open-iteration count drops to 0
    const status = await getFrameworkStatus({ root });
    expect(status.openIterations).toBe(0);
  });

  it("throws NotFound for unknown iteration selector", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", archetype: "solve" });

    await expect(
      closeIteration({ root, selector: "nonexistent", result: "rejected" }),
    ).rejects.toThrow();
  });
});

describe("closeAnalysis", () => {
  it("records an explicit close without mechanically gating analysis content", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAnalysis({
      root,
      title: "Empty Review",
      now: new Date("2026-06-14T10:00:00"),
    });

    const result = await closeAnalysis({
      root,
      path: created.path,
      exit: "adopt",
      now: new Date("2026-06-15T10:00:00"),
    });

    expect(result.path).toBe(created.path);
    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("Status: applied");
    expect(content).toContain("[x] adopt");
  });

  it("closes an analysis with an adopt exit", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAnalysis({
      root,
      title: "Review Source",
      now: new Date("2026-06-14T10:00:00"),
    });
    await fillAnalysisSections(created.absolutePath, {
      key: "- Source exposes a useful review pattern.",
      adopt: "- Adopt the review pattern.",
    });

    const result = await closeAnalysis({
      root,
      path: created.path,
      exit: "adopt",
      note: "good pattern",
      now: new Date("2026-06-15T10:00:00"),
    });

    expect(result.path).toBe(created.path);

    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("Status: applied");
    expect(content).toContain("[x] adopt");
  });

  it("checks the ADR checkbox for adr exit", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAnalysis({
      root,
      title: "ADR Candidate",
      now: new Date("2026-06-14T10:00:00"),
    });
    await fillAnalysisSections(created.absolutePath, {
      key: "- The decision should become an ADR.",
    });

    await closeAnalysis({
      root,
      path: created.path,
      exit: "adr",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("[x] ADR");
  });

  it("closes a living source observation through a bound analysis", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");
    await addSource({
      root,
      source,
      alias: "Source",
      now: new Date("2026-07-01T08:00:00"),
    });

    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");
    const synced = await syncSource({
      root,
      alias: "source",
      changeClass: "major",
      now: new Date("2026-07-01T09:00:00"),
    });
    expect(synced.observation).not.toBeNull();

    const analysis = await createAnalysis({
      root,
      title: "Revalidate Source",
      forSource: "source",
      now: new Date("2026-07-01T10:00:00"),
    });
    let content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Source alias: source");
    expect(content).toContain(`- Source observation: ${synced.observation?.observation_id}`);
    expect(content).toContain("- Source change class: major");

    const before = await checkFramework({ root, includeAdvisories: true });
    expect(before.rows.some((row) => row.message?.includes("needs revalidation analysis"))).toBe(
      true,
    );

    await fillAnalysisSections(analysis.absolutePath, {
      key: "- The major source change was reviewed.",
      adopt: "- Adopt the updated source assumptions.",
    });
    await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-07-01T11:00:00"),
    });

    const observationPath = path.join(
      root,
      "references",
      "source",
      "observations",
      `${synced.observation?.observation_id}.yaml`,
    );
    content = await readFile(observationPath, "utf8");
    expect(content).toContain("analysis_status: closed");
    expect(content).toContain(`analysis_path: ${analysis.path}`);
    expect(content).toContain("analysis_exit: adopt");
    const closedObservation = content;

    content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Source analysis status: closed");
    expect(content).not.toContain("- Source analysis status: open");

    await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-07-01T12:00:00"),
    });
    content = await readFile(analysis.absolutePath, "utf8");
    expect(content.match(/^- Source analysis status: closed$/gm)).toHaveLength(1);
    expect(await readFile(observationPath, "utf8")).toBe(closedObservation);

    const after = await checkFramework({ root, includeAdvisories: true });
    expect(after.rows.some((row) => row.message?.includes("needs revalidation analysis"))).toBe(
      false,
    );
  });

  it("does not mark a source-bound analysis closed when source closure fails", async () => {
    const root = path.join(await tempDir(), "demo");
    const source = path.join(await tempDir(), "source");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv1\n", "utf8");
    const added = await addSource({
      root,
      source,
      alias: "source",
      now: new Date("2026-07-01T08:00:00"),
    });
    const analysis = await createAnalysis({
      root,
      title: "Review Source",
      forSource: "source",
      now: new Date("2026-07-01T09:00:00"),
    });
    await rm(path.join(root, added.observationFile));

    await expect(
      closeAnalysis({
        root,
        path: analysis.path,
        exit: "adopt",
        now: new Date("2026-07-01T10:00:00"),
      }),
    ).rejects.toThrow("source observation not found");

    const content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Status: draft");
    expect(content).toContain("- Source analysis status: open");
    expect(content).not.toContain("- Source analysis status: closed");
  });
});

describe("addKnowledge", () => {
  it("creates a knowledge entry with back-references", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    const result = await addKnowledge({
      root,
      type: "pattern",
      title: "Config-Driven Design",
      fromAnalysis: "analyses/references/2026-06-14-review-source.md",
      fromIteration: "iterations/2026-06-14-try-pattern",
      now: new Date("2026-06-15T10:00:00"),
    });

    expect(result.path).toBe("knowledge/patterns/2026-06-15-config-driven-design.md");
    const content = await readFile(path.join(root, result.path), "utf8");
    expect(content).toContain("# Config-Driven Design");
    expect(content).toContain("Type: pattern");
    expect(content).toContain("from analysis: analyses/references/2026-06-14-review-source.md");
    expect(content).toContain("from iteration: iterations/2026-06-14-try-pattern");

    // Status should reflect the new knowledge entry
    const status = await getFrameworkStatus({ root });
    expect(status.knowledgeEntries).toBe(1);
  });

  it("rejects duplicate knowledge entries", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    await addKnowledge({
      root,
      type: "guide",
      title: "Setup Guide",
      now: new Date("2026-06-15T10:00:00"),
    });

    await expect(
      addKnowledge({
        root,
        type: "guide",
        title: "Setup Guide",
        now: new Date("2026-06-15T10:00:00"),
      }),
    ).rejects.toThrow();
  });

  it("writes troubleshooting entries to knowledge/troubleshooting/ (not troubleshootings/)", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    const result = await addKnowledge({
      root,
      type: "troubleshooting",
      title: "OpenBLAS thread limiter noise",
      now: new Date("2026-06-15T10:00:00"),
    });

    // The directory must match the template/constants name, not a naive plural.
    expect(result.path).toBe(
      "knowledge/troubleshooting/2026-06-15-openblas-thread-limiter-noise.md",
    );
    expect(result.path).not.toContain("troubleshootings");
  });
});
