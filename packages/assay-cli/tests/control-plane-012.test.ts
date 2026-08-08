import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-cli-control-plane-012");
let runner: BuiltCliRunner;
let indexRoot: string;

beforeEach(async () => {
  indexRoot = await createIsolatedRegistryRoot(tempDirs);
  runner = createBuiltCliRunner({ registryRoot: indexRoot });
});

afterEach(async () => tempDirs.cleanup());

describe("0.13 CLI control plane", () => {
  it("offers template/workspace commands and removes retired public surfaces", async () => {
    const help = await runner.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("template");
    expect(help.stdout).toContain("workspace");
    expect(help.stdout).not.toMatch(/\barchetype\b/);
    expect(help.stdout).not.toMatch(/\bprojects\b/);
    expect(help.stdout).not.toMatch(/\bevent\b/);

    const templates = await runner.runCli(["template", "list", "--json"]);
    expect(JSON.parse(templates.stdout).map((entry: { name: string }) => entry.name)).toEqual([
      "study",
      "solve",
      "explore",
    ]);
    const retired = await runner.runCli(["archetype", "list"]);
    expect(retired.exitCode).toBe(1);
    const manualEvent = await runner.runCli(["event", "capture", "--kind", "note"]);
    expect(manualEvent.exitCode).toBe(1);
  });

  it("uses an explicit custom template once and never writes the index implicitly", async () => {
    const parent = await tempDirs.createTempDir();
    const root = path.join(parent, "workspace");
    const descriptor = path.join(parent, "custom.yaml");
    await writeFile(
      descriptor,
      "__schema: 1\ndescription: CLI custom.\ndirectories:\n  - path: custom\n    purpose: Custom\nfiles:\n  - path: custom/value.txt\n    content: hello\n",
      "utf8",
    );
    const init = await runner.runCli(["init", root, "--template", descriptor, "--no-agents"]);
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("Template: custom");
    expect((await runner.runCli(["workspace", "list", "--json"])).stdout.trim()).toBe("[]");
    await runner.runCli(["status", "--root", root]);
    await runner.runCli(["update", "--root", root, "--dry-run"]);
    expect((await runner.runCli(["workspace", "list", "--json"])).stdout.trim()).toBe("[]");

    const tracked = await runner.runCli(["workspace", "track", root, "--json"]);
    expect(tracked.exitCode).toBe(0);
    const trackedRecord = JSON.parse(tracked.stdout) as { __schema: number; path: string };
    const canonicalRoot = await realpath(root);
    expect(trackedRecord).toMatchObject({ __schema: 1, path: canonicalRoot });
    const listed = await runner.runCli(["workspace", "list", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({
        status: "current",
        record: expect.objectContaining({ path: canonicalRoot }),
      }),
    ]);
    expect((await runner.runCli(["workspace", "forget", trackedRecord.path])).exitCode).toBe(0);
  });
});
