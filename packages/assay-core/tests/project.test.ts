import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addReference,
  addSource,
  applyUpdate,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  createAnalysis,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  loadNativeProject,
  migrateProjectAuthority,
  recordManagedFile,
  resolveWorkspaceLayout,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-project");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
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
      expect((await checkFramework({ root })).ok).toBe(true);
    },
    60_000,
  );

  it("keeps the Project id stable across repeated init and update", async () => {
    const root = path.join(await tempDirs.createTempDir(), "stable");
    await initFramework({ target: root, name: "Stable", archetype: "solve" });
    const first = await nativeProject(root);
    await initFramework({ target: root, name: "Stable", archetype: "solve" });
    await applyUpdate({ root });
    expect((await nativeProject(root)).id).toBe(first.id);
  });

  it("fails check for a malformed or open-ended Project envelope", async () => {
    const root = path.join(await tempDirs.createTempDir(), "invalid");
    await initFramework({ target: root, name: "Invalid", archetype: "study" });
    await writeFile(
      path.join(root, "project", "project.yaml"),
      "__schema: 1\nid: not-a-uuid\nname: Invalid\nauthority:\n  mode: native\n  pointer: README.md\nextra: forbidden\n",
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
      check.rows.some(
        (row) => row.status === "error" && row.message?.includes("roadmap placeholder"),
      ),
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

  it("keeps Reference and Analysis lazy for solve, then recognizes first use", async () => {
    const root = path.join(await tempDirs.createTempDir(), "lazy");
    await initFramework({ target: root, name: "Lazy", archetype: "solve" });
    expect(await exists(path.join(root, "references"))).toBe(false);
    expect(await exists(path.join(root, "analyses"))).toBe(false);

    const before = await getFrameworkStatus({ root });
    expect(before.nativeProject).toEqual(
      expect.objectContaining({ path: "project/project.yaml", authority: "native:README.md" }),
    );
    expect(before.zones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "references", files: 0 }),
        expect.objectContaining({ path: "analyses", files: 0 }),
      ]),
    );

    const source = path.join(await tempDirs.createTempDir(), "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
    await addReference({ root, source, name: "Source" });
    await createAnalysis({ root, title: "First analysis" });
    const check = await checkFramework({ root, includeAdvisories: true });
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.message?.includes("not declared by archetype"))).toBe(
      false,
    );
  });

  it("creates the native Reference zone on first source use in explore", async () => {
    const root = path.join(await tempDirs.createTempDir(), "lazy-source");
    await initFramework({ target: root, name: "Lazy source", archetype: "explore" });
    const source = path.join(await tempDirs.createTempDir(), "living-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Living source\n", "utf8");

    await addSource({ root, source, alias: "living", capture: "archive" });

    expect(await exists(path.join(root, "references", "living", "source.yaml"))).toBe(true);
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
      if (archetype === "study") {
        expect(await exists(path.join(root, ".assay", "references"))).toBe(true);
        expect(await exists(path.join(root, ".assay", "analyses"))).toBe(true);
      } else {
        expect(await exists(path.join(root, ".assay", "references"))).toBe(false);
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

describe("legacy project-authority migration", () => {
  async function legacyWorkspace(name: string): Promise<string> {
    const root = path.join(await tempDirs.createTempDir(), name);
    await initFramework({ target: root, name, archetype: "solve" });
    await rm(path.join(root, "project"), { recursive: true });
    const legacy = path.join(root, "project-authority");
    await mkdir(path.join(legacy, "policy"), { recursive: true });
    await writeFile(path.join(legacy, "README.md"), "# Managed legacy placeholder\n", "utf8");
    await writeFile(
      path.join(legacy, "policy", "README.md"),
      "# Managed policy placeholder\n",
      "utf8",
    );
    await writeFile(path.join(legacy, "policy", "rules.md"), "# Keep these bytes\n", "utf8");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.project.capabilities = ["project-authority"];
    recordManagedFile(manifest, {
      path: "project-authority/README.md",
      templateId: "project.authority.readme",
      content: "# Managed legacy placeholder\n",
    });
    recordManagedFile(manifest, {
      path: "project-authority/policy/README.md",
      templateId: "project.authority.policy.readme",
      content: "# Managed policy placeholder\n",
    });
    manifest.user_deleted = [
      "project-authority/README.md",
      "project-authority/policy/deleted.md",
      "unrelated.md",
    ];
    await saveManifest(root, manifest);
    return root;
  }

  it("previews without writes, applies transactionally, and preserves the source", async () => {
    const root = await legacyWorkspace("legacy");
    const updatePreview = await applyUpdate({ root, dryRun: true });
    expect(updatePreview.report.notes.join("\n")).toContain("migrate-authority --dry-run");
    const updated = await applyUpdate({ root });
    expect(updated.report.notes.join("\n")).toContain("legacy project-authority preserved");
    expect(await exists(path.join(root, "project"))).toBe(false);

    const preview = await migrateProjectAuthority({ root });
    expect(preview.entries).toEqual(["policy"]);
    expect(await exists(path.join(root, "project"))).toBe(false);

    const applied = await migrateProjectAuthority({ root, apply: true });
    expect(applied.eventFile).toBeTruthy();
    expect(await readFile(path.join(root, "project", "policy", "rules.md"), "utf8")).toBe(
      "# Keep these bytes\n",
    );
    expect(await readFile(path.join(root, "project-authority", "policy", "rules.md"), "utf8")).toBe(
      "# Keep these bytes\n",
    );
    expect((await loadManifest(root))?.project.capabilities).toBeUndefined();
    const migratedManifest = await loadManifest(root);
    expect(Object.keys(migratedManifest?.managed_files ?? {})).toContain(
      "project/policy/README.md",
    );
    expect(
      Object.keys(migratedManifest?.managed_files ?? {}).some((entry) =>
        entry.startsWith("project-authority/"),
      ),
    ).toBe(false);
    expect(migratedManifest?.managed_files["project/README.md"]).toBeUndefined();
    expect(migratedManifest?.user_deleted).toEqual(["project/policy/deleted.md", "unrelated.md"]);
    expect(
      await readFile(path.join(root, "project-authority", "policy", "README.md"), "utf8"),
    ).toBe("# Managed policy placeholder\n");
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("fails before writes for a non-empty target or unknown source entry", async () => {
    const conflict = await legacyWorkspace("conflict");
    await mkdir(path.join(conflict, "project"), { recursive: true });
    await writeFile(path.join(conflict, "project", "user.md"), "keep", "utf8");
    await expect(migrateProjectAuthority({ root: conflict, apply: true })).rejects.toThrow(
      /target already contains content/,
    );
    expect(await readFile(path.join(conflict, "project", "user.md"), "utf8")).toBe("keep");

    const unknown = await legacyWorkspace("unknown");
    await writeFile(path.join(unknown, "project-authority", "mystery.txt"), "keep", "utf8");
    await expect(migrateProjectAuthority({ root: unknown, apply: true })).rejects.toThrow(
      /unknown entry/,
    );
    expect(await exists(path.join(unknown, "project"))).toBe(false);
    expect(await readFile(path.join(unknown, "project-authority", "mystery.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("rejects a redirected legacy source before writing the native Project", async () => {
    const root = await legacyWorkspace("junction");
    const source = path.join(root, "project-authority");
    const actual = path.join(root, "legacy-authority-actual");
    await rename(source, actual);
    await symlink(actual, source, process.platform === "win32" ? "junction" : "dir");

    await expect(migrateProjectAuthority({ root, apply: true })).rejects.toThrow(
      /real directory|symlink|junction|reparse point/,
    );
    expect(await exists(path.join(root, "project"))).toBe(false);
    expect(await readFile(path.join(actual, "policy", "rules.md"), "utf8")).toBe(
      "# Keep these bytes\n",
    );
  });
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
});
