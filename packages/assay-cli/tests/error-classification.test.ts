import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-cli-error-classification");
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({ registryRoot: await createIsolatedRegistryRoot(tempDirs) });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string, archetype?: string): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
    ...(archetype ? { archetype } : {}),
  });
}

/**
 * `Error:` marks something the caller can fix by changing their input;
 * `Runtime error:` is reserved for Assay's own faults. Scripts branch on that
 * distinction, so each case asserts the prefix, not just a non-zero exit.
 */
describe("assay error messages distinguish user input from internal faults", () => {
  it("prefixes a capability that the chosen archetype does not enable with Error", async () => {
    const root = await workspace("PrefixCapability");

    const result = await cliRunner.runCli(["iteration", "start", "Try Pattern", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: capability not enabled in archetype study: iteration");
    expect(result.stderr).not.toContain("Runtime error");
  });

  it("prefixes an unknown archetype with Error", async () => {
    const root = path.join(await tempDirs.createTempDir(), "PrefixArchetype");

    const result = await cliRunner.runCli([
      "init",
      root,
      "--name",
      "PrefixArchetype",
      "--archetype",
      "nonexistent",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: archetype not found: nonexistent");
    expect(result.stderr).not.toContain("Runtime error");
  });

  it("prefixes a self-superseding ADR with Error", async () => {
    const root = await workspace("PrefixAdr");
    const created = await cliRunner.runCli(["adr", "new", "T1", "--root", root]);
    expect(created.exitCode, created.stderr).toBe(0);
    const id = created.stdout.match(/ADR-\d{4}-[a-z0-9-]+/)?.[0];
    if (!id) throw new Error(`ADR id not found in output:\n${created.stdout}`);
    await cliRunner.runCli(["adr", "accept", id, "--root", root]);

    const result = await cliRunner.runCli(["adr", "supersede", id, id, "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Error: ADR cannot supersede itself: ${id}`);
    expect(result.stderr).not.toContain("Runtime error");
  });

  it("keeps Runtime error for a corrupted persisted record", async () => {
    const root = await workspace("PrefixCorrupt");
    await writeFile(path.join(root, ".assay", "manifest.json"), '{"__schema": 1}', "utf8");

    const result = await cliRunner.runCli(["update", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Runtime error");
  });
});
