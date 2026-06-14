import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyUpdate,
  buildLayoutMigrationPlan,
  computeHash,
  desiredTemplates,
  initFramework,
  loadManifest,
  migrateLayout,
  saveManifest,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-core-update-"));
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

function readmeTemplate() {
  const template = desiredTemplates("Demo", "demo-core").find(
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("applyUpdate", () => {
  it("auto-updates clean managed files and records a backup", async () => {
    const root = await initUpdateFixture();
    const template = readmeTemplate();
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
    expect(await readFile(readme, "utf8")).toBe(readmeTemplate().content);
  });

  it("create-new writes .new files without changing modified files", async () => {
    const root = await initUpdateFixture();
    const readme = path.join(root, "README.md");
    await writeFile(readme, "# User modified README\n", "utf8");

    const result = await applyUpdate({ root, action: "create-new" });

    expect(result.report.new_copies).toContain("README.md.new");
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");
    expect(await readFile(path.join(root, "README.md.new"), "utf8")).toBe(readmeTemplate().content);
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
    expect(await readFile(path.join(root, "README.md.new"), "utf8")).toBe(readmeTemplate().content);
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
    await mkdir(path.join(root, ".metasystem"), { recursive: true });
    await writeFile(path.join(root, "references", "202401", "source.md"), "# Source\n", "utf8");
    await writeFile(path.join(root, "experiments", "trial", "plan.md"), "# Plan\n", "utf8");
    await writeFile(path.join(root, ".metasystem", "queue.json"), "[]\n", "utf8");

    const result = await migrateLayout({
      root,
      apply: true,
      now: new Date("2026-06-14T08:09:10"),
    });

    expect(result.backup?.relativePath).toBe(".framework/backups/20260614-080910");
    expect(await exists(path.join(root, "references", "202401", "source.md"))).toBe(true);
    expect(await exists(path.join(root, "references", "frozen", "202401", "source.md"))).toBe(true);
    expect(await exists(path.join(root, "experiments", "trial", "plan.md"))).toBe(true);
    expect(await exists(path.join(root, "iterations", "trial", "plan.md"))).toBe(true);
    expect(await exists(path.join(root, ".metasystem", "queue.json"))).toBe(true);
    expect(await exists(path.join(root, ".framework", "legacy-metasystem", "queue.json"))).toBe(
      true,
    );
  });
});
