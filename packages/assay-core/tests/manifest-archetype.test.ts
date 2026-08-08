import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidManifestError,
  WorkspaceCutoverRequiredError,
  addKnowledge,
  addSource,
  analyzeUpdate,
  applyUpdate,
  attachExistingRepo,
  convertOverlayToStandalone,
  defaultManifest,
  discoverFrameworkRoot,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  manifestPath,
  saveManifest,
} from "../src/index.js";
import { frameworkProjectSchema } from "../src/schemas/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-manifest-current-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeManifestJson(root: string, manifest: unknown, stateRoot = ".assay") {
  const file = path.join(root, stateRoot, "manifest.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file).replaceAll("\\", "/"));
      if (entry.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function layout4Manifest() {
  const current = defaultManifest("Old workspace") as unknown as Record<string, unknown>;
  current.framework_version = "0.6.0";
  current.minimum_assay_version = "0.6.0";
  current.layout_version = 4;
  const layout = current.layout as Record<string, unknown>;
  layout.version = 4;
  layout.paths = {
    ...(layout.paths as Record<string, unknown>),
    adrs_index: ".assay/adrs.json",
  };
  return current;
}

describe("manifest 0.7 envelope", () => {
  it("writes and loads exactly schema 2 and layout 5", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Current");
    expect(manifest).toMatchObject({
      __schema: 2,
      framework_version: "0.7.0",
      minimum_assay_version: "0.7.0",
      layout_version: 5,
      layout: { version: 5 },
    });
    expect(manifest.layout.paths).not.toHaveProperty("adrs_index");
    await saveManifest(root, manifest);
    await expect(loadManifest(root)).resolves.toMatchObject({ framework_version: "0.7.0" });
  });

  it.each([
    ["healthy", '{"__schema":1,"next_number":2,"adrs":{},"updated_at":"x"}'],
    ["malformed", "{"],
    ["missing", null],
  ])("rejects a layout 4 workspace before reading its retired index (%s)", async (_case, index) => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest());
    if (index !== null) await writeFile(path.join(root, ".assay", "adrs.json"), index, "utf8");
    const before = await treeHash(root);
    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.6.0+s2+l4",
      required: "0.7.0+s2+l5",
      locator: "assay-cutover:0.6.0+s2+l4->0.7.0+s2+l5",
    });
    expect(await treeHash(root)).toBe(before);
  });

  it("rejects .framework through the same non-executable cutover locator", async () => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest(), ".framework");
    await expect(loadManifest(root)).rejects.toBeInstanceOf(WorkspaceCutoverRequiredError);
    await expect(loadManifest(root)).rejects.toMatchObject({
      locator: "assay-cutover:.framework:0.6.0+s2+l4->0.7.0+s2+l5",
    });
  });

  it("reports malformed current JSON precisely without legacy parsing", async () => {
    const root = await tempDir();
    await mkdir(path.dirname(manifestPath(root)), { recursive: true });
    await writeFile(manifestPath(root), "{", "utf8");
    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
  });

  it("keeps current project schema extensible only through current fields", () => {
    expect(frameworkProjectSchema.parse({ name: "Current" })).toEqual({
      name: "Current",
      archetype: "study",
      mode: "learning",
    });
    expect(() => frameworkProjectSchema.parse({ name: "Old", core: "old-core" })).toThrow();
  });

  it.each([
    ["escape", "knowledge", "../outside"],
    ["dot alias", "references", "./references"],
    ["duplicate", "analyses", "references"],
    ["managed escape", "systems_contracts", ".assay/../systems"],
  ])("rejects a non-canonical layout-5 path before use (%s)", async (_case, key, value) => {
    const root = await tempDir();
    const manifest = defaultManifest("Unsafe layout");
    (manifest.layout.paths as Record<string, string>)[key] = value;
    await writeManifestJson(root, manifest);
    const before = await treeHash(root);

    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(root)).toBe(before);
  });

  it("fails knowledge, source, and update before an unsafe layout can write", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Unsafe operations");
    manifest.layout.paths.knowledge = "../outside";
    await writeManifestJson(root, manifest);
    const before = await treeHash(root);

    await expect(addKnowledge({ root, type: "pattern", title: "Blocked" })).rejects.toBeInstanceOf(
      InvalidManifestError,
    );
    await expect(addSource({ root, source: path.join(root, "source") })).rejects.toBeInstanceOf(
      InvalidManifestError,
    );
    await expect(applyUpdate({ root, dryRun: false })).rejects.toBeInstanceOf(InvalidManifestError);
    await expect(analyzeUpdate({ root })).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(root)).toBe(before);
  });

  it("fails conversion before an unsafe overlay layout writes either tree", async () => {
    const container = await tempDir();
    const root = path.join(container, "overlay");
    const target = path.join(container, "target");
    const manifest = defaultManifest("Unsafe overlay");
    manifest.layout = {
      ...manifest.layout,
      mode: "overlay",
      work_root: ".assay",
      privacy: "private",
      paths: {
        ...manifest.layout.paths,
        references: "../outside",
        analyses: ".assay/analyses",
        iterations: ".assay/iterations",
        knowledge: ".assay/knowledge",
        systems_contracts: ".assay/systems",
      },
    };
    await writeManifestJson(root, manifest);
    const before = await treeHash(container);

    await expect(
      convertOverlayToStandalone({ root, target, move: false, keepOverlay: true }),
    ).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(container)).toBe(before);
  });

  it("blocks creation and conversion entries below a retired ancestor without writes", async () => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest(), ".framework");
    const nested = path.join(root, "systems", "nested-product");
    await mkdir(nested, { recursive: true });
    const targetContainer = await tempDir();
    const target = path.join(targetContainer, "converted");
    const beforeRoot = await treeHash(root);
    const beforeTarget = await treeHash(targetContainer);

    const discovered = await discoverFrameworkRoot(nested);
    expect(discovered).toBe(root);
    await expect(getFrameworkStatus({ root: discovered })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
    });
    expect(await treeHash(root)).toBe(beforeRoot);

    for (const operation of [
      () => initFramework({ target: nested, name: "Nested" }),
      () => attachExistingRepo({ root: nested, name: "Nested", noTrack: true }),
      () => applyUpdate({ root: nested, dryRun: true }),
      () => convertOverlayToStandalone({ root: nested, target, move: false }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "WORKSPACE_CUTOVER_REQUIRED" });
      expect(await treeHash(root)).toBe(beforeRoot);
      expect(await treeHash(targetContainer)).toBe(beforeTarget);
    }
  });
});
