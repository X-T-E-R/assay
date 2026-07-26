import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addReference,
  addSource,
  archiveSystem,
  checkFramework,
  closeAnalysis,
  closeIteration,
  createAnalysis,
  getFrameworkStatus,
  initFramework,
  registerSystem,
  startIteration,
  syncSource,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-state-rewrites");

beforeAll(() => {
  // Never touch the user-global Assay project registry from tests.
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string, archetype?: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name, ...(archetype ? { archetype } : {}) });
  return root;
}

async function directorySource(name: string, body = "# Source\n\nv1\n"): Promise<string> {
  const source = path.join(await tempDirs.createTempDir(), name);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "README.md"), body, "utf8");
  return source;
}

/** Remove the `fingerprint:` block from an observation, as an older or damaged record would lack it. */
async function stripObservationFingerprint(observationFile: string): Promise<void> {
  const lines = (await readFile(observationFile, "utf8")).split("\n");
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^fingerprint:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() !== "" && /^\s/.test(line)) continue;
      inBlock = false;
    }
    kept.push(line);
  }
  await writeFile(observationFile, kept.join("\n"), "utf8");
}

async function onlyObservation(root: string, alias: string): Promise<string> {
  const dir = path.join(root, "references", alias, "observations");
  const entries = await readdir(dir);
  const first = entries[0];
  if (!first) throw new Error(`no observation recorded for ${alias}`);
  return path.join(dir, first);
}

describe("iteration close writes the header status, not a lookalike line", () => {
  it("closes the real status when a note above it mentions Status: open", async () => {
    const root = await workspace("IterationDecoy", "solve");
    const started = await startIteration({
      root,
      title: "Decoy Iteration",
      now: new Date("2026-06-14T10:00:00"),
    });
    const planPath = path.join(root, started.planPath);
    const original = await readFile(planPath, "utf8");
    await writeFile(
      planPath,
      original.replace(
        "## Hypothesis\n",
        "## Hypothesis\n\n- Blocker note: Status: open (waiting on upstream)\n",
      ),
      "utf8",
    );

    await closeIteration({
      root,
      selector: started.path,
      result: "applied",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(planPath, "utf8");
    expect(content).toContain("- Status: closed");
    expect(content).toContain("- Blocker note: Status: open (waiting on upstream)");
    expect(await getFrameworkStatus({ root })).toMatchObject({ openIterations: 0 });
    const status = await checkFramework({ root, includeAdvisories: true });
    expect(status.rows.some((row) => row.message?.includes("iteration(s) not closed"))).toBe(false);
  });

  it("appends the result to the Result section even when a body line names it", async () => {
    const root = await workspace("IterationResultDecoy", "solve");
    const started = await startIteration({
      root,
      title: "Result Decoy",
      now: new Date("2026-06-14T10:00:00"),
    });
    const planPath = path.join(root, started.planPath);
    const original = await readFile(planPath, "utf8");
    await writeFile(
      planPath,
      original.replace("## Scope\n", "## Scope\n\n- Outcome is recorded under ## Result\n"),
      "utf8",
    );

    await closeIteration({
      root,
      selector: started.path,
      result: "applied",
      note: "verified",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(planPath, "utf8");
    const resultSection = content.slice(content.lastIndexOf("## Result"));
    expect(resultSection).toContain("applied on 2026-06-15 — verified");
    expect(content.slice(0, content.lastIndexOf("## Result"))).not.toContain("applied on");
  });

  it("records the closed status even when the plan header never declared one", async () => {
    const root = await workspace("IterationNoStatus", "solve");
    const started = await startIteration({
      root,
      title: "No Status Header",
      now: new Date("2026-06-14T10:00:00"),
    });
    const planPath = path.join(root, started.planPath);
    const original = await readFile(planPath, "utf8");
    await writeFile(planPath, original.replace("- Status: open\n", ""), "utf8");

    await closeIteration({
      root,
      selector: started.path,
      result: "applied",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(planPath, "utf8");
    expect(content.slice(0, content.indexOf("## "))).toContain("- Status: closed");
  });
});

describe("analysis close writes the header status and the real decision checkbox", () => {
  it("closes the real status when a header line above it looks like one", async () => {
    const root = await workspace("AnalysisStatusDecoy");
    const created = await createAnalysis({
      root,
      title: "Status Decoy",
      now: new Date("2026-06-14T10:00:00"),
    });
    const original = await readFile(created.absolutePath, "utf8");
    await writeFile(
      created.absolutePath,
      original.replace(
        "- Status: draft\n",
        "- Upstream ticket: JIRA-1 - Status: unknown\n- Status: draft\n",
      ),
      "utf8",
    );

    await closeAnalysis({
      root,
      path: created.path,
      exit: "adopt",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("- Status: applied");
    expect(content).not.toContain("- Status: draft");
    expect(content).toContain("- Upstream ticket: JIRA-1 - Status: unknown");
  });

  it("ticks the checkbox under Decision exit, not a lookalike above it", async () => {
    const root = await workspace("AnalysisCheckboxDecoy");
    const created = await createAnalysis({
      root,
      title: "Checkbox Decoy",
      now: new Date("2026-06-14T10:00:00"),
    });
    const original = await readFile(created.absolutePath, "utf8");
    await writeFile(
      created.absolutePath,
      original.replace(
        "## Key observations\n",
        "## Key observations\n\n- [ ] adopt upstream naming later\n",
      ),
      "utf8",
    );

    await closeAnalysis({
      root,
      path: created.path,
      exit: "adopt",
      now: new Date("2026-06-15T10:00:00"),
    });

    const content = await readFile(created.absolutePath, "utf8");
    expect(content).toContain("- [ ] adopt upstream naming later");
    const decisionSection = content.slice(content.indexOf("## Decision exit"));
    expect(decisionSection).toContain("- [x] adopt");
    expect(decisionSection).toContain("- [ ] reject");
  });

  it("refuses to close when the Decision exit section has no matching checkbox", async () => {
    const root = await workspace("AnalysisMissingCheckbox");
    const created = await createAnalysis({
      root,
      title: "Missing Checkbox",
      now: new Date("2026-06-14T10:00:00"),
    });
    const original = await readFile(created.absolutePath, "utf8");
    await writeFile(created.absolutePath, original.replace("- [ ] adopt\n", ""), "utf8");

    await expect(closeAnalysis({ root, path: created.path, exit: "adopt" })).rejects.toThrow(
      /no '- \[ \] adopt' checkbox/,
    );

    // The refusal must leave the card untouched rather than half-closed.
    expect(await readFile(created.absolutePath, "utf8")).toContain("- Status: draft");
  });

  it("records the closed source analysis status in the header, not in a body lookalike", async () => {
    const root = await workspace("AnalysisSourceStatusDecoy");
    const source = await directorySource("analysis-source-status");
    await addSource({ root, source, alias: "up" });
    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");
    const synced = await syncSource({ root, alias: "up", changeClass: "major" });
    expect(synced.observation).not.toBeNull();

    const analysis = await createAnalysis({
      root,
      title: "Review Source Status",
      forSource: "up",
      now: new Date("2026-07-01T10:00:00"),
    });
    // A card whose header no longer carries the field while a body line looks
    // like it. The rewrite must restore the header state instead of quietly
    // editing the body line and reporting success.
    const original = await readFile(analysis.absolutePath, "utf8");
    await writeFile(
      analysis.absolutePath,
      original
        .replace(/^- Source analysis status:.*\n/m, "")
        .replace(
          "## Key observations\n",
          "## Key observations\n\n- Source analysis status: open per the upstream tracker\n",
        ),
      "utf8",
    );

    await closeAnalysis({
      root,
      path: analysis.path,
      exit: "adopt",
      now: new Date("2026-07-01T11:00:00"),
    });

    const content = await readFile(analysis.absolutePath, "utf8");
    const header = content.slice(0, content.indexOf("## "));
    expect(header).toContain("- Source analysis status: closed");
    expect(content).toContain("- Source analysis status: open per the upstream tracker");
  });
});

describe("reference case files are read and written through one YAML parser", () => {
  async function frozenReference(root: string, name: string): Promise<string> {
    const source = await directorySource(`${name}-source`);
    const frozen = await addReference({
      root,
      source,
      name,
      now: new Date("2026-06-14T10:00:00"),
    });
    return frozen.path;
  }

  it("refuses to report success when the case file indents the analyzed flag", async () => {
    const root = await workspace("ReferenceIndented");
    const referencePath = await frozenReference(root, "Indented Ref");
    const yamlPath = path.join(root, referencePath, "reference.yaml");
    const original = await readFile(yamlPath, "utf8");
    // A hand edit that indents the flag. The previous hand-rolled reader
    // trimmed leading whitespace and reported the value while the anchored
    // rewrite could not see it, so `analysis close` exited 0 without marking
    // anything. One parser for both sides makes the file's real state visible.
    await writeFile(yamlPath, original.replace("analyzed: false", "  analyzed: false"), "utf8");

    const analysis = await createAnalysis({
      root,
      title: "Review Indented Ref",
      forReference: referencePath,
      now: new Date("2026-06-15T10:00:00"),
    }).catch(async (error: unknown) => {
      expect(String(error)).toMatch(/reference case file cannot be parsed as YAML/);
      return null;
    });

    if (analysis) {
      await expect(closeAnalysis({ root, path: analysis.path, exit: "adopt" })).rejects.toThrow(
        /reference case file/,
      );
    }

    // Either way the flag was never silently reported as set.
    expect(await readFile(yamlPath, "utf8")).toMatch(/analyzed:\s*false/);
  });

  it("refuses to close when the case file cannot record the analyzed flag", async () => {
    const root = await workspace("ReferenceUnmarkable");
    const referencePath = await frozenReference(root, "Unmarkable Ref");
    const yamlPath = path.join(root, referencePath, "reference.yaml");
    const original = await readFile(yamlPath, "utf8");
    await writeFile(yamlPath, original.replace(/^analyzed: false$/m, 'analyzed: "no"'), "utf8");

    const analysis = await createAnalysis({
      root,
      title: "Review Unmarkable Ref",
      forReference: referencePath,
      now: new Date("2026-06-15T10:00:00"),
    });

    await expect(closeAnalysis({ root, path: analysis.path, exit: "adopt" })).rejects.toThrow(
      /no boolean 'analyzed' flag/,
    );
  });

  it("preserves the case file comments when marking it analyzed", async () => {
    const root = await workspace("ReferenceComments");
    const referencePath = await frozenReference(root, "Comment Ref");
    const analysis = await createAnalysis({
      root,
      title: "Review Comment Ref",
      forReference: referencePath,
      now: new Date("2026-06-15T10:00:00"),
    });
    await closeAnalysis({ root, path: analysis.path, exit: "adopt" });

    const updated = await readFile(path.join(root, referencePath, "reference.yaml"), "utf8");
    expect(updated).toContain("# Reference case file.");
    expect(updated).toContain("analysis_points: []");
    expect(updated).toMatch(/analyzed:\s*true/);
  });
});

describe("system archive handles systems recorded outside the workspace", () => {
  it("moves an out-of-root system to the destination it reports", async () => {
    const root = await workspace("ArchiveOutOfRoot");
    const outside = path.join(path.dirname(root), "precious");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "marker.txt"), "keep me\n", "utf8");
    await mkdir(path.join(root, "systems", "main"), { recursive: true });
    await registerSystem(root, { path: "systems/main", name: "main", primary: true });
    await registerSystem(root, { path: outside, name: "precious" });

    const result = await archiveSystem(root, "precious", { now: new Date("2026-07-26") });

    expect(result.movedTo).toBe("systems/archive/2026-07-26-pre-precious/precious");
    if (!result.movedTo) throw new Error("archive destination missing");
    expect(await exists(path.join(root, result.movedTo, "marker.txt"))).toBe(true);
    expect(await exists(outside)).toBe(false);

    const check = await checkFramework({ root });
    expect(check.rows.filter((row) => row.status === "error")).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("reports an out-of-root system that exists on disk as present", async () => {
    const root = await workspace("CheckOutOfRoot");
    const outside = path.join(path.dirname(root), "ext");
    await mkdir(outside, { recursive: true });
    await registerSystem(root, { path: outside, name: "ext", primary: true });

    const check = await checkFramework({ root });

    expect(check.rows.filter((row) => row.status === "error")).toEqual([]);
    expect(check.rows.some((row) => row.message?.includes("contract file missing"))).toBe(false);
    expect(check.ok).toBe(true);
  });

  it("fails the check when an archived record points at a missing archive", async () => {
    const root = await workspace("CheckMissingArchive");
    await mkdir(path.join(root, "systems", "main"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await registerSystem(root, { path: "systems/main", name: "main", primary: true });
    await registerSystem(root, { path: "systems/old", name: "old" });
    const archived = await archiveSystem(root, "old", { now: new Date("2026-07-26") });
    if (!archived.system.archive_path) throw new Error("archive_path missing");
    await rm(path.join(root, archived.system.archive_path), { recursive: true, force: true });

    const check = await checkFramework({ root });

    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) =>
          row.status === "error" && row.message?.includes("archived system 'old' has no archive"),
      ),
    ).toBe(true);
  });
});

describe("analysis.closed events describe only what happened", () => {
  it("never records allow_empty, whether or not the deprecated flag was passed", async () => {
    const root = await workspace("AllowEmptyEvent");
    const created = await createAnalysis({
      root,
      title: "Deprecated Flag",
      now: new Date("2026-06-14T10:00:00"),
    });

    const closed = await closeAnalysis({
      root,
      path: created.path,
      exit: "adopt",
      allowEmpty: true,
      now: new Date("2026-06-15T10:00:00"),
    });

    const events = (await readFile(path.join(root, closed.eventFile), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const closeEvent = events.find((event) => event.event === "analysis.closed");
    expect(closeEvent).toBeDefined();
    expect(closeEvent).not.toHaveProperty("allow_empty");
  });
});

describe("check reports any source-ledger failure instead of skipping it", () => {
  it("fails on a source.yaml that is not a YAML mapping", async () => {
    const root = await workspace("LedgerNotObject");
    const source = await directorySource("ledger-not-object");
    await addSource({ root, source, alias: "up" });
    await writeFile(path.join(root, "references", "up", "source.yaml"), "just a string\n", "utf8");

    const check = await checkFramework({ root });

    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) =>
          row.path === "references" &&
          row.status === "error" &&
          row.message?.includes("YAML file is not an object"),
      ),
    ).toBe(true);
  });

  it("fails on a source.yaml that cannot be parsed", async () => {
    const root = await workspace("LedgerUnparseable");
    const source = await directorySource("ledger-unparseable");
    await addSource({ root, source, alias: "up" });
    await writeFile(path.join(root, "references", "up", "source.yaml"), "a: [1,\n  b: {\n", "utf8");

    const check = await checkFramework({ root });

    expect(check.ok).toBe(false);
    expect(check.rows.some((row) => row.path === "references" && row.status === "error")).toBe(
      true,
    );
  });
});

describe("source sync repairs an observation that records no fingerprint", () => {
  it("records a fresh observation for a non-Git directory source in checkout mode", async () => {
    const root = await workspace("FingerprintCheckout");
    const source = await directorySource("fingerprint-checkout-source");
    await addSource({ root, source, alias: "up", capture: "checkout" });
    await stripObservationFingerprint(await onlyObservation(root, "up"));

    const before = await checkFramework({ root });
    expect(before.ok).toBe(false);
    expect(
      before.rows.some(
        (row) => row.status === "error" && row.message?.includes("has no fingerprint"),
      ),
    ).toBe(true);

    const synced = await syncSource({ root, alias: "up" });
    expect(synced.observation?.fingerprint.value).toBeTruthy();

    const after = await checkFramework({ root });
    expect(after.rows.filter((row) => row.status === "error")).toEqual([]);
    expect(after.ok).toBe(true);
  });

  it("records a fresh observation for an archive-mode source", async () => {
    const root = await workspace("FingerprintArchive");
    const source = await directorySource("fingerprint-archive-source");
    await addSource({ root, source, alias: "up", capture: "archive" });
    await stripObservationFingerprint(await onlyObservation(root, "up"));

    expect((await checkFramework({ root })).ok).toBe(false);

    const synced = await syncSource({ root, alias: "up" });
    expect(synced.observation?.fingerprint.value).toBeTruthy();
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("still refuses to refresh a checkout whose recorded fingerprint proves local drift", async () => {
    const root = await workspace("FingerprintGuardIntact");
    const source = await directorySource("fingerprint-guard-source");
    await addSource({ root, source, alias: "up", capture: "checkout" });

    const checkoutFile = path.join(root, "references", "up", "checkout", "README.md");
    await writeFile(checkoutFile, "# Source\n\nlocal work\n", "utf8");
    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");

    await expect(syncSource({ root, alias: "up" })).rejects.toThrow(
      "managed source checkout has unrecorded changes",
    );
    expect(await readFile(checkoutFile, "utf8")).toContain("local work");
  });
});
