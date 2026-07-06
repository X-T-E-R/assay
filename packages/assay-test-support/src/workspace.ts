import path from "node:path";

import type { BuiltCliRunner } from "./cli.js";
import type { TempDirectoryFixture } from "./filesystem.js";

export async function createWorkspaceRoot(
  tempDirs: TempDirectoryFixture,
  directoryName: string,
): Promise<string> {
  return path.join(await tempDirs.createTempDir(), directoryName);
}

export async function createInitializedCoreWorkspace<Result>(options: {
  readonly tempDirs: TempDirectoryFixture;
  readonly directoryName: string;
  readonly initialize: (root: string) => Promise<Result>;
}): Promise<{ readonly root: string; readonly result: Result }> {
  const root = await createWorkspaceRoot(options.tempDirs, options.directoryName);
  const result = await options.initialize(root);
  return { root, result };
}

export async function createInitializedCliWorkspace(options: {
  readonly tempDirs: TempDirectoryFixture;
  readonly runner: BuiltCliRunner;
  readonly directoryName: string;
  readonly projectName?: string;
  readonly archetype?: string;
  readonly extraArgs?: readonly string[];
}): Promise<string> {
  const root = await createWorkspaceRoot(options.tempDirs, options.directoryName);
  const args = ["init", root, "--name", options.projectName ?? options.directoryName];
  if (options.archetype) {
    args.push("--archetype", options.archetype);
  }
  args.push(...(options.extraArgs ?? []));

  const result = await options.runner.runCli(args);
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Expected assay init for ${root} to exit with code 0, got ${result.exitCode}.`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return root;
}
