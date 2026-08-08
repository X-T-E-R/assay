import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createInitializedCoreWorkspace,
  createTempDirectoryFixture,
  pathExists,
} from "assay-test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyUpdate,
  checkFramework,
  computeHash,
  desiredRuntimeTemplates,
  initFramework,
  loadManifest,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-update");

async function tempDir(): Promise<string> {
  return tempDirs.createTempDir();
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
  const { root } = await createInitializedCoreWorkspace({
    tempDirs,
    directoryName: "demo",
    initialize: (target) => initFramework({ target, name: "Demo" }),
  });
  return root;
}

afterEach(async () => {
  await tempDirs.cleanup();
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
      expect.arrayContaining([".assay/manifest.json", ".assay/VERSION", "README.md"]),
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
    expect(await pathExists(readme)).toBe(false);
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

    const beforeManifest = await readFile(path.join(root, ".assay", "manifest.json"), "utf8");
    const result = await applyUpdate({ root, action: "force", dryRun: true });

    expect(result.report.notes).toContain("dry-run: no changes applied");
    expect(await readFile(readme, "utf8")).toBe("# User modified README\n");
    expect(await readFile(path.join(root, ".assay", "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(await readdir(path.join(root, ".assay", "backups"))).toEqual([".gitkeep"]);
  });
});
