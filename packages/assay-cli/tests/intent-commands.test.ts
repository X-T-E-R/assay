import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
  pathExists,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-intent-cli");
let registryRoot = "";
let cliRunner: BuiltCliRunner;

const INTENT_TEXT = "The report must show the same totals the export produces.";

afterEach(async () => {
  await tempDirs.cleanup();
});

beforeEach(async () => {
  registryRoot = await createIsolatedRegistryRoot(tempDirs);
  cliRunner = createBuiltCliRunner({ registryRoot });
});

async function runCli(args: readonly string[]) {
  return cliRunner.runCli(args);
}

/** Workspace with the intent capability enabled and a registered primary system. */
async function intentWorkspace(name: string): Promise<string> {
  const root = await createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
    archetype: "library",
  });
  expect((await runCli(["capability", "add", "intent", "--root", root])).exitCode).toBe(0);
  await mkdir(path.join(root, "systems", "app"), { recursive: true });
  expect(
    (await runCli(["system", "register", "systems/app", "--primary", "--root", root])).exitCode,
  ).toBe(0);
  return root;
}

async function captureId(root: string, text: string): Promise<string> {
  const result = await runCli(["intent", "capture", "--text", text, "--root", root]);
  expect(result.exitCode, result.stderr).toBe(0);
  const id = result.stdout.match(/Captured intent: (\S+)/)?.[1];
  expect(id).toBeDefined();
  return id as string;
}

describe("assay intent CLI", () => {
  it("exposes the intent command family", async () => {
    const result = await runCli(["intent", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const sub of ["capture", "promote", "list"]) {
      expect(result.stdout).toContain(sub);
    }
    expect(result.stderr).toBe("");
  });

  it("captures verbatim text and reports the record it wrote", async () => {
    const root = await intentWorkspace("IntentCapture");

    const result = await runCli([
      "intent",
      "capture",
      "--text",
      INTENT_TEXT,
      "--source",
      "kickoff call",
      "--root",
      root,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/Captured intent: \d{8}-[0-9a-f]{12}/);
    expect(result.stdout).toContain("System: app");
    expect(result.stdout).toContain("Event:");

    const id = result.stdout.match(/Captured intent: (\S+)/)?.[1];
    expect(await pathExists(path.join(root, "intent", "original", `${id}.md`))).toBe(true);
    expect(await readFile(path.join(root, "intent", "original", `${id}.md`), "utf8")).toContain(
      INTENT_TEXT,
    );

    const rerun = await runCli(["intent", "capture", "--text", INTENT_TEXT, "--root", root]);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toContain("Intent already captured");
  });

  it("reports the capability requirement instead of scaffolding on demand", async () => {
    const root = await createInitializedCliWorkspace({
      tempDirs,
      runner: cliRunner,
      directoryName: "IntentNoCapability",
      archetype: "library",
    });

    const result = await runCli(["intent", "capture", "--text", INTENT_TEXT, "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("capability not enabled in archetype library: intent");
    expect(result.stderr).toContain("assay capability add intent");
  });

  it("refuses capture when the system's intent authority is external, and shadows with --force", async () => {
    const root = await intentWorkspace("IntentAuthority");
    expect(
      (
        await runCli([
          "system",
          "update",
          "app",
          "--intent-authority",
          "external",
          "--intent-pointer",
          "https://atlas.example/app/intent",
          "--root",
          root,
        ])
      ).exitCode,
    ).toBe(0);

    const refused = await runCli(["intent", "capture", "--text", INTENT_TEXT, "--root", root]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("https://atlas.example/app/intent");
    expect(refused.stderr).toContain("--force");

    const forced = await runCli([
      "intent",
      "capture",
      "--text",
      INTENT_TEXT,
      "--force",
      "--root",
      root,
    ]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Shadow: yes");

    const listed = await runCli(["intent", "list", "--root", root]);
    expect(listed.stdout).toContain("[shadow]");
  });

  it("promotes a capture into a requirement and into an ADR", async () => {
    const root = await intentWorkspace("IntentPromote");
    expect((await runCli(["capability", "add", "adr", "--root", root])).exitCode).toBe(0);
    const id = await captureId(root, INTENT_TEXT);

    const requirement = await runCli([
      "intent",
      "promote",
      id,
      "--to",
      "requirement",
      "--title",
      "Matching totals",
      "--root",
      root,
    ]);
    expect(requirement.exitCode).toBe(0);
    expect(requirement.stdout).toContain("Path: intent/requirements/");

    const decision = await runCli([
      "intent",
      "promote",
      id,
      "--to",
      "decision",
      "--title",
      "Share one totals query",
      "--root",
      root,
    ]);
    expect(decision.exitCode).toBe(0);
    expect(decision.stdout).toContain("ADR: ADR-0001-share-one-totals-query");

    const adr = await runCli(["adr", "show", "ADR-0001", "--root", root, "--json"]);
    expect(JSON.parse(adr.stdout)).toMatchObject({ related_intent: id, system: "app" });

    const listed = await runCli(["intent", "list", "--root", root]);
    expect(listed.stdout).toContain("1 requirement(s)");
    expect(listed.stdout).toContain("ADR ADR-0001-share-one-totals-query");

    expect((await runCli(["check", "--root", root])).exitCode).toBe(0);
  });

  it("rejects an unsupported promotion target", async () => {
    const root = await intentWorkspace("IntentPromoteTarget");
    const id = await captureId(root, INTENT_TEXT);

    const result = await runCli(["intent", "promote", id, "--to", "poem", "--root", root]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--to");
  });

  it("lists lineage systems only when asked", async () => {
    const root = await intentWorkspace("IntentLineage");
    const old = await captureId(root, INTENT_TEXT);
    await mkdir(path.join(root, "systems", "next"), { recursive: true });
    await runCli(["system", "register", "systems/next", "--root", root]);
    await runCli(["system", "promote", "next", "--root", root]);
    await runCli(["system", "update", "next", "--supersedes", "app", "--root", root]);
    const current = await captureId(root, "The replacement still reconciles totals.");

    const scoped = await runCli(["intent", "list", "--system", "next", "--root", root]);
    expect(scoped.stdout).toContain(current);
    expect(scoped.stdout).not.toContain(old);

    const lineage = await runCli([
      "intent",
      "list",
      "--system",
      "next",
      "--include-lineage",
      "--json",
      "--root",
      root,
    ]);
    const payload = JSON.parse(lineage.stdout) as {
      systems: string[];
      captures: { id: string }[];
    };
    expect(payload.systems).toEqual(["app", "next"]);
    expect(payload.captures.map((capture) => capture.id).sort()).toEqual([old, current].sort());
  });

  it("shows the intent authority flags in system help", async () => {
    const register = await runCli(["system", "register", "--help"]);
    const update = await runCli(["system", "update", "--help"]);

    expect(register.stdout).toContain("--intent-authority");
    expect(register.stdout).toContain("--intent-pointer");
    expect(update.stdout).toContain("--no-intent-authority");
  });
});
