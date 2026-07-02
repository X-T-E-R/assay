import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidManifestError,
  defaultManifest,
  loadManifest,
  manifestPath,
  saveManifest,
} from "../src/index.js";
import { frameworkProjectSchema } from "../src/schemas/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-manifest-archetype-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function legacyManifest(project: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __schema: 1,
    framework_version: "0.0.0",
    layout_version: 3,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    project: {
      name: "Legacy",
      core: "legacy-core",
      ...project,
    },
    managed_files: {},
    user_deleted: [],
    applied_migrations: [],
  };
}

async function writeManifestJson(root: string, manifest: unknown): Promise<void> {
  await mkdir(path.dirname(manifestPath(root)), { recursive: true });
  await writeFile(manifestPath(root), JSON.stringify(manifest), "utf8");
}

describe("manifest archetype/mode contract", () => {
  it("defaults legacy project schema fields without requiring core", () => {
    expect(frameworkProjectSchema.parse({ name: "Legacy", core: "legacy-core" })).toEqual({
      name: "Legacy",
      core: "legacy-core",
      archetype: "study",
      mode: "learning",
    });

    expect(frameworkProjectSchema.parse({ name: "Coreless" })).toEqual({
      name: "Coreless",
      archetype: "study",
      mode: "learning",
    });
  });

  it("accepts custom archetype strings while still rejecting blank archetype and invalid mode values", () => {
    expect(
      frameworkProjectSchema.parse({
        name: "Custom",
        core: "custom-core",
        archetype: "assay",
      }),
    ).toMatchObject({
      name: "Custom",
      archetype: "assay",
      mode: "learning",
    });

    expect(() =>
      frameworkProjectSchema.parse({
        name: "Invalid",
        core: "invalid-core",
        archetype: "",
      }),
    ).toThrow();

    expect(() =>
      frameworkProjectSchema.parse({
        name: "Invalid",
        core: "invalid-core",
        mode: "archive",
      }),
    ).toThrow();
  });

  it("creates default manifests with explicit or default archetype and mode", () => {
    expect(defaultManifest("Demo").project).toEqual({
      name: "Demo",
      archetype: "study",
      mode: "learning",
    });

    expect(
      defaultManifest("Solve", {
        archetype: "solve",
        mode: "absorption",
      }).project,
    ).toEqual({
      name: "Solve",
      archetype: "solve",
      mode: "absorption",
    });

    expect(defaultManifest("Library", { archetype: "library" }).project).toEqual({
      name: "Library",
      archetype: "library",
      mode: "learning",
    });
  });

  it("loads and saves legacy manifests with archetype/mode defaults", async () => {
    const root = await tempDir();
    await writeManifestJson(root, legacyManifest());

    const loaded = await loadManifest(root);
    assert(loaded);
    expect(loaded.project).toEqual({
      name: "Legacy",
      core: "legacy-core",
      archetype: "study",
      mode: "learning",
    });

    await saveManifest(root, loaded);
    const saved = JSON.parse(await readFile(manifestPath(root), "utf8")) as {
      project?: Record<string, unknown>;
    };
    expect(saved.project).toMatchObject({
      archetype: "study",
      mode: "learning",
    });
  });

  it("loads legacy manifests that omit project.core", async () => {
    const root = await tempDir();
    await writeManifestJson(root, legacyManifest({ core: undefined }));

    const loaded = await loadManifest(root);
    assert(loaded);
    expect(loaded.project).toEqual({
      name: "Legacy",
      archetype: "study",
      mode: "learning",
    });
  });

  it("throws a typed error instead of preserving invalid mode values", async () => {
    const root = await tempDir();
    await writeManifestJson(root, legacyManifest({ mode: "archive" }));

    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
  });
});
