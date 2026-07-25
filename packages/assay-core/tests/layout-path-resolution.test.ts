import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrameworkError,
  archiveSystem,
  attachExistingRepo,
  createAdr,
  initFramework,
  loadManifest,
  migrateLayout,
  registerSystem,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-layout-paths");

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

/** Product repository with one tracked file and a committed history. */
async function productRepo(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function overlayWorkspace(
  name: string,
  options: { readonly archetype?: string } = {},
): Promise<string> {
  const root = await productRepo(name);
  await attachExistingRepo({
    root,
    name,
    archetype: options.archetype ?? "study",
    privacy: "private",
    noTrack: true,
    now: new Date("2026-07-06T08:00:00"),
  });
  return root;
}

async function standaloneWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name, archetype: "study" });
  return root;
}

describe("ADR paths resolve through the layout path map", () => {
  it("writes overlay ADRs under .assay and leaves the product repo root clean", async () => {
    const root = await overlayWorkspace("Product");

    const result = await createAdr(
      root,
      { title: "Overlay Decision" },
      { now: new Date("2026-07-06T09:00:00") },
    );

    expect(result.adr.path).toBe(".assay/knowledge/decisions/ADR-0001-overlay-decision.md");
    expect(await exists(path.join(root, ".assay", "knowledge", "decisions"))).toBe(true);
    // The product repo must not gain a top-level knowledge/ directory: it is
    // outside the /.assay/ exclude and would pollute product Git.
    expect(await exists(path.join(root, "knowledge"))).toBe(false);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");

    const content = await readFile(path.join(root, result.adr.path), "utf8");
    expect(content).toContain("adr: ADR-0001-overlay-decision");
  });

  it("keeps standalone ADR paths at knowledge/decisions", async () => {
    const root = await standaloneWorkspace("Standalone");

    const result = await createAdr(
      root,
      { title: "Standalone Decision" },
      { now: new Date("2026-07-06T09:00:00") },
    );

    expect(result.adr.path).toBe("knowledge/decisions/ADR-0001-standalone-decision.md");
    expect(await exists(path.join(root, result.adr.path))).toBe(true);
  });

  it("keeps standalone ADR paths at knowledge/decisions for legacy v3 manifests", async () => {
    const root = await standaloneWorkspace("LegacyStandalone");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.layout_version = 3;
    Reflect.deleteProperty(manifest, "layout");
    await saveManifest(root, manifest);

    const result = await createAdr(
      root,
      { title: "Legacy Decision" },
      { now: new Date("2026-07-06T09:00:00") },
    );

    expect(result.adr.path).toBe("knowledge/decisions/ADR-0001-legacy-decision.md");
  });
});

describe("layout migration preserves the workspace mode", () => {
  it("keeps overlay mode and paths when upgrading an overlay manifest", async () => {
    const root = await overlayWorkspace("MigrateOverlay");

    // Simulate an overlay workspace written by an older build: layout_version
    // below the current one, which is what makes migrate-layout upgrade the
    // manifest.
    const before = await loadManifest(root);
    if (!before?.layout) throw new Error("overlay manifest missing layout");
    before.layout_version = 3;
    await saveManifest(root, before);

    await migrateLayout({ root, apply: true, now: new Date("2026-07-07T09:00:00") });

    const after = await loadManifest(root);
    expect(after?.layout_version).toBe(4);
    expect(after?.layout?.mode).toBe("overlay");
    expect(after?.layout?.work_root).toBe(".assay");
    expect(after?.layout?.privacy).toBe("private");
    expect(after?.layout?.paths.knowledge).toBe(".assay/knowledge");
    expect(after?.layout?.paths.analyses).toBe(".assay/analyses");
    expect(after?.layout?.paths.systems_contracts).toBe(".assay/systems");

    // The migrated workspace must still write into .assay/.
    const adr = await createAdr(
      root,
      { title: "Post Migration Decision" },
      { now: new Date("2026-07-07T10:00:00") },
    );
    expect(adr.adr.path).toBe(".assay/knowledge/decisions/ADR-0001-post-migration-decision.md");
    expect(await exists(path.join(root, "knowledge"))).toBe(false);
  });

  it("defaults a legacy v3 manifest without a layout block to standalone", async () => {
    const root = await standaloneWorkspace("MigrateLegacy");
    const before = await loadManifest(root);
    if (!before) throw new Error("manifest missing");
    before.layout_version = 3;
    Reflect.deleteProperty(before, "layout");
    await saveManifest(root, before);

    await migrateLayout({ root, apply: true, now: new Date("2026-07-07T09:00:00") });

    const after = await loadManifest(root);
    expect(after?.layout_version).toBe(4);
    expect(after?.layout?.mode).toBe("standalone");
    expect(after?.layout?.work_root).toBe(".");
    expect(after?.layout?.paths.knowledge).toBe("knowledge");
  });
});

describe("attach validates the requested archetype", () => {
  it("rejects an unknown archetype before writing workspace state", async () => {
    const root = await productRepo("BogusArchetype");

    await expect(
      attachExistingRepo({
        root,
        archetype: "bogus",
        privacy: "private",
        noTrack: true,
        now: new Date("2026-07-06T08:00:00"),
      }),
    ).rejects.toThrow(FrameworkError);

    expect(await exists(path.join(root, ".assay"))).toBe(false);
    expect(await loadManifest(root)).toBeNull();
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
  });

  it("records the archetype mode for a valid non-default archetype", async () => {
    const root = await overlayWorkspace("SolveOverlay", { archetype: "solve" });
    const manifest = await loadManifest(root);
    expect(manifest?.project.archetype).toBe("solve");
    expect(manifest?.project.mode).toBe("absorption");
  });
});

describe("system archive paths resolve through the layout path map", () => {
  it("archives overlay systems under .assay/systems/archive", async () => {
    const root = await overlayWorkspace("ArchiveOverlay");
    const systemDir = path.join(root, ".assay", "systems", "widget");
    await mkdir(systemDir, { recursive: true });
    await writeFile(path.join(systemDir, "notes.md"), "# Widget\n", "utf8");
    await registerSystem(
      root,
      { name: "widget", path: ".assay/systems/widget" },
      { now: new Date("2026-07-06T09:00:00") },
    );

    const result = await archiveSystem(root, "widget", { now: new Date("2026-07-07T09:00:00") });

    expect(result.system.archive_path).toBe(".assay/systems/archive/2026-07-07-pre-widget/widget");
    expect(await exists(path.join(root, ".assay", "systems", "archive"))).toBe(true);
    expect(await exists(path.join(root, "systems"))).toBe(false);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
  });

  it("keeps standalone archive paths at systems/archive", async () => {
    const root = await standaloneWorkspace("ArchiveStandalone");
    const systemDir = path.join(root, "systems", "widget");
    await mkdir(systemDir, { recursive: true });
    await writeFile(path.join(systemDir, "notes.md"), "# Widget\n", "utf8");
    await registerSystem(
      root,
      { name: "widget", path: "systems/widget" },
      { now: new Date("2026-07-06T09:00:00") },
    );

    const result = await archiveSystem(root, "widget", { now: new Date("2026-07-07T09:00:00") });

    expect(result.system.archive_path).toBe("systems/archive/2026-07-07-pre-widget/widget");
    expect(
      await exists(path.join(root, "systems", "archive", "2026-07-07-pre-widget", "widget")),
    ).toBe(true);
  });
});
