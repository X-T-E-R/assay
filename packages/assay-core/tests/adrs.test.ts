import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrameworkError,
  acceptAdr,
  createAdr,
  deprecateAdr,
  findAdr,
  initFramework,
  listAdrs,
  loadAdrIndex,
  supersedeAdr,
} from "../src/index.js";

const tempRoots: string[] = [];
type TestArchetype = "study" | "solve" | "library" | "science" | "evaluation" | "explore";

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-adrs-"));
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

async function initWorkspace(name: string, archetype: TestArchetype = "study"): Promise<string> {
  const root = path.join(await tempDir(), name);
  await initFramework({ target: root, name, archetype });
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ADR index", () => {
  it("creates a proposed ADR with monotonic numbering and markdown frontmatter", async () => {
    const root = await initWorkspace("AdrCreate");

    const result = await createAdr(
      root,
      {
        title: "Use Registry Backed Decisions",
        relatedAnalysis: "analyses/references/example.md",
      },
      { now: new Date("2026-06-17T10:00:00") },
    );

    expect(result.adr).toMatchObject({
      id: "ADR-0001-use-registry-backed-decisions",
      number: 1,
      status: "proposed",
      date: "2026-06-17",
      related_analysis: "analyses/references/example.md",
    });
    expect(result.eventFile).toContain(".assay/events/");
    expect(await exists(path.join(root, ".assay", "adrs.json"))).toBe(true);

    const content = await readFile(path.join(root, result.adr.path), "utf8");
    expect(content).toContain("adr: ADR-0001-use-registry-backed-decisions");
    expect(content).toContain("status: proposed");

    const second = await createAdr(root, { title: "Second Decision" });
    expect(second.adr.id).toBe("ADR-0002-second-decision");
  });

  it("rejects ADR mutations when the archetype does not enable the adr capability", async () => {
    const root = await initWorkspace("AdrDisabled", "library");

    await expect(createAdr(root, { title: "Should Not Create" })).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );
    await expect(acceptAdr(root, "ADR-0001-anything")).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );
    await expect(deprecateAdr(root, "ADR-0001-anything")).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );
    await expect(supersedeAdr(root, "ADR-0001-a", "ADR-0002-b")).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );
    await expect(listAdrs(root)).rejects.toThrow(
      /capability not enabled in archetype library: adr/,
    );
  });

  it("allows ADR creation in the evaluation archetype", async () => {
    const root = await initWorkspace("AdrEvaluation", "evaluation");

    const result = await createAdr(root, { title: "Select Evaluation Winner" });

    expect(result.adr.id).toBe("ADR-0001-select-evaluation-winner");
    expect(await exists(path.join(root, "knowledge", "decisions", `${result.adr.id}.md`))).toBe(
      true,
    );
  });

  it("accepts a proposed ADR and updates markdown frontmatter", async () => {
    const root = await initWorkspace("AdrAccept");
    const created = await createAdr(root, { title: "Accept Me" });

    const accepted = await acceptAdr(root, created.adr.id);

    expect(accepted.adr.status).toBe("accepted");
    const content = await readFile(path.join(root, accepted.adr.path), "utf8");
    expect(content).toContain("status: accepted");
  });

  it("supersedes one accepted ADR with another accepted ADR", async () => {
    const root = await initWorkspace("AdrSupersede");
    const oldAdr = await createAdr(root, { title: "Old Decision" });
    const newAdr = await createAdr(root, { title: "New Decision" });
    await acceptAdr(root, oldAdr.adr.id);
    await acceptAdr(root, newAdr.adr.id);

    const result = await supersedeAdr(root, oldAdr.adr.id, newAdr.adr.id);

    expect(result.oldAdr.status).toBe("superseded");
    expect(result.oldAdr.superseded_by).toBe(newAdr.adr.id);
    expect(result.newAdr.supersedes).toContain(oldAdr.adr.id);
  });

  it("deprecates proposed and accepted ADRs without replacement", async () => {
    const root = await initWorkspace("AdrDeprecate");
    const proposed = await createAdr(root, { title: "Proposed Only" });
    const accepted = await createAdr(root, { title: "Accepted Then Deprecated" });
    await acceptAdr(root, accepted.adr.id);

    const deprecatedProposed = await deprecateAdr(root, proposed.adr.id);
    const deprecatedAccepted = await deprecateAdr(root, accepted.adr.id);

    expect(deprecatedProposed.adr.status).toBe("deprecated");
    expect(deprecatedAccepted.adr.status).toBe("deprecated");
  });

  it("rejects invalid state transitions", async () => {
    const root = await initWorkspace("AdrInvalid");
    const oldAdr = await createAdr(root, { title: "Accepted Old" });
    const replacement = await createAdr(root, { title: "Replacement Not Accepted" });
    await acceptAdr(root, oldAdr.adr.id);

    await expect(acceptAdr(root, oldAdr.adr.id)).rejects.toBeInstanceOf(FrameworkError);
    await expect(supersedeAdr(root, oldAdr.adr.id, replacement.adr.id)).rejects.toBeInstanceOf(
      FrameworkError,
    );
  });

  it("finds and lists ADRs by number, id prefix, and status", async () => {
    const root = await initWorkspace("AdrFind");
    const proposed = await createAdr(root, { title: "Proposal" });
    const accepted = await createAdr(root, { title: "Accepted" });
    await acceptAdr(root, accepted.adr.id);

    const index = await loadAdrIndex(root);
    if (!index) {
      throw new Error("ADR index missing");
    }

    expect(findAdr(index, "1").id).toBe(proposed.adr.id);
    expect(findAdr(index, "ADR-0002").id).toBe(accepted.adr.id);

    const { adrs: acceptedAdrs } = await listAdrs(root, "accepted");
    expect(acceptedAdrs.map((adr) => adr.id)).toEqual([accepted.adr.id]);
  });

  it("defers ADR creation when trellis is detected, unless --force", async () => {
    const root = await initWorkspace("AdrDefer");
    await mkdir(path.join(root, ".trellis"), { recursive: true });

    await expect(createAdr(root, { title: "Should Defer" })).rejects.toThrow(
      /external governance detected.*trellis.*Use --force/,
    );

    const forced = await createAdr(root, { title: "Forced" }, { force: true });
    expect(forced.adr.status).toBe("proposed");
  });

  it("defers ADR creation when .superpowers governance is detected", async () => {
    const root = await initWorkspace("AdrDeferSuperpowers");
    await mkdir(path.join(root, ".superpowers"), { recursive: true });

    await expect(createAdr(root, { title: "Should Defer" })).rejects.toThrow(
      /external governance detected.*superpowers.*Use --force/,
    );

    const forced = await createAdr(root, { title: "Forced" }, { force: true });
    expect(forced.adr.status).toBe("proposed");
  });

  it("does not treat a bare superpowers directory as external governance", async () => {
    const root = await initWorkspace("AdrBareSuperpowers");
    await mkdir(path.join(root, "superpowers"), { recursive: true });

    const result = await createAdr(root, { title: "Bare Superpowers Allowed" });

    expect(result.adr.id).toBe("ADR-0001-bare-superpowers-allowed");
  });

  it("warns but creates ADRs when docs/adr already exists", async () => {
    const root = await initWorkspace("AdrDocsAdrWarn");
    const warnings: string[] = [];
    await mkdir(path.join(root, "docs", "adr"), { recursive: true });

    const result = await createAdr(
      root,
      { title: "Create Alongside Docs Adr" },
      { onWarning: (message) => warnings.push(message) },
    );

    expect(result.adr.id).toBe("ADR-0001-create-alongside-docs-adr");
    expect(warnings).toEqual([
      expect.stringContaining("external governance detected (docs-adr at docs/adr/)"),
    ]);
  });
});
