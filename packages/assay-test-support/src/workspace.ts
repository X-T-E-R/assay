import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BuiltCliRunner } from "./cli.js";
import type { TempDirectoryFixture } from "./filesystem.js";

/**
 * Name of the archetype `writeBareArchetype` installs: extends base, declares
 * no directories of its own, and enables no capability modules.
 */
export const BARE_ARCHETYPE = "bare";

/**
 * Write a project-local archetype into a workspace root before it is
 * initialized, so `init` and `attach` can resolve a shape no built-in
 * provides. The common case is a workspace with no capability modules at all,
 * which is the starting point every `capability add` test needs.
 */
export async function writeProjectArchetype(options: {
  readonly root: string;
  readonly name: string;
  readonly mode?: "learning" | "absorption";
  readonly description?: string;
  readonly modules?: readonly string[];
  readonly dirs?: readonly string[];
}): Promise<string> {
  const archetypeDir = path.join(options.root, ".assay", "archetypes");
  await mkdir(archetypeDir, { recursive: true });
  const archetypePath = path.join(archetypeDir, `${options.name}.yaml`);
  const modules = options.modules ?? [];
  const dirs = options.dirs ?? [];
  await writeFile(
    archetypePath,
    [
      "extends: base",
      `mode: ${options.mode ?? "learning"}`,
      `description: ${options.description ?? `Test archetype ${options.name}.`}`,
      modules.length === 0 ? "modules: []" : "modules:",
      ...modules.map((module) => `  - ${module}`),
      dirs.length === 0 ? "dirs: []" : "dirs:",
      ...dirs.map((directory) => `  - ${directory}`),
      "dirs_learning: []",
      "dirs_absorption: []",
      "templates: []",
      "",
    ].join("\n"),
    "utf8",
  );
  return archetypePath;
}

/** Install {@link BARE_ARCHETYPE} into a workspace root that does not exist yet. */
export async function writeBareArchetype(root: string): Promise<string> {
  return writeProjectArchetype({
    root,
    name: BARE_ARCHETYPE,
    description: "Shared core only, with no capability modules.",
  });
}

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
  /** Initialize with {@link BARE_ARCHETYPE}, installed into the root first. */
  readonly bare?: boolean;
  readonly extraArgs?: readonly string[];
}): Promise<string> {
  const root = await createWorkspaceRoot(options.tempDirs, options.directoryName);
  const archetype = options.bare ? BARE_ARCHETYPE : options.archetype;
  if (options.bare) {
    await writeBareArchetype(root);
  }
  const args = ["init", root, "--name", options.projectName ?? options.directoryName];
  if (archetype) {
    args.push("--archetype", archetype);
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
