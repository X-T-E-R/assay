import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyUpdate,
  buildLayoutMigrationPlan,
  computeHash,
  desiredRuntimeTemplates,
  initFramework,
  loadManifest,
  loadSystemsRegistry,
  migrateLayout,
  saveManifest,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-core-update-"));
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

async function readmeTemplate() {
  const template = (await desiredRuntimeTemplates("Demo", "study", "learning")).find(
    (candidate) => candidate.path === "README.md",
  );
  if (!template) {
    throw new Error("README.md template missing from registry.");
  }
  return template;
}

async function initUpdateFixture(): Promise<string> {
  const root = path.join(await tempDir(), "demo");
  await initFramework({ target: root, name: "Demo" });
  return root;
}

async function addLegacySystemManagedFiles(root: string): Promise<void> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new Error("manifest missing");
  }
  const legacyFiles: Record<string, string> = {
    "systems/demo-core/README.md": "# Legacy system README\n",
    "systems/demo-core/framework.yaml":
      "system:\n  name: demo-core\n  status: primary\n  version: 0.2.0\n",
  };
  for (const [relativePath, content] of Object.entries(legacyFiles)) {
    const absolutePath = path.join(root, relativePath);
    const finalContent = (await exists(absolutePath))
      ? await readFile(absolutePath, "utf8")
      : content;
    if (!(await exists(absolutePath))) {
      await writeFile(absolutePath, finalContent, "utf8");
    }
    manifest.managed_files[relativePath] = {
      template_id: `legacy.${relativePath}`,
      hash: computeHash(finalContent),
      installed_version: "0.2.0",
      protected: false,
      executable: false,
      updated_at: "2026-06-17T00:00:00+08:00",
    };
  }
  manifest.project.core = "demo-core";
  manifest.layout_version = 2;
  await saveManifest(root, manifest);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("applyUpdate", () => {
  it("auto-updates clean managed files and records a backup", async () => {
    const root = await initUpdateFixture();
    const template = await readmeTemplate();
    const oldContent = "# Old generated README\n";
    const readme = path.join(root, "README.md");
    await writeFile(readme, oldContent, "utf8");
    const manifest = await loadManifest(root);
    if (!manifest) {
      throw new Error("manifest missing");
    }
    const readmeRecord = manifest.managed_files["README.md"];
    if (!readmeRecord) {
      throw new Error("README.md manifest record missing");
    }
    manifest.managed_files["README.md"] = {
      ...readmeRecord,
      hash: computeHash(oldContent),
    };
    await saveManifest(root, manifest);

    const result = await applyUpdate({
      root,
      now: new Date("2026-06-14T08:09:10"),
    });

    expect(result.analysis.changes.auto_update.map((change) => change.path)).toContain("README.md");
    expect(result.report.updated_files).toContain("README.md");
    expect(await readFile(readme, "utf8")).toBe(template.content);
    expect(result.backup?.copied).toEqual(
      expect.arrayContaining([".framework/manifest.json", ".framework/VERSION", "README.md"]),
    );
    expect(
      await readFile(path.join(root, result.backup?.relativePath ?? "", "README.md"), "utf8"),
    ).toBe(oldContent);
  });

  it("skips user-modified managed files by default", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await writeFile(readme, "# User modified README\n", "utf8");

    const result = await applyUpdate({ root });

    expect(result.analysis.changes.modified_by_user.map((change) => change.path)).toContain(
      "README.md",
    );
    expect(result.report.skipped_files).toContain("README.md");
    expect(result.report.conflicted_files).toContain("README.md");
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");
  });

  it("force overwrites modified files only when requested", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await writeFile(readme, "# User modified README\n", "utf8");

    await applyUpdate({ root, action: "skip" });
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");

    const forced = await applyUpdate({ root, action: "force" });
    expect(forced.report.updated_files).toContain("README.md");
    expect(await readFile(readme, "utf8")).toBe((await readmeTemplate()).content);
  });

  it("create-new writes .new files without changing modified files", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await writeFile(readme, "# User modified README\n", "utf8");

    const result = await applyUpdate({ root, action: "create-new" });

    expect(result.report.new_copies).toContain("README.md.new");
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");
    expect(await readFile(path.join(root, "README.md.new"), "utf8")).toBe(
      (await readmeTemplate()).content,
    );
  });

  it("keeps user-deleted managed files deleted", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await rm(readme);

    const result = await applyUpdate({ root, action: "force" });
    const manifest = await loadManifest(root);

    expect(result.analysis.changes.user_deleted.map((change) => change.path)).toContain(
      "README.md",
    );
    expect(result.report.skipped_files).toContain("README.md (user-deleted)");
    expect(await exists(readme)).toBe(false);
    expect(manifest?.user_deleted).toContain("README.md");
  });

  it("skips untracked existing files or copies them to .new depending on action", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    const userContent = "# Untracked user README\n";
    const manifest = await loadManifest(root);
    if (!manifest) {
      throw new Error("manifest missing");
    }
    const { "README.md": _removed, ...managedFiles } = manifest.managed_files;
    manifest.managed_files = managedFiles;
    await saveManifest(root, manifest);
    await writeFile(readme, userContent, "utf8");

    const skipped = await applyUpdate({ root, action: "skip" });
    expect(skipped.analysis.changes.untracked_existing.map((change) => change.path)).toContain(
      "README.md",
    );
    expect(skipped.report.skipped_files).toContain("README.md");
    expect(await readFile(readme, "utf8")).toBe(userContent);

    const copied = await applyUpdate({ root, action: "create-new" });
    expect(copied.report.new_copies).toContain("README.md.new");
    expect(await readFile(readme, "utf8")).toBe(userContent);
    expect(await readFile(path.join(root, "README.md.new"), "utf8")).toBe(
      (await readmeTemplate()).content,
    );
  });

  it("dry-run performs no writes", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await writeFile(readme, "# User modified README\n", "utf8");

    const beforeManifest = await readFile(path.join(root, ".framework", "manifest.json"), "utf8");
    const result = await applyUpdate({ root, action: "force", dryRun: true });

    expect(result.report.notes).toContain("dry-run: no changes applied");
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");
    expect(await readFile(path.join(root, ".framework", "manifest.json"), "utf8")).toBe(
      beforeManifest,
    );
    expect(await readdir(path.join(root, ".framework", "backups"))).toEqual([".gitkeep"]);
  });
});

describe("layout migration", () => {
  it("plans legacy references and experiments layout changes", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "references", "202401"), { recursive: true });
    await mkdir(path.join(root, "references", "frozen"), { recursive: true });
    await mkdir(path.join(root, "experiments", "trial"), { recursive: true });
    await mkdir(path.join(root, "knowledge", "evaluations"), { recursive: true });

    const plan = await buildLayoutMigrationPlan({ root });

    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "copy-dir",
          from: "references/202401",
          to: "references/frozen/202401",
        }),
        expect.objectContaining({ type: "copy-dir", from: "experiments", to: "iterations" }),
        expect.objectContaining({
          type: "manual-review",
          from: "knowledge/evaluations",
        }),
      ]),
    );
  });

  it("applies migration by copying rather than destructively moving", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "references", "202401"), { recursive: true });
    await mkdir(path.join(root, "experiments", "trial"), { recursive: true });
    await mkdir(path.join(root, ".assay"), { recursive: true });
    await writeFile(path.join(root, "references", "202401", "source.md"), "# Source\n", "utf8");
    await writeFile(path.join(root, "experiments", "trial", "plan.md"), "# Plan\n", "utf8");
    await writeFile(path.join(root, ".assay", "queue.json"), "[]\n", "utf8");

    const result = await migrateLayout({
      root,
      apply: true,
      now: new Date("2026-06-14T08:09:10"),
    });

    expect(result.backup).toBeUndefined();
    expect("backup_dir" in result.plan).toBe(false);
    expect(await exists(path.join(root, ".framework", "backups", "20260614-080910"))).toBe(false);
    expect(await exists(path.join(root, "references", "202401", "source.md"))).toBe(true);
    expect(await exists(path.join(root, "references", "frozen", "202401", "source.md"))).toBe(true);
    expect(await exists(path.join(root, "experiments", "trial", "plan.md"))).toBe(true);
    expect(await exists(path.join(root, "iterations", "trial", "plan.md"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "queue.json"))).toBe(true);
    expect(await exists(path.join(root, ".framework", "legacy-assay", "queue.json"))).toBe(true);
    if (!result.eventFile) {
      throw new Error("layout migration event missing");
    }
    const eventLines = (await readFile(path.join(root, result.eventFile), "utf8"))
      .trim()
      .split("\n");
    const event = JSON.parse(eventLines[eventLines.length - 1] ?? "{}");
    expect(event.backup).toBeUndefined();
  });
});

describe("v2 to v3 layout migration", () => {
  it("plans systems-registry creation from manifest core", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    // Create a system directory with .git (independent-git)
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });
    await writeFile(
      path.join(root, "systems", "demo-core", "framework.yaml"),
      "system:\n  name: demo-core\n  status: primary\n  version: 0.2.0\n",
      "utf8",
    );
    await addLegacySystemManagedFiles(root);

    const plan = await buildLayoutMigrationPlan({ root });

    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "create-systems-registry",
          action: "create",
        }),
        expect.objectContaining({
          type: "generate-contract",
          from: "systems/demo-core",
          to: "systems/demo-core/system.yaml",
        }),
        expect.objectContaining({
          type: "mark-user-deleted",
          from: "systems/demo-core/README.md",
        }),
        expect.objectContaining({
          type: "upgrade-manifest",
          action: "upgrade",
        }),
      ]),
    );
  });

  it("does not plan v2-to-v3 steps when registry already exists", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    // Create registry file to simulate v3 already applied
    await writeFile(
      path.join(root, ".framework", "systems-registry.json"),
      JSON.stringify({
        __schema: 1,
        primary: "demo-core",
        systems: {},
        updated_at: "2026-06-17T00:00:00+08:00",
      }),
      "utf8",
    );

    const plan = await buildLayoutMigrationPlan({ root });

    expect(plan.steps.some((s) => s.type === "create-systems-registry")).toBe(false);
    expect(plan.steps.some((s) => s.type === "upgrade-manifest")).toBe(false);
  });

  it("upgrades an old layout_version without overwriting an existing systems registry", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await writeFile(
      path.join(root, ".framework", "systems-registry.json"),
      JSON.stringify({
        __schema: 1,
        primary: "demo-core",
        systems: {
          "demo-core": {
            name: "demo-core",
            path: "systems/demo-core",
            status: "primary",
            vcs: "embedded",
            vcs_ref: "",
            version: "0.1.0",
            contract_file: "systems/demo-core/system.yaml",
            supersedes: [],
            absorbed_on: "2026-06-17",
            archived_on: null,
            archive_path: null,
          },
        },
        updated_at: "2026-06-17T00:00:00+08:00",
      }),
      "utf8",
    );
    const manifest = await loadManifest(root);
    if (!manifest) {
      throw new Error("manifest missing");
    }
    manifest.layout_version = 2;
    await saveManifest(root, manifest);

    const plan = await buildLayoutMigrationPlan({ root });

    expect(plan.steps.some((s) => s.type === "create-systems-registry")).toBe(false);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "upgrade-manifest",
          action: "upgrade",
        }),
      ]),
    );

    const result = await migrateLayout({ root, apply: true, now: new Date("2026-06-17T10:00:00") });
    const upgradedManifest = await loadManifest(root);
    const registry = await loadSystemsRegistry(root);

    expect(result.backup).toBeUndefined();
    expect("backup_dir" in result.plan).toBe(false);
    expect(upgradedManifest?.layout_version).toBe(3);
    expect(registry?.primary).toBe("demo-core");
    expect(Object.keys(registry?.systems ?? {})).toEqual(["demo-core"]);
  });

  it("backs up only pre-existing files overwritten by explicit migration backup mode", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });
    await writeFile(
      path.join(root, "systems", "demo-core", "framework.yaml"),
      "system:\n  name: demo-core\n  status: primary\n  version: 0.2.0\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "systems", "demo-core", "system.yaml"),
      "system:\n  name: user-owned-contract\n",
      "utf8",
    );
    await addLegacySystemManagedFiles(root);

    const result = await migrateLayout({
      root,
      apply: true,
      backup: true,
      now: new Date("2026-06-17T10:00:00"),
    });

    expect(result.backup?.relativePath).toBe(".framework/backups/20260617-100000");
    expect(result.backup?.copied).toEqual([
      ".framework/manifest.json",
      "systems/demo-core/system.yaml",
    ]);
    expect(result.plan.backup_dir).toBe(".framework/backups/20260617-100000");
    expect(
      await readFile(
        path.join(
          root,
          ".framework",
          "backups",
          "20260617-100000",
          "systems",
          "demo-core",
          "system.yaml",
        ),
        "utf8",
      ),
    ).toBe("system:\n  name: user-owned-contract\n");
    expect(
      await exists(
        path.join(
          root,
          ".framework",
          "backups",
          "20260617-100000",
          "systems",
          "demo-core",
          "README.md",
        ),
      ),
    ).toBe(false);
    expect(
      await exists(
        path.join(root, ".framework", "backups", "20260617-100000", ".framework", "VERSION"),
      ),
    ).toBe(false);
    if (!result.eventFile) {
      throw new Error("layout migration event missing");
    }
    const eventLines = (await readFile(path.join(root, result.eventFile), "utf8"))
      .trim()
      .split("\n");
    const event = JSON.parse(eventLines[eventLines.length - 1] ?? "{}");
    expect(event.backup).toBe(".framework/backups/20260617-100000");
  });

  it("applies migration: creates registry, contracts, removes stale managed files", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    // Create system directory with .git and legacy framework.yaml
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });
    await mkdir(path.join(root, "systems", "demo-core", ".git"), { recursive: true });
    await writeFile(
      path.join(root, "systems", "demo-core", "framework.yaml"),
      "system:\n  name: demo-core\n  status: primary\n  version: 0.2.0\n  supersedes: [old-system]\n",
      "utf8",
    );
    await addLegacySystemManagedFiles(root);
    // Create an archived system
    await mkdir(path.join(root, "systems", "archive", "2026-06-16-pre-old", "old-system"), {
      recursive: true,
    });

    const result = await migrateLayout({
      root,
      apply: true,
      now: new Date("2026-06-17T10:00:00"),
    });

    expect(result.dryRun).toBe(false);

    // Registry created
    const registryContent = await readFile(
      path.join(root, ".framework", "systems-registry.json"),
      "utf8",
    );
    const registry = JSON.parse(registryContent);
    expect(registry.primary).toBe("demo-core");
    expect(registry.systems["demo-core"]).toMatchObject({
      status: "primary",
      vcs: "independent-git",
      version: "0.2.0",
    });
    expect(registry.systems["demo-core"].supersedes).toEqual(["old-system"]);
    expect(registry.systems["old-system"]).toMatchObject({ status: "archived" });

    // Contract file generated
    expect(await exists(path.join(root, "systems", "demo-core", "system.yaml"))).toBe(true);

    // Stale managed files removed from manifest
    const manifest = await loadManifest(root);
    expect(Object.keys(manifest?.managed_files ?? {})).not.toContain("systems/demo-core/README.md");
    expect(manifest?.user_deleted).toContain("systems/demo-core/README.md");
  });
});
