import path from "node:path";

import { CURRENT_VERSION } from "./constants.js";
import { loadManifest } from "./manifest.js";
import type { WorkspaceLayoutMode } from "./schemas/index.js";
import {
  SEMANTIC_DETAIL_COMMAND,
  SEMANTIC_TOPICS,
  type SemanticDigestEntry,
  type SemanticTopic,
  semanticDigest,
} from "./semantics.js";
import { listTasks } from "./task.js";
import { type FrameworkStatusResult, getFrameworkStatus } from "./workspace.js";

/**
 * Session-start orientation: the semantic contract first, then the state of the
 * workspace it applies to.
 *
 * Orientation is read once, before anything is known about the workspace, so
 * every part of it degrades independently. A workspace that cannot be read
 * still returns the contract, because that half is what stops the first
 * misuse; a note records what could not be collected instead of failing the
 * command an agent runs to find its bearings.
 */

export interface PrimeTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface PrimeZone {
  readonly path: string;
  readonly files: number;
  readonly purpose: string;
}

export interface PrimeWorkspaceState {
  readonly root: string;
  readonly layoutMode: WorkspaceLayoutMode;
  readonly layoutVersion: number | null;
  readonly installedVersion: string | null;
  readonly cliVersion: string;
  readonly project: string | null;
  readonly projectId: string | null;
  readonly zones: readonly PrimeZone[];
  readonly activeTasks: readonly PrimeTaskSummary[];
  readonly activeTaskCount: number;
  readonly sources: FrameworkStatusResult["sources"] | null;
  readonly primarySystem: string | null;
  readonly systemCount: number;
  readonly counts: {
    readonly knowledgeEntries: number;
    readonly managedFiles: number;
    readonly sourceAdoptions: number;
    readonly runRecords: number;
  };
}

export interface PrimeResult {
  readonly root: string;
  /** Present only inside a readable workspace. */
  readonly workspace: PrimeWorkspaceState | null;
  readonly semantics: readonly SemanticDigestEntry[];
  readonly topics: readonly SemanticTopic[];
  readonly detailsCommand: string;
  /** What could not be collected, in the caller's reading order. */
  readonly notes: readonly string[];
}

export interface PrimeOptions {
  readonly root: string;
}

function errorNote(subject: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${subject} could not be read: ${detail}`;
}

async function collectActiveTasks(
  root: string,
  notes: string[],
): Promise<{ tasks: readonly PrimeTaskSummary[]; total: number }> {
  try {
    const result = await listTasks({ root, status: "active", limit: 100 });
    const tasks = result.tasks
      .filter((task) => task.valid)
      .map((task) => ({
        id: task.id,
        title: task.title ?? "",
        status: task.status ?? "active",
      }));
    if (result.issues.length > 0) {
      notes.push(
        `task storage has ${result.issues.length} issue(s); run \`assay task validate\` for the detail`,
      );
    }
    return { tasks, total: tasks.length };
  } catch (error) {
    notes.push(errorNote("active tasks", error));
    return { tasks: [], total: 0 };
  }
}

export async function primeWorkspace(options: PrimeOptions): Promise<PrimeResult> {
  const root = path.resolve(options.root);
  const notes: string[] = [];
  const base = {
    root,
    semantics: semanticDigest(),
    topics: SEMANTIC_TOPICS,
    detailsCommand: SEMANTIC_DETAIL_COMMAND,
  };

  let status: FrameworkStatusResult | null = null;
  let layoutMode: WorkspaceLayoutMode | null = null;
  try {
    const manifest = await loadManifest(root);
    if (!manifest) {
      return { ...base, workspace: null, notes };
    }
    layoutMode = manifest.layout.mode;
    status = await getFrameworkStatus({ root });
  } catch (error) {
    notes.push(errorNote("workspace state", error));
    return { ...base, workspace: null, notes };
  }

  const { tasks, total } = await collectActiveTasks(root, notes);
  const primary = status.systems?.find((system) => system.status === "primary");

  return {
    ...base,
    workspace: {
      root,
      layoutMode,
      layoutVersion: status.layoutVersion ?? null,
      installedVersion: status.installedVersion ?? null,
      cliVersion: CURRENT_VERSION,
      project: status.project ?? null,
      projectId: status.nativeProject?.id ?? null,
      zones: status.zones.map((zone) => ({
        path: zone.path,
        files: zone.files,
        purpose: zone.purpose,
      })),
      activeTasks: tasks,
      activeTaskCount: total,
      sources: status.sources ?? null,
      primarySystem: primary?.name ?? null,
      systemCount: status.systems?.length ?? 0,
      counts: {
        knowledgeEntries: status.knowledgeEntries ?? 0,
        managedFiles: status.managedFiles,
        sourceAdoptions: status.sourceAdoptions?.adoptions ?? 0,
        runRecords: status.runRecords ?? 0,
      },
    },
    notes,
  };
}
