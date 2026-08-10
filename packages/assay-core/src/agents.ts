import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  safelyWriteAuthorityFile,
} from "./authority-file-write.js";
import { AuthorityWriteConflictError, FrameworkError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import { type WorkspaceZone, manifestZones, zoneTable } from "./zones.js";

export const ASSAY_AGENTS_FILE = "AGENTS.md";
export const ASSAY_AGENTS_START_MARKER = "<!-- ASSAY:START -->";
export const ASSAY_AGENTS_END_MARKER = "<!-- ASSAY:END -->";
export const ASSAY_AGENTS_MALFORMED_REASON = "AGENTS.md has incomplete Assay managed block markers";

let assayAgentsWriteProbe: AuthorityWriteProbe | undefined;

export function setAssayAgentsWriteProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  assayAgentsWriteProbe = probe;
}

/**
 * Workspace facts the managed block states beyond the fixed rules. The block is
 * the one channel that is already in context when a session starts, so the
 * directory table lives here rather than only in per-directory READMEs an agent
 * would have to go looking for.
 */
export interface AssayAgentsLayoutSection {
  readonly zones: readonly WorkspaceZone[];
}

const ASSAY_AGENTS_RULES = [
  "# Assay Workspace Instructions",
  "",
  "This workspace is managed by Assay.",
  "",
  "- Before changing workspace structure, start from the installed `assay-builder` skill if the agent environment exposes it. Otherwise use `assay --help` / `assay help <command>` and inspect the workspace with `assay status`.",
  "- Do not assume the repository root is the system being built. The root is the Assay workspace/control surface. Systems live under `systems/` and registered systems are managed with `assay system ...`.",
  "- Use Assay commands for `.assay/` state. Edits outside this block are preserved.",
];

/**
 * Build the managed block. The layout section is appended only when the
 * workspace resolves an manifest entries with at least one zone, so a workspace whose
 * manifest or manifest entries cannot be read still gets the standing rules.
 */
export function assayAgentsBlock(layout?: AssayAgentsLayoutSection | null): string {
  const table = layout ? zoneTable(layout.zones) : [];
  const layoutSection = layout && table.length > 0 ? ["", "## Workspace layout", "", ...table] : [];
  return [
    ASSAY_AGENTS_START_MARKER,
    "",
    ...ASSAY_AGENTS_RULES,
    ...layoutSection,
    "",
    ASSAY_AGENTS_END_MARKER,
  ].join("\n");
}

/** The managed block without a workspace layout section. */
export const ASSAY_AGENTS_BLOCK = assayAgentsBlock(null);

/**
 * Read the manifest entries-declared layout for a workspace root. Returns null when
 * the workspace has no readable manifest or manifest entries: the block then keeps its
 * rules instead of failing the command that writes it.
 */
export async function readAssayAgentsLayoutSection(
  root: string,
): Promise<AssayAgentsLayoutSection | null> {
  try {
    const manifest = await loadManifest(root);
    if (!manifest) {
      return null;
    }
    return { zones: manifestZones(manifest.layout.entries, manifest.layout) };
  } catch {
    return null;
  }
}

export type AssayAgentsBlockMode = "install" | "refresh-existing" | "skip";
export type AssayAgentsBlockAction = "create" | "append" | "replace" | "skip";

export interface PlanAssayAgentsBlockOptions {
  readonly root: string;
  readonly mode?: AssayAgentsBlockMode;
}

export interface ApplyAssayAgentsBlockOptions extends PlanAssayAgentsBlockOptions {
  readonly dryRun?: boolean;
  /** Use the recoverable CAS writer for ordinary update without changing init callers. */
  readonly authorityWrite?: boolean;
}

export interface AssayAgentsBlockPlan {
  readonly path: typeof ASSAY_AGENTS_FILE;
  readonly action: AssayAgentsBlockAction;
  readonly reason: string;
  readonly changed: boolean;
}

export interface AssayAgentsBlockResult extends AssayAgentsBlockPlan {
  readonly dryRun: boolean;
}

interface InternalAssayAgentsBlockPlan extends AssayAgentsBlockPlan {
  readonly content?: string;
  readonly expectedContent?: string | null;
}

type LocatedAssayAgentsBlock =
  | { readonly kind: "found"; readonly start: number; readonly end: number }
  | { readonly kind: "none" }
  | { readonly kind: "malformed" };

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function blockContentForFile(layout: AssayAgentsLayoutSection | null): string {
  return `${assayAgentsBlock(layout)}\n`;
}

function includeTrailingLineEnding(content: string, index: number): number {
  if (content.startsWith("\r\n", index)) {
    return index + 2;
  }
  if (content.startsWith("\n", index)) {
    return index + 1;
  }
  return index;
}

function locateAssayAgentsBlock(content: string): LocatedAssayAgentsBlock {
  const start = content.indexOf(ASSAY_AGENTS_START_MARKER);
  const hasEndMarker = content.includes(ASSAY_AGENTS_END_MARKER);

  if (start === -1) {
    return hasEndMarker ? { kind: "malformed" } : { kind: "none" };
  }

  const end = content.indexOf(ASSAY_AGENTS_END_MARKER, start + ASSAY_AGENTS_START_MARKER.length);
  if (end === -1) {
    return { kind: "malformed" };
  }

  return {
    kind: "found",
    start,
    end: includeTrailingLineEnding(content, end + ASSAY_AGENTS_END_MARKER.length),
  };
}

function appendAssayAgentsBlock(content: string, layout: AssayAgentsLayoutSection | null): string {
  const block = blockContentForFile(layout);
  if (content.length === 0) {
    return block;
  }
  if (content.endsWith("\n\n")) {
    return `${content}${block}`;
  }
  if (content.endsWith("\n")) {
    return `${content}\n${block}`;
  }
  return `${content}\n\n${block}`;
}

async function readAgentsFile(root: string): Promise<string | null> {
  const file = path.join(root, ASSAY_AGENTS_FILE);
  if (!(await exists(file))) {
    return null;
  }
  return readFile(file, "utf8");
}

function publicPlan(plan: InternalAssayAgentsBlockPlan): AssayAgentsBlockPlan {
  return {
    path: plan.path,
    action: plan.action,
    reason: plan.reason,
    changed: plan.changed,
  };
}

async function buildAssayAgentsBlockPlan(
  options: PlanAssayAgentsBlockOptions,
  authorityWrite = false,
): Promise<InternalAssayAgentsBlockPlan> {
  const root = path.resolve(options.root);
  const mode = options.mode ?? "install";

  if (mode === "skip") {
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "Assay agent instructions are disabled",
      changed: false,
    };
  }

  if (authorityWrite) {
    const file = path.join(root, ASSAY_AGENTS_FILE);
    await recoverAuthorityFile({
      root,
      file,
      error: (message, cause) =>
        new FrameworkError(message, cause === undefined ? {} : { cause }),
      ...(assayAgentsWriteProbe ? { probe: assayAgentsWriteProbe } : {}),
    });
  }

  const existing = await readAgentsFile(root);
  const layoutSection = await readAssayAgentsLayoutSection(root);

  if (existing === null) {
    if (mode === "install") {
      return {
        path: ASSAY_AGENTS_FILE,
        action: "create",
        reason: "AGENTS.md is missing",
        changed: true,
        content: blockContentForFile(layoutSection),
        expectedContent: null,
      };
    }
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "AGENTS.md is missing and agents install was not requested",
      changed: false,
    };
  }

  const located = locateAssayAgentsBlock(existing);
  if (located.kind === "malformed") {
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: ASSAY_AGENTS_MALFORMED_REASON,
      changed: false,
    };
  }

  if (located.kind === "none") {
    if (mode === "install") {
      return {
        path: ASSAY_AGENTS_FILE,
        action: "append",
        reason: "AGENTS.md exists without an Assay managed block",
        changed: true,
        content: appendAssayAgentsBlock(existing, layoutSection),
        expectedContent: existing,
      };
    }
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "AGENTS.md has no Assay managed block",
      changed: false,
    };
  }

  const nextContent = `${existing.slice(0, located.start)}${blockContentForFile(
    layoutSection,
  )}${existing.slice(located.end)}`;
  if (nextContent === existing) {
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "Assay managed block is already current",
      changed: false,
    };
  }
  return {
    path: ASSAY_AGENTS_FILE,
    action: "replace",
    reason: "refresh Assay managed block",
    changed: true,
    content: nextContent,
    expectedContent: existing,
  };
}

export async function planAssayAgentsBlock(
  options: PlanAssayAgentsBlockOptions,
): Promise<AssayAgentsBlockPlan> {
  return publicPlan(await buildAssayAgentsBlockPlan(options));
}

export async function applyAssayAgentsBlock(
  options: ApplyAssayAgentsBlockOptions,
): Promise<AssayAgentsBlockResult> {
  const plan = await buildAssayAgentsBlockPlan(options, options.authorityWrite ?? false);
  const dryRun = options.dryRun ?? false;

  if (plan.changed && !dryRun && plan.content !== undefined) {
    const root = path.resolve(options.root);
    const file = path.join(root, ASSAY_AGENTS_FILE);
    if (options.authorityWrite) {
      const expectedContent = plan.expectedContent;
      await safelyWriteAuthorityFile({
        root,
        file,
        content: plan.content,
        validateExisting: (bytes) => {
          const current = bytes?.toString("utf8") ?? null;
          if (current !== expectedContent) {
            throw new AuthorityWriteConflictError(
              `${ASSAY_AGENTS_FILE} changed after its managed block was planned`,
            );
          }
        },
        error: (message, cause) =>
          new FrameworkError(message, cause === undefined ? {} : { cause }),
        textFileMode: { preserveExisting: true, createMode: 0o666 },
        ...(assayAgentsWriteProbe ? { probe: assayAgentsWriteProbe } : {}),
      });
    } else {
      await writeFile(file, plan.content, "utf8");
    }
  }

  return {
    ...publicPlan(plan),
    dryRun,
  };
}

export function describeAssayAgentsBlockAction(result: AssayAgentsBlockResult): string {
  if (result.changed && result.dryRun) {
    return `${ASSAY_AGENTS_FILE}: would ${result.action} Assay managed block`;
  }
  if (result.changed) {
    if (result.action === "skip") {
      return `${ASSAY_AGENTS_FILE}: ${result.reason}`;
    }
    const pastTense: Record<Exclude<AssayAgentsBlockAction, "skip">, string> = {
      append: "appended",
      create: "created",
      replace: "replaced",
    };
    return `${ASSAY_AGENTS_FILE}: ${pastTense[result.action]} Assay managed block`;
  }
  return `${ASSAY_AGENTS_FILE}: ${result.reason}`;
}
