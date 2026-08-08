import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILE,
  findProjectRecord,
  forgetProject,
  initFramework,
  listProjectRecords,
  markProjectUninstalled,
  projectIdForPath,
  projectRecordPath,
  projectRegistryRoot,
  pruneProjects,
  recordProjectLifecycleBestEffort,
  registerProject,
  scanForProjects,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-core-registry-"));
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

describe("project registry paths and ids", () => {
  it("uses an explicit registry root and stable ids for canonical project paths", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await mkdir(root, { recursive: true });

    expect(projectRegistryRoot({ registryRoot })).toBe(path.resolve(registryRoot));
    expect(projectIdForPath(root)).toBe(projectIdForPath(path.join(root, ".")));
    if (process.platform === "win32") {
      expect(projectIdForPath(root.toUpperCase())).toBe(projectIdForPath(root.toLowerCase()));
    }
  });
});

describe("project registry records", () => {
  it("registers, lists, and refreshes active records from .assay/manifest.json", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Registry Demo" });

    const createdAt = new Date("2026-06-15T10:00:00Z");
    const record = await registerProject(root, "init", {
      registryRoot,
      now: () => createdAt,
    });

    expect(record).toMatchObject({
      path: path.resolve(root),
      name: "Registry Demo",
      core: "demo-core",
      createdAt: createdAt.toISOString(),
      lastSeenAt: createdAt.toISOString(),
      createdBy: "init",
      lastCommand: "init",
      status: "active",
    });
    expect(record.managedFiles).toBeGreaterThan(0);
    expect(await exists(projectRecordPath(record.id, { registryRoot }))).toBe(true);

    const listed = await listProjectRecords({ registryRoot });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: record.id,
      frameworkVersion: record.frameworkVersion,
      layoutVersion: record.layoutVersion,
      status: "active",
    });
  });

  it("preserves creation metadata when a project is touched by update", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Touch Demo" });

    const first = await registerProject(root, "init", {
      registryRoot,
      now: () => new Date("2026-06-15T10:00:00Z"),
    });
    const second = await registerProject(root, "update", {
      registryRoot,
      now: () => new Date("2026-06-15T11:00:00Z"),
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.createdBy).toBe("init");
    expect(second.lastSeenAt).toBe("2026-06-15T11:00:00.000Z");
    expect(second.lastCommand).toBe("update");
  });

  it("skips best-effort lifecycle writes when tracking is disabled", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "No Track Demo" });

    await recordProjectLifecycleBestEffort(root, "init", { registryRoot, noTrack: true });

    expect(await exists(registryRoot)).toBe(false);
    await recordProjectLifecycleBestEffort(root, "init", { registryRoot });
    expect(await exists(projectRecordPath(projectIdForPath(root), { registryRoot }))).toBe(true);
  });

  it("honors ASSAY_NO_TRACK for best-effort lifecycle writes", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "No Track Env Demo" });
    const previousRegistryRoot = process.env.ASSAY_PROJECT_REGISTRY_ROOT;
    const previousNoTrack = process.env.ASSAY_NO_TRACK;

    try {
      process.env.ASSAY_PROJECT_REGISTRY_ROOT = registryRoot;
      process.env.ASSAY_NO_TRACK = "1";
      await recordProjectLifecycleBestEffort(root, "init");
      expect(await exists(registryRoot)).toBe(false);
    } finally {
      if (previousRegistryRoot === undefined) {
        Reflect.deleteProperty(process.env, "ASSAY_PROJECT_REGISTRY_ROOT");
      } else {
        process.env.ASSAY_PROJECT_REGISTRY_ROOT = previousRegistryRoot;
      }
      if (previousNoTrack === undefined) {
        Reflect.deleteProperty(process.env, "ASSAY_NO_TRACK");
      } else {
        process.env.ASSAY_NO_TRACK = previousNoTrack;
      }
    }
  });

  it("finds records by id, id prefix, and path selector", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Selector Demo" });
    const record = await registerProject(root, "init", { registryRoot });

    await expect(findProjectRecord(record.id, { registryRoot })).resolves.toMatchObject({
      id: record.id,
    });
    await expect(
      findProjectRecord(record.id.slice(0, 10), { registryRoot }),
    ).resolves.toMatchObject({
      id: record.id,
    });
    await expect(findProjectRecord(path.join(root, "."), { registryRoot })).resolves.toMatchObject({
      id: record.id,
    });
  });

  it("does not resolve selectors outside the registry root", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    const escapedRecordPath = path.join(path.dirname(registryRoot), "escaped.json");
    await initFramework({ target: root, name: "Escape Demo" });

    const escapedRecord = await registerProject(root, "init", { registryRoot });
    await writeFile(
      escapedRecordPath,
      `${JSON.stringify({ ...escapedRecord, status: "missing" }, null, 2)}\n`,
      "utf8",
    );

    await expect(findProjectRecord("../escaped", { registryRoot })).rejects.toThrow(
      "project not found",
    );
  });

  it("fails closed instead of hiding an unreadable manifest", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Missing Demo" });
    const record = await registerProject(root, "init", { registryRoot });

    await writeFile(path.join(root, MANIFEST_FILE), "{not json", "utf8");
    await expect(listProjectRecords({ registryRoot })).rejects.toThrow(
      "Framework manifest is not valid JSON",
    );
    expect(record.status).toBe("active");
  });
});

describe("project registry scan and cleanup", () => {
  it("scans for scaffold markers while skipping heavy directories", async () => {
    const root = await tempDir();
    const registryRoot = path.join(await tempDir(), "registry");
    const project = path.join(root, "project");
    const nested = path.join(root, "group", "nested");
    const ignored = path.join(root, "node_modules", "ignored");
    await initFramework({ target: project, name: "Scan Demo" });
    await initFramework({ target: nested, name: "Nested Demo" });
    await initFramework({ target: ignored, name: "Ignored Demo" });

    const records = await scanForProjects([root], { registryRoot });

    expect(records.map((record) => record.name)).toEqual(["Nested Demo", "Scan Demo"]);
    expect(records.some((record) => record.path.includes("node_modules"))).toBe(false);
  });

  it("forgets and prunes registry files without deleting project files", async () => {
    const root = path.join(await tempDir(), "demo");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Cleanup Demo" });
    const active = await registerProject(root, "init", { registryRoot });

    const forgotten = await forgetProject(active.id, { registryRoot });
    expect(forgotten.id).toBe(active.id);
    expect(await exists(projectRecordPath(active.id, { registryRoot }))).toBe(false);
    expect(await exists(path.join(root, MANIFEST_FILE))).toBe(true);

    const stale = await registerProject(root, "scan", { registryRoot });
    await rm(root, { recursive: true, force: true });
    const dryRun = await pruneProjects({ registryRoot, dryRun: true });
    expect(dryRun.map((record) => record.id)).toEqual([stale.id]);
    expect(await exists(projectRecordPath(stale.id, { registryRoot }))).toBe(true);

    const pruned = await pruneProjects({ registryRoot });
    expect(pruned.map((record) => record.id)).toEqual([stale.id]);
    expect(await exists(projectRecordPath(stale.id, { registryRoot }))).toBe(false);
  });

  it("keeps a record whose directory is still there but whose manifest cannot be read", async () => {
    const root = path.join(await tempDir(), "unreadable");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Unreadable Demo" });
    const record = await registerProject(root, "init", { registryRoot });
    await rm(path.join(root, ".assay"), { recursive: true, force: true });

    expect((await listProjectRecords({ registryRoot }))[0]).toMatchObject({ status: "missing" });
    await expect(pruneProjects({ registryRoot })).resolves.toEqual([]);
    expect(await exists(projectRecordPath(record.id, { registryRoot }))).toBe(true);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# Unreadable Demo");
  });

  it("requires external cutover for a .framework workspace", async () => {
    const root = path.join(await tempDir(), "legacy");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Legacy Demo" });
    await rename(path.join(root, ".assay"), path.join(root, ".framework"));
    await expect(registerProject(root, "scan", { registryRoot })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
    });
  });

  it("prunes a record the workspace explicitly uninstalled", async () => {
    const root = path.join(await tempDir(), "uninstalled");
    const registryRoot = path.join(await tempDir(), "registry");
    await initFramework({ target: root, name: "Uninstalled Demo" });
    await registerProject(root, "init", { registryRoot });
    const record = await markProjectUninstalled(root, { registryRoot });

    await expect(pruneProjects({ registryRoot })).resolves.toMatchObject([{ id: record.id }]);
    expect(await exists(projectRecordPath(record.id, { registryRoot }))).toBe(false);
  });

  it("ignores corrupted records whose ids do not match the generated hash format", async () => {
    const registryRoot = path.join(await tempDir(), "registry");
    const filePath = path.join(registryRoot, "malicious.json");
    await mkdir(registryRoot, { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "../outside",
          path: "C:/fake/project",
          realpath: "C:/fake/project",
          name: "Malicious",
          core: "malicious-core",
          createdAt: "2026-06-15T10:00:00.000Z",
          lastSeenAt: "2026-06-15T10:00:00.000Z",
          createdBy: "scan",
          lastCommand: "scan",
          managedFiles: 0,
          status: "missing",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(listProjectRecords({ registryRoot })).resolves.toEqual([]);
    await expect(pruneProjects({ registryRoot })).resolves.toEqual([]);
    expect(await exists(filePath)).toBe(true);
  });

  it("prunes records whose project directory no longer exists at all", async () => {
    const registryRoot = path.join(await tempDir(), "registry");
    const vanished = path.join(await tempDir(), "vanished");
    await initFramework({ target: vanished, name: "Vanished" });
    const record = await registerProject(vanished, "init", { registryRoot });
    await rm(vanished, { recursive: true, force: true });

    const pruned = await pruneProjects({ registryRoot });

    expect(pruned.map((entry) => entry.id)).toEqual([record.id]);
    expect(await exists(projectRecordPath(record.id, { registryRoot }))).toBe(false);
  });
});

/**
 * The isolation itself, asserted where a broken harness fails loudly. The
 * run-level check lives in the vitest global setup and compares the user
 * registry before and after; this catches a misconfigured worker at the point
 * where the workspace-creating tests run.
 */
describe("test project registry isolation", () => {
  it("redirects the registry away from the user's home directory", () => {
    const configured = process.env.ASSAY_PROJECT_REGISTRY_ROOT;
    const userRegistryRoot = path.join(homedir(), ".assay", "projects");

    expect(configured, "vitest setup must redirect ASSAY_PROJECT_REGISTRY_ROOT").toBeTruthy();
    expect(path.resolve(configured ?? "")).not.toBe(path.resolve(userRegistryRoot));
    expect(path.resolve(projectRegistryRoot())).not.toBe(path.resolve(userRegistryRoot));
  });
});
