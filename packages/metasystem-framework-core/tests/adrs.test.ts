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

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "metasystem-adrs-"));
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

async function initWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDir(), name);
  await initFramework({ target: root, name });
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
    expect(result.eventFile).toContain(".framework/events/");
    expect(await exists(path.join(root, ".framework", "adrs.json"))).toBe(true);

    const content = await readFile(path.join(root, result.adr.path), "utf8");
    expect(content).toContain("adr: ADR-0001-use-registry-backed-decisions");
    expect(content).toContain("status: proposed");

    const second = await createAdr(root, { title: "Second Decision" });
    expect(second.adr.id).toBe("ADR-0002-second-decision");
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
    // Simulate trellis presence
    await mkdir(path.join(root, ".trellis"), { recursive: true });

    await expect(createAdr(root, { title: "Should Defer" })).rejects.toThrow(
      /external governance detected.*trellis/,
    );

    // --force bypasses deferral
    const forced = await createAdr(root, { title: "Forced" }, { force: true });
    expect(forced.adr.status).toBe("proposed");
  });
});
