import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  FrameworkError,
  addCapability,
  analyzeUpdate,
  applyUpdate,
  attachExistingRepo,
  checkFramework,
  createAdr,
  effectiveCapabilities,
  initFramework,
  isCapabilityEnabled,
  listAdrs,
  listCapabilities,
  loadAdrIndex,
  loadArchetype,
  loadManifest,
  requireCapability,
  saveManifest,
  startIteration,
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
  await initFramework({ target: root, name, archetype });
  return root;
}

async function overlayWorkspace(name: string, archetype = "library"): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "initial"]);
  await attachExistingRepo({ root, name, archetype, privacy: "private", noTrack: true });
  return root;
}

async function readEvents(root: string): Promise<Record<string, unknown>[]> {
  const eventsDir = path.join(root, ".assay", "events");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(eventsDir);
  const entries: Record<string, unknown>[] = [];
  for (const file of files) {
    const content = await readFile(path.join(eventsDir, file), "utf8");
    for (const line of content.split("\n").filter((value) => value.trim().length > 0)) {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return entries;
}

describe("effectiveCapabilities", () => {
  it("unions archetype modules with manifest capabilities and drops unknown names", async () => {
    const study = await loadArchetype("study");

    expect(effectiveCapabilities(study, undefined)).toEqual(["adr"]);
    expect(effectiveCapabilities(study, ["iteration"])).toEqual(["adr", "iteration"]);
    expect(effectiveCapabilities(study, ["adr"])).toEqual(["adr"]);
    expect(effectiveCapabilities(study, ["telepathy"])).toEqual(["adr"]);
    expect(effectiveCapabilities(null, ["iteration"])).toEqual(["iteration"]);
  });
});

describe("addCapability", () => {
  it("scaffolds a module the archetype lacks and keeps the workspace checkable", async () => {
    const root = await standaloneWorkspace("AddAdr", "library");

    expect(await isCapabilityEnabled(root, "adr")).toBe(false);
    await expect(createAdr(root, { title: "Too Early" })).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );

    const result = await addCapability({ root, module: "adr" });

    expect(result.alreadyEnabled).toBe(false);
    expect(result.source).toBe("added");
    expect(result.capabilities).toEqual(["adr"]);
    expect(await exists(path.join(root, "knowledge", "decisions", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "knowledge", "decisions", "ADR-TEMPLATE.md"))).toBe(true);
    expect(await loadAdrIndex(root)).not.toBeNull();

    const manifest = await loadManifest(root);
    expect(manifest?.project.capabilities).toEqual(["adr"]);
    expect(Object.keys(manifest?.managed_files ?? {})).toContain(
      "knowledge/decisions/ADR-TEMPLATE.md",
    );

    expect(await isCapabilityEnabled(root, "adr")).toBe(true);
    const adr = await createAdr(root, { title: "First Decision" });
    expect(adr.adr.path).toBe("knowledge/decisions/ADR-0001-first-decision.md");
    expect((await listAdrs(root)).adrs).toHaveLength(1);

    const check = await checkFramework({ root });
    expect(check.ok).toBe(true);
    expect(
      check.rows.some((row) => row.path === "knowledge/decisions" && row.status === "ok"),
    ).toBe(true);
  });

  it("writes a capability.added event", async () => {
    const root = await standaloneWorkspace("CapabilityEvent", "library");

    const result = await addCapability({ root, module: "iteration" });

    expect(result.eventFile).toBeDefined();
    const events = await readEvents(root);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "capability.added",
        module: "iteration",
        archetype: "library",
      }),
    );
  });

  it("is a no-op when the module is already enabled", async () => {
    const root = await standaloneWorkspace("Idempotent", "library");
    await addCapability({ root, module: "iteration" });
    const before = await loadManifest(root);

    const rerun = await addCapability({ root, module: "iteration" });

    expect(rerun.alreadyEnabled).toBe(true);
    expect(rerun.source).toBe("added");
    expect(rerun.report.created_files).toEqual([]);
    expect(rerun.report.skipped_files).toEqual([]);
    expect(rerun.eventFile).toBeUndefined();
    expect((await loadManifest(root))?.project.capabilities).toEqual(before?.project.capabilities);
    expect(
      (await readEvents(root)).filter((event) => event.event === "capability.added"),
    ).toHaveLength(1);
  });

  it("reports an archetype-provided module as already enabled without recording it", async () => {
    const root = await standaloneWorkspace("ArchetypeProvided", "study");

    const result = await addCapability({ root, module: "adr" });

    expect(result.alreadyEnabled).toBe(true);
    expect(result.source).toBe("archetype");
    expect((await loadManifest(root))?.project.capabilities).toBeUndefined();
  });

  it("rejects a module this build does not implement", async () => {
    const root = await standaloneWorkspace("UnknownModule", "library");

    await expect(addCapability({ root, module: "telepathy" })).rejects.toThrow(FrameworkError);
    await expect(addCapability({ root, module: "telepathy" })).rejects.toThrow(
      /supported modules: adr, intent, iteration/,
    );
    expect((await loadManifest(root))?.project.capabilities).toBeUndefined();
  });

  it("scaffolds an overlay workspace under .assay and never the product repo root", async () => {
    const root = await overlayWorkspace("OverlayCapability");

    await addCapability({ root, module: "adr" });

    expect(await exists(path.join(root, ".assay", "knowledge", "decisions", "README.md"))).toBe(
      true,
    );
    expect(await exists(path.join(root, "knowledge"))).toBe(false);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");

    const manifest = await loadManifest(root);
    expect(Object.keys(manifest?.managed_files ?? {})).toContain(
      ".assay/knowledge/decisions/README.md",
    );

    const adr = await createAdr(root, { title: "Overlay Decision" });
    expect(adr.adr.path).toBe(".assay/knowledge/decisions/ADR-0001-overlay-decision.md");
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("enables iteration on an archetype that only ships adr", async () => {
    const root = await standaloneWorkspace("AddIteration", "study");

    await expect(startIteration({ root, title: "Too Early" })).rejects.toThrow(
      /capability not enabled in archetype study: iteration/,
    );

    await addCapability({ root, module: "iteration" });

    expect(await exists(path.join(root, "iterations", "templates", "iteration-plan.md"))).toBe(
      true,
    );
    const started = await startIteration({ root, title: "First Loop" });
    expect(started.path).toMatch(/^iterations\//);
    expect((await checkFramework({ root })).ok).toBe(true);

    const archetype = await loadArchetype("study");
    expect(await requireCapability(root, "iteration")).toEqual(archetype);
  });
});

describe("capability-scaffolded templates stay under update management", () => {
  it("appears in the update analysis and is restored after deletion", async () => {
    const root = await standaloneWorkspace("UpdateReconcile", "library");
    await addCapability({ root, module: "iteration" });

    const clean = await analyzeUpdate({ root });
    expect(clean.changes.unchanged.map((change) => change.path)).toContain(
      "iterations/templates/iteration-plan.md",
    );

    await rm(path.join(root, "iterations", "templates", "iteration-plan.md"), { force: true });
    const afterDelete = await analyzeUpdate({ root });
    expect(afterDelete.changes.user_deleted.map((change) => change.path)).toContain(
      "iterations/templates/iteration-plan.md",
    );
  });

  it("creates capability templates that were never written", async () => {
    const root = await standaloneWorkspace("UpdateCreate", "library");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    // A manifest that declares the capability without its files on disk: the
    // update pass owns them, so it must create rather than ignore them.
    manifest.project.capabilities = ["iteration"];
    await saveManifest(root, manifest);

    const result = await applyUpdate({ root, action: "skip" });

    expect(result.report.created_files).toContain("iterations/README.md");
    expect(await exists(path.join(root, "iterations", "templates", "iteration-plan.md"))).toBe(
      true,
    );
  });
});

describe("manifests without a capabilities field", () => {
  it("keeps working with archetype modules only", async () => {
    const root = await standaloneWorkspace("LegacyManifest", "study");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    expect(manifest.project.capabilities).toBeUndefined();

    expect(await isCapabilityEnabled(root, "adr")).toBe(true);
    expect(await isCapabilityEnabled(root, "iteration")).toBe(false);
    expect((await checkFramework({ root })).ok).toBe(true);
    expect((await analyzeUpdate({ root })).changes.new).toEqual([]);
  });

  it("ignores a manifest capability this build does not implement", async () => {
    const root = await standaloneWorkspace("UnknownCapability", "library");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.project.capabilities = ["telepathy"];
    await saveManifest(root, manifest);

    expect(await isCapabilityEnabled(root, "adr")).toBe(false);
    expect((await checkFramework({ root })).ok).toBe(true);

    const listed = await listCapabilities({ root });
    expect(listed.capabilities).toContainEqual({
      module: "telepathy",
      enabled: false,
      source: "added",
      supported: false,
    });
  });
});

describe("listCapabilities", () => {
  it("distinguishes archetype-provided modules from added ones", async () => {
    const root = await standaloneWorkspace("ListCapabilities", "study");
    await addCapability({ root, module: "iteration" });

    const result = await listCapabilities({ root });

    expect(result.project).toBe("ListCapabilities");
    expect(result.archetype).toBe("study");
    expect(result.capabilities).toEqual([
      { module: "adr", enabled: true, source: "archetype", supported: true },
      { module: "intent", enabled: false, source: null, supported: true },
      { module: "iteration", enabled: true, source: "added", supported: true },
    ]);
  });

  it("marks modules the workspace has not enabled", async () => {
    const root = await standaloneWorkspace("ListNone", "library");

    const result = await listCapabilities({ root });

    expect(result.capabilities).toEqual([
      { module: "adr", enabled: false, source: null, supported: true },
      { module: "intent", enabled: false, source: null, supported: true },
      { module: "iteration", enabled: false, source: null, supported: true },
    ]);
  });
});
