import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  FrameworkError,
  addCapability,
  attachExistingRepo,
  captureIntent,
  checkFramework,
  convertOverlayToStandalone,
  getFrameworkStatus,
  initFramework,
  listAdrs,
  listIntent,
  loadManifest,
  loadSystemsRegistry,
  promoteIntent,
  promoteSystem,
  registerSystem,
  updateSystem,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-intent");

const INTENT_TEXT = "Exports must include every column the table shows, in the order shown.";

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

/** Standalone workspace with the intent capability and one registered primary system. */
async function intentWorkspace(name: string, systemName = "app"): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name, archetype: "library" });
  await addCapability({ root, module: "intent" });
  await mkdir(path.join(root, "systems", systemName), { recursive: true });
  await registerSystem(root, { path: `systems/${systemName}`, primary: true });
  return root;
}

async function overlayIntentWorkspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "initial"]);
  await attachExistingRepo({ root, name, archetype: "library", privacy: "private", noTrack: true });
  await addCapability({ root, module: "intent" });
  return root;
}

async function readEvents(root: string): Promise<Record<string, unknown>[]> {
  const eventsDir = path.join(root, ".assay", "events");
  const entries: Record<string, unknown>[] = [];
  for (const file of await readdir(eventsDir)) {
    const content = await readFile(path.join(eventsDir, file), "utf8");
    for (const line of content.split("\n").filter((value) => value.trim().length > 0)) {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return entries;
}

describe("intent capture", () => {
  it("writes a content-addressed record with system, digest, and capture time", async () => {
    const root = await intentWorkspace("CaptureBasics");

    const result = await captureIntent({ root, text: INTENT_TEXT, source: "kickoff call" });

    expect(result.created).toBe(true);
    expect(result.capture.id).toMatch(/^\d{8}-[0-9a-f]{12}$/);
    expect(result.capture.path).toBe(`intent/original/${result.capture.id}.md`);
    expect(result.capture.system).toBe("app");
    expect(result.capture.shadow).toBe(false);
    expect(result.capture.id.endsWith(result.capture.sha256.slice(0, 12))).toBe(true);

    const content = await readFile(path.join(root, result.capture.path), "utf8");
    expect(content).toContain(`intent: "${result.capture.id}"`);
    expect(content).toContain('system: "app"');
    expect(content).toContain(`sha256: "${result.capture.sha256}"`);
    expect(content).toContain('source: "kickoff call"');
    expect(content.endsWith(`\n\n${INTENT_TEXT}\n`)).toBe(true);

    const events = await readEvents(root);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "intent.captured",
        id: result.capture.id,
        system: "app",
        shadow: false,
      }),
    );
  });

  it("is a no-op when the identical text is captured again", async () => {
    const root = await intentWorkspace("CaptureIdempotent");
    const first = await captureIntent({ root, text: INTENT_TEXT });

    const again = await captureIntent({ root, text: INTENT_TEXT });

    expect(again.created).toBe(false);
    expect(again.capture.id).toBe(first.capture.id);
    expect(again.eventFile).toBeUndefined();
    expect(
      (await readEvents(root)).filter((event) => event.event === "intent.captured"),
    ).toHaveLength(1);
    expect((await readdir(path.join(root, "intent", "original"))).sort()).toEqual(
      ["README.md", `${first.capture.id}.md`].sort(),
    );
  });

  it("refuses to re-record a capture whose body was edited after recording", async () => {
    const root = await intentWorkspace("CaptureTamper");
    const first = await captureIntent({ root, text: INTENT_TEXT });
    const recordPath = path.join(root, first.capture.path);
    const original = await readFile(recordPath, "utf8");
    await writeFile(recordPath, `${original}Someone reworded this later.\n`, "utf8");

    await expect(captureIntent({ root, text: INTENT_TEXT })).rejects.toThrow(
      /was modified after recording/,
    );

    // The refusal must not repair the record behind the caller's back.
    expect(await readFile(recordPath, "utf8")).toBe(`${original}Someone reworded this later.\n`);
  });

  it("refuses identical text already recorded for another system", async () => {
    const root = await intentWorkspace("CaptureSystemConflict");
    const first = await captureIntent({ root, text: INTENT_TEXT });
    await mkdir(path.join(root, "systems", "next"), { recursive: true });
    await registerSystem(root, { path: "systems/next" });

    await expect(captureIntent({ root, text: INTENT_TEXT, system: "next" })).rejects.toThrow(
      /identical text is already recorded for system 'app'.*a capture is scoped to one system/s,
    );

    // The first record keeps its scope and no second record appears.
    expect(await readFile(path.join(root, first.capture.path), "utf8")).toContain('system: "app"');
    expect((await listIntent({ root })).captures).toHaveLength(1);
  });

  it("refuses identical text already recorded under a different authority marking", async () => {
    const root = await intentWorkspace("CaptureShadowConflict");
    const first = await captureIntent({ root, text: INTENT_TEXT });
    await updateSystem(root, "app", {
      intentAuthority: { mode: "external", pointer: "https://atlas.example/app/intent" },
    });

    await expect(captureIntent({ root, text: INTENT_TEXT, force: true })).rejects.toThrow(
      /marked as the authoritative record; this call would record it as a shadow copy/,
    );

    expect(await readFile(path.join(root, first.capture.path), "utf8")).not.toContain("shadow:");
    expect((await listIntent({ root })).captures[0]?.shadow).toBe(false);
  });

  it("names the metadata a repeat capture could not apply", async () => {
    const root = await intentWorkspace("CaptureIgnoredOptions");
    const first = await captureIntent({ root, text: INTENT_TEXT, source: "kickoff call" });
    const other = await captureIntent({ root, text: "A second, different intent." });

    const again = await captureIntent({
      root,
      text: INTENT_TEXT,
      source: "retro",
      supersedes: [other.capture.id],
    });

    expect(again.created).toBe(false);
    expect(again.ignoredOptions).toEqual(["--source", "--supersedes"]);
    // Naming them is all that happens: the record is untouched.
    const content = await readFile(path.join(root, first.capture.path), "utf8");
    expect(content).toContain('source: "kickoff call"');
    expect(content).not.toContain("supersedes:");

    const unchanged = await captureIntent({ root, text: INTENT_TEXT, source: "kickoff call" });
    expect(unchanged.ignoredOptions).toEqual([]);
  });

  it("refuses --supersedes ids that name no recorded capture", async () => {
    const root = await intentWorkspace("SupersedesUnknown");
    const first = await captureIntent({ root, text: INTENT_TEXT });
    const typo = `${first.capture.id.slice(0, -1)}${first.capture.id.endsWith("0") ? "1" : "0"}`;

    await expect(
      captureIntent({
        root,
        text: `${INTENT_TEXT} Excel is out of scope.`,
        supersedes: [typo, "yesterdays-note"],
      }),
    ).rejects.toThrow(
      new RegExp(
        `--supersedes must name recorded intent captures.*'${typo}' is not a recorded capture.*'yesterdays-note' is not a capture id`,
        "s",
      ),
    );

    // A prefix resolves selectors, not correction chains: it names no record.
    await expect(
      captureIntent({
        root,
        text: `${INTENT_TEXT} Excel is out of scope.`,
        supersedes: [first.capture.id.slice(0, 12)],
      }),
    ).rejects.toThrow(/is not a capture id/);

    expect((await listIntent({ root })).captures.map((entry) => entry.id)).toEqual([
      first.capture.id,
    ]);
  });

  it("records a correction as a new capture instead of editing the old one", async () => {
    const root = await intentWorkspace("CaptureAppendOnly");
    const first = await captureIntent({ root, text: INTENT_TEXT });

    const corrected = await captureIntent({
      root,
      text: `${INTENT_TEXT} Excel export is out of scope.`,
      supersedes: [first.capture.id],
    });

    expect(corrected.capture.id).not.toBe(first.capture.id);
    expect(corrected.capture.supersedes).toEqual([first.capture.id]);
    expect(await readFile(path.join(root, first.capture.path), "utf8")).toContain(INTENT_TEXT);
    expect((await listIntent({ root })).captures).toHaveLength(2);
  });

  it("requires the intent capability", async () => {
    const root = path.join(await tempDirs.createTempDir(), "NoCapability");
    await initFramework({ target: root, name: "NoCapability", archetype: "library" });
    await mkdir(path.join(root, "systems", "app"), { recursive: true });
    await registerSystem(root, { path: "systems/app", primary: true });

    await expect(captureIntent({ root, text: INTENT_TEXT })).rejects.toThrow(
      /capability not enabled in archetype library: intent/,
    );
  });

  it("names the system a capture belongs to even after the primary pointer moves", async () => {
    const root = await intentWorkspace("CaptureSystemResolution");
    const captured = await captureIntent({ root, text: INTENT_TEXT });
    expect(captured.capture.system).toBe("app");

    await mkdir(path.join(root, "systems", "next"), { recursive: true });
    await registerSystem(root, { path: "systems/next" });
    await promoteSystem(root, "next");

    const later = await captureIntent({ root, text: "The next system owns billing." });
    expect(later.capture.system).toBe("next");
    // The earlier record still names the system it was actually about.
    expect((await listIntent({ root, system: "app" })).captures.map((entry) => entry.id)).toEqual([
      captured.capture.id,
    ]);
  });
});

describe("intent authority", () => {
  it("refuses capture for an external authority and names the pointer", async () => {
    const root = await intentWorkspace("AuthorityExternal");
    await updateSystem(root, "app", {
      intentAuthority: { mode: "external", pointer: "https://atlas.example/app/intent" },
    });

    await expect(captureIntent({ root, text: INTENT_TEXT })).rejects.toThrow(
      /intent authority for system 'app' is external; record it there instead: https:\/\/atlas\.example\/app\/intent/,
    );
    expect(await exists(path.join(root, "intent", "original"))).toBe(true);
    expect(await readdir(path.join(root, "intent", "original"))).toEqual(["README.md"]);
  });

  it("refuses capture for an authority mode of none", async () => {
    const root = await intentWorkspace("AuthorityNone");
    await updateSystem(root, "app", { intentAuthority: { mode: "none" } });

    await expect(captureIntent({ root, text: INTENT_TEXT })).rejects.toThrow(
      /declares no intent authority \(mode: none\)/,
    );
  });

  it("records a shadow-marked copy with --force and flags it in the listing", async () => {
    const root = await intentWorkspace("AuthorityForce");
    await updateSystem(root, "app", {
      intentAuthority: { mode: "external", pointer: "https://atlas.example/app/intent" },
    });

    const forced = await captureIntent({ root, text: INTENT_TEXT, force: true });

    expect(forced.capture.shadow).toBe(true);
    expect(await readFile(path.join(root, forced.capture.path), "utf8")).toContain("shadow: true");
    expect((await listIntent({ root })).captures[0]?.shadow).toBe(true);
    expect(await readEvents(root)).toContainEqual(
      expect.objectContaining({ event: "intent.captured", shadow: true }),
    );
  });

  it("captures normally once the authority is cleared back to inline", async () => {
    const root = await intentWorkspace("AuthorityCleared");
    await updateSystem(root, "app", { intentAuthority: { mode: "none" } });
    await updateSystem(root, "app", { intentAuthority: null });

    const captured = await captureIntent({ root, text: INTENT_TEXT });

    expect(captured.capture.shadow).toBe(false);
    expect((await loadSystemsRegistry(root))?.systems.app?.intent_authority).toBeUndefined();
  });

  it("mirrors the authority into the generated system contract", async () => {
    const root = path.join(await tempDirs.createTempDir(), "AuthorityContract");
    await initFramework({ target: root, name: "AuthorityContract", archetype: "library" });
    await mkdir(path.join(root, "systems", "app"), { recursive: true });

    await registerSystem(root, {
      path: "systems/app",
      primary: true,
      intentAuthority: { mode: "external", pointer: "https://atlas.example/app/intent" },
    });

    const contract = await readFile(path.join(root, "systems", "app", "system.yaml"), "utf8");
    expect(contract).toContain("intent_authority:");
    expect(contract).toContain("mode: external");
    expect(contract).toContain("pointer: https://atlas.example/app/intent");
  });

  it("reports an intent_authority change on system update", async () => {
    const root = await intentWorkspace("AuthorityChange");

    const result = await updateSystem(root, "app", {
      intentAuthority: { mode: "external", pointer: "https://atlas.example/app/intent" },
    });

    expect(result.changes).toContainEqual({
      field: "intent_authority",
      previous: null,
      current: "external https://atlas.example/app/intent",
    });
  });
});

describe("intent promote", () => {
  it("writes a requirement that declares what it derives from", async () => {
    const root = await intentWorkspace("PromoteRequirement");
    const captured = await captureIntent({ root, text: INTENT_TEXT });

    const promoted = await promoteIntent({
      root,
      capture: captured.capture.id,
      to: "requirement",
      title: "Full-fidelity CSV export",
    });

    expect(promoted.path).toMatch(
      /^intent\/requirements\/\d{4}-\d{2}-\d{2}-full-fidelity-csv-export\.md$/,
    );
    const content = await readFile(path.join(root, promoted.path), "utf8");
    expect(content).toContain(`derives_from: "${captured.capture.id}"`);
    expect(content).toContain('system: "app"');
    expect(await readEvents(root)).toContainEqual(
      expect.objectContaining({
        event: "intent.promoted",
        id: captured.capture.id,
        to: "requirement",
      }),
    );
  });

  it("creates an ADR linked back to the capture and the system", async () => {
    const root = await intentWorkspace("PromoteDecision");
    await addCapability({ root, module: "adr" });
    const captured = await captureIntent({ root, text: INTENT_TEXT });

    const promoted = await promoteIntent({
      root,
      capture: captured.capture.id,
      to: "decision",
      title: "Stream CSV exports",
    });

    expect(promoted.adrId).toBe("ADR-0001-stream-csv-exports");
    const adr = (await listAdrs(root)).adrs[0];
    expect(adr?.related_intent).toBe(captured.capture.id);
    expect(adr?.system).toBe("app");
    const markdown = await readFile(path.join(root, promoted.path), "utf8");
    expect(markdown).toContain(`related_intent: "${captured.capture.id}"`);
    expect(markdown).toContain('system: "app"');

    const listed = await listIntent({ root });
    expect(listed.captures[0]?.decisions).toEqual(["ADR-0001-stream-csv-exports"]);
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("resolves a unique capture id prefix and rejects an ambiguous one", async () => {
    const root = await intentWorkspace("PromotePrefix");
    const captured = await captureIntent({ root, text: INTENT_TEXT });

    const promoted = await promoteIntent({
      root,
      capture: captured.capture.id.slice(0, 12),
      to: "requirement",
      title: "Prefix Selected",
    });
    expect(promoted.capture.id).toBe(captured.capture.id);

    await captureIntent({ root, text: "A second, different intent." });
    await expect(
      promoteIntent({ root, capture: captured.capture.id.slice(0, 8), to: "requirement" }),
    ).rejects.toThrow(/is ambiguous/);
  });
});

describe("intent list", () => {
  it("follows the registry supersedes chain only when lineage is requested", async () => {
    const root = await intentWorkspace("ListLineage");
    const old = await captureIntent({ root, text: INTENT_TEXT });
    await mkdir(path.join(root, "systems", "next"), { recursive: true });
    await registerSystem(root, { path: "systems/next" });
    await promoteSystem(root, "next");
    await updateSystem(root, "next", { supersedes: ["app"] });
    const current = await captureIntent({ root, text: "The replacement keeps CSV export." });

    const scoped = await listIntent({ root, system: "next" });
    expect(scoped.captures.map((entry) => entry.id)).toEqual([current.capture.id]);

    const lineage = await listIntent({ root, system: "next", includeLineage: true });
    expect(lineage.systems).toEqual(["app", "next"]);
    expect(lineage.captures.map((entry) => entry.id).sort()).toEqual(
      [old.capture.id, current.capture.id].sort(),
    );
  });

  it("ignores the capability module's README", async () => {
    const root = await intentWorkspace("ListReadme");

    expect((await listIntent({ root })).captures).toEqual([]);
  });

  it("marks a damaged record instead of failing the whole listing", async () => {
    const root = await intentWorkspace("ListIntegrity");
    const intact = await captureIntent({ root, text: INTENT_TEXT });
    const edited = await captureIntent({ root, text: "Totals must reconcile with the ledger." });
    const broken = await captureIntent({ root, text: "Retention is ninety days." });

    const editedPath = path.join(root, edited.capture.path);
    await writeFile(editedPath, `${await readFile(editedPath, "utf8")}Reworded later.\n`, "utf8");
    await writeFile(path.join(root, broken.capture.path), "not an intent record\n", "utf8");

    const listed = await listIntent({ root });
    const byId = new Map(listed.captures.map((entry) => [entry.id, entry]));
    expect([...byId.keys()].sort()).toEqual(
      [intact.capture.id, edited.capture.id, broken.capture.id].sort(),
    );
    expect(byId.get(intact.capture.id)?.integrity).toBe("ok");
    expect(byId.get(intact.capture.id)?.integrityMessage).toBeUndefined();
    expect(byId.get(edited.capture.id)?.integrity).toBe("modified");
    expect(byId.get(edited.capture.id)?.integrityMessage).toMatch(/was modified after recording/);
    expect(byId.get(broken.capture.id)?.integrity).toBe("unreadable");
    expect(byId.get(broken.capture.id)?.integrityMessage).toMatch(/not a readable intent record/);

    // A record too damaged to name its system stays visible in a scoped view.
    const scoped = await listIntent({ root, system: "app" });
    expect(scoped.captures.map((entry) => entry.id).sort()).toEqual(
      [intact.capture.id, edited.capture.id, broken.capture.id].sort(),
    );

    // Reporting damage in the listing does not soften the write paths.
    await expect(
      promoteIntent({ root, capture: edited.capture.id, to: "requirement" }),
    ).rejects.toThrow(/was modified after recording/);
    await expect(captureIntent({ root, text: "Retention is ninety days." })).rejects.toThrow(
      /not a readable intent record/,
    );
  });
});

describe("intent path inputs stay inside the workspace", () => {
  it("refuses a --file path above the workspace and captures nothing", async () => {
    const root = await intentWorkspace("FileEscape");
    const outside = path.join(path.dirname(root), "outside-intent.md");
    await writeFile(outside, "Secret intent from another project.\n", "utf8");

    await expect(captureIntent({ root, file: "../outside-intent.md" })).rejects.toThrow(
      /intent source path escapes the workspace/,
    );

    expect(await readdir(path.join(root, "intent", "original"))).toEqual(["README.md"]);
  });

  it("refuses an absolute --file path outside the workspace", async () => {
    const root = await intentWorkspace("FileAbsoluteEscape");
    const outside = path.join(path.dirname(root), "absolute-intent.md");
    await writeFile(outside, "Secret intent from another project.\n", "utf8");

    await expect(captureIntent({ root, file: outside })).rejects.toThrow(
      /intent source path escapes the workspace/,
    );
  });

  it("still captures from a file inside the workspace", async () => {
    const root = await intentWorkspace("FileInside");
    await writeFile(path.join(root, "knowledge", "brief.md"), `${INTENT_TEXT}\n`, "utf8");

    const captured = await captureIntent({ root, file: "knowledge/brief.md" });

    expect(await readFile(path.join(root, captured.capture.path), "utf8")).toContain(INTENT_TEXT);
  });

  it("refuses a path-shaped capture selector instead of reading outside intent/original", async () => {
    const root = await intentWorkspace("SelectorEscape");
    const outside = path.join(path.dirname(root), "evil.md");
    await writeFile(outside, '---\nintent: "x"\n---\n\nnope\n', "utf8");

    await expect(promoteIntent({ root, capture: "../../evil", to: "requirement" })).rejects.toThrow(
      /invalid intent capture selector/,
    );
    await expect(promoteIntent({ root, capture: "../../evil", to: "requirement" })).rejects.toThrow(
      FrameworkError,
    );
  });
});

describe("intent in an overlay workspace", () => {
  it("keeps captures under .assay and out of the product repo", async () => {
    // `attach` already registered the product repo root as the primary system.
    const root = await overlayIntentWorkspace("OverlayIntent");

    const captured = await captureIntent({ root, text: INTENT_TEXT });

    expect(captured.capture.path).toBe(`.assay/intent/original/${captured.capture.id}.md`);
    expect(await exists(path.join(root, "intent"))).toBe(false);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("reports intent zones in status only where the module is enabled", async () => {
    const withIntent = await intentWorkspace("StatusWithIntent");
    await captureIntent({ root: withIntent, text: INTENT_TEXT });
    const withoutRoot = path.join(await tempDirs.createTempDir(), "StatusWithoutIntent");
    await initFramework({ target: withoutRoot, name: "StatusWithoutIntent", archetype: "library" });

    const withZones = (await getFrameworkStatus({ root: withIntent })).zones;
    expect(withZones).toContainEqual({
      path: "intent/original",
      files: 2,
      purpose: "Verbatim intent captures, append-only",
    });
    expect(withZones.some((zone) => zone.path === "intent/requirements")).toBe(true);

    const withoutZones = (await getFrameworkStatus({ root: withoutRoot })).zones;
    expect(withoutZones.some((zone) => zone.path.startsWith("intent/"))).toBe(false);
  });

  it("hoists intent out of .assay on convert and strands nothing behind", async () => {
    const root = await overlayIntentWorkspace("ConvertIntent");
    const captured = await captureIntent({ root, text: INTENT_TEXT });
    await promoteIntent({
      root,
      capture: captured.capture.id,
      to: "requirement",
      title: "Full Export",
    });

    const target = path.join(path.dirname(root), "converted-intent");
    await convertOverlayToStandalone({ root, target, move: true, keepOverlay: false });

    expect(await exists(path.join(root, ".assay"))).toBe(false);
    expect(await exists(path.join(target, "intent", "original", `${captured.capture.id}.md`))).toBe(
      true,
    );
    expect((await readdir(path.join(target, "intent", "requirements"))).length).toBeGreaterThan(1);

    const managedPaths = Object.keys((await loadManifest(target))?.managed_files ?? {});
    expect(managedPaths).toContain("intent/README.md");
    expect(managedPaths.some((entry) => entry.startsWith(".assay/intent/"))).toBe(false);

    const check = await checkFramework({ root: target });
    expect(check.rows.filter((row) => row.status === "error")).toEqual([]);
    expect(check.ok).toBe(true);
    expect((await listIntent({ root: target })).captures.map((entry) => entry.id)).toEqual([
      captured.capture.id,
    ]);
  });
});

describe("intent advisories", () => {
  it("recommends private-git when intent lives in a private overlay", async () => {
    const root = await overlayIntentWorkspace("AdvisoryPrivateOverlay");

    const advisory = await checkFramework({ root, includeAdvisories: true });
    const row = advisory.rows.find((entry) => entry.path === ".assay/intent");
    expect(row?.status).toBe("warning");
    expect(row?.message).toContain("private-git");
    expect(advisory.ok).toBe(true);

    // Advisories are opt-in: the default check must stay silent about it.
    const plain = await checkFramework({ root });
    expect(plain.rows.some((entry) => entry.path === ".assay/intent")).toBe(false);
  });

  it("does not raise the overlay advisory for a workspace without intent", async () => {
    const root = path.join(await tempDirs.createTempDir(), "AdvisoryNoIntent");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"product"}\n', "utf8");
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "assay@example.test"]);
    await git(root, ["config", "user.name", "Assay Test"]);
    await git(root, ["add", "package.json"]);
    await git(root, ["commit", "-m", "initial"]);
    await attachExistingRepo({
      root,
      name: "AdvisoryNoIntent",
      archetype: "library",
      privacy: "private",
      noTrack: true,
    });

    const advisory = await checkFramework({ root, includeAdvisories: true });
    expect(advisory.rows.some((entry) => entry.path === ".assay/intent")).toBe(false);
  });

  it("flags a superseded system no chain points at, and only as an advisory", async () => {
    const root = await intentWorkspace("AdvisorySupersededChain");
    await mkdir(path.join(root, "systems", "next"), { recursive: true });
    await registerSystem(root, { path: "systems/next" });
    await promoteSystem(root, "next");

    const advisory = await checkFramework({ root, includeAdvisories: true });
    const row = advisory.rows.find((entry) =>
      entry.message?.includes("system 'app' is superseded"),
    );
    expect(row?.status).toBe("warning");
    expect(advisory.ok).toBe(true);
    expect(
      (await checkFramework({ root })).rows.some((entry) =>
        entry.message?.includes("is superseded but no system records it"),
      ),
    ).toBe(false);

    await updateSystem(root, "next", { supersedes: ["app"] });
    expect(
      (await checkFramework({ root, includeAdvisories: true })).rows.some((entry) =>
        entry.message?.includes("is superseded but no system records it"),
      ),
    ).toBe(false);
  });
});

describe("intent capability scaffolding", () => {
  it("keeps its templates under update management and its dirs in check", async () => {
    const root = await intentWorkspace("IntentScaffold");

    expect(await exists(path.join(root, "intent", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intent", "original", "README.md"))).toBe(true);
    expect(await exists(path.join(root, "intent", "requirements", "README.md"))).toBe(true);
    expect(Object.keys((await loadManifest(root))?.managed_files ?? {})).toContain(
      "intent/original/README.md",
    );

    const check = await checkFramework({ root });
    expect(check.rows).toContainEqual(
      expect.objectContaining({ path: "intent/original", status: "ok" }),
    );
    expect(check.ok).toBe(true);

    await rm(path.join(root, "intent", "requirements"), { recursive: true, force: true });
    expect((await checkFramework({ root })).rows).toContainEqual(
      expect.objectContaining({ path: "intent/requirements", status: "missing" }),
    );
  });
});
