import { workspaceWorkRelativePath } from "./layout.js";
import type { ManifestEntry, WorkspaceLayout } from "./schemas/index.js";

/**
 * A directory an agent or a person is expected to put work into, together with
 * the one line that says what belongs there.
 *
 * Zones are the shared truth behind the three channels that carry directory
 * semantics: the AGENTS.md managed block, `assay status`, and the placement
 * advisories in `assay check`. All three derive from the manifest entries, so a new
 * manifest entries gains them without touching this package.
 */
export interface WorkspaceZone {
  /** Workspace-root-relative path with POSIX separators, no trailing slash. */
  readonly path: string;
  /** What belongs here; empty when the manifest entries does not declare a purpose. */
  readonly purpose: string;
}

/**
 * Zones a workspace has, given its manifest entries and mode.
 *
 * Two kinds of declared directory are left out:
 *
 * - anything under a dot-directory (`.assay/backups`, `.assay/migrations`),
 *   which is runtime state rather than a place to put work;
 * - `<zone>/templates`, which holds blank forms for its parent zone. An
 *   manifest entries that wants the parent listed declares the parent itself, which is
 *   why an manifest entries may declare both a parent directory and a nested work area.
 */
export function manifestZones(
  entries: readonly ManifestEntry[],
  layout?: WorkspaceLayout,
): WorkspaceZone[] {
  const declared = [
    ...entries.filter((entry) => entry.kind === "directory"),
    ...nativeDirectories(layout).map((entry) => ({ ...entry, kind: "directory" as const })),
  ];
  const byPath = new Map(declared.map((entry) => [entry.path, entry]));
  return [...byPath.values()].filter(isZoneDirectory).map((directory) => ({
    path: directory.path,
    purpose: directory.purpose,
  }));
}

/**
 * Source and Analysis are native for every manifest entries, but lazy outside
 * study. Declaring them as zones makes placement/status semantics available
 * without causing init or check to require their directories on disk.
 */
export const NATIVE_LAZY_DIRECTORIES: readonly WorkspaceZone[] = [
  {
    path: "sources",
    purpose: "Living sources and frozen external evidence (created on first use)",
  },
  { path: "analyses", purpose: "Analysis records (created on first use)" },
];

function nativeDirectories(layout?: WorkspaceLayout): WorkspaceZone[] {
  const resolved = (relative: string) =>
    layout ? workspaceWorkRelativePath(layout, relative) : relative;
  return [
    { path: resolved("project"), purpose: "Native Project authority" },
    { path: resolved("systems"), purpose: "Registered systems and local implementations" },
    { path: resolved("knowledge"), purpose: "Accepted reusable knowledge" },
    ...NATIVE_LAZY_DIRECTORIES.map((entry) => ({ ...entry, path: resolved(entry.path) })),
  ];
}

function isZoneDirectory(directory: WorkspaceZone): boolean {
  const segments = directory.path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return false;
  }
  return !(segments.length > 1 && segments[segments.length - 1] === "templates");
}

/**
 * Render zones as a Markdown table. Used by the AGENTS.md managed block, where
 * the table is the first thing a coding agent reads about the workspace.
 */
export function zoneTable(zones: readonly WorkspaceZone[]): string[] {
  if (zones.length === 0) {
    return [];
  }
  return [
    "| Directory | What goes here |",
    "| --- | --- |",
    ...zones.map((zone) => `| \`${zone.path}/\` | ${escapeTableCell(zone.purpose)} |`),
  ];
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
