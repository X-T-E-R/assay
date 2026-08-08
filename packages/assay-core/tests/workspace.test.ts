import { createHash } from "node:crypto";
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
  addKnowledge,
  addSource,
  attachExistingRepo,
  captureEvent,
  checkFramework,
  closeAnalysis,
  createAnalysis,
  desiredRuntimeTemplates,
  dirsForArchetype,
  getFrameworkStatus,
  initFramework,
  loadArchetype,
  loadManifest,
  loadSystemsRegistry,
  projectIdForPath,
  projectRecordPath,
  readFrameworkMode,
  readInstalledArchetype,
  registerSystem,
  saveSystemsRegistry,
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

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const target = path.join(directory, entry.name);
      hash.update(path.relative(root, target).replaceAll("\\", "/"));
      if (entry.isDirectory()) await visit(target);
      else hash.update(await readFile(target));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function writeLocalArchetype(
  root: string,
  name: string,
  options: { readonly dirPath?: string; readonly templatePath?: string },
): Promise<void> {
  const file = path.join(root, ".assay", "archetypes", `${name}.yaml`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "extends: base",
      "mode: learning",
      "dirs:",
      `  - ${options.dirPath ?? "work"}`,
      "dirs_learning: []",
      "dirs_absorption: []",
      ...(options.templatePath
        ? [
            "templates:",
            `  - path: ${options.templatePath}`,
            "    templateId: custom.retired.readme",
            '    content: "retired"',
          ]
        : ["templates: []"]),
      "",
    ].join("\n"),
    "utf8",
  );
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
    content = content.replace("## Next step\n\n", `## Next step\n\n${sections.next}\n\n`);
  }
  await writeFile(analysisPath, content, "utf8");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("retired custom archetype paths", () => {
  it("rejects standalone init before its first workspace write", async () => {
    const root = path.join(await tempDir(), "retired-custom-init");
    const archetype = "retired-init";
    const retired = ["itera", "tions"].join("");
    await writeLocalArchetype(root, archetype, { dirPath: `work/../${retired}/history` });
    const before = await treeHash(root);

    await expect(initFramework({ target: root, name: "Retired", archetype })).rejects.toMatchObject(
      { code: "RETIRED_ARCHETYPE_PATH" },
    );

    expect(await treeHash(root)).toBe(before);
    expect(await exists(path.join(root, MANIFEST_FILE))).toBe(false);
  });

  it("rejects overlay attach before changing either product or overlay state", async () => {
    const root = await productRepo("retired-custom-attach");
    const archetype = "retired-attach";
    const retired = ["itera", "tions"].join("");
    await writeLocalArchetype(root, archetype, {
      templatePath: `.assay\\work\\..\\${retired}\\README.md`,
    });
    const before = await treeHash(root);

    await expect(
      attachExistingRepo({ root, name: "Retired", archetype, noTrack: true }),
    ).rejects.toMatchObject({ code: "RETIRED_ARCHETYPE_PATH" });

    expect(await treeHash(root)).toBe(before);
    expect(await exists(path.join(root, MANIFEST_FILE))).toBe(false);
  });

  it("degrades status and check without turning a rejected path into a zone", async () => {
    const root = path.join(await tempDir(), "retired-custom-status");
    const archetype = "retired-status";
    const retired = ["itera", "tions"].join("");
    await writeLocalArchetype(root, archetype, { dirPath: "work" });
    await initFramework({ target: root, name: "Retired status", archetype });
    await writeLocalArchetype(root, archetype, { dirPath: `.assay/${retired}/history` });
    await mkdir(path.join(root, retired, "manual"), { recursive: true });

    const status = await getFrameworkStatus({ root });
    const check = await checkFramework({ root, includeAdvisories: true });

    expect(status.archetypeNotice).toContain("retired archetype path");
    expect(status.zones.some((zone) => zone.path.includes(retired))).toBe(false);
    expect(check.rows).toContainEqual(
      expect.objectContaining({
        path: MANIFEST_FILE,
        status: "warning",
        message: expect.stringContaining("retired archetype path"),
      }),
    );
    expect(check.rows.some((row) => row.path.includes(retired) && row.status === "ok")).toBe(false);
  });
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
      manifestFormat: "schema 3; archetype study; mode learning",
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
      "project",
      "systems",
      "knowledge",
      "sources",
      "analyses",
    ]);
    expect(solve.zones.find((zone) => zone.path === "problem")?.purpose).toBe(
      "Task statement, official rules, scoring definition",
    );
    // Study's directories are dead zones for a solve workspace.
    expect(solve.zones.some((zone) => zone.path === "analyses/references")).toBe(false);

    const studyRoot = path.join(await tempDir(), "study");
    await initFramework({ target: studyRoot, name: "Study" });

    const study = await getFrameworkStatus({ root: studyRoot });
    const studyZones = study.zones.map((zone) => zone.path);

    expect(studyZones).toEqual(
      expect.arrayContaining(["analyses/references", "analyses/patterns", "sources", "knowledge"]),
    );
    expect(studyZones.some((zone) => zone.startsWith("problem"))).toBe(false);
    expect(study.zones.every((zone) => zone.purpose !== "")).toBe(true);
  });

  it("treats a retired work directory as generic undeclared content", async () => {
    const root = path.join(await tempDir(), "retired-work-area");
    await initFramework({ target: root, name: "Current" });
    const retiredName = ["itera", "tions"].join("");
    await mkdir(path.join(root, retiredName, "unreadable-record"), { recursive: true });
    await writeFile(path.join(root, retiredName, "unreadable-record", "plan.md"), "{", "utf8");

    expect(
      (await getFrameworkStatus({ root })).zones.some((zone) => zone.path === retiredName),
    ).toBe(false);
    const result = await checkFramework({ root, includeAdvisories: true });
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        path: retiredName,
        status: "warning",
        message: expect.stringContaining("is not declared by archetype study"),
      }),
    );
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

  it("treats a loose knowledge/decisions directory as undeclared user content", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(root, "knowledge", "decisions"), { recursive: true });
    await writeFile(path.join(root, "knowledge", "decisions", "old.md"), "user bytes", "utf8");

    const result = await checkFramework({ root });

    expect(result.ok).toBe(true);
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        path: "knowledge/decisions",
        status: "warning",
      }),
    );
  });

  it("warns on a draft analysis with empty Key observations", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // A draft analysis whose Key observations section is empty.
    await writeFile(
      path.join(root, "analyses", "references", "2026-06-20-shell.md"),
      "# Shell\n\n- Status: draft\n\n## Source\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Decision exit\n\n- [ ] adopt\n",
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
  it("includes systems and knowledgeEntries", async () => {
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

    const status = await getFrameworkStatus({ root });

    expect(status.systems).toBeDefined();
    expect(status.systems).toHaveLength(1);
    expect(status.systems?.[0]).toMatchObject({
      name: "demo-core",
      status: "primary",
      vcs: "independent-git",
      version: "0.2.0",
    });
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
    expect(status.sources).toEqual({
      total: 1,
      living: 1,
      frozen: 0,
      majorChanges: 0,
    });

    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");
    await syncSource({
      root,
      alias: "source",
      changeClass: "major",
      now: new Date("2026-07-01T09:00:00"),
    });

    status = await getFrameworkStatus({ root });
    expect(status.sources).toMatchObject({
      total: 1,
      living: 1,
      majorChanges: 1,
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
    expect(sourceResult.path).toBe(".assay/sources/sample");
    expect(knowledge.path).toBe(".assay/knowledge/patterns/2026-07-06-overlay-pattern.md");
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "sources"))).toBe(false);
    expect(await exists(path.join(root, "knowledge"))).toBe(false);
    expect(await exists(path.join(root, ".assay", "analyses"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "sources", "sample", "source.yaml"))).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.path === ".assay/sources" && row.status === "ok")).toBe(
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

  it("solve archetype scaffolds problem/ + intake/benchmarks/attempts + tools", async () => {
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

    expect(await exists(path.join(root, ["itera", "tions"].join("")))).toBe(false);
    expect(await exists(path.join(root, "tools"))).toBe(true);

    // Solve does not inherit study analyses or frozen-reference outlets.
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "sources"))).toBe(false);
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

    for (const directory of ["systems", "knowledge", "approaches", "trials"]) {
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

  it("creates a deterministic analysis artifact for a supplied date", async () => {
    const root = path.join(await tempDir(), "demo");
    const now = new Date("2026-06-14T10:00:00");
    await initFramework({ target: root, name: "Demo" });

    const analysis = await createAnalysis({ root, title: "Review Source", now });

    expect(analysis.path).toBe("analyses/references/2026-06-14-review-source.md");
    expect(await readFile(analysis.absolutePath, "utf8")).toContain("# Review Source");
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

  it("keeps a Source observation immutable when a bound Analysis closes", async () => {
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

    const observationPath = path.join(
      root,
      "sources",
      "source",
      "observations",
      `${synced.observation?.observation_id}.yaml`,
    );
    const observationBeforeClose = await readFile(observationPath, "utf8");

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

    expect(await readFile(observationPath, "utf8")).toBe(observationBeforeClose);

    content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Status: applied");
    expect(content).not.toContain("Source analysis status:");

    await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-07-01T12:00:00"),
    });
    content = await readFile(analysis.absolutePath, "utf8");
    expect(await readFile(observationPath, "utf8")).toBe(observationBeforeClose);
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
      now: new Date("2026-06-15T10:00:00"),
    });

    expect(result.path).toBe("knowledge/patterns/2026-06-15-config-driven-design.md");
    const content = await readFile(path.join(root, result.path), "utf8");
    expect(content).toContain("# Config-Driven Design");
    expect(content).toContain("Type: pattern");
    expect(content).toContain("from analysis: analyses/references/2026-06-14-review-source.md");

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
