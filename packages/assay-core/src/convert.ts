import type { Stats } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { MANAGED_DIR, MANAGED_FILES_FILE, MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
  type WorkspaceArea,
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspacePath,
  workspaceWorkRelativePath,
} from "./layout.js";
import { loadManagedFiles, saveManagedFiles } from "./managed-files.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { assertNoAncestorWorkspaceAuthority, relativeDisplayPath } from "./paths.js";
import { loadNativeProject } from "./project.js";
import { withRoadmapGlobalCoordination } from "./roadmap.js";
import type {
  FrameworkManifest,
  SystemRecord,
  SystemsRegistry,
  WorkspaceLayout,
} from "./schemas/index.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";
import { getSourceAdoption, listSourceAdoptions } from "./source-adoptions.js";
import { resolveSourceObservation } from "./sources.js";
import { withSpecGlobalCoordination } from "./spec.js";
import {
  normalizeRegistryPath,
  requireSystemsRegistrySnapshot,
  resolveRegistryPath,
  saveSystemsRegistry,
  systemRecordForSelector,
} from "./systems-registry.js";
import { withWorkspaceConversionCoordination } from "./tasks/task-storage.js";

export interface ConvertOverlayOptions {
  readonly root: string;
  readonly target: string;
  readonly move?: boolean;
  readonly keepOverlay?: boolean;
  readonly now?: Date;
}

interface ConversionSemanticPreflight {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly sourceLayout: WorkspaceLayout;
  readonly targetLayout: WorkspaceLayout;
  readonly sourceRegistry: SystemsRegistry;
  readonly additionalWorkDirectories: readonly string[];
}

async function preflightConversionSemantics(
  input: ConversionSemanticPreflight,
): Promise<SystemsRegistry> {
  const systems = Object.fromEntries(
    Object.entries(input.sourceRegistry.systems).map(([name, record]) => [
      name,
      rewriteSystemRecord(record, input),
    ]),
  );
  const targetRegistry: SystemsRegistry = { ...input.sourceRegistry, systems };

  const adoptions = await listSourceAdoptions({ root: input.sourceRoot });
  for (const entry of adoptions.adoptions) {
    const { definition } = await getSourceAdoption({
      root: input.sourceRoot,
      adoptionId: entry.id,
    });
    await resolveSourceObservation({
      root: input.sourceRoot,
      alias: definition.source.alias,
      observation: definition.source.observation,
    });
    for (const target of definition.targets) {
      const sourceSystem = systemRecordForSelector(input.sourceRegistry, target.system);
      const targetSystem = systemRecordForSelector(targetRegistry, target.system);
      if (!sourceSystem || !targetSystem) {
        throw new FrameworkError(
          `source adoption '${definition.id}' targets unknown system '${target.system}'`,
        );
      }
      const current = resolveRegistryPath(input.sourceRoot, sourceSystem.path);
      let info: Stats;
      try {
        info = await lstat(current);
      } catch {
        throw new FrameworkError(
          `source adoption '${definition.id}' target system '${target.system}' does not resolve before conversion: ${sourceSystem.path}`,
        );
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new FrameworkError(
          `source adoption '${definition.id}' target system '${target.system}' is not a real directory: ${sourceSystem.path}`,
        );
      }
      const predicted = predictedConvertedSystemAbsolutePath(sourceSystem, targetSystem, input);
      if (!predicted) {
        throw new FrameworkError(
          `source adoption '${definition.id}' target system '${target.system}' cannot preserve its semantic path during conversion`,
        );
      }
    }
  }
  return targetRegistry;
}

function rewriteSystemRecord(
  record: SystemRecord,
  input: ConversionSemanticPreflight,
): SystemRecord {
  if (path.isAbsolute(record.path)) {
    return { ...record, path: normalizeRegistryPath(input.targetRoot, record.path) };
  }
  const relayout = relayoutWorkPath(
    toPosixPath(record.path),
    input.sourceLayout,
    input.targetLayout,
    input.additionalWorkDirectories,
  );
  const rewrittenPath =
    relayout !== toPosixPath(record.path)
      ? relayout
      : normalizeRegistryPath(input.targetRoot, resolveRegistryPath(input.sourceRoot, record.path));
  return { ...record, path: rewrittenPath };
}

function predictedConvertedSystemAbsolutePath(
  source: SystemRecord,
  target: SystemRecord,
  input: ConversionSemanticPreflight,
): string | null {
  const current = resolveRegistryPath(input.sourceRoot, source.path);
  const predicted = resolveRegistryPath(input.targetRoot, target.path);
  if (path.isAbsolute(source.path)) {
    return path.normalize(predicted) === path.normalize(current) ? predicted : null;
  }
  const relayout = relayoutWorkPath(
    toPosixPath(source.path),
    input.sourceLayout,
    input.targetLayout,
    input.additionalWorkDirectories,
  );
  if (relayout !== toPosixPath(source.path)) return predicted;
  return path.normalize(predicted) === path.normalize(current) ? predicted : null;
}

async function rewriteCurrentSourceSemanticPaths(
  targetRoot: string,
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const targetSources = workspacePath(targetRoot, targetLayout, "sources");
  if (!(await exists(targetSources))) return;
  const sourceSources = workspacePath(sourceRoot, sourceLayout, "sources");
  for (const entry of await readdir(targetSources, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetEntry = path.join(targetSources, entry.name);
    const sourceEntry = path.join(sourceSources, entry.name);
    const observations = path.join(targetEntry, "observations");
    if (await exists(observations)) {
      for (const file of await readdir(observations, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
        const absolute = path.join(observations, file.name);
        const parsed = parseYaml(await readFile(absolute, "utf8")) as Record<string, unknown>;
        parsed.source_path = toPosixPath(path.relative(targetRoot, targetEntry));
        await writeFile(absolute, stringifyYaml(parsed), "utf8");
      }
    }
    const manifests = path.join(targetEntry, "manifests");
    if (await exists(manifests)) {
      for (const file of await readdir(manifests, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const absolute = path.join(manifests, file.name);
        const parsed = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
        if (typeof parsed.root === "string") {
          const relative = path.relative(sourceEntry, parsed.root);
          if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
            parsed.root = path.resolve(targetEntry, relative);
          }
        }
        await writeFile(absolute, stringifySortedJson(parsed), "utf8");
      }
    }
  }
}

export interface ConvertOverlayResult {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly moved: boolean;
  readonly keepOverlay: boolean;
  /** True when the emptied overlay state directory was removed after a move. */
  readonly overlayStateRemoved: boolean;
  readonly layout: WorkspaceLayout;
  readonly systemSelector: string;
  readonly system: SystemRecord;
  readonly sourceManifestPath: string;
  readonly targetManifestPath: string;
  readonly eventFile: string;
}

/** Work areas hoisted out of `.assay/` when detaching an overlay. */
const OVERLAY_WORK_AREAS = ["sources", "analyses", "knowledge"] as const;

/**
 * Work folders that live under the work root without a `layout.paths` key, so
 * they are hoisted and rewritten by their own name. Anything listed here that
 * is missing from both the hoist and the managed-path rewrite would be
 * stranded in the source overlay after a move.
 */
const OVERLAY_WORK_DIRECTORIES = ["project", "tasks"] as const;

/**
 * Layout `paths` keys whose location differs between overlay and standalone.
 * Managed-file records are rewritten across all of them. The systems path is
 * transferred as ordinary user/System content; no filename inside it is a
 * contract or receives special parsing.
 */
const RELOCATED_PATH_KEYS = [
  "sources",
  "analyses",
  "knowledge",
  "systems",
] as const satisfies readonly (keyof WorkspaceLayout["paths"])[];

type ConvertRoadmapProbe = () => void | Promise<void>;
let roadmapCoordinationProbe: ConvertRoadmapProbe | undefined;

/** Test-only hook after conversion preflight while Roadmap coordination is held. */
export function setConvertRoadmapProbeForTests(probe: ConvertRoadmapProbe | undefined): void {
  roadmapCoordinationProbe = probe;
}

async function exists(target: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Detach an overlay workspace into a sibling standalone workbench without
 * touching the product repository. Work folders are hoisted out of `.assay/`
 * to the target root, Assay state is copied/moved to `target/.assay/`, the
 * manifest layout is rewritten to standalone, and the original product repo
 * is registered as the primary independent system by relative path.
 */
export async function convertOverlayToStandalone(
  options: ConvertOverlayOptions,
): Promise<ConvertOverlayResult> {
  const sourceRoot = path.resolve(options.root);
  const targetRoot = path.resolve(options.target);
  await assertNoAncestorWorkspaceAuthority(sourceRoot);
  await assertNoAncestorWorkspaceAuthority(targetRoot);
  // Fail old/invalid envelopes and receipts before coordination can create a
  // lock or target directory.
  const preflightManifest = await loadManifest(sourceRoot);
  if (preflightManifest) await loadManagedFiles(sourceRoot);
  const result = await withWorkspaceConversionCoordination(
    sourceRoot,
    async () => {
      const sourceManifest = await loadManifest(sourceRoot);
      if (!sourceManifest) {
        throw new FrameworkNotFoundError(
          `No Assay manifest found at ${path.join(sourceRoot, MANIFEST_FILE)}. Run \`assay attach\` first.`,
        );
      }
      const sourceLayout = resolveWorkspaceLayout(sourceManifest);
      if (!sourceLayout || sourceLayout.mode !== "overlay") {
        throw new FrameworkError(
          `convert --to standalone requires an overlay workspace; ${sourceRoot} is not overlay mode.`,
        );
      }
      const result = await withRoadmapGlobalCoordination(sourceRoot, () =>
        withSpecGlobalCoordination(sourceRoot, () => convertOverlayToStandaloneLocked(options)),
      );
      if (options.keepOverlay === false) {
        await removeEmptiedOverlayState(sourceRoot, sourceLayout);
      }
      return result;
    },
    { removeStateDirectoryWhenEmpty: options.keepOverlay === false },
  );
  if (options.keepOverlay === false) {
    return {
      ...result,
      overlayStateRemoved: !(await exists(path.join(sourceRoot, MANAGED_DIR))),
    };
  }
  return result;
}

async function convertOverlayToStandaloneLocked(
  options: ConvertOverlayOptions,
): Promise<ConvertOverlayResult> {
  const sourceRoot = path.resolve(options.root);
  const targetRoot = path.resolve(options.target);
  const now = options.now ?? new Date();
  const move = options.move ?? false;
  const keepOverlay = options.keepOverlay ?? true;
  if (!keepOverlay && !move) {
    throw new FrameworkError(
      "removing the source overlay requires --move; with --copy the overlay work folders are still the only copy of that state.",
    );
  }

  const sourceManifest = await loadManifest(sourceRoot);
  if (!sourceManifest) {
    throw new FrameworkNotFoundError(
      `No Assay manifest found at ${path.join(sourceRoot, MANIFEST_FILE)}. Run \`assay attach\` first.`,
    );
  }
  const sourceLayout = resolveWorkspaceLayout(sourceManifest);
  if (!sourceLayout || sourceLayout.mode !== "overlay") {
    throw new FrameworkError(
      `convert --to standalone requires an overlay workspace; ${sourceRoot} is not overlay mode.`,
    );
  }
  const targetLayout = defaultStandaloneLayout();
  const sourceReceipt = await loadManagedFiles(sourceRoot);
  const sourceProject = await loadNativeProject(sourceRoot, sourceLayout);
  if (!sourceProject) throw new FrameworkNotFoundError("native Project envelope is required");
  const additionalWorkDirectories = [
    ...new Set(
      sourceManifest.layout.entries
        .filter((entry) => entry.kind === "directory")
        .flatMap((entry) => {
          const relative =
            sourceLayout.work_root === ".assay" && entry.path.startsWith(".assay/")
              ? entry.path.slice(".assay/".length)
              : entry.path;
          const first = relative.split("/")[0];
          return first ? [first] : [];
        }),
    ),
  ].filter(
    (directory) =>
      !directory.startsWith(".") &&
      !OVERLAY_WORK_AREAS.includes(directory as (typeof OVERLAY_WORK_AREAS)[number]) &&
      !OVERLAY_WORK_DIRECTORIES.includes(directory as (typeof OVERLAY_WORK_DIRECTORIES)[number]) &&
      !["systems", "backups", "events", "source-adoptions"].includes(directory),
  );
  if (move && !keepOverlay) {
    await assertNoUnknownOverlayState(sourceRoot, sourceLayout, additionalWorkDirectories);
  }
  await assertSourceAdoptionStoreTransferSafe(sourceRoot, sourceLayout, targetRoot, targetLayout);
  const systemName = sourceProject.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sourceRegistrySnapshot = await requireSystemsRegistrySnapshot(sourceRoot);
  const sourceRegistry = sourceRegistrySnapshot.registry;
  const targetRegistry = await preflightConversionSemantics({
    sourceRoot,
    targetRoot,
    sourceLayout,
    targetLayout,
    sourceRegistry,
    additionalWorkDirectories,
  });
  const targetExists = await exists(targetRoot);
  await assertTaskContextTransferSafe(sourceRoot, sourceLayout, targetRoot, targetLayout);
  await assertTaskTransferPathsSafe(sourceRoot, sourceLayout, targetRoot, targetLayout);
  await assertNativeProjectTransferPathsSafe(sourceRoot, sourceLayout, targetRoot, targetLayout);
  for (const directory of additionalWorkDirectories) {
    await assertWorkDirectoryTransferPathsSafe(
      sourceRoot,
      sourceLayout,
      targetRoot,
      targetLayout,
      directory,
    );
  }
  await roadmapCoordinationProbe?.();
  if (targetExists) {
    if (await exists(path.join(targetRoot, MANIFEST_FILE))) {
      throw new FrameworkError(
        `target already has an Assay manifest: ${path.join(targetRoot, MANIFEST_FILE)}`,
      );
    }
  }
  if (!targetExists) {
    await mkdir(targetRoot, { recursive: true });
  }

  // Copy/move Assay state files. Conversion intentionally ignores retired
  // data surfaces and never reads or rewrites them.
  const stateAreas: readonly WorkspaceArea[] = ["events", "backups"];
  const stateDirectories: readonly string[] = [];
  await mkdir(path.join(targetRoot, MANAGED_DIR), { recursive: true });
  await copyOrMoveFile(
    path.join(sourceRoot, sourceLayout.paths.manifest),
    path.join(targetRoot, targetLayout.paths.manifest),
    move,
  );
  await copyOrMoveFile(
    path.join(sourceRoot, sourceLayout.paths.systems_registry),
    path.join(targetRoot, targetLayout.paths.systems_registry),
    move,
  );
  await copyOrMoveFile(
    path.join(sourceRoot, MANAGED_FILES_FILE),
    path.join(targetRoot, MANAGED_FILES_FILE),
    move,
  );
  for (const area of stateAreas) {
    const from = workspacePath(sourceRoot, sourceLayout, area);
    const to = workspacePath(targetRoot, targetLayout, area);
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
    }
  }
  for (const directory of stateDirectories) {
    const from = path.join(sourceRoot, sourceLayout.state_root, directory);
    const to = path.join(targetRoot, targetLayout.state_root, directory);
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
    }
  }
  for (const directory of ["source-adoptions"] as const) {
    const from = path.join(sourceRoot, sourceLayout.state_root, directory);
    const to = path.join(targetRoot, targetLayout.state_root, directory);
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDirWithoutLocks(from, to, move);
    }
  }
  await transferStateRootFiles(sourceRoot, sourceLayout, targetRoot, targetLayout, move);

  // Hoist work folders out of .assay/ to the target root.
  for (const area of OVERLAY_WORK_AREAS) {
    const from = workspacePath(sourceRoot, sourceLayout, area);
    const to = workspacePath(targetRoot, targetLayout, area);
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
    }
  }
  await rewriteCurrentSourceSemanticPaths(targetRoot, sourceRoot, sourceLayout, targetLayout);

  for (const directory of OVERLAY_WORK_DIRECTORIES) {
    const from = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, directory));
    const to = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, directory));
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
    }
  }
  for (const directory of additionalWorkDirectories) {
    const from = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, directory));
    const to = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, directory));
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
    }
  }

  // Transfer `.assay/systems/` as ordinary content. Even for `--move`, preserve
  // the source tree: it may contain unknown user bytes that core has no
  // authority to delete.
  const sourceSystems = workspacePath(sourceRoot, sourceLayout, "systems");
  const targetSystems = workspacePath(targetRoot, targetLayout, "systems");
  if (await exists(sourceSystems)) {
    await mkdir(targetSystems, { recursive: true });
    await copyOrMoveDir(sourceSystems, targetSystems, false);
  }

  // Rewrite the target manifest: standalone layout, drop overlay specifics.
  // Managed-file paths are recorded relative to the workspace root, so the
  // work-folder entries move with the folders that were just hoisted out of
  // `.assay/`. Without this rewrite, `check` reports every hoisted managed
  // file as missing on disk and `update` would recreate it at the overlay
  // location.
  const targetManifest: FrameworkManifest = {
    ...sourceManifest,
    layout: {
      ...targetLayout,
      entries: sourceManifest.layout.entries.map((entry) => ({
        ...entry,
        path: relayoutWorkPath(entry.path, sourceLayout, targetLayout, additionalWorkDirectories),
      })),
    },
  };
  await saveManifest(targetRoot, targetManifest);
  await saveManagedFiles(targetRoot, {
    __schema: 1,
    files: sourceReceipt.files.map((record) => ({
      ...record,
      path: relayoutWorkPath(record.path, sourceLayout, targetLayout, additionalWorkDirectories),
    })),
  });

  await saveSystemsRegistry(targetRoot, targetRegistry, {
    expectedRevision: sourceRegistrySnapshot.revision,
  });
  const primaryName = targetRegistry.primary;
  const systemRecord =
    systemRecordForSelector(targetRegistry, primaryName) ??
    systemRecordForSelector(targetRegistry, systemName);
  if (!systemRecord) {
    throw new FrameworkError("converted systems registry has no primary system");
  }

  const eventFile = await appendEvent(
    targetRoot,
    {
      event: "workspace.converted",
      from: sourceRoot,
      to: targetRoot,
      mode: "standalone",
      primary_system: primaryName,
      moved: move,
    },
    now,
  );

  // Optionally remove the emptied overlay state directory. Only reachable with
  // --move, where every Assay-owned file above was relocated to the target.
  // Anything still present (a nested `.assay/.git`, user files) is left alone
  // and reported as not removed rather than deleted silently.
  const overlayStateRemoved = false;

  return {
    sourceRoot,
    targetRoot,
    moved: move,
    keepOverlay,
    overlayStateRemoved,
    layout: targetLayout,
    systemSelector: primaryName,
    system: systemRecord,
    sourceManifestPath: path.join(sourceRoot, sourceLayout.paths.manifest),
    targetManifestPath: path.join(targetRoot, targetLayout.paths.manifest),
    eventFile: relativeDisplayPath(eventFile, targetRoot),
  };
}

/**
 * Task records are history, so conversion must neither merge nor overwrite
 * them. Validate both trees before creating any conversion output; this also
 * prevents `cp` from following a redirecting entry out of either workspace.
 */
async function assertTaskTransferPathsSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const locks = path.join(sourceRoot, sourceLayout.state_root, "task-locks");
  if (await assertRealDirectory(locks, "source task locks", true)) {
    if ((await readdir(locks)).length > 0) {
      throw new FrameworkError(`source has an active or stale task lock: ${locks}`);
    }
  }
  const source = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, "tasks"));
  if (!(await assertRealDirectory(source, "source tasks", true))) return;
  await assertRealDirectoryTree(source, "source tasks");

  const target = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, "tasks"));
  const targetContainer = await nearestExistingAncestor(targetRoot);
  await assertRealDirectory(targetContainer, "tasks target ancestor", false);
  if (!(await assertRealDirectory(target, "target tasks", true))) return;
  await assertRealDirectoryTree(target, "target tasks");
  if ((await readdir(target)).length > 0) {
    throw new FrameworkError(`target tasks path already contains content: ${target}`);
  }
}

async function assertTaskContextTransferSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const sourceContextLock = path.join(sourceRoot, sourceLayout.state_root, ".task-context.lock");
  if (await exists(sourceContextLock)) {
    throw new FrameworkError(`source has an active task context lock: ${sourceContextLock}`);
  }
  const source = path.join(sourceRoot, sourceLayout.state_root, "task-contexts.json");
  const target = path.join(targetRoot, targetLayout.state_root, "task-contexts.json");
  await assertRealFile(source, "source task contexts", true);
  let targetEntryExists = true;
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      targetEntryExists = false;
    } else {
      throw error;
    }
  }
  const targetAncestor = await nearestExistingAncestor(
    targetEntryExists ? path.dirname(target) : target,
  );
  await assertRealDirectory(targetAncestor, "task contexts target ancestor", false);
  const targetExists = await assertRealFile(target, "target task contexts", true);
  if (targetExists) {
    const stats = await lstat(target);
    if (stats.size > 0) {
      throw new FrameworkError(`target task contexts already contain content: ${target}`);
    }
  }
}

async function assertNativeProjectTransferPathsSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const source = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, "project"));
  await assertRealDirectory(source, "source native Project", false);
  await assertRealDirectoryTree(source, "source native Project");

  const target = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, "project"));
  const targetContainer = await nearestExistingAncestor(targetRoot);
  await assertRealDirectory(targetContainer, "native Project target ancestor", false);
  if (!(await assertRealDirectory(target, "target native Project", true))) return;
  await assertRealDirectoryTree(target, "target native Project");
  if ((await readdir(target)).length > 0) {
    throw new FrameworkError(`target native Project path already contains content: ${target}`);
  }
}

async function assertWorkDirectoryTransferPathsSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
  directory: string,
): Promise<void> {
  const source = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, directory));
  if (!(await assertRealDirectory(source, `source ${directory}`, true))) return;
  await assertRealDirectoryTree(source, `source ${directory}`);
  const target = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, directory));
  const targetContainer = await nearestExistingAncestor(targetRoot);
  await assertRealDirectory(targetContainer, `${directory} target ancestor`, false);
  if (!(await assertRealDirectory(target, `target ${directory}`, true))) return;
  await assertRealDirectoryTree(target, `target ${directory}`);
  if ((await readdir(target)).length > 0) {
    throw new FrameworkError(`target ${directory} path already contains content: ${target}`);
  }
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FrameworkError(`no existing ancestor for target: ${target}`);
    }
    current = parent;
  }
}

/**
 * Require a directory whose own entry and resolved ancestry are ordinary.
 * `lstat` rejects a symlink/junction at the named path; `realpath` catches an
 * earlier reparse point that would redirect later conversion writes/removals.
 */
async function assertRealDirectory(
  target: string,
  label: string,
  allowMissing: boolean,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && allowMissing) {
      return false;
    }
    throw error;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new FrameworkError(
      `${label} must be a real directory, not a symlink or junction: ${target}`,
    );
  }

  const resolved = path.normalize(path.resolve(target));
  const resolvedRealPath = path.normalize(await realpath(target));
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const comparableReal =
    process.platform === "win32" ? resolvedRealPath.toLowerCase() : resolvedRealPath;
  if (comparableResolved !== comparableReal) {
    throw new FrameworkError(
      `${label} resolves through a symlink, junction, or reparse point: ${target}`,
    );
  }
  return true;
}

async function assertRealFile(
  target: string,
  label: string,
  allowMissing: boolean,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && allowMissing) {
      return false;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new FrameworkError(`${label} must be a regular file, not a redirect: ${target}`);
  }
  const resolved = path.normalize(path.resolve(target));
  const resolvedRealPath = path.normalize(await realpath(target));
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const comparableReal =
    process.platform === "win32" ? resolvedRealPath.toLowerCase() : resolvedRealPath;
  if (comparableResolved !== comparableReal) {
    throw new FrameworkError(`${label} resolves through a redirect: ${target}`);
  }
  return true;
}

async function assertRealDirectoryTree(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === ".assay-checkpoint.json") {
      throw new FrameworkError(
        `task checkpoint transaction must be recovered before conversion: ${entryPath}`,
      );
    }
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new FrameworkError(
        `${label} contains a symlink, junction, or reparse point: ${entryPath}`,
      );
    }
    if (stats.isDirectory()) {
      await assertRealDirectory(entryPath, label, false);
      await assertRealDirectoryTree(entryPath, label);
    }
  }
}

/**
 * The Source adoption receipt store is opaque conversion state. Validate
 * its complete physical tree before semantic readers or target creation so
 * `cp` cannot follow a redirect outside either workspace. Unknown ordinary
 * files and directories remain portable; only redirects and special entries
 * are rejected. `.lock` files are validated here but remain excluded from the
 * transferred store by copyOrMoveDirWithoutLocks.
 */
async function assertSourceAdoptionStoreTransferSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const sourceStore = path.join(sourceRoot, sourceLayout.state_root, "source-adoptions");
  if (await assertRealDirectory(sourceStore, "source Source adoption receipt store", true)) {
    await assertContainedRealTree(sourceStore, "source Source adoption receipt store");
  }

  const targetStore = path.join(targetRoot, targetLayout.state_root, "source-adoptions");
  const targetAncestor = await nearestExistingAncestor(targetStore);
  await assertRealDirectory(targetAncestor, "Source adoption target ancestor", false);
  if (await assertRealDirectory(targetStore, "target Source adoption receipt store", true)) {
    await assertContainedRealTree(targetStore, "target Source adoption receipt store");
  }
}

async function assertContainedRealTree(directory: string, label: string): Promise<void> {
  const realRoot = await realpath(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new FrameworkError(
        `${label} contains a symlink, junction, or reparse point: ${entryPath}`,
      );
    }
    const entryRealPath = await realpath(entryPath);
    if (!isContainedRealPath(realRoot, entryRealPath)) {
      throw new FrameworkError(`${label} entry resolves outside its store: ${entryPath}`);
    }
    if (stats.isDirectory()) {
      await assertRealDirectory(entryPath, label, false);
      await assertContainedRealTree(entryPath, label);
      continue;
    }
    if (!stats.isFile()) {
      throw new FrameworkError(`${label} contains a non-regular entry: ${entryPath}`);
    }
  }
}

function isContainedRealPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function transferStateRootFiles(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
  move: boolean,
): Promise<void> {
  const from = path.join(sourceRoot, sourceLayout.state_root);
  if (!(await exists(from))) return;
  const handled = new Set(
    [sourceLayout.paths.manifest, sourceLayout.paths.systems_registry, MANAGED_FILES_FILE].map(
      (filePath) => path.basename(filePath),
    ),
  );
  // Preserve only generic/current loose state files, without parsing them.
  // Retired surfaces are not named, read, copied, or rewritten here; the
  // external cutover tool owns them.
  const portableLooseState = new Set([
    "README.md",
    "external-plugins.json",
    "task-contexts.json",
    "queue.json",
  ]);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile() || handled.has(entry.name) || !portableLooseState.has(entry.name)) continue;
    await copyOrMoveFile(
      path.join(from, entry.name),
      path.join(targetRoot, targetLayout.state_root, entry.name),
      move,
    );
  }
}

/**
 * A destructive detach may remove the source state root only when every
 * top-level entry belongs to the current layout contract. Unknown residuals
 * are neither opened nor followed; their directory entry alone blocks the
 * move before target creation or source cleanup.
 */
async function assertNoUnknownOverlayState(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  additionalWorkDirectories: readonly string[],
): Promise<void> {
  const stateRoot = path.join(sourceRoot, sourceLayout.state_root);
  const currentNames = new Set([
    path.basename(sourceLayout.paths.manifest),
    path.basename(sourceLayout.paths.systems_registry),
    path.basename(MANAGED_FILES_FILE),
    "events",
    "backups",
    "source-adoptions",
    "external-plugins.json",
    "README.md",
    "task-contexts.json",
    "queue.json",
    "coordination",
    "task-locks",
    "roadmap-locks",
    "spec-locks",
    ".task-context.lock",
    ...OVERLAY_WORK_AREAS,
    ...OVERLAY_WORK_DIRECTORIES,
    "systems",
    ...additionalWorkDirectories,
  ]);
  const residuals = (await readdir(stateRoot, { withFileTypes: true }))
    .filter((entry) => !currentNames.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (residuals.length > 0) {
    throw new FrameworkError(
      `source overlay contains unknown state that cannot be moved or deleted safely: ${residuals.join(", ")}`,
    );
  }
}

function relayoutWorkPath(
  filePath: string,
  sourceLayout: WorkspaceLayout,
  targetLayout: WorkspaceLayout,
  additionalWorkDirectories: readonly string[] = [],
): string {
  for (const key of RELOCATED_PATH_KEYS) {
    const fromRoot = sourceLayout.paths[key];
    const from = `${fromRoot}/`;
    if (filePath === fromRoot) return targetLayout.paths[key];
    if (filePath.startsWith(from)) {
      return `${targetLayout.paths[key]}/${filePath.slice(from.length)}`;
    }
  }
  for (const directory of [...OVERLAY_WORK_DIRECTORIES, ...additionalWorkDirectories]) {
    const fromRoot = workspaceWorkRelativePath(sourceLayout, directory);
    const from = `${fromRoot}/`;
    if (filePath === fromRoot) return workspaceWorkRelativePath(targetLayout, directory);
    if (filePath.startsWith(from)) {
      const to = workspaceWorkRelativePath(targetLayout, directory);
      return `${to}/${filePath.slice(from.length)}`;
    }
  }
  return filePath;
}

/**
 * Remove the state root only when it is already empty. Unknown entries are
 * never traversed or deleted; an ENOTEMPTY result
 * leaves the source boundary in place.
 */
async function removeEmptiedOverlayState(
  sourceRoot: string,
  layout: WorkspaceLayout,
): Promise<boolean> {
  const stateRoot = path.join(sourceRoot, layout.state_root);
  if (!(await exists(stateRoot))) {
    return false;
  }
  for (const directory of ["task-locks", "roadmap-locks", "spec-locks", "spec-staging"]) {
    try {
      await rmdir(path.join(stateRoot, directory));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
  try {
    await rmdir(stateRoot);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

async function copyOrMoveFile(from: string, to: string, move: boolean): Promise<void> {
  if (!(await exists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: false });
  if (move) {
    await rm(from, { force: true });
  }
}

async function copyOrMoveDir(from: string, to: string, move: boolean): Promise<void> {
  if (!(await exists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  if (move) {
    await rm(from, { recursive: true, force: true });
  }
}

async function copyOrMoveDirWithoutLocks(from: string, to: string, move: boolean): Promise<void> {
  if (!(await exists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".lock",
  });
  if (move) {
    await rm(from, { recursive: true, force: true });
  }
}
