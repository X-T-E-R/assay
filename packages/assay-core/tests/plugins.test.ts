import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BARE_ARCHETYPE,
  createTempDirectoryFixture,
  pathExists as exists,
  writeBareArchetype,
} from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PLUGINS_STATE_FILE,
  addCapability,
  addPlugin,
  attachExistingRepo,
  checkFramework,
  checkPlugins,
  convertOverlayToStandalone,
  initFramework,
  isCapabilityEnabled,
  listCapabilities,
  listPlugins,
  loadManifest,
  loadPluginsState,
  nowIso,
  reconcilePlugins,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-plugins");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function standaloneWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype: BARE_ARCHETYPE });
  return root;
}

async function overlayWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await execa("git", ["init"], { cwd: root });
  await execa("git", ["config", "user.email", "assay@example.test"], { cwd: root });
  await execa("git", ["config", "user.name", "Assay Test"], { cwd: root });
  await execa("git", ["add", "package.json"], { cwd: root });
  await execa("git", ["commit", "-m", "initial"], { cwd: root });
  await writeBareArchetype(root);
  await attachExistingRepo({
    root,
    name,
    archetype: BARE_ARCHETYPE,
    privacy: "private",
    noTrack: true,
  });
  return root;
}

async function eventBytes(root: string): Promise<string> {
  const directory = path.join(root, ".assay", "events");
  const files = (await readdir(directory)).sort();
  return (
    await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))
  ).join("");
}

describe("assay.intent plugin", () => {
  it("does not grant a contributed capability from declaration alone", async () => {
    const root = await standaloneWorkspace("DeclaredOnlyIntent");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.plugins = { "assay.intent": { kind: "workspace-module" } };
    await saveManifest(root, manifest);

    expect(await isCapabilityEnabled(root, "intent")).toBe(false);
    expect((await listCapabilities({ root })).capabilities).toContainEqual({
      module: "intent",
      enabled: false,
      source: null,
      supported: true,
    });
  });

  it("declares, scaffolds, receipts, and enables intent without a legacy capability flag", async () => {
    const root = await standaloneWorkspace("PluginIntent");
    const now = new Date("2026-07-28T00:00:00.000Z");
    const timestamp = nowIso(now);

    const result = await addPlugin({
      root,
      plugin: "intent",
      now,
    });

    expect(result.plugin).toBe("assay.intent");
    expect(result.alreadyDeclared).toBe(false);
    expect(result.plugins).toEqual([
      expect.objectContaining({ id: "assay.intent", action: "install" }),
    ]);
    expect(await exists(path.join(root, "intent", "original", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intent", "requirements", "README.md"))).toBe(true);

    const manifest = await loadManifest(root);
    expect(manifest?.plugins).toEqual({
      "assay.intent": { kind: "workspace-module" },
    });
    expect(manifest?.project.capabilities).toBeUndefined();
    expect(Object.keys(manifest?.managed_files ?? {})).toContain("intent/original/README.md");

    expect(await loadPluginsState(root)).toEqual({
      __schema: 1,
      plugins: {
        "assay.intent": {
          kind: "workspace-module",
          state_version: 1,
          installed_at: timestamp,
          updated_at: timestamp,
        },
      },
      updated_at: timestamp,
    });
    expect(await isCapabilityEnabled(root, "intent")).toBe(true);
    expect((await listCapabilities({ root })).capabilities).toContainEqual({
      module: "intent",
      enabled: true,
      source: "plugin",
      supported: true,
    });
    const legacyEntrance = await addCapability({ root, module: "intent" });
    expect(legacyEntrance.alreadyEnabled).toBe(true);
    expect(legacyEntrance.source).toBe("plugin");
    expect((await loadManifest(root))?.project.capabilities).toBeUndefined();
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("keeps a second apply byte-for-byte idempotent, including receipts and events", async () => {
    const root = await standaloneWorkspace("PluginIdempotent");
    await addPlugin({
      root,
      plugin: "assay.intent",
      now: new Date("2026-07-28T00:00:00.000Z"),
    });
    const manifestBefore = await readFile(path.join(root, ".assay", "manifest.json"), "utf8");
    const stateBefore = await readFile(path.join(root, PLUGINS_STATE_FILE), "utf8");
    const eventsBefore = await eventBytes(root);

    const result = await reconcilePlugins({
      root,
      apply: true,
      now: new Date("2026-07-29T00:00:00.000Z"),
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({ id: "assay.intent", action: "noop" }),
    ]);
    expect(result.eventFile).toBeUndefined();
    expect(result.report).toEqual({
      created_dirs: [],
      existing_dirs: [],
      created_files: [],
      updated_files: [],
      skipped_files: [],
      conflicted_files: [],
      new_copies: [],
      notes: [],
    });
    expect(await readFile(path.join(root, ".assay", "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(root, PLUGINS_STATE_FILE), "utf8")).toBe(stateBefore);
    expect(await eventBytes(root)).toBe(eventsBefore);
  });

  it("previews without writing and repairs only missing scaffold files on apply", async () => {
    const root = await standaloneWorkspace("PluginRepair");
    await addPlugin({ root, plugin: "assay.intent" });
    const missing = path.join(root, "intent", "requirements", "README.md");
    await rm(missing);
    const stateBefore = await readFile(path.join(root, PLUGINS_STATE_FILE), "utf8");

    const preview = await reconcilePlugins({ root });
    expect(preview.dryRun).toBe(true);
    expect(preview.plugins).toEqual([
      expect.objectContaining({
        id: "assay.intent",
        action: "repair",
        missingPaths: ["intent/requirements/README.md"],
      }),
    ]);
    expect(await exists(missing)).toBe(false);
    expect(await readFile(path.join(root, PLUGINS_STATE_FILE), "utf8")).toBe(stateBefore);

    const applied = await reconcilePlugins({ root, apply: true });
    expect(applied.plugins[0]?.action).toBe("repair");
    expect(applied.report.created_files).toContain("intent/requirements/README.md");
    expect(await exists(missing)).toBe(true);
    expect((await checkPlugins(root)).ok).toBe(true);
  });

  it("adopts a complete legacy intent capability without rewriting its scaffold", async () => {
    const root = await standaloneWorkspace("LegacyIntent");
    await addCapability({ root, module: "intent" });
    const readme = path.join(root, "intent", "README.md");
    const readmeBefore = await readFile(readme, "utf8");

    const preview = await reconcilePlugins({ root });
    expect(preview.plugins).toEqual([
      expect.objectContaining({
        id: "assay.intent",
        action: "adopt",
        desiredSources: ["legacy-capability"],
      }),
    ]);

    const applied = await reconcilePlugins({
      root,
      apply: true,
      now: new Date("2026-07-28T00:00:00.000Z"),
    });
    expect(applied.report.created_files).toEqual([PLUGINS_STATE_FILE]);
    expect(await readFile(readme, "utf8")).toBe(readmeBefore);
    expect((await loadManifest(root))?.project.capabilities).toEqual(["intent"]);
    expect((await listPlugins(root)).plugins).toContainEqual(
      expect.objectContaining({
        id: "assay.intent",
        desired: true,
        installed: true,
        action: "noop",
      }),
    );
  });

  it("keeps overlay paths private and carries plugin state through conversion", async () => {
    const root = await overlayWorkspace("OverlayPlugin");

    await addPlugin({ root, plugin: "assay.intent" });

    expect(await exists(path.join(root, ".assay", "intent", "original", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intent"))).toBe(false);
    expect(Object.keys((await loadManifest(root))?.managed_files ?? {})).toContain(
      ".assay/intent/original/README.md",
    );
    expect((await checkFramework({ root })).ok).toBe(true);

    const target = path.join(path.dirname(root), "converted-plugin");
    await convertOverlayToStandalone({ root, target, move: false, keepOverlay: true });

    expect((await loadManifest(target))?.plugins).toEqual({
      "assay.intent": { kind: "workspace-module" },
    });
    expect(await loadPluginsState(target)).not.toBeNull();
    expect(await exists(path.join(target, "intent", "original", "README.md"))).toBe(true);
    expect((await checkFramework({ root: target })).ok).toBe(true);
  });

  it("reports kind mismatches as blocked without writing plugin state", async () => {
    const root = await standaloneWorkspace("PluginMismatch");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.plugins = { "assay.intent": { kind: "external-tool" } };
    await saveManifest(root, manifest);

    const preview = await reconcilePlugins({ root });
    expect(preview.plugins).toEqual([
      expect.objectContaining({ id: "assay.intent", action: "blocked" }),
    ]);
    await expect(reconcilePlugins({ root, apply: true })).rejects.toThrow(
      /plugin reconcile blocked/,
    );
    expect(await exists(path.join(root, PLUGINS_STATE_FILE))).toBe(false);
    expect((await checkPlugins(root)).ok).toBe(false);
  });

  it("surfaces damaged and orphaned receipts without guessing a destructive repair", async () => {
    const damagedRoot = await standaloneWorkspace("DamagedPluginState");
    await addPlugin({ root: damagedRoot, plugin: "assay.intent" });
    await writeFile(
      path.join(damagedRoot, PLUGINS_STATE_FILE),
      '{"__schema":1,"plugins":[],"updated_at":"broken"}\n',
      "utf8",
    );

    await expect(reconcilePlugins({ root: damagedRoot })).rejects.toThrow(
      /plugin state failed validation/,
    );
    const damagedCheck = await checkPlugins(damagedRoot);
    expect(damagedCheck.ok).toBe(false);
    expect(damagedCheck.rows).toEqual([
      expect.objectContaining({ path: PLUGINS_STATE_FILE, status: "error" }),
    ]);

    const orphanRoot = await standaloneWorkspace("OrphanPluginState");
    await addPlugin({ root: orphanRoot, plugin: "assay.intent" });
    const manifest = await loadManifest(orphanRoot);
    if (!manifest) throw new Error("manifest missing");
    const orphanManifest = { ...manifest };
    Reflect.deleteProperty(orphanManifest, "plugins");
    await saveManifest(orphanRoot, orphanManifest);

    expect((await listPlugins(orphanRoot)).plugins).toContainEqual(
      expect.objectContaining({
        id: "assay.intent",
        desired: false,
        installed: true,
        action: "orphan",
      }),
    );
    const orphanCheck = await checkPlugins(orphanRoot);
    expect(orphanCheck.ok).toBe(true);
    expect(orphanCheck.rows).toContainEqual(
      expect.objectContaining({ path: PLUGINS_STATE_FILE, status: "warning" }),
    );
  });
});
