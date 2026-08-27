import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-orientation-cli");
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({ registryRoot: await createIsolatedRegistryRoot(tempDirs) });
});

afterEach(async () => tempDirs.cleanup());

async function workspace(directoryName: string): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName,
    bare: true,
  });
}

const DIGEST_LABELS = [
  "Project is",
  "Task is",
  "Roadmap is",
  "Spec is",
  "Source is",
  "Source adoption is",
  "Analysis is",
  "Knowledge is",
  "System registry is",
];

describe("assay prime", { timeout: 60_000 }, () => {
  it("states the semantic contract and the workspace state within one screen", async () => {
    const root = await workspace("prime");
    const primed = await cliRunner.runCli(["prime", "--root", root]);
    expect(primed.exitCode, primed.stderr).toBe(0);

    for (const label of DIGEST_LABELS) {
      expect(primed.stdout).toContain(label);
    }
    expect(primed.stdout).toContain("Most-broken rule:");
    expect(primed.stdout).toContain("Layout:");
    expect(primed.stdout).toContain("standalone");
    expect(primed.stdout).toContain("Active tasks:");
    expect(primed.stdout).toContain("Primary system:");
    expect(primed.stdout).toContain("details: assay explain <topic>");
    expect(primed.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
  });

  it("reports active tasks and stays within the line budget once work exists", async () => {
    const root = await workspace("prime-tasks");
    for (const title of ["First outcome", "Second outcome", "Third outcome"]) {
      const created = await cliRunner.runCli(["task", "create", "--title", title, "--root", root]);
      expect(created.exitCode, created.stderr).toBe(0);
    }

    const primed = await cliRunner.runCli(["prime", "--root", root]);
    expect(primed.exitCode, primed.stderr).toBe(0);
    expect(primed.stdout).toContain("Active tasks:    3");
    expect(primed.stdout).toContain("task-0001-first-outcome");
    expect(primed.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
  });

  it("emits the same contract as JSON", async () => {
    const root = await workspace("prime-json");
    const primed = await cliRunner.runCli(["prime", "--root", root, "--json"]);
    expect(primed.exitCode, primed.stderr).toBe(0);
    const result = JSON.parse(primed.stdout) as {
      workspace: { layoutMode: string; zones: unknown[] } | null;
      semantics: { topic: string; purpose: string; antiRule: string }[];
      topics: string[];
      notes: string[];
    };
    expect(result.semantics).toHaveLength(9);
    expect(result.semantics.map((entry) => entry.topic)).toContain("adoption");
    expect(result.topics).toContain("workspace");
    expect(result.workspace?.layoutMode).toBe("standalone");
    expect(result.notes).toEqual([]);
  });

  it("degrades to the contract alone outside a workspace", async () => {
    const outside = await tempDirs.createTempDir();
    const primed = await cliRunner.runCli(["prime", "--root", outside]);
    expect(primed.exitCode, primed.stderr).toBe(0);
    expect(primed.stdout).toContain("Task is one bounded outcome");
    expect(primed.stdout).toContain("no Assay workspace found here");
    expect(primed.stdout).toContain("assay init");

    const json = await cliRunner.runCli(["prime", "--root", outside, "--json"]);
    expect(json.exitCode, json.stderr).toBe(0);
    const result = JSON.parse(json.stdout) as { workspace: unknown; semantics: unknown[] };
    expect(result.workspace).toBeNull();
    expect(result.semantics).toHaveLength(9);
  });
});

describe("assay explain", { timeout: 60_000 }, () => {
  it("answers why an object exists, when not to use it, and how it is misused", async () => {
    const explained = await cliRunner.runCli(["explain", "task"]);
    expect(explained.exitCode, explained.stderr).toBe(0);
    expect(explained.stdout).toContain("Most-broken rule:");
    expect(explained.stdout).toContain("Why it exists");
    expect(explained.stdout).toContain("When not to use it");
    expect(explained.stdout).toContain("Common misuses");
    expect(explained.stdout).toContain("Flags and options: assay task --help");
  });

  it("covers every documented topic", async () => {
    for (const topic of [
      "workspace",
      "project",
      "task",
      "roadmap",
      "spec",
      "source",
      "adoption",
      "analysis",
      "knowledge",
      "system",
    ]) {
      const explained = await cliRunner.runCli(["explain", topic, "--json"]);
      expect(explained.exitCode, `${topic}: ${explained.stderr}`).toBe(0);
      const entry = JSON.parse(explained.stdout) as { topic: string; commonMisuses: string[] };
      expect(entry.topic).toBe(topic);
      expect(entry.commonMisuses.length).toBeGreaterThan(0);
    }
  });

  it("names the valid topics for an unknown one", async () => {
    const explained = await cliRunner.runCli(["explain", "intent"]);
    expect(explained.exitCode).toBe(1);
    expect(explained.stderr).toContain("unknown topic 'intent'");
    expect(explained.stderr).toContain("explain covers: workspace, project, task");
  });
});

describe("point-of-use hints", { timeout: 60_000 }, () => {
  it("closes human output with one line and exposes hints in JSON", async () => {
    const root = await workspace("hints");

    const created = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Ship it",
      "--root",
      root,
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const lines = created.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(
      "Hint: One durable outcome is one Task; a new attempt at the same outcome is not a new Task.",
    );

    const createdJson = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Ship it again",
      "--root",
      root,
      "--json",
    ]);
    expect(createdJson.exitCode, createdJson.stderr).toBe(0);
    const result = JSON.parse(createdJson.stdout) as { hints: string[]; task: { id: string } };
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toContain("a new attempt at the same outcome is not a new Task");

    const finished = await cliRunner.runCli([
      "task",
      "finish",
      result.task.id,
      "--root",
      root,
      "--json",
    ]);
    expect(finished.exitCode, finished.stderr).toBe(0);
    const finishedResult = JSON.parse(finished.stdout) as { hints: string[] };
    expect(finishedResult.hints[0]).toContain("it does not archive the Task");

    const added = await cliRunner.runCli([
      "knowledge",
      "add",
      "pattern",
      "Kept lesson",
      "--root",
      root,
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout.trimEnd().split("\n").at(-1)).toContain(
      "work in progress stays in an Analysis",
    );
  });
});

describe("teaching errors", { timeout: 60_000 }, () => {
  it("states the correct model when a terminal Task is reopened", async () => {
    const root = await workspace("teaching");
    const created = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Bounded outcome",
      "--root",
      root,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const id = (JSON.parse(created.stdout) as { task: { id: string } }).task.id;

    const finished = await cliRunner.runCli(["task", "finish", id, "--root", root]);
    expect(finished.exitCode, finished.stderr).toBe(0);

    const reopened = await cliRunner.runCli(["task", "status", id, "active", "--root", root]);
    expect(reopened.exitCode).toBe(1);
    expect(reopened.stderr).toContain("terminal task cannot change status");
    expect(reopened.stderr).toContain(
      "Terminal Tasks stay terminal: create a successor Task and record `continues` or `supersedes`.",
    );
  });

  it("states the correct model when a live Task is archived too early", async () => {
    const root = await workspace("teaching-archive");
    const created = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Still open",
      "--root",
      root,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const id = (JSON.parse(created.stdout) as { task: { id: string } }).task.id;

    const archived = await cliRunner.runCli(["task", "archive", id, "--root", root]);
    expect(archived.exitCode).toBe(1);
    expect(archived.stderr).toContain("Archive follows a terminal status");
  });
});
