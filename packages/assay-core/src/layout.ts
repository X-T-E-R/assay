import path from "node:path";

import {
  ADRS_FILE,
  BACKUPS_DIR,
  EVENTS_DIR,
  MANAGED_DIR,
  MANIFEST_FILE,
  SYSTEMS_REGISTRY_FILE,
} from "./constants.js";
import type {
  FrameworkManifest,
  WorkspaceLayout,
  WorkspaceLayoutMode,
  WorkspacePrivacy,
} from "./schemas/index.js";

/**
 * Areas of an Assay workspace that commands need to locate. Every command
 * resolves paths through {@link workspacePath} instead of hard-coding
 * root-relative strings, so standalone and overlay layouts share one code
 * path and differ only in the path map.
 */
export type WorkspaceArea =
  | "manifest"
  | "events"
  | "backups"
  | "systemsRegistry"
  | "adrsIndex"
  | "references"
  | "analyses"
  | "iterations"
  | "knowledge"
  | "systemsContracts";

/**
 * Resolve the layout block for a manifest. Layout v3 manifests carry no
 * `layout` field; this returns a standalone fallback whose path map points
 * at the v3 directory names (`.framework/` state at root, work folders at
 * root) so legacy workspaces keep working until `migrate-layout` upgrades
 * them to v4.
 *
 * The fallback uses `.framework/` for state paths when the manifest's
 * `layout_version` is below 4, because that is where v3 wrote them. Once a
 * manifest is upgraded to layout 4 it always carries an explicit `layout`
 * block and this fallback is not used.
 */
export function resolveWorkspaceLayout(manifest: FrameworkManifest | null): WorkspaceLayout | null {
  if (manifest?.layout) {
    return manifest.layout;
  }
  if (!manifest) {
    return null;
  }
  return legacyStandaloneLayout(manifest.layout_version);
}

/**
 * Standalone layout for a freshly initialized v4 workspace. State lives in
 * `.assay/`, work folders live at the workspace root.
 */
export function defaultStandaloneLayout(): WorkspaceLayout {
  return {
    version: 4,
    mode: "standalone",
    state_root: ".assay",
    work_root: ".",
    privacy: "tracked",
    paths: standalonePaths(),
  };
}

/**
 * Overlay layout for `assay attach`. All Assay-owned state and work folders
 * live under `.assay/`; the product repo root is the primary system.
 */
export function defaultOverlayLayout(privacy: WorkspacePrivacy): WorkspaceLayout {
  return {
    version: 4,
    mode: "overlay",
    state_root: ".assay",
    work_root: ".assay",
    privacy,
    paths: overlayPaths(),
  };
}

/**
 * Resolve a workspace area to a path relative to `root`. Callers join this
 * with `root` to get an absolute path, or display it as-is for users.
 */
export function workspacePath(root: string, layout: WorkspaceLayout, area: WorkspaceArea): string {
  switch (area) {
    case "manifest":
      return path.join(root, layout.paths.manifest);
    case "events":
      return path.join(root, layout.paths.events);
    case "backups":
      return path.join(root, layout.paths.backups);
    case "systemsRegistry":
      return path.join(root, layout.paths.systems_registry);
    case "adrsIndex":
      return path.join(root, layout.paths.adrs_index);
    case "references":
      return path.join(root, layout.paths.references);
    case "analyses":
      return path.join(root, layout.paths.analyses);
    case "iterations":
      return path.join(root, layout.paths.iterations);
    case "knowledge":
      return path.join(root, layout.paths.knowledge);
    case "systemsContracts":
      return path.join(root, layout.paths.systems_contracts);
  }
}

/**
 * Relative path map for standalone layout v4. State under `.assay/`, work
 * folders at root.
 */
export function standalonePaths() {
  return {
    manifest: MANIFEST_FILE,
    events: EVENTS_DIR,
    backups: BACKUPS_DIR,
    systems_registry: SYSTEMS_REGISTRY_FILE,
    adrs_index: ADRS_FILE,
    references: "references",
    analyses: "analyses",
    iterations: "iterations",
    knowledge: "knowledge",
    systems_contracts: `${MANAGED_DIR}/systems`,
  };
}

/**
 * Relative path map for overlay layout v4. Everything Assay-owned lives
 * under `.assay/`.
 */
export function overlayPaths() {
  return {
    manifest: MANIFEST_FILE,
    events: EVENTS_DIR,
    backups: BACKUPS_DIR,
    systems_registry: SYSTEMS_REGISTRY_FILE,
    adrs_index: ADRS_FILE,
    references: `${MANAGED_DIR}/references`,
    analyses: `${MANAGED_DIR}/analyses`,
    iterations: `${MANAGED_DIR}/iterations`,
    knowledge: `${MANAGED_DIR}/knowledge`,
    systems_contracts: `${MANAGED_DIR}/systems`,
  };
}

/**
 * Standalone layout pointing at v3 directory names. Used only as a read
 * fallback for manifests that have not yet been migrated to layout 4.
 *
 * Layout v3 wrote state under `.framework/` and work folders at root, so the
 * only difference from {@link defaultStandaloneLayout} is the state_root and
 * the registry/manifest paths. Work folders are identical.
 */
function legacyStandaloneLayout(layoutVersion: number): WorkspaceLayout {
  // v3 and below used `.framework/` for state. The path map mirrors the v3
  // constants so commands reading an un-migrated workspace find files where
  // v3 left them.
  const stateRoot = layoutVersion < 4 ? ".framework" : MANAGED_DIR;
  return {
    version: 4,
    mode: "standalone",
    state_root: stateRoot,
    work_root: ".",
    privacy: "tracked",
    paths: {
      manifest: `${stateRoot}/manifest.json`,
      events: `${stateRoot}/events`,
      backups: `${stateRoot}/backups`,
      systems_registry: `${stateRoot}/systems-registry.json`,
      adrs_index: `${stateRoot}/adrs.json`,
      references: "references",
      analyses: "analyses",
      iterations: "iterations",
      knowledge: "knowledge",
      systems_contracts: `${stateRoot}/systems`,
    },
  };
}

export type { WorkspaceLayoutMode, WorkspacePrivacy };
