import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrameworkError,
  archiveSystem,
  attachExistingRepo,
  initFramework,
  loadManifest,
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
