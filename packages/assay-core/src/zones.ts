import {
  type Archetype,
  type ArchetypeDirectory,
  type CapabilityModule,
  archetypeDirectories,
  capabilityDirectories,
  mergeDirectories,
} from "./profile.js";
import type { ProjectMode } from "./schemas/index.js";

/**
 * A directory an agent or a person is expected to put work into, together with
 * the one line that says what belongs there.
 *
 * Zones are the shared truth behind the three channels that carry directory
 * semantics: the AGENTS.md managed block, `assay status`, and the placement
 * advisories in `assay check`. All three derive from the archetype, so a new
 * archetype gains them without touching this package.
 */
export interface WorkspaceZone {
  /** Workspace-root-relative path with POSIX separators, no trailing slash. */
  readonly path: string;
  /** What belongs here; empty when the archetype does not declare a purpose. */
  readonly purpose: string;
}

/**
 * Zones a workspace has, given its archetype, mode, and enabled capability
 * modules.
 *
 * Two kinds of declared directory are left out:
 *
 * - anything under a dot-directory (`.assay/backups`, `.assay/migrations`),
 *   which is runtime state rather than a place to put work;
 * - `<zone>/templates`, which holds blank forms for its parent zone. An
 *   archetype that wants the parent listed declares the parent itself, which is
 *   why `solve` declares `iterations` next to `iterations/templates`.
 */
export function archetypeZones(
  archetype: Pick<Archetype, "dirs" | "dirsLearning" | "dirsAbsorption">,
  mode: ProjectMode,
  capabilities: readonly CapabilityModule[] = [],
): WorkspaceZone[] {
  const declared = mergeDirectories(
    archetypeDirectories(archetype, mode),
    capabilityDirectories(capabilities),
    NATIVE_LAZY_DIRECTORIES,
  );
  return declared.filter(isZoneDirectory).map((directory) => ({
    path: directory.path,
    purpose: directory.purpose,
  }));
}

/**
 * Reference and Analysis are native for every archetype, but lazy outside
 * study. Declaring them as zones makes placement/status semantics available
 * without causing init or check to require their directories on disk.
 */
export const NATIVE_LAZY_DIRECTORIES: readonly ArchetypeDirectory[] = [
  {
    path: "references",
    purpose: "Living sources and frozen external evidence (created on first use)",
  },
  { path: "analyses", purpose: "Analysis records (created on first use)" },
];

function isZoneDirectory(directory: ArchetypeDirectory): boolean {
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
