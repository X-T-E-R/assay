import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addSource,
  archiveSystem,
  checkFramework,
  closeAnalysis,
  createAnalysis,
  getFrameworkStatus,
  initFramework,
  registerSystem,
  syncSource,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-state-rewrites");

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });
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
  const dir = path.join(root, "sources", alias, "observations");
  const entries = await readdir(dir);
  const first = entries[0];
  if (!first) throw new Error(`no observation recorded for ${alias}`);
  return path.join(dir, first);
}

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

  it("logically archives an out-of-root system without moving external bytes", async () => {
    const root = await workspace("ArchiveOutOfRoot");
    const outside = path.join(path.dirname(root), "precious");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "marker.txt"), "keep me\n", "utf8");
    await mkdir(path.join(root, "systems", "main"), { recursive: true });
    await registerSystem(root, { path: "systems/main", name: "main", primary: true });
    await registerSystem(root, { path: outside, name: "precious" });

    const result = await archiveSystem(root, "precious", { now: new Date("2026-07-26") });

    expect(result.archiveMode).toBe("logical");
    expect(await readFile(path.join(outside, "marker.txt"), "utf8")).toBe("keep me\n");
    expect(await exists(outside)).toBe(true);

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

  it("does not invent or require a physical archive for a logical record", async () => {
    const root = await workspace("CheckMissingArchive");
    await mkdir(path.join(root, "systems", "main"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await registerSystem(root, { path: "systems/main", name: "main", primary: true });
    await registerSystem(root, { path: "systems/old", name: "old" });
    const archived = await archiveSystem(root, "old", { now: new Date("2026-07-26") });
    expect(Object.hasOwn(archived.system, "archive_path")).toBe(false);
    await rm(path.join(root, "systems", "old"), { recursive: true, force: true });

    const check = await checkFramework({ root });

    expect(
      check.rows.some(
        (row) => row.path === ".assay/systems-registry.json" && row.status === "error",
      ),
    ).toBe(false);
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
    await writeFile(path.join(root, "sources", "up", "source.yaml"), "just a string\n", "utf8");

    const check = await checkFramework({ root });

    expect(check.ok).toBe(false);
    expect(
      check.rows.some(
        (row) =>
          row.path === "sources" &&
          row.status === "error" &&
          row.message?.includes("YAML file is not an object"),
      ),
    ).toBe(true);
  });

  it("fails on a source.yaml that cannot be parsed", async () => {
    const root = await workspace("LedgerUnparseable");
    const source = await directorySource("ledger-unparseable");
    await addSource({ root, source, alias: "up" });
    await writeFile(path.join(root, "sources", "up", "source.yaml"), "a: [1,\n  b: {\n", "utf8");

    const check = await checkFramework({ root });

    expect(check.ok).toBe(false);
    expect(check.rows.some((row) => row.path === "sources" && row.status === "error")).toBe(true);
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
        (row) => row.status === "error" && row.message?.includes("recorded no content identity"),
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

    const checkoutFile = path.join(root, "sources", "up", "checkout", "README.md");
    await writeFile(checkoutFile, "# Source\n\nlocal work\n", "utf8");
    await writeFile(path.join(source, "README.md"), "# Source\n\nv2\n", "utf8");

    await expect(syncSource({ root, alias: "up" })).rejects.toThrow(
      "managed source checkout has unrecorded changes",
    );
    expect(await readFile(checkoutFile, "utf8")).toContain("local work");
  });
});
