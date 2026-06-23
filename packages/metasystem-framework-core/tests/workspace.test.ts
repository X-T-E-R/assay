import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILE,
  absorbReference,
  acceptAdr,
  addKnowledge,
  addReference,
  captureEvent,
  checkFramework,
  closeAnalysis,
  closeIteration,
  createAdr,
  createAnalysis,
  desiredTemplates,
  dirsForMode,
  getFrameworkStatus,
  initFramework,
  loadAdrIndex,
  loadManifest,
  loadProfile,
  loadSystemsRegistry,
  readFrameworkMode,
  registerSystem,
  saveAdrIndex,
  saveSystemsRegistry,
  startIteration,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-core-workspace-"));
  tempRoots.push(root);
  return root;
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desiredTemplates", () => {
  it("returns deterministic template paths and ids from the registry", async () => {
    const first = await desiredTemplates("Demo", "demo-core");
    const second = await desiredTemplates("Demo", "demo-core");

    expect(second).toEqual(first);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      ".framework/VERSION",
      "framework.version",
    ]);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      "systems/demo-core/system.yaml",
      "system.core.contract",
    ]);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      "knowledge/decisions/ADR-TEMPLATE.md",
      "knowledge.decisions.adr_template",
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
  it("creates .framework version, manifest, primary directories, and managed records", async () => {
    const root = path.join(await tempDir(), "demo");
    const result = await initFramework({ target: root, name: "Demo" });

    expect(result.project).toBe("Demo");
    expect(result.core).toBe("demo-core");
    expect(await exists(path.join(root, ".framework", "VERSION"))).toBe(true);
    expect(await exists(path.join(root, MANIFEST_FILE))).toBe(true);
    const profile = await loadProfile("metasystem");
    for (const directory of dirsForMode(profile, "learning")) {
      expect(await exists(path.join(root, directory))).toBe(true);
    }
    expect(await exists(path.join(root, "systems", "demo-core", "system.yaml"))).toBe(true);
    expect(await exists(path.join(root, "systems", "demo-core", "docs"))).toBe(false);
    expect(await exists(path.join(root, "knowledge", "decisions", "ADR-TEMPLATE.md"))).toBe(true);

    const manifest = await loadManifest(root);
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest?.managed_files ?? {})).toContain(".framework/VERSION");
    expect(Object.keys(manifest?.managed_files ?? {})).toHaveLength(
      (await desiredTemplates("Demo", "demo-core")).length,
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
    expect(
      passing.rows.some((row) => row.path === ".framework/VERSION" && row.status === "ok"),
    ).toBe(true);

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
    await writeFile(path.join(root, "knowledge", "guides", "extra.md"), "# Extra\n", "utf8");

    const status = await getFrameworkStatus({ root });

    expect(status).toMatchObject({
      hasManifest: true,
      project: "Demo",
      core: "demo-core",
      managedFiles: (await desiredTemplates("Demo", "demo-core")).length,
    });
    expect(status.zones.find((zone) => zone.path === "knowledge")?.files).toBeGreaterThan(0);
  });
});

describe("checkFramework semantic validation", () => {
  it("reports error when a managed file is missing from disk", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // Delete a managed file
    await rm(path.join(root, "systems", "demo-core", "system.yaml"), { force: true });

    const result = await checkFramework({ root });

    expect(result.ok).toBe(false);
    expect(
      result.rows.some(
        (row) =>
          row.path === "systems/demo-core/system.yaml" &&
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
          row.path === ".framework/systems-registry.json" &&
          row.status === "error" &&
          row.message?.includes("exactly one primary"),
      ),
    ).toBe(true);
  });

  it("reports warning for open iterations", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await startIteration({ root, title: "Open Iteration" });

    const result = await checkFramework({ root });

    // warning doesn't fail check
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

  it("warns on a frozen reference that no analysis cites", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    // Freeze a reference directory with no analysis mentioning it.
    await mkdir(path.join(root, "references", "frozen", "202606", "lonely-ref"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "references", "frozen", "202606", "lonely-ref", "README.md"),
      "# lonely\n",
      "utf8",
    );

    const result = await checkFramework({ root });

    expect(
      result.rows.some(
        (row) =>
          row.path === "references/frozen/202606/lonely-ref" &&
          row.status === "warning" &&
          row.message?.includes("no analysis citing"),
      ),
    ).toBe(true);
  });

  it("does not warn on a frozen reference that an analysis cites", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    await mkdir(path.join(root, "references", "frozen", "202606", "cited-ref"), {
      recursive: true,
    });
    // An analysis that mentions the reference name.
    await writeFile(
      path.join(root, "analyses", "references", "2026-06-20-cited-ref.md"),
      "# Cited ref\n\n- Status: applied\n\n## Reference\n\ncited-ref\n\n## Key observations\n\nsomething\n",
      "utf8",
    );

    const result = await checkFramework({ root });

    expect(
      result.rows.some(
        (row) =>
          row.path === "references/frozen/202606/cited-ref" &&
          row.status === "warning" &&
          row.message?.includes("no analysis citing"),
      ),
    ).toBe(false);
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

    const result = await checkFramework({ root });

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

    const result = await checkFramework({ root });

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
      path.join(root, ".framework", "queue.json"),
      JSON.stringify([
        { id: "r1", status: "pending", summary: "Analyze ref A" },
        { id: "r2", status: "done", summary: "Analyze ref B" },
        { id: "r3", status: "pending", summary: "Analyze ref C" },
      ]),
      "utf8",
    );

    const result = await checkFramework({ root });

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
    await initFramework({ target: root, name: "Demo" });
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
});

describe("workspace operations", () => {
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

  it("writes a reference.yaml case file with analyzed: false on freeze", async () => {
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
    expect(yaml).toContain("analyzed: false");
    expect(yaml).toContain("freeze_path: references/frozen/202606/source-project");

    // The freeze event should record analysis_required.
    const event = await readFile(path.join(root, result.eventFile), "utf8");
    expect(event).toContain('"analysis_required":true');
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

  it("closeAnalysis flips the bound reference.yaml analyzed flag to true", async () => {
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

    await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-06-16T10:00:00"),
    });

    const yaml = await readFile(path.join(ref.absolutePath, "reference.yaml"), "utf8");
    expect(yaml).toContain("analyzed: true");

    // check should no longer warn about this reference being unanalyzed.
    const check = await checkFramework({ root });
    expect(
      check.rows.some(
        (row) =>
          row.path === ref.path &&
          row.status === "warning" &&
          row.message?.includes("no analysis citing"),
      ),
    ).toBe(false);
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
    expect(yaml).toContain("analyzed: false");

    // An analysis was opened and bound.
    expect(result.analysisPath).toBe("analyses/references/2026-06-14-absorb-source-project.md");
    const analysis = await readFile(path.join(root, result.analysisPath), "utf8");
    expect(analysis).toContain("- Freeze path: references/frozen/202606/source-project");

    // The analysis is pre-filled with a README lead and a top-level layout.
    expect(analysis).toContain("## Architecture / structure");
    expect(analysis).toContain("A short description of the source.");
    expect(analysis).toContain("src/");
    expect(analysis).toContain("README.md");

    // Status is draft (open work), so check flags it as an open analysis — not
    // silently "done". The reference is unanalyzed until the analysis closes.
    const check = await checkFramework({ root });
    expect(
      check.rows.some(
        (row) =>
          row.path === result.referencePath &&
          row.status === "warning" &&
          row.message?.includes("no analysis citing"),
      ),
    ).toBe(false); // cited by its own bound analysis
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

  it("init with absorption mode writes mode to config.yaml and readFrameworkMode reads it", async () => {
    const root = path.join(await tempDir(), "absorb-mode");
    await initFramework({ target: root, name: "AbsorbProj", mode: "absorption" });

    const config = await readFile(path.join(root, ".framework", "config.yaml"), "utf8");
    expect(config).toContain("mode: absorption");

    expect(await readFrameworkMode(root)).toBe("absorption");

    // A default (learning) workspace reads back as learning.
    const learningRoot = path.join(await tempDir(), "learning-mode");
    await initFramework({ target: learningRoot, name: "LearnProj" });
    expect(await readFrameworkMode(learningRoot)).toBe("learning");
  });

  it("absorbReference routes to problem/ (not references/frozen/) in absorption mode", async () => {
    const root = path.join(await tempDir(), "absorb-mode-ws");
    const source = path.join(await tempDir(), "absorb-src");
    await initFramework({ target: root, name: "AbsorbProj", mode: "absorption" });
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

  it("library profile scaffolds only systems/knowledge/data, no references or analyses", async () => {
    const root = path.join(await tempDir(), "lib-profile");
    await initFramework({ target: root, name: "LibProj", profile: "library" });

    // Core dirs present
    expect(await exists(path.join(root, "systems"))).toBe(true);
    expect(await exists(path.join(root, "knowledge"))).toBe(true);
    expect(await exists(path.join(root, "data"))).toBe(true);

    // Governance dirs absent — library profile does not scaffold them
    expect(await exists(path.join(root, "references"))).toBe(false);
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    expect(await exists(path.join(root, "iterations"))).toBe(false);
    expect(await exists(path.join(root, "releases"))).toBe(false);

    // config records the profile
    const config = await readFile(path.join(root, ".framework", "config.yaml"), "utf8");
    expect(config).toContain("profile: library");
  });

  it("contest profile v3 scaffolds problem/ + intake/benchmarks/submissions + tools/iterations/analyses", async () => {
    const root = path.join(await tempDir(), "contest-profile");
    await initFramework({ target: root, name: "ConProj", profile: "contest" });

    // Core contest dirs (v1 + v2)
    expect(await exists(path.join(root, "problem"))).toBe(true);
    expect(await exists(path.join(root, "systems"))).toBe(true);
    expect(await exists(path.join(root, "data"))).toBe(true);

    // Three immutable-object layers (v2 ADR-0006 kept in v3)
    expect(await exists(path.join(root, "intake"))).toBe(true);
    expect(await exists(path.join(root, "benchmarks"))).toBe(true);
    expect(await exists(path.join(root, "submissions"))).toBe(true);

    // v3 restorations (double-sided adaptation against real Huawei3):
    // iterations/ and tools/ were wrongly stripped in v2 — restored here.
    expect(await exists(path.join(root, "iterations"))).toBe(true);
    expect(await exists(path.join(root, "iterations", "templates"))).toBe(true);
    expect(await exists(path.join(root, "tools"))).toBe(true);

    // analyses keeps the default 4-folder split (references/gaps/patterns/templates)
    expect(await exists(path.join(root, "analyses", "references"))).toBe(true);
    expect(await exists(path.join(root, "analyses", "gaps"))).toBe(true);
    expect(await exists(path.join(root, "analyses", "patterns"))).toBe(true);
    expect(await exists(path.join(root, "analyses", "templates"))).toBe(true);

    // references/frozen for third-party side evidence
    expect(await exists(path.join(root, "references", "frozen"))).toBe(true);

    // handoffs becomes a governance-layer location under .framework/
    expect(await exists(path.join(root, ".framework", "handoffs"))).toBe(true);

    // Mode + profile_version
    const config = await readFile(path.join(root, ".framework", "config.yaml"), "utf8");
    expect(config).toContain("mode: absorption");
    expect(config).toContain("profile: contest");
    expect(config).toContain("profile_version: 3");
  });

  it("contest profile v3 selection schema uses generic questions[] list", async () => {
    const root = path.join(await tempDir(), "contest-v3-manifests");
    await initFramework({ target: root, name: "Huawei3 Demo", profile: "contest" });

    // contest.json manifest at root (unchanged from v2)
    const manifest = JSON.parse(await readFile(path.join(root, "contest.json"), "utf8"));
    expect(manifest.kind).toBe("contest");
    expect(manifest.current_selection_path).toBe("systems/current.json");

    // v3 selection: questions[] generic list, not q1/q2 hardcoded fields
    const selection = JSON.parse(
      await readFile(path.join(root, "systems", "current.json"), "utf8"),
    );
    expect(selection.kind).toBe("selection");
    expect(Array.isArray(selection.questions)).toBe(true);
    expect(selection.questions).toEqual([]);
    expect(selection).not.toHaveProperty("q1"); // v2 fields no longer in v3 schema
    expect(selection).not.toHaveProperty("q2");
    expect(selection.schema_version).toBe("v3-1");

    // runs.jsonl + tools/README explain contract
    expect(await readFile(path.join(root, "runs.jsonl"), "utf8")).toBe("");
    const toolsReadme = await readFile(path.join(root, "tools", "README.md"), "utf8");
    expect(toolsReadme).toContain("tools/judge/");
  });

  it("creates deterministic analysis and iteration artifacts for a supplied date", async () => {
    const root = path.join(await tempDir(), "demo");
    const now = new Date("2026-06-14T10:00:00");
    await initFramework({ target: root, name: "Demo" });

    const analysis = await createAnalysis({ root, title: "Review Source", now });
    const iteration = await startIteration({ root, title: "Try Pattern", now });

    expect(analysis.path).toBe("analyses/references/2026-06-14-review-source.md");
    expect(await readFile(analysis.absolutePath, "utf8")).toContain("# Review Source");
    expect(iteration.path).toBe("iterations/2026-06-14-try-pattern");
    expect(iteration.planPath).toBe("iterations/2026-06-14-try-pattern/plan.md");
    expect(await readFile(path.join(root, iteration.planPath), "utf8")).toContain("# Try Pattern");
  });

  it("captures event JSONL entries through the workspace operation", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });

    const result = await captureEvent({
      root,
      kind: "note",
      text: "Captured from test",
      now: new Date("2026-06-14T10:00:00"),
    });

    const lines = (await readFile(path.join(root, result.eventFile), "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      event: "capture.created",
      kind: "note",
      text: "Captured from test",
    });
  });
});

describe("closeIteration", () => {
  it("closes an open iteration and writes an event", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
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
    await initFramework({ target: root, name: "Demo" });

    await expect(
      closeIteration({ root, selector: "nonexistent", result: "rejected" }),
    ).rejects.toThrow();
  });
});

describe("closeAnalysis", () => {
  it("closes an analysis with an adopt exit", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    const created = await createAnalysis({
      root,
      title: "Review Source",
      now: new Date("2026-06-14T10:00:00"),
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

    await closeAnalysis({
      root,
      path: created.path,
      exit: "adr",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("[x] ADR");
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
