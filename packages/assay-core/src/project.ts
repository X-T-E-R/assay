import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { MANAGED_DIR, MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { workspaceWorkRelativePath } from "./layout.js";
import { projectReadableId } from "./readable-id.js";
import { type NativeProject, type WorkspaceLayout, nativeProjectSchema } from "./schemas/index.js";
import { withTaskLock } from "./tasks/task-storage.js";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROJECT_AUTHORITY_MODE = "native" as const;
export const PROJECT_AUTHORITY_POINTER = "README.md" as const;

export interface NativeProjectScaffoldResult {
  readonly project: NativeProject;
  readonly rootPath: string;
  readonly createdDirectories: readonly string[];
  readonly createdFiles: readonly string[];
}

export function projectRootRelativePath(layout: WorkspaceLayout): string {
  return workspaceWorkRelativePath(layout, "project");
}

export function projectFileRelativePath(layout: WorkspaceLayout): string {
  return `${projectRootRelativePath(layout)}/project.yaml`;
}

export function projectReadme(): string {
  return `# Project

This is the workspace's single native Project authority. The Project owns its adopted charter, roadmap, specifications, Project-selected Relay records, and extensions.

Semantic locations such as \`specs/\`, \`relay/\`, and \`extensions/\` are created only when the Project adopts material that belongs there. Their absence is healthy.

Native Specs under \`specs/<id>/{spec.yaml,specification.md}\` own current normative constraints and acceptance contracts. They are not approvals, Roadmap state, Task state, or System lifecycle signals; promotion and lifecycle commands do not propagate across those authorities.

Authority remains separate elsewhere:

- \`references/\` owns living and frozen external evidence.
- \`analyses/\` owns analysis records.
- \`tasks/\` owns Assay-native Task records.
- \`systems/\` owns registered System contracts and implementations.
- \`.assay/\` owns workspace layout, runtime state, receipts, and caches.

Project ownership does not grant plugins, Relay, Ponytail, or external tooling permission to write this area. Those tools act only through an explicit Project selection and their own declared authority.
`;
}

export function projectRoadmapReadme(): string {
  return `# Roadmap

This directory contains Assay-native Roadmap items. Each live item is stored at \`<id>/{item.yaml,outcome.md}\`; terminal items may be moved unchanged to \`archive/<id>/\`.

The root README is explanatory only. It is never a generated index. Machine state belongs in each \`item.yaml\`, while reader-edited outcome prose belongs in \`outcome.md\` and is never rewritten by lifecycle commands.

Roadmap items link to Tasks from their canonical \`task_refs\` field. Tasks do not carry Roadmap back-references, and neither Task nor Roadmap status changes propagate automatically.
`;
}

export function serializeNativeProject(project: NativeProject): string {
  return stringify(nativeProjectSchema.parse(project), { lineWidth: 0 });
}

export async function loadNativeProject(
  root: string,
  layout: WorkspaceLayout,
): Promise<NativeProject | null> {
  await preflightNativeProjectPath(root, layout);
  const relative = projectFileRelativePath(layout);
  let raw: string;
  try {
    raw = await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return nativeProjectSchema.parse(parse(raw));
  } catch (error) {
    throw new FrameworkError(`native Project envelope failed validation: ${relative}`, {
      code: "IO_ERROR",
      cause: error,
    });
  }
}

export async function ensureNativeProject(
  rootInput: string,
  layout: WorkspaceLayout,
  name: string,
): Promise<NativeProjectScaffoldResult> {
  const root = path.resolve(rootInput);
  return withTaskLock(root, path.join(root, layout.state_root, "project-create.lock"), () =>
    ensureNativeProjectUnlocked(root, layout, name),
  );
}

async function ensureNativeProjectUnlocked(
  root: string,
  layout: WorkspaceLayout,
  name: string,
): Promise<NativeProjectScaffoldResult> {
  const rootPath = projectRootRelativePath(layout);
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const projectDir = path.join(root, rootPath);
  const roadmapDir = path.join(projectDir, "roadmap");

  // Validate the complete existing boundary before mkdir/read/write. A
  // redirect anywhere in Project or its existing ancestry must not turn a
  // native lifecycle command into an external filesystem writer.
  await preflightNativeProjectPath(root, layout);

  for (const [absolute, relative] of [
    [projectDir, rootPath],
    [roadmapDir, `${rootPath}/roadmap`],
  ] as const) {
    if (!(await entryExists(absolute))) {
      await mkdir(absolute, { recursive: true });
      createdDirectories.push(relative);
    }
  }

  let project = await loadNativeProject(root, layout);
  if (!project) {
    project = nativeProjectSchema.parse({
      __schema: PROJECT_SCHEMA_VERSION,
      id: projectReadableId(name),
      name,
      authority: { mode: PROJECT_AUTHORITY_MODE, pointer: PROJECT_AUTHORITY_POINTER },
    });
    const relative = projectFileRelativePath(layout);
    await writeFile(path.join(root, relative), serializeNativeProject(project), {
      encoding: "utf8",
      flag: "wx",
    });
    createdFiles.push(relative);
  }

  for (const [relative, content] of [
    [`${rootPath}/README.md`, projectReadme()],
    [`${rootPath}/roadmap/README.md`, projectRoadmapReadme()],
  ] as const) {
    if (!(await entryExists(path.join(root, relative)))) {
      await writeFile(path.join(root, relative), content, { encoding: "utf8", flag: "wx" });
      createdFiles.push(relative);
    }
  }

  return { project, rootPath, createdDirectories, createdFiles };
}

/** Validate the required native Project files without interpreting prose. */
export async function validateNativeProjectStructure(
  rootInput: string,
  layout: WorkspaceLayout,
): Promise<void> {
  const root = path.resolve(rootInput);
  await preflightNativeProjectPath(root, layout);
  const projectRoot = path.join(root, projectRootRelativePath(layout));
  await assertOrdinaryDirectory(projectRoot, "native Project", false);
  await assertOrdinaryFile(path.join(projectRoot, "project.yaml"), "native Project envelope");
  await assertOrdinaryFile(
    path.join(projectRoot, PROJECT_AUTHORITY_POINTER),
    "native Project authority pointer",
  );
  const roadmap = path.join(projectRoot, "roadmap");
  await assertOrdinaryDirectory(roadmap, "native Project roadmap", false);
  await assertOrdinaryFile(path.join(roadmap, "README.md"), "native Project roadmap guide");
}

/** Read-only lifecycle preflight for a possibly not-yet-created Project. */
export async function preflightNativeProjectBoundary(
  rootInput: string,
  layout: WorkspaceLayout,
): Promise<void> {
  await preflightNativeProjectPath(path.resolve(rootInput), layout);
}

/** Safely establish the manifest boundary before its layout can be trusted. */
export async function preflightWorkspaceManifestBoundary(rootInput: string): Promise<void> {
  const root = path.resolve(rootInput);
  const stateRoot = path.join(root, MANAGED_DIR);
  await assertOrdinaryDirectory(
    await nearestExistingAncestor(stateRoot),
    "Assay manifest ancestor",
    false,
  );
  if (await entryExists(stateRoot)) {
    await assertOrdinaryDirectory(stateRoot, "Assay state root", false);
  }
  const manifest = path.join(root, MANIFEST_FILE);
  if (await entryExists(manifest)) {
    await assertOrdinaryFile(manifest, "Assay manifest");
  }
}

async function preflightNativeProjectPath(root: string, layout: WorkspaceLayout): Promise<void> {
  const projectRoot = path.join(root, projectRootRelativePath(layout));
  await assertOrdinaryDirectory(
    await nearestExistingAncestor(projectRoot),
    "native Project ancestor",
    false,
  );
  if (await assertOrdinaryDirectory(projectRoot, "native Project", true)) {
    // Roadmap and Spec descendants are validated item-by-item so one corrupt
    // record does not hide healthy siblings. Their roots are checked by the
    // owning modules, and every operation enforces its own reparse boundary.
    for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
      if (entry.name === "roadmap" || entry.name === "specs") continue;
      const entryPath = path.join(projectRoot, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new FrameworkError(
          `native Project contains a symlink, junction, or reparse point: ${entryPath}`,
        );
      }
      if (stats.isDirectory()) await assertOrdinaryTree(entryPath, "native Project");
      else if (!stats.isFile()) {
        throw new FrameworkError(`native Project contains a non-regular entry: ${entryPath}`);
      }
    }
    for (const [target, label] of [
      [path.join(projectRoot, "project.yaml"), "native Project envelope"],
      [path.join(projectRoot, PROJECT_AUTHORITY_POINTER), "native Project authority pointer"],
    ] as const) {
      if (await entryExists(target)) await assertOrdinaryFile(target, label);
    }
    const roadmap = path.join(projectRoot, "roadmap");
    if (await entryExists(roadmap)) {
      await assertOrdinaryDirectory(roadmap, "native Project roadmap", false);
      const roadmapReadme = path.join(roadmap, "README.md");
      if (await entryExists(roadmapReadme)) {
        await assertOrdinaryFile(roadmapReadme, "native Project roadmap guide");
      }
    }
  }
}

async function assertOrdinaryTree(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new FrameworkError(
        `${label} contains a symlink, junction, or reparse point: ${entryPath}`,
      );
    }
    if (stats.isDirectory()) {
      await assertOrdinaryDirectory(entryPath, label, false);
      await assertOrdinaryTree(entryPath, label);
    } else if (!stats.isFile()) {
      throw new FrameworkError(`${label} contains a non-regular entry: ${entryPath}`);
    }
  }
}

async function assertOrdinaryDirectory(
  target: string,
  label: string,
  allowMissing: boolean,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    if (isMissing(error)) throw new FrameworkNotFoundError(`${label} not found: ${target}`);
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new FrameworkError(
      `${label} must be a real directory, not a symlink or junction: ${target}`,
    );
  }
  const resolved = comparable(path.resolve(target));
  const actual = comparable(await realpath(target));
  if (resolved !== actual) {
    throw new FrameworkError(
      `${label} resolves through a symlink, junction, or reparse point: ${target}`,
    );
  }
  return true;
}

async function assertOrdinaryFile(target: string, label: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (isMissing(error)) throw new FrameworkNotFoundError(`${label} not found: ${target}`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new FrameworkError(`${label} must be a regular file, not a redirect: ${target}`);
  }
  if (comparable(path.resolve(target)) !== comparable(await realpath(target))) {
    throw new FrameworkError(`${label} resolves through a redirect: ${target}`);
  }
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FrameworkError(`no existing ancestor for native Project target: ${target}`);
    }
    current = parent;
  }
}

async function entryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
