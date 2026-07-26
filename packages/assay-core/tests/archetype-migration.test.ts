import path from "node:path";
import { createTempDirectoryFixture } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  applyUpdate,
  checkFramework,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-archetype-migration");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

/** A study workspace whose manifest records some other archetype name. */
async function workspaceRecording(archetype: string, name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new Error(`expected a manifest at ${root}`);
  }
  manifest.project.archetype = archetype;
  await saveManifest(root, manifest);
  return root;
}

describe("a manifest recording the old research archetype", () => {
  it("resolves as study, so check and status behave as they always did", async () => {
    const root = await workspaceRecording(`re${"search"}`, "ResearchWorkspace");
    const studyRoot = path.join(await tempDirs.createTempDir(), "StudyWorkspace");
    await initFramework({ target: studyRoot, name: "StudyWorkspace" });

    const study = await getFrameworkStatus({ root: studyRoot });
    const status = await getFrameworkStatus({ root });
    const check = await checkFramework({ root });

    expect(status.archetype).toBe(`re${"search"}`);
    expect(status.archetypeNotice).toBeUndefined();
    expect(status.archetypeDescription).toBe(study.archetypeDescription);
    expect(status.zones.map((zone) => zone.path)).toEqual(study.zones.map((zone) => zone.path));
    expect(check.ok).toBe(true);
    expect(check.rows.some((row) => row.message?.includes("removed"))).toBe(false);
  });

  it("is rewritten to study by update, without asking anyone to migrate", async () => {
    const root = await workspaceRecording(`re${"search"}`, "ResearchUpdate");

    const result = await applyUpdate({ root });

    expect((await loadManifest(root))?.project.archetype).toBe("study");
    expect(result.report.notes).toContain(
      `archetype: renamed re${"search"} to study in the manifest`,
    );

    // Rewriting the record must be the only change it makes to the workspace.
    const rerun = await applyUpdate({ root });
    expect(rerun.report.notes).not.toContain(
      `archetype: renamed re${"search"} to study in the manifest`,
    );
  });

  it("leaves a study manifest alone", async () => {
    const root = path.join(await tempDirs.createTempDir(), "StudyUpdate");
    await initFramework({ target: root, name: "StudyUpdate" });

    const result = await applyUpdate({ root });

    expect((await loadManifest(root))?.project.archetype).toBe("study");
    expect(result.report.notes.some((note) => note.startsWith("archetype: renamed"))).toBe(false);
  });
});

describe("a manifest recording a removed archetype", () => {
  it("says so in status instead of silently reporting a shorter workspace", async () => {
    const root = await workspaceRecording("science", "ScienceWorkspace");

    const status = await getFrameworkStatus({ root });

    expect(status.archetype).toBe("science");
    expect(status.archetypeNotice).toContain("archetype 'science' was removed in Assay");
    expect(status.archetypeNotice).toContain("reporting base structure only");
    expect(status.archetypeDescription).toBeUndefined();
  });

  it("says so in check, as a warning that does not fail the workspace", async () => {
    const root = await workspaceRecording("evaluation", "EvaluationWorkspace");

    const check = await checkFramework({ root });
    const degraded = check.rows.find((row) => row.message?.includes("was removed in Assay"));

    expect(check.ok).toBe(true);
    expect(degraded?.status).toBe("warning");
    expect(degraded?.message).toContain("archetype 'evaluation' was removed in Assay");
    expect(degraded?.message).toContain("reporting base structure only");
  });

  it("keeps reporting nothing when the archetype resolves normally", async () => {
    const root = path.join(await tempDirs.createTempDir(), "SolveWorkspace");
    await initFramework({ target: root, name: "SolveWorkspace", archetype: "solve" });

    const check = await checkFramework({ root });
    const status = await getFrameworkStatus({ root });

    expect(check.rows.some((row) => row.message?.includes("reporting base structure only"))).toBe(
      false,
    );
    expect(status.archetypeNotice).toBeUndefined();
  });
});
