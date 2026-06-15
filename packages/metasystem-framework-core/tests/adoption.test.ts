import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AdoptExistingProjectResult,
  adoptExistingProject,
  initFramework,
  loadManifest,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-core-adopt-"));
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

function fixedNow(): Date {
  return new Date("2026-06-15T04:05:06");
}

async function readAdoptionManifest(result: AdoptExistingProjectResult): Promise<unknown> {
  expect(result.manifestPath).toBeDefined();
  return JSON.parse(await readFile(path.join(result.root, result.manifestPath ?? ""), "utf8"));
}

describe("adoptExistingProject", () => {
  it("plans adoption as a dry-run without writing archive or scaffold files", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# Existing\n", "utf8");

    const result = await adoptExistingProject({
      root,
      name: "Existing Project",
      now: fixedNow(),
    });

    expect(result.dryRun).toBe(true);
    expect(result.archiveDir).toBe(".old/20260615-040506");
    expect(result.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "README.md",
          destination: ".old/20260615-040506/README.md",
          status: "planned",
        }),
        expect.objectContaining({
          source: "src",
          destination: ".old/20260615-040506/src",
          status: "planned",
        }),
      ]),
    );
    expect(await exists(path.join(root, ".old"))).toBe(false);
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(false);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Existing\n");
  });

  it("moves existing root children into .old while preserving .git and creating a scaffold", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# Existing\n", "utf8");

    const result = await adoptExistingProject({
      root,
      name: "Adopted Project",
      core: "chosen-core",
      apply: true,
      now: fixedNow(),
    });

    expect(result.dryRun).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.moves.every((move) => move.status === "moved")).toBe(true);
    expect(result.skipped).toContainEqual({
      path: ".git",
      reason: "preserved at project root",
    });
    expect(await exists(path.join(root, ".git"))).toBe(true);
    expect(await exists(path.join(root, "README.md"))).toBe(true);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# Adopted Project");
    expect(await exists(path.join(root, ".old", "20260615-040506", "README.md"))).toBe(true);
    expect(await exists(path.join(root, ".old", "20260615-040506", "src", "index.ts"))).toBe(true);
    expect(await exists(path.join(root, ".framework", "manifest.json"))).toBe(true);
    expect((await loadManifest(root))?.project).toMatchObject({
      name: "Adopted Project",
      core: "chosen-core",
    });

    const manifest = await readAdoptionManifest(result);
    expect(manifest).toMatchObject({
      dryRun: false,
      archiveDir: ".old/20260615-040506",
      failures: [],
      scaffold: {
        project: "Adopted Project",
        core: "chosen-core",
      },
    });
  });

  it("does not move .old into the new archive", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, ".old", "previous"), { recursive: true });
    await writeFile(path.join(root, "app.txt"), "app\n", "utf8");

    const result = await adoptExistingProject({ root, apply: true, now: fixedNow() });

    expect(result.skipped).toContainEqual({
      path: ".old",
      reason: "existing adoption archives are never moved into a new archive",
    });
    expect(await exists(path.join(root, ".old", "previous"))).toBe(true);
    expect(await exists(path.join(root, ".old", "20260615-040506", ".old"))).toBe(false);
  });

  it("creates a suffixed archive when the timestamped archive already exists", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, ".old", "20260615-040506"), { recursive: true });
    await writeFile(path.join(root, ".old", "20260615-040506", "kept.txt"), "keep\n", "utf8");
    await writeFile(path.join(root, "app.txt"), "app\n", "utf8");

    const result = await adoptExistingProject({ root, apply: true, now: fixedNow() });

    expect(result.archiveDir).toBe(".old/20260615-040506-01");
    expect(await exists(path.join(root, ".old", "20260615-040506", "kept.txt"))).toBe(true);
    expect(await exists(path.join(root, ".old", "20260615-040506-01", "app.txt"))).toBe(true);
  });

  it("refuses to adopt a workspace that already has a framework manifest", async () => {
    const root = path.join(await tempDir(), "managed");
    await initFramework({ target: root, name: "Managed" });

    await expect(adoptExistingProject({ root, apply: true, now: fixedNow() })).rejects.toThrow(
      "MetaSystem framework manifest already exists",
    );
  });

  it("refuses to adopt a missing project root", async () => {
    const root = path.join(await tempDir(), "missing");

    await expect(adoptExistingProject({ root, apply: true, now: fixedNow() })).rejects.toThrow(
      "Cannot adopt missing project root",
    );
  });
});
