import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASSAY_AGENTS_END_MARKER,
  ASSAY_AGENTS_FILE,
  ASSAY_AGENTS_MALFORMED_REASON,
  ASSAY_AGENTS_START_MARKER,
  adoptExistingProject,
  applyAssayAgentsBlock,
  applyUpdate,
  initFramework,
  loadManifest,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-core-agents-"));
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

async function readAgents(root: string): Promise<string> {
  return readFile(path.join(root, ASSAY_AGENTS_FILE), "utf8");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Assay AGENTS.md managed block", () => {
  it("creates an AGENTS.md file when installing the block", async () => {
    const root = await tempDir();

    const result = await applyAssayAgentsBlock({ root, mode: "install" });

    expect(result).toMatchObject({ action: "create", changed: true, dryRun: false });
    const content = await readAgents(root);
    expect(content).toContain(ASSAY_AGENTS_START_MARKER);
    expect(content).toContain("This workspace is managed by Assay.");
    expect(content).toContain(ASSAY_AGENTS_END_MARKER);
    expect(content).not.toContain("skills/assay-builder/SKILL.md");
  });

  it("appends to existing AGENTS.md content without markers", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, ASSAY_AGENTS_FILE), "# Local Rules\n\nKeep this.\n", "utf8");

    const result = await applyAssayAgentsBlock({ root, mode: "install" });

    expect(result).toMatchObject({ action: "append", changed: true });
    const content = await readAgents(root);
    expect(content.startsWith("# Local Rules\n\nKeep this.\n")).toBe(true);
    expect(content).toContain(ASSAY_AGENTS_START_MARKER);
  });

  it("replaces only the Assay block and preserves outside content", async () => {
    const root = await tempDir();
    await writeFile(
      path.join(root, ASSAY_AGENTS_FILE),
      [
        "# Local Rules",
        "",
        "Before.",
        ASSAY_AGENTS_START_MARKER,
        "stale content",
        ASSAY_AGENTS_END_MARKER,
        "After.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await applyAssayAgentsBlock({ root, mode: "refresh-existing" });

    expect(result).toMatchObject({ action: "replace", changed: true });
    const content = await readAgents(root);
    expect(content).toContain("# Local Rules\n\nBefore.\n");
    expect(content).toContain("\nAfter.\n");
    expect(content).not.toContain("stale content");
    expect(content).toContain("Use Assay commands for `.framework/` state.");
  });

  it("skips default refresh when AGENTS.md is missing or lacks the Assay block", async () => {
    const missingRoot = await tempDir();
    const missing = await applyAssayAgentsBlock({ root: missingRoot, mode: "refresh-existing" });
    expect(missing).toMatchObject({ action: "skip", changed: false });
    expect(await exists(path.join(missingRoot, ASSAY_AGENTS_FILE))).toBe(false);

    const plainRoot = await tempDir();
    await writeFile(path.join(plainRoot, ASSAY_AGENTS_FILE), "# Local Rules\n", "utf8");
    const plain = await applyAssayAgentsBlock({ root: plainRoot, mode: "refresh-existing" });
    expect(plain).toMatchObject({ action: "skip", changed: false });
    expect(await readAgents(plainRoot)).toBe("# Local Rules\n");
  });

  it("dry-run reports the intended action without writing", async () => {
    const root = await tempDir();

    const result = await applyAssayAgentsBlock({ root, mode: "install", dryRun: true });

    expect(result).toMatchObject({ action: "create", changed: true, dryRun: true });
    expect(await exists(path.join(root, ASSAY_AGENTS_FILE))).toBe(false);
  });

  it("init injects the block by default and leaves it out of managed_files", async () => {
    const root = path.join(await tempDir(), "demo");

    const result = await initFramework({ target: root, name: "Demo" });

    expect(result.report.created_files).toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(root)).toContain(ASSAY_AGENTS_START_MARKER);
    expect((await loadManifest(root))?.managed_files[ASSAY_AGENTS_FILE]).toBeUndefined();
  });

  it("init skips AGENTS.md when agents are disabled", async () => {
    const root = path.join(await tempDir(), "demo");

    const result = await initFramework({ target: root, name: "Demo", agents: false });

    expect(result.report.created_files).not.toContain(ASSAY_AGENTS_FILE);
    expect(await exists(path.join(root, ASSAY_AGENTS_FILE))).toBe(false);
  });

  it("init reports malformed Assay markers and leaves the file untouched", async () => {
    const root = path.join(await tempDir(), "demo");
    await mkdir(root, { recursive: true });
    const malformed = `# Local Rules\n\n${ASSAY_AGENTS_START_MARKER}\npartial\n`;
    await writeFile(path.join(root, ASSAY_AGENTS_FILE), malformed, "utf8");

    const result = await initFramework({ target: root, name: "Demo" });

    expect(result.report.notes).toContain(`AGENTS.md: ${ASSAY_AGENTS_MALFORMED_REASON}`);
    expect(await readAgents(root)).toBe(malformed);
  });

  it("adopt --apply injects by default and can skip with agents disabled", async () => {
    const root = path.join(await tempDir(), "existing");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");

    await adoptExistingProject({ root, name: "Adopted", apply: true });
    expect(await readAgents(root)).toContain(ASSAY_AGENTS_START_MARKER);

    const noAgentsRoot = path.join(await tempDir(), "no-agents");
    await mkdir(path.join(noAgentsRoot, "src"), { recursive: true });
    await writeFile(path.join(noAgentsRoot, "src", "index.ts"), "export {};\n", "utf8");

    await adoptExistingProject({
      root: noAgentsRoot,
      name: "No Agents",
      apply: true,
      agents: false,
    });
    expect(await exists(path.join(noAgentsRoot, ASSAY_AGENTS_FILE))).toBe(false);
  });

  it("ordinary update refreshes only existing Assay blocks and respects deletion", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo" });
    await writeFile(
      path.join(root, ASSAY_AGENTS_FILE),
      `${ASSAY_AGENTS_START_MARKER}\nstale\n${ASSAY_AGENTS_END_MARKER}\n`,
      "utf8",
    );

    const refreshed = await applyUpdate({ root });
    expect(refreshed.report.updated_files).toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(root)).not.toContain("stale");

    await rm(path.join(root, ASSAY_AGENTS_FILE));
    const deleted = await applyUpdate({ root });
    expect(deleted.report.created_files).not.toContain(ASSAY_AGENTS_FILE);
    expect(await exists(path.join(root, ASSAY_AGENTS_FILE))).toBe(false);

    await writeFile(path.join(root, ASSAY_AGENTS_FILE), "# User Rules\n", "utf8");
    const noBlock = await applyUpdate({ root });
    expect(noBlock.report.updated_files).not.toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(root)).toBe("# User Rules\n");
  });

  it("update with agents enabled creates or appends the block, and dry-run does not write", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", agents: false });

    const dryRun = await applyUpdate({ root, agents: true, dryRun: true });
    expect(dryRun.report.notes).toContain("AGENTS.md: would create Assay managed block");
    expect(await exists(path.join(root, ASSAY_AGENTS_FILE))).toBe(false);

    const created = await applyUpdate({ root, agents: true });
    expect(created.report.created_files).toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(root)).toContain(ASSAY_AGENTS_START_MARKER);

    const plainRoot = path.join(await tempDir(), "plain");
    await initFramework({ target: plainRoot, name: "Plain", agents: false });
    await writeFile(path.join(plainRoot, ASSAY_AGENTS_FILE), "# User Rules\n", "utf8");

    const appended = await applyUpdate({ root: plainRoot, agents: true });
    expect(appended.report.updated_files).toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(plainRoot)).toContain("# User Rules\n\n");
    expect(await readAgents(plainRoot)).toContain(ASSAY_AGENTS_START_MARKER);
  });

  it("update reports malformed Assay markers without rewriting the file", async () => {
    const root = path.join(await tempDir(), "demo");
    await initFramework({ target: root, name: "Demo", agents: false });
    const malformed = `# Local Rules\n\n${ASSAY_AGENTS_START_MARKER}\npartial\n`;
    await writeFile(path.join(root, ASSAY_AGENTS_FILE), malformed, "utf8");

    const dryRun = await applyUpdate({ root, agents: true, dryRun: true });
    expect(dryRun.report.notes).toContain(`AGENTS.md: ${ASSAY_AGENTS_MALFORMED_REASON}`);
    expect(await readAgents(root)).toBe(malformed);

    const applied = await applyUpdate({ root, agents: true });
    expect(applied.report.notes).toContain(`AGENTS.md: ${ASSAY_AGENTS_MALFORMED_REASON}`);
    expect(applied.report.updated_files).not.toContain(ASSAY_AGENTS_FILE);
    expect(await readAgents(root)).toBe(malformed);
  });
});
