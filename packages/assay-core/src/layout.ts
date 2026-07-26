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
 * `layout` field; this returns a standalone fallback whose work folders sit at
 * the workspace root, so legacy workspaces keep working until
 * `migrate-layout` upgrades them to v4.
 *
 * The fallback's state root is `.assay`, because that is the only location
 * {@link loadManifest} reads a manifest from — never `layout_version`. A
 * manifest loaded from `.assay/manifest.json` describes a workspace whose state
 * already lives in `.assay/`, however stale its recorded version is; inferring
 * `.framework/` from `layout_version < 4` sends state writes to a directory the
 * rest of the workspace does not use. A genuine `.framework/` workspace cannot
 * reach this function: `loadManifest` returns null for it, and commands ask for
 * `migrate-layout` instead.
 */
export function resolveWorkspaceLayout(manifest: FrameworkManifest | null): WorkspaceLayout | null {
  if (manifest?.layout) {
    return manifest.layout;
  }
  if (!manifest) {
    return null;
  }
  return legacyStandaloneLayout(MANAGED_DIR);
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

export function workspaceRelativePath(layout: WorkspaceLayout, area: WorkspaceArea): string {
  return workspacePath("", layout, area).split(path.sep).join("/");
}

export function workspaceSubpath(
  layout: WorkspaceLayout,
  area: WorkspaceArea,
  ...segments: readonly string[]
): string {
  return [
    workspaceRelativePath(layout, area),
    ...segments.map((segment) => toRelativePosix(segment)),
  ]
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function workspaceWorkRelativePath(layout: WorkspaceLayout, relativePath: string): string {
  const normalized = toRelativePosix(relativePath);
  if (layout.work_root === ".") {
    return normalized;
  }
  return [layout.work_root, normalized].filter((segment) => segment.length > 0).join("/");
}

/** Work-folder areas addressable by their first path segment. */
const WORK_AREA_BY_SEGMENT: Readonly<Record<string, WorkspaceArea>> = {
  references: "references",
  analyses: "analyses",
  iterations: "iterations",
  knowledge: "knowledge",
  systems: "systemsContracts",
};

/**
 * Resolve an archetype-declared template path against a layout.
 *
 * Archetype YAML declares template paths as workspace-root-relative literals
 * (`README.md`, `analyses/README.md`, `.assay/VERSION`). Those literals are
 * written for a standalone layout, so an overlay workspace must translate them
 * before writing or the templates land in the product repository root instead
 * of `.assay/`.
 *
 * - Paths already under the state root keep their declared location.
 * - Paths that start with a work area segment resolve through that area.
 * - Everything else resolves against the work root.
 *
 * For a standalone layout this is the identity function.
 */
export function workspaceTemplateRelativePath(
  layout: WorkspaceLayout,
  templatePath: string,
): string {
  const normalized = toRelativePosix(templatePath);
  const stateRoot = toRelativePosix(layout.state_root);
  if (stateRoot !== "" && (normalized === stateRoot || normalized.startsWith(`${stateRoot}/`))) {
    return normalized;
  }

  const [first, ...rest] = normalized.split("/");
  const area = first === undefined ? undefined : WORK_AREA_BY_SEGMENT[first];
  if (area && rest.length > 0) {
    return [workspaceRelativePath(layout, area), ...rest].join("/");
  }
  if (area) {
    return workspaceRelativePath(layout, area);
  }
  return workspaceWorkRelativePath(layout, normalized);
}

function toRelativePosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
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
    systems_contracts: "systems",
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
 * Standalone layout for a manifest with no `layout` block, pointing at the
 * state directory the manifest was read from. Used only as a read fallback for
 * manifests that have not yet been migrated to layout 4.
 *
 * Layout v3 wrote work folders at the workspace root, which is also what
 * {@link defaultStandaloneLayout} does, so `stateRoot` is the only difference.
 */
function legacyStandaloneLayout(stateRoot: WorkspaceLayout["state_root"]): WorkspaceLayout {
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
      systems_contracts: "systems",
    },
  };
}

export type { WorkspaceLayoutMode, WorkspacePrivacy };
