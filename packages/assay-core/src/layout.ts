import path from "node:path";

import {
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
  | "sources"
  | "analyses"
  | "knowledge"
  | "systemsContracts";

/**
 * Resolve the layout block for a current manifest. The raw manifest envelope
 * gate rejects every pre-v6 workspace before this function is reached.
 */
export function resolveWorkspaceLayout(manifest: FrameworkManifest | null): WorkspaceLayout | null {
  return manifest?.layout ?? null;
}

/**
 * Standalone layout for a freshly initialized v6 workspace. State lives in
 * `.assay/`, work folders live at the workspace root.
 */
export function defaultStandaloneLayout(): WorkspaceLayout {
  return {
    version: 8,
    mode: "standalone",
    state_root: ".assay",
    work_root: ".",
    privacy: "tracked",
    paths: standalonePaths(),
    entries: [],
  };
}

/**
 * Overlay layout for `assay attach`. All Assay-owned state and work folders
 * live under `.assay/`; the product repo root is the primary system.
 */
export function defaultOverlayLayout(privacy: WorkspacePrivacy): WorkspaceLayout {
  return {
    version: 8,
    mode: "overlay",
    state_root: ".assay",
    work_root: ".assay",
    privacy,
    paths: overlayPaths(),
    entries: [],
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
    case "sources":
      return path.join(root, layout.paths.sources);
    case "analyses":
      return path.join(root, layout.paths.analyses);
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
  sources: "sources",
  analyses: "analyses",
  knowledge: "knowledge",
  systems: "systemsContracts",
};

/**
 * Resolve an manifest entries-declared template path against a layout.
 *
 * Manifest entries YAML declares template paths as workspace-root-relative literals
 * (`README.md`, `analyses/README.md`, `.assay/managed-files.json`). Those literals are
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
 * Relative path map for standalone layout v8. State under `.assay/`, work
 * folders at root.
 */
export function standalonePaths() {
  return {
    manifest: MANIFEST_FILE,
    events: EVENTS_DIR,
    backups: BACKUPS_DIR,
    systems_registry: SYSTEMS_REGISTRY_FILE,
    sources: "sources",
    analyses: "analyses",
    knowledge: "knowledge",
    systems_contracts: "systems",
  };
}

/**
 * Relative path map for overlay layout v8. Everything Assay-owned lives
 * under `.assay/`.
 */
export function overlayPaths() {
  return {
    manifest: MANIFEST_FILE,
    events: EVENTS_DIR,
    backups: BACKUPS_DIR,
    systems_registry: SYSTEMS_REGISTRY_FILE,
    sources: `${MANAGED_DIR}/sources`,
    analyses: `${MANAGED_DIR}/analyses`,
    knowledge: `${MANAGED_DIR}/knowledge`,
    systems_contracts: `${MANAGED_DIR}/systems`,
  };
}

export type { WorkspaceLayoutMode, WorkspacePrivacy };
