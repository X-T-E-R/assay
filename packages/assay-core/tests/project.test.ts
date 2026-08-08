import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addSource,
  applyUpdate,
  archiveRoadmap,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  createAnalysis,
  createRoadmap,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  loadNativeProject,
  realizeRoadmap,
  recordManagedFile,
  resolveWorkspaceLayout,
  saveManifest,
  setConvertRoadmapProbeForTests,
  showRoadmap,
  updateRoadmap,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-project");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  setConvertRoadmapProbeForTests(undefined);
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
}

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

async function nativeProject(root: string) {
  const manifest = await loadManifest(root);
  const layout = resolveWorkspaceLayout(manifest);
  if (!layout) throw new Error("layout missing");
  const project = await loadNativeProject(root, layout);
  if (!project) throw new Error("native Project missing");
  return project;
}

describe("native Project scaffold", () => {
  it.each(["study", "solve", "explore"])(
    "creates the exact minimal standalone Project for %s",
    async (archetype) => {
      const root = path.join(await tempDirs.createTempDir(), archetype);
      await initFramework({ target: root, name: `${archetype} workspace`, archetype });

      expect((await readdir(path.join(root, "project"))).sort()).toEqual([
        "README.md",
        "project.yaml",
        "roadmap",
      ]);
      expect(await readdir(path.join(root, "project", "roadmap"))).toEqual(["README.md"]);
      for (const absent of ["facts", "policy", "norms", "decisions", "relay", "extensions"])
        expect(await exists(path.join(root, "project", absent))).toBe(false);
      const retiredName = ["itera", "tions"].join("");
      expect((await loadManifest(root))?.layout.paths).not.toHaveProperty(retiredName);
      expect(await exists(path.join(root, retiredName))).toBe(false);
      expect((await checkFramework({ root })).ok).toBe(true);
    },
    60_000,
  );

  it("keeps the Project id stable across repeated init and update", async () => {
    const root = path.join(await tempDirs.createTempDir(), "stable");
    await initFramework({ target: root, name: "Stable", archetype: "solve" });
    const first = await nativeProject(root);
    expect(first.id).toBe("project-stable");
    await initFramework({ target: root, name: "Stable", archetype: "solve" });
    await applyUpdate({ root });
    expect((await nativeProject(root)).id).toBe(first.id);
  });

  it("rejects an unpublished UUID-shaped native Project id", async () => {
    const root = path.join(await tempDirs.createTempDir(), "uuid-project-id");
    await initFramework({ target: root, name: "Readable only", archetype: "solve" });
    const file = path.join(root, "project", "project.yaml");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        /^id: .*$/m,
        "id: 123e4567-e89b-42d3-a456-426614174000",
      ),
      "utf8",
    );
    expect((await checkFramework({ root })).ok).toBe(false);
  });

  it("fails check for a malformed or open-ended Project envelope", async () => {
    const root = path.join(await tempDirs.createTempDir(), "invalid");
    await initFramework({ target: root, name: "Invalid", archetype: "study" });
    await writeFile(
      path.join(root, "project", "project.yaml"),
      "__schema: 1\nid: not-readable\nname: Invalid\nauthority:\n  mode: native\n  pointer: README.md\nextra: forbidden\n",
      "utf8",
    );
    const check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(check.rows).toContainEqual(
      expect.objectContaining({ path: "project/project.yaml", status: "error" }),
    );
  });

  it("rejects a redirected Project before init can write outside the workspace", async () => {
    const root = path.join(await tempDirs.createTempDir(), "redirect-init");
    const outside = path.join(await tempDirs.createTempDir(), "outside-project");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(
      outside,
      path.join(root, "project"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      initFramework({ target: root, name: "Redirect", archetype: "solve" }),
    ).rejects.toThrow(/real directory|symlink|junction|reparse point|resolves through/);
    expect(await readdir(outside)).toEqual([]);
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(false);
  });

  it("rejects a redirected overlay Project ancestor before attach probes or writes it", async () => {
    const root = await productRepo("redirect-attach");
    const outside = path.join(await tempDirs.createTempDir(), "outside-assay");
    await mkdir(path.join(outside, "project"), { recursive: true });
    await symlink(
      outside,
      path.join(root, ".assay"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      attachExistingRepo({ root, name: "Redirect attach", archetype: "solve", noTrack: true }),
    ).rejects.toThrow(/real directory|symlink|junction|reparse point|resolves through/);
    expect(await readdir(outside)).toEqual(["project"]);
    expect(await readdir(path.join(outside, "project"))).toEqual([]);
    expect(await exists(path.join(outside, "manifest.json"))).toBe(false);
  }, 60_000);

  it("reports an existing redirected Project and update refuses to follow it", async () => {
    const root = path.join(await tempDirs.createTempDir(), "redirect-existing");
    await initFramework({ target: root, name: "Redirect existing", archetype: "solve" });
    const outside = path.join(await tempDirs.createTempDir(), "outside-existing");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "sentinel.txt"), "unchanged", "utf8");
    await rm(path.join(root, "project"), { recursive: true });
    await symlink(
      outside,
      path.join(root, "project"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(check.rows).toContainEqual(
      expect.objectContaining({ path: "project", status: "error" }),
    );
    await expect(getFrameworkStatus({ root })).rejects.toThrow(
      /real directory|symlink|junction|reparse point|resolves through/,
    );
    await expect(applyUpdate({ root })).rejects.toThrow(
      /real directory|symlink|junction|reparse point|resolves through/,
    );
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
  });

  it("requires ordinary authority and roadmap files while preserving prose edits", async () => {
    const root = path.join(await tempDirs.createTempDir(), "required-files");
    await initFramework({ target: root, name: "Required files", archetype: "solve" });
    const authority = path.join(root, "project", "README.md");
    const roadmap = path.join(root, "project", "roadmap", "README.md");

    await rm(authority);
    let check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) => row.status === "error" && row.message?.includes("authority pointer"),
      ),
    ).toBe(true);
    await applyUpdate({ root });
    expect(await exists(authority)).toBe(true);

    await rm(roadmap);
    check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(
      check.rows.some((row) => row.status === "error" && row.message?.includes("roadmap guide")),
    ).toBe(true);
    await applyUpdate({ root });

    await writeFile(authority, "# Project-owned edited charter\n", "utf8");
    await writeFile(roadmap, "# Project-owned edited roadmap\n", "utf8");
    expect((await checkFramework({ root })).ok).toBe(true);
    await applyUpdate({ root });
    expect(await readFile(authority, "utf8")).toBe("# Project-owned edited charter\n");
    expect(await readFile(roadmap, "utf8")).toBe("# Project-owned edited roadmap\n");

    await rm(roadmap);
    await mkdir(roadmap);
    check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(
      check.rows.some((row) => row.status === "error" && row.message?.includes("regular file")),
    ).toBe(true);
  });

  it("creates the native Source zone on first source use in explore", async () => {
    const root = path.join(await tempDirs.createTempDir(), "lazy-source");
    await initFramework({ target: root, name: "Lazy source", archetype: "explore" });
    const source = path.join(await tempDirs.createTempDir(), "living-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Living source\n", "utf8");

    await addSource({ root, source, alias: "living", capture: "archive" });

    expect(await exists(path.join(root, "sources", "living", "source.yaml"))).toBe(true);
    expect(await exists(path.join(root, "analyses"))).toBe(false);
    const check = await checkFramework({ root, includeAdvisories: true });
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.message?.includes("not declared by archetype"))).toBe(
      false,
    );
  });

  it.each(["study", "solve", "explore"])(
    "creates the minimal Project in an overlay for %s",
    async (archetype) => {
      const root = await productRepo(`overlay-${archetype}`);
      await attachExistingRepo({
        root,
        name: "Overlay",
        archetype,
        privacy: "private",
        noTrack: true,
      });
      expect((await readdir(path.join(root, ".assay", "project"))).sort()).toEqual([
        "README.md",
        "project.yaml",
        "roadmap",
      ]);
      expect(await exists(path.join(root, "project"))).toBe(false);
      const retiredName = ["itera", "tions"].join("");
      expect((await loadManifest(root))?.layout.paths).not.toHaveProperty(retiredName);
      expect(await exists(path.join(root, ".assay", retiredName))).toBe(false);
      expect(await exists(path.join(root, retiredName))).toBe(false);
      if (archetype === "study") {
        expect(await exists(path.join(root, ".assay", "sources"))).toBe(true);
        expect(await exists(path.join(root, ".assay", "analyses"))).toBe(true);
      } else {
        expect(await exists(path.join(root, ".assay", "sources"))).toBe(false);
        expect(await exists(path.join(root, ".assay", "analyses"))).toBe(false);
      }
      expect((await checkFramework({ root })).ok).toBe(true);
    },
    60_000,
  );

  it.each(["file", "directory"] as const)(
    "ignores an ordinary product-root project %s in a legal overlay",
    async (kind) => {
      const root = await productRepo(`overlay-product-project-${kind}`);
      const productProject = path.join(root, "project");
      if (kind === "file") {
        await writeFile(productProject, "product-owned file\n", "utf8");
      } else {
        await mkdir(productProject);
        await writeFile(
          path.join(productProject, "owned.txt"),
          "product-owned directory\n",
          "utf8",
        );
      }
      await attachExistingRepo({
        root,
        name: `Overlay ${kind}`,
        archetype: "solve",
        noTrack: true,
      });

      expect((await checkFramework({ root })).ok).toBe(true);
      expect((await getFrameworkStatus({ root })).nativeProject?.path).toBe(
        ".assay/project/project.yaml",
      );
      expect((await applyUpdate({ root, dryRun: true })).dryRun).toBe(true);
      if (kind === "file") {
        expect(await readFile(productProject, "utf8")).toBe("product-owned file\n");
      } else {
        expect(await readFile(path.join(productProject, "owned.txt"), "utf8")).toBe(
          "product-owned directory\n",
        );
      }
    },
    60_000,
  );

  it("rejects a redirected .assay/project in an otherwise legal overlay", async () => {
    const root = await productRepo("overlay-project-redirect");
    await attachExistingRepo({ root, name: "Overlay redirect", archetype: "solve", noTrack: true });
    const outside = path.join(await tempDirs.createTempDir(), "outside-overlay-project");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "sentinel.txt"), "unchanged", "utf8");
    await rm(path.join(root, ".assay", "project"), { recursive: true });
    await symlink(
      outside,
      path.join(root, ".assay", "project"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const check = await checkFramework({ root });
    expect(check.ok).toBe(false);
    expect(check.rows).toContainEqual(
      expect.objectContaining({ path: ".assay/project", status: "error" }),
    );
    await expect(getFrameworkStatus({ root })).rejects.toThrow(
      /real directory|symlink|junction|reparse point|resolves through/,
    );
    await expect(applyUpdate({ root, dryRun: true })).rejects.toThrow(
      /real directory|symlink|junction|reparse point|resolves through/,
    );
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  }, 60_000);
});

describe("Project conversion", () => {
  it("preserves Project identity while hoisting an overlay", async () => {
    const root = await productRepo("convert-source");
    await attachExistingRepo({ root, name: "Convert", archetype: "explore", noTrack: true });
    const before = await nativeProject(root);
    const target = path.join(path.dirname(root), "convert-target");
    await convertOverlayToStandalone({ root, target });
    expect((await nativeProject(target)).id).toBe(before.id);
    const check = await checkFramework({ root: target });
    expect(check.ok, JSON.stringify(check.rows, null, 2)).toBe(true);
  }, 60_000);

  it("fail-closes create, update, and archive across a copy conversion", async () => {
    const root = await productRepo("convert-roadmap-source");
    await attachExistingRepo({
      root,
      name: "Convert Roadmap",
      archetype: "explore",
      noTrack: true,
    });
    const editable = await createRoadmap({ root, title: "Editable" });
    const archivable = await realizeRoadmap({
      root,
      id: (await createRoadmap({ root, title: "Archivable" })).item.id,
    });
    const target = path.join(path.dirname(root), "convert-roadmap-target");
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    setConvertRoadmapProbeForTests(async () => {
      enteredResolve?.();
      await release;
    });
    const converting = convertOverlayToStandalone({ root, target });
    await entered;
    await Promise.all([
      expect(createRoadmap({ root, title: "Concurrent" })).rejects.toMatchObject({
        code: "ROADMAP_CONFLICT",
      }),
      expect(updateRoadmap({ root, id: editable.item.id, title: "Updated" })).rejects.toMatchObject(
        { code: "ROADMAP_CONFLICT" },
      ),
      expect(archiveRoadmap({ root, id: archivable.item.id })).rejects.toMatchObject({
        code: "ROADMAP_CONFLICT",
      }),
    ]);
    releaseResolve?.();
    await converting;

    expect((await showRoadmap({ root, id: editable.item.id })).item.title).toBe("Editable");
    expect((await showRoadmap({ root, id: archivable.item.id })).archived).toBe(false);
    expect((await showRoadmap({ root: target, id: editable.item.id })).item.title).toBe("Editable");
    expect((await showRoadmap({ root: target, id: archivable.item.id })).archived).toBe(false);
  }, 60_000);

  it("fails a Roadmap create at the move boundary instead of recreating Project", async () => {
    const root = await productRepo("convert-roadmap-move-source");
    await attachExistingRepo({ root, name: "Move Roadmap", archetype: "explore", noTrack: true });
    await createRoadmap({ root, title: "Moved" });
    const target = path.join(path.dirname(root), "convert-roadmap-move-target");
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    setConvertRoadmapProbeForTests(async () => {
      enteredResolve?.();
      await release;
    });
    const converting = convertOverlayToStandalone({ root, target, move: true });
    await entered;
    await expect(createRoadmap({ root, title: "Must not appear" })).rejects.toMatchObject({
      code: "ROADMAP_CONFLICT",
    });
    releaseResolve?.();
    await converting;
    expect(await exists(path.join(root, ".assay", "project"))).toBe(false);
    expect((await showRoadmap({ root: target, id: "roadmap-0001-moved" })).item.title).toBe(
      "Moved",
    );
  }, 60_000);

  it("fails conversion before writes when the Roadmap coordination path is redirected", async () => {
    const root = await productRepo("convert-roadmap-lock-redirect");
    await attachExistingRepo({ root, name: "Redirect Lock", archetype: "explore", noTrack: true });
    await createRoadmap({ root, title: "Protected" });
    const locks = path.join(root, ".assay", "roadmap-locks");
    const outside = path.join(path.dirname(root), "outside-roadmap-locks");
    await rm(locks, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, locks, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(path.dirname(root), "convert-roadmap-lock-target");
    await expect(convertOverlayToStandalone({ root, target })).rejects.toMatchObject({
      code: "ROADMAP_STORAGE_BOUNDARY",
    });
    expect(await exists(target)).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  }, 60_000);
});
