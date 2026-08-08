import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { BARE_ARCHETYPE, createTempDirectoryFixture, writeBareArchetype } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addPlugin,
  attachExistingRepo,
  convertOverlayToStandalone,
  createTrellisTask,
  defaultManifest,
  defaultPluginsState,
  getCurrentTrellisTask,
  initFramework,
  listPlugins,
  loadPluginsState,
  savePluginsState,
  setConvertRoadmapProbeForTests,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-plugins");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  setConvertRoadmapProbeForTests(undefined);
  await tempDirs.cleanup();
});

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

describe("built-in plugin substrate", () => {
  it("validates existing plugin-state bytes before overwrite and preserves invalid state", async () => {
    const root = path.join(await tempDirs.createTempDir(), "plugin-state-writer");
    await initFramework({ target: root, name: "Plugin state writer" });
    const file = path.join(root, ".assay", "plugins.json");
    const retired = {
      __schema: 1,
      plugins: {
        "assay.intent": {
          kind: "workspace-module",
          state_version: 1,
          installed_at: "2026-08-08T00:00:00.000Z",
          updated_at: "2026-08-08T00:00:00.000Z",
        },
      },
      updated_at: "2026-08-08T00:00:00.000Z",
    };
    const beforeEntries = (await readdir(path.join(root, ".assay"))).sort();

    for (const raw of [`${JSON.stringify(retired)}\n`, "{malformed\n"]) {
      await writeFile(file, raw, "utf8");
      await expect(savePluginsState(root, defaultPluginsState())).rejects.toThrow(
        /retired assay\.intent|failed validation/,
      );
      expect(await readFile(file, "utf8")).toBe(raw);
      expect((await readdir(path.join(root, ".assay"))).sort()).toEqual(
        [...beforeEntries, "plugins.json"].sort(),
      );
    }
  });

  it("creates and overwrites only current built-in plugin state", async () => {
    const root = path.join(await tempDirs.createTempDir(), "current-plugin-state");
    await initFramework({ target: root, name: "Current plugin state" });
    const retired = defaultPluginsState();
    retired.plugins["assay.intent"] = {
      kind: "workspace-module",
      state_version: 1,
      installed_at: "2026-08-08T00:00:00.000Z",
      updated_at: "2026-08-08T00:00:00.000Z",
    };
    const beforeEntries = (await readdir(path.join(root, ".assay"))).sort();
    await expect(savePluginsState(root, retired)).rejects.toThrow(/retired assay\.intent/);
    expect((await readdir(path.join(root, ".assay"))).sort()).toEqual(beforeEntries);

    const state = defaultPluginsState(new Date("2026-08-08T00:00:00.000Z"));
    state.plugins["assay.trellis"] = {
      kind: "workspace-runtime",
      state_version: 1,
      installed_at: "2026-08-08T00:00:00.000Z",
      updated_at: "2026-08-08T00:00:00.000Z",
    };
    await savePluginsState(root, state, new Date("2026-08-08T00:00:01.000Z"));
    const saved = await savePluginsState(root, state, new Date("2026-08-08T00:00:02.000Z"));
    await expect(loadPluginsState(root)).resolves.toMatchObject({
      plugins: { "assay.trellis": { kind: "workspace-runtime" } },
      updated_at: saved.updated_at,
    });
  });

  it("rejects redirected plugin state without touching the target or external state", async () => {
    const root = path.join(await tempDirs.createTempDir(), "redirected-plugin-state");
    const authority = path.join(root, "redirected-authority");
    await mkdir(authority, { recursive: true });
    await writeFile(
      path.join(authority, "manifest.json"),
      `${JSON.stringify(defaultManifest("Redirected plugin state"))}\n`,
      "utf8",
    );
    const file = path.join(authority, "plugins.json");
    const raw = `${JSON.stringify(defaultPluginsState())}\n`;
    await writeFile(file, raw, "utf8");
    const externalRaw = '{"preserved":"external-state"}\n';
    await writeFile(path.join(authority, "external-plugins.json"), externalRaw, "utf8");
    await symlink(authority, path.join(root, ".assay"), "junction");

    await expect(savePluginsState(root, defaultPluginsState())).rejects.toThrow(/redirect/);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readFile(path.join(authority, "external-plugins.json"), "utf8")).toBe(externalRaw);
  });

  it("keeps Trellis runtime state through conversion and blocks concurrent mutations", async () => {
    const root = await overlayWorkspace("PluginConversionBoundary");
    await addPlugin({ root, plugin: "assay.trellis" });
    const before = await createTrellisTask({
      root,
      title: "Before conversion",
      sessionId: "before",
    });
    const target = path.join(await tempDirs.createTempDir(), "converted-boundary");
    let reached!: () => void;
    let release!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const continueConversion = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConvertRoadmapProbeForTests(async () => {
      reached();
      await continueConversion;
    });

    const conversion = convertOverlayToStandalone({ root, target, move: false, keepOverlay: true });
    await atBoundary;
    try {
      await expect(addPlugin({ root, plugin: "assay.trellis" })).rejects.toThrow(
        /workspace conversion/,
      );
    } finally {
      release();
    }
    await conversion;

    expect((await getCurrentTrellisTask({ root: target, sessionId: "before" })).task?.id).toBe(
      before.task?.id,
    );
    expect((await listPlugins(target)).plugins).toContainEqual(
      expect.objectContaining({ id: "assay.trellis", installed: true, desired: true }),
    );
  });

  it("does not expose the removed built-in intent plugin or alias", async () => {
    const root = await overlayWorkspace("NoIntentPlugin");
    await expect(addPlugin({ root, plugin: "assay.intent" })).rejects.toThrow(/unsupported plugin/);
    await expect(addPlugin({ root, plugin: "intent" })).rejects.toThrow(/unsupported plugin/);
    expect((await listPlugins(root)).plugins.map((plugin) => plugin.id)).not.toContain(
      "assay.intent",
    );
  });
});
