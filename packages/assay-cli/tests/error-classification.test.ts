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

async function workspace(name: string): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
  });
}

/**
 * `Error:` marks something the caller can fix by changing their input;
 * `Runtime error:` is reserved for Assay's own faults. Scripts branch on that
 * distinction, so each case asserts the prefix, not just a non-zero exit.
 */
describe("assay error messages distinguish user input from internal faults", () => {
  it("prefixes an unknown template with Error", async () => {
    const root = path.join(await tempDirs.createTempDir(), "PrefixTemplate");

    const result = await cliRunner.runCli([
      "init",
      root,
      "--name",
      "PrefixTemplate",
      "--template",
      "nonexistent",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: unknown template 'nonexistent'");
    expect(result.stderr).not.toContain("Runtime error");
  });

  it("reports an old manifest as a stable cutover requirement", async () => {
    const root = await workspace("PrefixCorrupt");
    await writeFile(path.join(root, ".assay", "manifest.json"), '{"__schema": 1}', "utf8");

    const result = await cliRunner.runCli(["update", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Workspace cutover required");
    expect(result.stderr).toContain("0.12.0+s4+l8");
    expect(result.stderr).toContain("assay-cutover:");
  });
});
