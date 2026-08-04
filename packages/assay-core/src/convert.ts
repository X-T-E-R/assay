import type { Stats } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_VERSION, MANAGED_DIR, MANIFEST_FILE, VERSION_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
  type WorkspaceArea,
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspacePath,
  workspaceWorkRelativePath,
} from "./layout.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { relativeDisplayPath } from "./paths.js";
import { reconcilePlugins } from "./plugins/reconcile.js";
import { DECISION_GOVERNANCE_RESPONSIBILITY, TRELLIS_PLUGIN_ID } from "./plugins/registry.js";
import type { FrameworkManifest, SystemRecord, WorkspaceLayout } from "./schemas/index.js";
import { adrIndexSchema } from "./schemas/index.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";
import { defaultSystemsRegistry, saveSystemsRegistry } from "./systems-registry.js";
import { nowIso } from "./time.js";

export interface ConvertOverlayOptions {
  readonly root: string;
  readonly target: string;
  readonly move?: boolean;
  readonly keepOverlay?: boolean;
  readonly now?: Date;
}

export interface ConvertOverlayResult {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly moved: boolean;
  readonly keepOverlay: boolean;
  /** True when the emptied overlay state directory was removed after a move. */
  readonly overlayStateRemoved: boolean;
  readonly layout: WorkspaceLayout;
  readonly system: SystemRecord;
  readonly sourceManifestPath: string;
  readonly targetManifestPath: string;
  readonly eventFile: string;
}

/** Work areas hoisted out of `.assay/` when detaching an overlay. */
const OVERLAY_WORK_AREAS = ["references", "analyses", "iterations", "knowledge"] as const;

/**
 * Work folders that live under the work root without a `layout.paths` key, so
 * they are hoisted and rewritten by their own name. Anything listed here that
 * is missing from both the hoist and the managed-path rewrite would be
 * stranded in the source overlay after a move.
 */
const OVERLAY_WORK_DIRECTORIES = ["intent", "project-authority"] as const;

/**
 * Layout `paths` keys whose location differs between overlay and standalone.
 * Managed-file records are rewritten across all of them, including the system
 * contracts directory, which is relocated separately from the work folders.
 */
const RELOCATED_PATH_KEYS = [
  "references",
  "analyses",
  "iterations",
  "knowledge",
  "systems_contracts",
] as const satisfies readonly (keyof WorkspaceLayout["paths"])[];

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
  const systemName = sourceManifest.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const decisionBinding = sourceManifest.bindings?.[DECISION_GOVERNANCE_RESPONSIBILITY];
  const targetExists = await exists(targetRoot);
  await assertProjectAuthorityTransferPathsSafe(sourceRoot, sourceLayout, targetRoot, targetLayout);
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

  // Copy/move Assay state files (.assay/manifest.json, systems-registry,
  // adrs.json, events, backups, donors, archetypes). Anything left behind
  // silently corrupts the new workspace: a missing adrs.json makes `adr new`
  // restart numbering at 0001 over existing ADR files, and a missing
  // project-local archetypes/ makes every later command fail to load the
  // workspace archetype.
  const stateAreas: readonly WorkspaceArea[] = ["events", "backups"];
  const stateDirectories: readonly string[] = ["donors", "archetypes", "migrations", "trellis"];
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
  await transferAdrIndex(sourceRoot, sourceLayout, targetRoot, targetLayout, move);
  // Write VERSION into the target (overlay wrote it in source .assay/).
  await writeFile(path.join(targetRoot, VERSION_FILE), CURRENT_VERSION, "utf8");
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

  for (const directory of OVERLAY_WORK_DIRECTORIES) {
    const from = path.join(sourceRoot, workspaceWorkRelativePath(sourceLayout, directory));
    const to = path.join(targetRoot, workspaceWorkRelativePath(targetLayout, directory));
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      if (directory === "project-authority") {
        await copyOrMoveProjectAuthorityDir(from, to, move);
      } else {
        await copyOrMoveDir(from, to, move);
      }
    }
  }

  // Root system sidecar contracts under .assay/systems/ in overlay move to
  // target .assay/systems/ (kept as contracts; the original repo is now an
  // external independent system referenced by relative path).
  const sourceContracts = workspacePath(sourceRoot, sourceLayout, "systemsContracts");
  const targetContracts = workspacePath(targetRoot, targetLayout, "systemsContracts");
  if (await exists(sourceContracts)) {
    await mkdir(targetContracts, { recursive: true });
    await copyOrMoveDir(sourceContracts, targetContracts, move);
  }

  // Rewrite the target manifest: standalone layout, drop overlay specifics.
  // Managed-file paths are recorded relative to the workspace root, so the
  // work-folder entries move with the folders that were just hoisted out of
  // `.assay/`. Without this rewrite, `check` reports every hoisted managed
  // file as missing on disk and `update` would recreate it at the overlay
  // location.
  const targetManifest: FrameworkManifest = {
    ...sourceManifest,
    layout: targetLayout,
    layout_version: 4,
    managed_files: rewriteManagedFilePaths(
      sourceManifest.managed_files,
      sourceLayout,
      targetLayout,
    ),
    user_deleted: [
      ...new Set(
        sourceManifest.user_deleted.map((entry) =>
          relayoutWorkPath(entry, sourceLayout, targetLayout),
        ),
      ),
    ],
    ...(decisionBinding?.provider === TRELLIS_PLUGIN_ID &&
    decisionBinding.target.kind === "workspace"
      ? {
          bindings: {
            ...(sourceManifest.bindings ?? {}),
            [DECISION_GOVERNANCE_RESPONSIBILITY]: {
              provider: TRELLIS_PLUGIN_ID,
              target: { kind: "system", name: systemName },
            },
          },
        }
      : {}),
    updated_at: nowIso(now),
  };
  await saveManifest(targetRoot, targetManifest);

  // Register the original product repo as the primary independent system.
  // Use a real relative path so the sibling product repo is referenced
  // portably (e.g. ../attach-smoke). relativeDisplayPath falls back to
  // absolute when the path leaves the root, which we do not want here.
  const relativeSourcePath = toPosixPath(path.relative(targetRoot, sourceRoot));
  const registry = defaultSystemsRegistry();
  const systemRecord: SystemRecord = {
    name: systemName,
    path: relativeSourcePath,
    status: "primary",
    vcs: "independent-git",
    vcs_ref: "",
    version: "0.1.0",
    contract_file: `${MANAGED_DIR}/systems/${systemName}.yaml`,
    supersedes: [],
    absorbed_on: nowIso(now).slice(0, 10),
    archived_on: null,
    archive_path: null,
  };
  registry.systems[systemName] = systemRecord;
  registry.primary = systemName;
  await saveSystemsRegistry(targetRoot, registry);

  // Write the sidecar contract for the original repo.
  const contractPath = path.join(targetRoot, MANAGED_DIR, "systems", `${systemName}.yaml`);
  await mkdir(path.dirname(contractPath), { recursive: true });
  await writeFile(
    contractPath,
    [
      `name: ${systemName}`,
      "kind: primary-system",
      `path: ${relativeSourcePath}`,
      "vcs: independent-git",
      "notes: Original product repository detached from overlay into this standalone workbench.",
      "",
    ].join("\n"),
    "utf8",
  );

  if (decisionBinding?.provider === TRELLIS_PLUGIN_ID) {
    await reconcilePlugins({
      root: targetRoot,
      plugins: [TRELLIS_PLUGIN_ID],
      apply: true,
      now,
    });
  }

  const eventFile = await appendEvent(
    targetRoot,
    {
      event: "workspace.converted",
      from: sourceRoot,
      to: targetRoot,
      mode: "standalone",
      primary_system: systemName,
      moved: move,
    },
    now,
  );

  // Optionally remove the emptied overlay state directory. Only reachable with
  // --move, where every Assay-owned file above was relocated to the target.
  // Anything still present (a nested `.assay/.git`, user files) is left alone
  // and reported as not removed rather than deleted silently.
  let overlayStateRemoved = false;
  if (!keepOverlay) {
    overlayStateRemoved = await removeEmptiedOverlayState(sourceRoot, sourceLayout);
  }

  return {
    sourceRoot,
    targetRoot,
    moved: move,
    keepOverlay,
    overlayStateRemoved,
    layout: targetLayout,
    system: systemRecord,
    sourceManifestPath: path.join(sourceRoot, sourceLayout.paths.manifest),
    targetManifestPath: path.join(targetRoot, targetLayout.paths.manifest),
    eventFile: relativeDisplayPath(eventFile, targetRoot),
  };
}

/**
 * A converted target may already be a prepared directory, but Project
 * Authority content must never be merged into or overwrite it. Check this
 * before creating the target manifest or any other conversion output, so a
 * conflict leaves the target untouched by Assay.
 */
async function assertProjectAuthorityTransferPathsSafe(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
): Promise<void> {
  const source = path.join(
    sourceRoot,
    workspaceWorkRelativePath(sourceLayout, "project-authority"),
  );
  if (!(await assertRealDirectory(source, "source project-authority", true))) return;

  const target = path.join(
    targetRoot,
    workspaceWorkRelativePath(targetLayout, "project-authority"),
  );
  const targetContainer = await nearestExistingAncestor(targetRoot);
  await assertRealDirectory(targetContainer, "project-authority target ancestor", false);
  if (!(await assertRealDirectory(target, "target project-authority", true))) return;

  if ((await readdir(target)).length > 0) {
    throw new FrameworkError(`target project-authority path already contains content: ${target}`);
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
      throw new FrameworkError(`no existing ancestor for project-authority target: ${target}`);
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

/**
 * Copy the ADR index to the new root, rewriting each record's markdown path
 * from the overlay work root to the standalone one. The markdown files are
 * hoisted out of `.assay/` by this conversion, so an index copied verbatim
 * would point every ADR at a path that no longer exists — and `check` would
 * report each one as missing on disk.
 */
async function transferAdrIndex(
  sourceRoot: string,
  sourceLayout: WorkspaceLayout,
  targetRoot: string,
  targetLayout: WorkspaceLayout,
  move: boolean,
): Promise<void> {
  const from = path.join(sourceRoot, sourceLayout.paths.adrs_index);
  if (!(await exists(from))) return;

  const index = adrIndexSchema.parse(JSON.parse(await readFile(from, "utf8")));
  const sourceKnowledge = `${sourceLayout.paths.knowledge}/`;
  const targetKnowledge = `${targetLayout.paths.knowledge}/`;
  for (const [id, adr] of Object.entries(index.adrs)) {
    if (adr.path.startsWith(sourceKnowledge)) {
      index.adrs[id] = {
        ...adr,
        path: `${targetKnowledge}${adr.path.slice(sourceKnowledge.length)}`,
      };
    }
  }

  const to = path.join(targetRoot, targetLayout.paths.adrs_index);
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, stringifySortedJson(index), "utf8");
  if (move) {
    await rm(from, { force: true });
  }
}

/**
 * Copy loose files that sit directly in the state root (`.assay/README.md` and
 * any other managed state file) so the converted workspace keeps the managed
 * files its manifest records. Files handled explicitly above (manifest,
 * registry, ADR index, VERSION) are skipped.
 */
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
    [
      sourceLayout.paths.manifest,
      sourceLayout.paths.systems_registry,
      sourceLayout.paths.adrs_index,
      VERSION_FILE,
    ].map((filePath) => path.basename(filePath)),
  );
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile() || handled.has(entry.name)) continue;
    await copyOrMoveFile(
      path.join(from, entry.name),
      path.join(targetRoot, targetLayout.state_root, entry.name),
      move,
    );
  }
}

/**
 * Move every work-area path in the managed-file map from the source layout to
 * the target layout. State paths (`.assay/manifest.json`, `.assay/VERSION`, ...)
 * are identical in both layouts and pass through unchanged.
 */
function rewriteManagedFilePaths(
  managedFiles: FrameworkManifest["managed_files"],
  sourceLayout: WorkspaceLayout,
  targetLayout: WorkspaceLayout,
): FrameworkManifest["managed_files"] {
  const rewritten: FrameworkManifest["managed_files"] = {};
  for (const [filePath, record] of Object.entries(managedFiles)) {
    rewritten[relayoutWorkPath(filePath, sourceLayout, targetLayout)] = record;
  }
  return rewritten;
}

function relayoutWorkPath(
  filePath: string,
  sourceLayout: WorkspaceLayout,
  targetLayout: WorkspaceLayout,
): string {
  for (const key of RELOCATED_PATH_KEYS) {
    const from = `${sourceLayout.paths[key]}/`;
    if (filePath.startsWith(from)) {
      return `${targetLayout.paths[key]}/${filePath.slice(from.length)}`;
    }
  }
  for (const directory of OVERLAY_WORK_DIRECTORIES) {
    const from = `${workspaceWorkRelativePath(sourceLayout, directory)}/`;
    if (filePath.startsWith(from)) {
      const to = workspaceWorkRelativePath(targetLayout, directory);
      return `${to}/${filePath.slice(from.length)}`;
    }
  }
  return filePath;
}

/**
 * Remove the overlay state directory once its contents have been moved out.
 * Deletes the runtime VERSION marker and any directories that are now empty,
 * then the state root itself. Returns false and leaves everything in place when
 * unmoved content remains.
 */
async function removeEmptiedOverlayState(
  sourceRoot: string,
  layout: WorkspaceLayout,
): Promise<boolean> {
  const stateRoot = path.join(sourceRoot, layout.state_root);
  if (!(await exists(stateRoot))) {
    return false;
  }
  await rm(path.join(sourceRoot, VERSION_FILE), { force: true });
  await removeEmptyDirectories(stateRoot);
  if (await exists(stateRoot)) {
    return false;
  }
  return true;
}

/** Depth-first removal of directories that hold no files. */
async function removeEmptyDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirectories(path.join(directory, entry.name));
    }
  }
  if ((await readdir(directory)).length === 0) {
    await rm(directory, { recursive: true, force: true });
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

async function copyOrMoveProjectAuthorityDir(
  from: string,
  to: string,
  move: boolean,
): Promise<void> {
  if (!(await exists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  if (move) {
    await rm(from, { recursive: true, force: true });
  }
}
