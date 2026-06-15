import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILE,
  PRIMARY_DIRS,
  addReference,
  captureEvent,
  checkFramework,
  createAnalysis,
  desiredTemplates,
  getFrameworkStatus,
  initFramework,
  loadManifest,
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
  it("returns deterministic template paths and ids from the registry", () => {
    const first = desiredTemplates("Demo", "demo-core");
    const second = desiredTemplates("Demo", "demo-core");

    expect(second).toEqual(first);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      ".framework/VERSION",
      "framework.version",
    ]);
    expect(first.map((template) => [template.path, template.template_id])).toContainEqual([
      "systems/demo-core/docs/update-mechanism.md",
      "system.core.update_mechanism",
    ]);
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
    for (const directory of PRIMARY_DIRS) {
      expect(await exists(path.join(root, directory))).toBe(true);
    }
    expect(await exists(path.join(root, "systems", "demo-core", "docs"))).toBe(true);

    const manifest = await loadManifest(root);
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest?.managed_files ?? {})).toContain(".framework/VERSION");
    expect(Object.keys(manifest?.managed_files ?? {})).toHaveLength(
      desiredTemplates("Demo", "demo-core").length,
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
      managedFiles: desiredTemplates("Demo", "demo-core").length,
    });
    expect(status.zones.find((zone) => zone.path === "knowledge")?.files).toBeGreaterThan(0);
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
