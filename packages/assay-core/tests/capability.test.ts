import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  FrameworkError,
  addCapability,
  analyzeUpdate,
  applyUpdate,
  attachExistingRepo,
  checkFramework,
  effectiveCapabilities,
  initFramework,
  isCapabilityEnabled,
  listCapabilities,
  loadArchetype,
  loadManifest,
  requireCapability,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-capability");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

async function standaloneWorkspace(name: string, archetype = "study"): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  if (archetype === BARE_ARCHETYPE) await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype });
  return root;
}

async function overlayWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeBareArchetype(root);
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "initial"]);
  await attachExistingRepo({
    root,
    name,
    archetype: BARE_ARCHETYPE,
    privacy: "private",
    noTrack: true,
  });
  return root;
}

async function readEvents(root: string): Promise<Record<string, unknown>[]> {
  const eventsDir = path.join(root, ".assay", "events");
  const { readdir } = await import("node:fs/promises");
  const entries: Record<string, unknown>[] = [];
  for (const file of await readdir(eventsDir)) {
    const content = await readFile(path.join(eventsDir, file), "utf8");
    for (const line of content.split("\n").filter((value) => value.trim().length > 0)) {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return entries;
}

describe("effectiveCapabilities", () => {
  it("keeps intent and drops unsupported names", async () => {
    const study = await loadArchetype("study");
    expect(effectiveCapabilities(study, undefined)).toEqual([]);
    expect(effectiveCapabilities(study, ["intent"])).toEqual(["intent"]);
    expect(effectiveCapabilities(study, ["iteration", "telepathy"])).toEqual([]);
    expect(effectiveCapabilities(null, ["intent"])).toEqual(["intent"]);
  });
});

describe("addCapability", () => {
  it("scaffolds intent and keeps the workspace checkable", async () => {
    const root = await standaloneWorkspace("AddIntent", BARE_ARCHETYPE);
    expect(await isCapabilityEnabled(root, "intent")).toBe(false);

    const result = await addCapability({ root, module: "intent" });
    expect(result).toMatchObject({
      alreadyEnabled: false,
      source: "added",
      capabilities: ["intent"],
    });
    expect(await exists(path.join(root, "intent", "original", "README.md"))).toBe(true);
    expect((await loadManifest(root))?.project.capabilities).toEqual(["intent"]);
    expect((await checkFramework({ root })).ok).toBe(true);
    expect(await requireCapability(root, "intent")).toEqual(
      await loadArchetype(BARE_ARCHETYPE, { root }),
    );
  });

  it("writes one event and is idempotent", async () => {
    const root = await standaloneWorkspace("CapabilityEvent", BARE_ARCHETYPE);
    const first = await addCapability({ root, module: "intent" });
    const rerun = await addCapability({ root, module: "intent" });

    expect(first.eventFile).toBeDefined();
    expect(rerun).toMatchObject({ alreadyEnabled: true, source: "added" });
    expect(rerun.report.created_files).toEqual([]);
    expect((await readEvents(root)).filter((event) => event.event === "capability.added")).toEqual([
      expect.objectContaining({ module: "intent", archetype: BARE_ARCHETYPE }),
    ]);
  });

  it("rejects retired and unknown modules without changing the manifest", async () => {
    const root = await standaloneWorkspace("UnsupportedModules", BARE_ARCHETYPE);
    for (const module of ["iteration", "telepathy"]) {
      await expect(addCapability({ root, module })).rejects.toThrow(FrameworkError);
      await expect(addCapability({ root, module })).rejects.toThrow(/supported modules: intent/);
    }
    expect((await loadManifest(root))?.project.capabilities).toBeUndefined();
  });

  it("scaffolds overlay intent under .assay and never the product root", async () => {
    const root = await overlayWorkspace("OverlayCapability");
    await addCapability({ root, module: "intent" });
    expect(await exists(path.join(root, ".assay", "intent", "original", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intent"))).toBe(false);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
    expect((await checkFramework({ root })).ok).toBe(true);
  });
});

describe("capability-scaffolded templates stay under update management", () => {
  it("detects deletion and restores a declared capability scaffold", async () => {
    const root = await standaloneWorkspace("UpdateReconcile", BARE_ARCHETYPE);
    await addCapability({ root, module: "intent" });
    expect(
      (await analyzeUpdate({ root })).changes.unchanged.map((change) => change.path),
    ).toContain("intent/original/README.md");

    await rm(path.join(root, "intent", "original", "README.md"), { force: true });
    expect(
      (await analyzeUpdate({ root })).changes.user_deleted.map((change) => change.path),
    ).toContain("intent/original/README.md");
  });

  it("creates intent templates declared directly in a manifest", async () => {
    const root = await standaloneWorkspace("UpdateCreate", BARE_ARCHETYPE);
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.project.capabilities = ["intent"];
    await saveManifest(root, manifest);

    const result = await applyUpdate({ root, action: "skip" });
    expect(result.report.created_files).toContain("intent/README.md");
    expect(await exists(path.join(root, "intent", "requirements", "README.md"))).toBe(true);
  });
});

describe("manifest capability compatibility", () => {
  it("ignores unsupported manifest names while keeping them visible", async () => {
    const root = await standaloneWorkspace("UnknownCapability", BARE_ARCHETYPE);
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.project.capabilities = ["iteration", "telepathy"];
    await saveManifest(root, manifest);

    expect(await isCapabilityEnabled(root, "intent")).toBe(false);
    expect((await checkFramework({ root })).ok).toBe(true);
    expect((await listCapabilities({ root })).capabilities).toEqual([
      { module: "intent", enabled: false, source: null, supported: true },
      { module: "iteration", enabled: false, source: "added", supported: false },
      { module: "telepathy", enabled: false, source: "added", supported: false },
    ]);
  });
});
