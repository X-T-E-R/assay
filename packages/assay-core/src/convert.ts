import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_VERSION, MANAGED_DIR, MANIFEST_FILE, VERSION_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
  type WorkspaceArea,
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspacePath,
} from "./layout.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { relativeDisplayPath } from "./paths.js";
import type { FrameworkManifest, SystemRecord, WorkspaceLayout } from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";
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
  readonly layout: WorkspaceLayout;
  readonly system: SystemRecord;
  readonly sourceManifestPath: string;
  readonly targetManifestPath: string;
  readonly eventFile: string;
}

const OVERLAY_WORK_AREAS: readonly WorkspaceArea[] = [
  "references",
  "analyses",
  "iterations",
  "knowledge",
];

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

  if (await exists(targetRoot)) {
    if (await exists(path.join(targetRoot, MANIFEST_FILE))) {
      throw new FrameworkError(
        `target already has an Assay manifest: ${path.join(targetRoot, MANIFEST_FILE)}`,
      );
    }
  } else {
    await mkdir(targetRoot, { recursive: true });
  }

  const targetLayout = defaultStandaloneLayout();

  // Copy/move Assay state files (.assay/manifest.json, systems-registry, events, backups).
  const stateAreas: readonly WorkspaceArea[] = ["events", "backups"];
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

  // Hoist work folders out of .assay/ to the target root.
  for (const area of OVERLAY_WORK_AREAS) {
    const from = workspacePath(sourceRoot, sourceLayout, area);
    const to = workspacePath(targetRoot, targetLayout, area);
    if (await exists(from)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyOrMoveDir(from, to, move);
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
  const targetManifest: FrameworkManifest = {
    ...sourceManifest,
    layout: targetLayout,
    layout_version: 4,
    updated_at: nowIso(now),
  };
  // managed_files paths referenced .assay/... in overlay; in standalone the
  // state files keep the same .assay/ paths, so no path rewrite is needed
  // for state files. Work-folder templates (README etc.) are not tracked in
  // overlay by default.
  await saveManifest(targetRoot, targetManifest);

  // Register the original product repo as the primary independent system.
  // Use a real relative path so the sibling product repo is referenced
  // portably (e.g. ../attach-smoke). relativeDisplayPath falls back to
  // absolute when the path leaves the root, which we do not want here.
  const relativeSourcePath = toPosixPath(path.relative(targetRoot, sourceRoot));
  const registry = defaultSystemsRegistry();
  const systemName = sourceManifest.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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

  // Optionally mark the overlay as detached (do not delete by default).
  if (!keepOverlay && move) {
    // With move=true and keepOverlay=false, the overlay .assay/ is already
    // emptied by the moves above; remove the leftover manifest if present.
    // We do not remove the product repo itself.
  }

  return {
    sourceRoot,
    targetRoot,
    moved: move,
    keepOverlay,
    layout: targetLayout,
    system: systemRecord,
    sourceManifestPath: path.join(sourceRoot, sourceLayout.paths.manifest),
    targetManifestPath: path.join(targetRoot, targetLayout.paths.manifest),
    eventFile: relativeDisplayPath(eventFile, targetRoot),
  };
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
