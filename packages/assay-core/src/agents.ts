import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const ASSAY_AGENTS_FILE = "AGENTS.md";
export const ASSAY_AGENTS_START_MARKER = "<!-- ASSAY:START -->";
export const ASSAY_AGENTS_END_MARKER = "<!-- ASSAY:END -->";
export const ASSAY_AGENTS_MALFORMED_REASON = "AGENTS.md has incomplete Assay managed block markers";

export const ASSAY_AGENTS_BLOCK = [
  ASSAY_AGENTS_START_MARKER,
  "",
  "# Assay Workspace Instructions",
  "",
  "This workspace is managed by Assay.",
  "",
  "- Before changing workspace structure, start from the installed `assay-builder` skill if the agent environment exposes it. Otherwise use `assay --help` / `assay help <command>` and inspect the workspace with `assay status`.",
  "- Do not assume the repository root is the system being built. The root is the Assay workspace/control surface. Systems live under `systems/` and registered systems are managed with `assay system ...`.",
  "- Use Assay commands for `.assay/` state. Edits outside this block are preserved.",
  "",
  ASSAY_AGENTS_END_MARKER,
].join("\n");

export type AssayAgentsBlockMode = "install" | "refresh-existing" | "skip";
export type AssayAgentsBlockAction = "create" | "append" | "replace" | "skip";

export interface PlanAssayAgentsBlockOptions {
  readonly root: string;
  readonly mode?: AssayAgentsBlockMode;
}

export interface ApplyAssayAgentsBlockOptions extends PlanAssayAgentsBlockOptions {
  readonly dryRun?: boolean;
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

function blockContentForFile(): string {
  return `${ASSAY_AGENTS_BLOCK}\n`;
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

function appendAssayAgentsBlock(content: string): string {
  if (content.length === 0) {
    return blockContentForFile();
  }
  if (content.endsWith("\n\n")) {
    return `${content}${blockContentForFile()}`;
  }
  if (content.endsWith("\n")) {
    return `${content}\n${blockContentForFile()}`;
  }
  return `${content}\n\n${blockContentForFile()}`;
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
): Promise<InternalAssayAgentsBlockPlan> {
  const root = path.resolve(options.root);
  const mode = options.mode ?? "install";
  const existing = await readAgentsFile(root);

  if (mode === "skip") {
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "Assay agent instructions are disabled",
      changed: false,
    };
  }

  if (existing === null) {
    if (mode === "install") {
      return {
        path: ASSAY_AGENTS_FILE,
        action: "create",
        reason: "AGENTS.md is missing",
        changed: true,
        content: blockContentForFile(),
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
        content: appendAssayAgentsBlock(existing),
      };
    }
    return {
      path: ASSAY_AGENTS_FILE,
      action: "skip",
      reason: "AGENTS.md has no Assay managed block",
      changed: false,
    };
  }

  const nextContent = `${existing.slice(0, located.start)}${blockContentForFile()}${existing.slice(
    located.end,
  )}`;
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
  const plan = await buildAssayAgentsBlockPlan(options);
  const dryRun = options.dryRun ?? false;

  if (plan.changed && !dryRun && plan.content !== undefined) {
    await writeFile(path.join(path.resolve(options.root), ASSAY_AGENTS_FILE), plan.content, "utf8");
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
