import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { FrameworkError } from "../errors.js";
import { stringifySortedJson } from "../serialization.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import {
  TRELLIS_PROTOCOL_VERSION,
  clearTrellisHookRegistration,
  getTrellisContext,
  getTrellisHookRegistration,
  recordTrellisHookRegistration,
  requireInstalledTrellisRuntime,
} from "./trellis-runtime.js";
import { safeTrellisPath, withPidFileLock } from "./trellis-storage.js";

// Persist an invocation that does not depend on `assay` being present on PATH.
// During CLI execution argv[1] is the installed Assay entry point; JSON quoting
// keeps both Windows and POSIX paths containing spaces intact.
export const CODEX_TRELLIS_HOOK_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(
  process.argv[1] ?? "assay",
)} trellis context --host codex --hook-adapter`;
export const CODEX_TRELLIS_HOOK_MARKER = "assay.trellis/codex-session-start/v1" as const;
const CODEX_HOOK_MATCHER = "startup|resume|clear|compact";

export const codexSessionStartHookOutputSchema = z
  .object({
    continue: z.literal(true),
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("SessionStart"),
        additionalContext: z.string(),
      })
      .strict(),
  })
  .strict();

export type CodexSessionStartHookOutput = z.infer<typeof codexSessionStartHookOutputSchema>;

interface CodexCommandHook {
  readonly type: "command";
  readonly command: string;
  readonly timeout: number;
}

interface CodexHookGroup {
  readonly matcher?: string;
  readonly hooks: readonly unknown[];
  readonly [key: string]: unknown;
}

interface CodexHooksDocument {
  readonly hooks: Record<string, readonly unknown[]>;
  readonly [key: string]: unknown;
}

export interface TrellisHookInstallPlan {
  readonly protocol_version: typeof TRELLIS_PROTOCOL_VERSION;
  readonly plugin: typeof TRELLIS_PLUGIN_ID;
  readonly host: "codex";
  readonly target: string;
  readonly action: "create" | "update" | "adopt" | "noop" | "conflict";
  readonly marker: typeof CODEX_TRELLIS_HOOK_MARKER;
  readonly fingerprint: string;
  readonly command: string;
  readonly message: string;
  readonly document: CodexHooksDocument;
}

export interface TrellisHookInstallResult extends TrellisHookInstallPlan {
  readonly applied: boolean;
}

function canonicalHookGroup(): CodexHookGroup {
  const hook: CodexCommandHook = {
    type: "command",
    command: CODEX_TRELLIS_HOOK_COMMAND,
    timeout: 10,
  };
  return { matcher: CODEX_HOOK_MATCHER, hooks: [hook] };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stringifySortedJson(value)).digest("hex");
}

function commandOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return record.type === "command" && typeof record.command === "string" ? record.command : null;
}

function normalizeDocument(value: unknown): CodexHooksDocument {
  if (value === undefined) return { hooks: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FrameworkError("Codex hooks configuration must be a JSON object");
  }
  const source = value as Record<string, unknown>;
  if (
    source.hooks !== undefined &&
    (!source.hooks || typeof source.hooks !== "object" || Array.isArray(source.hooks))
  ) {
    throw new FrameworkError("Codex hooks configuration 'hooks' must be an object");
  }
  const hookEntries: Record<string, readonly unknown[]> = {};
  for (const [event, entries] of Object.entries(
    (source.hooks as Record<string, unknown> | undefined) ?? {},
  )) {
    if (!Array.isArray(entries)) {
      throw new FrameworkError(`Codex hook event '${event}' must be an array`);
    }
    hookEntries[event] = entries;
  }
  return { ...source, hooks: hookEntries } as CodexHooksDocument;
}

async function readHooksDocument(file: string): Promise<CodexHooksDocument | undefined> {
  try {
    return normalizeDocument(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new FrameworkError(`Codex hooks configuration is invalid JSON: ${file}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function withHookLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return withPidFileLock(root, ".codex/.assay-trellis-hook.lock", action);
}

interface HookCandidate {
  readonly groupIndex: number;
  readonly group: CodexHookGroup;
  readonly groupFingerprint: string;
  readonly exactCanonical: boolean;
}

function findCandidates(document: CodexHooksDocument): readonly HookCandidate[] {
  const candidates: HookCandidate[] = [];
  for (const [groupIndex, entry] of (document.hooks.SessionStart ?? []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const group = entry as CodexHookGroup;
    if (!Array.isArray(group.hooks)) continue;
    if (!group.hooks.some((hook) => commandOf(hook) === CODEX_TRELLIS_HOOK_COMMAND)) continue;
    candidates.push({
      groupIndex,
      group,
      groupFingerprint: fingerprint(group),
      exactCanonical: fingerprint(group) === fingerprint(canonicalHookGroup()),
    });
  }
  return candidates;
}

function appendCanonical(document: CodexHooksDocument): CodexHooksDocument {
  return {
    ...document,
    hooks: {
      ...document.hooks,
      SessionStart: [...(document.hooks.SessionStart ?? []), canonicalHookGroup()],
    },
  };
}

function replaceProvenOwned(
  document: CodexHooksDocument,
  candidate: HookCandidate,
): CodexHooksDocument {
  const groups = [...(document.hooks.SessionStart ?? [])];
  groups[candidate.groupIndex] = canonicalHookGroup();
  return { ...document, hooks: { ...document.hooks, SessionStart: groups } };
}

export async function planTrellisHookInstall(options: {
  readonly root: string;
  readonly host: string;
}): Promise<TrellisHookInstallPlan> {
  if (options.host !== "codex") {
    throw new FrameworkError(`unsupported Trellis hook host '${options.host}'; supported: codex`);
  }
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntime(root);
  const target = await safeTrellisPath(root, ".codex/hooks.json");
  const relativeTarget = path.relative(root, target).replaceAll("\\", "/");
  const current = await readHooksDocument(target);
  const source = current ?? { hooks: {} };
  const candidates = findCandidates(source);
  const registration = await getTrellisHookRegistration(root, "codex");
  const canonicalFingerprint = fingerprint(canonicalHookGroup());

  let action: TrellisHookInstallPlan["action"];
  let message: string;
  let document = source;
  if (!registration) {
    if (candidates.length === 0) {
      action = current ? "update" : "create";
      message = "append a new Assay-owned Codex SessionStart hook";
      document = appendCanonical(source);
    } else if (candidates.length === 1 && candidates[0]?.exactCanonical) {
      action = "adopt";
      message = "adopt the matching unreceipted hook without rewriting it";
    } else {
      action = "conflict";
      message = "matching unreceipted hook is non-canonical or duplicated; preserve it for review";
    }
  } else if (
    registration.marker !== CODEX_TRELLIS_HOOK_MARKER ||
    registration.target !== relativeTarget
  ) {
    action = "conflict";
    message = "stored hook ownership marker or target does not match this registration";
  } else {
    const owned = candidates.filter(
      (candidate) => candidate.groupFingerprint === registration.fingerprint,
    );
    const ownedCandidate = candidates.length === 1 && owned.length === 1 ? owned[0] : undefined;
    if (!ownedCandidate) {
      action = "conflict";
      message =
        "the receipted hook is missing, duplicated, or modified; preserve host configuration";
    } else if (ownedCandidate.exactCanonical) {
      action = "noop";
      message = "Codex hook and Assay ownership receipt agree";
    } else {
      action = "update";
      message = "update the proven-owned Codex hook to the canonical adapter";
      document = replaceProvenOwned(source, ownedCandidate);
    }
  }

  return {
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    plugin: TRELLIS_PLUGIN_ID,
    host: "codex",
    target: relativeTarget,
    action,
    marker: CODEX_TRELLIS_HOOK_MARKER,
    fingerprint: canonicalFingerprint,
    command: CODEX_TRELLIS_HOOK_COMMAND,
    message,
    document,
  };
}

async function writeHooksDocument(root: string, plan: TrellisHookInstallPlan): Promise<void> {
  const target = path.join(root, plan.target);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringifySortedJson(plan.document), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function installTrellisHook(options: {
  readonly root: string;
  readonly host: string;
  readonly apply?: boolean;
}): Promise<TrellisHookInstallResult> {
  const root = path.resolve(options.root);
  const plan = await planTrellisHookInstall({ root, host: options.host });
  if (!options.apply || plan.action === "noop") return { ...plan, applied: false };
  if (plan.action === "conflict") {
    throw new FrameworkError(`Trellis hook install conflict: ${plan.message}`, {
      details: plan,
    });
  }
  return withHookLock(root, async () => {
    const currentPlan = await planTrellisHookInstall({ root, host: options.host });
    if (currentPlan.action === "conflict") {
      throw new FrameworkError(`Trellis hook install conflict: ${currentPlan.message}`, {
        details: currentPlan,
      });
    }
    if (currentPlan.action === "noop") return { ...currentPlan, applied: false };
    if (currentPlan.action !== "adopt") await writeHooksDocument(root, currentPlan);
    await recordTrellisHookRegistration({
      root,
      host: "codex",
      marker: currentPlan.marker,
      fingerprint: currentPlan.fingerprint,
      target: currentPlan.target,
    });
    return { ...currentPlan, applied: true };
  });
}

export async function removeTrellisHook(options: {
  readonly root: string;
  readonly host: string;
  /** Lifecycle recovery may prove that a missing candidate was already deleted. */
  readonly allowMissingOwned?: boolean;
}): Promise<{ readonly host: "codex"; readonly target: string; readonly removed: boolean }> {
  if (options.host !== "codex") {
    throw new FrameworkError(`unsupported Trellis hook host '${options.host}'; supported: codex`);
  }
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntime(root);
  return withHookLock(root, async () => {
    const target = await safeTrellisPath(root, ".codex/hooks.json");
    const relativeTarget = path.relative(root, target).replaceAll("\\", "/");
    const registration = await getTrellisHookRegistration(root, "codex");
    if (!registration) return { host: "codex", target: relativeTarget, removed: false };
    if (
      registration.marker !== CODEX_TRELLIS_HOOK_MARKER ||
      registration.target !== relativeTarget
    ) {
      throw new FrameworkError(
        "Trellis hook uninstall conflict: stored ownership marker or target does not match",
      );
    }
    const document = await readHooksDocument(target);
    if (!document) {
      await clearTrellisHookRegistration(root, "codex");
      return { host: "codex", target: relativeTarget, removed: false };
    }
    const candidates = findCandidates(document);
    if (candidates.length === 0 && options.allowMissingOwned) {
      await clearTrellisHookRegistration(root, "codex");
      return { host: "codex", target: relativeTarget, removed: false };
    }
    const owned = candidates.filter(
      (candidate) => candidate.groupFingerprint === registration.fingerprint,
    );
    if (candidates.length !== 1 || owned.length !== 1) {
      throw new FrameworkError(
        "Trellis hook uninstall conflict: the receipted hook is missing, duplicated, or modified",
      );
    }
    const groups = [...(document.hooks.SessionStart ?? [])];
    const ownedCandidate = owned[0];
    if (!ownedCandidate) throw new FrameworkError("Trellis hook uninstall ownership vanished");
    groups.splice(ownedCandidate.groupIndex, 1);
    const next = {
      ...document,
      hooks: { ...document.hooks, SessionStart: groups },
    };
    await writeHooksDocument(root, {
      protocol_version: TRELLIS_PROTOCOL_VERSION,
      plugin: TRELLIS_PLUGIN_ID,
      host: "codex",
      target: relativeTarget,
      action: "update",
      marker: CODEX_TRELLIS_HOOK_MARKER,
      fingerprint: registration.fingerprint,
      command: CODEX_TRELLIS_HOOK_COMMAND,
      message: "remove proven-owned Codex SessionStart hook",
      document: next,
    });
    await clearTrellisHookRegistration(root, "codex");
    return { host: "codex", target: relativeTarget, removed: true };
  });
}

function stringCandidate(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveCodexHookSessionId(
  stdinValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let payload: unknown = stdinValue;
  if (typeof stdinValue === "string") {
    if (!stdinValue.trim()) payload = undefined;
    else {
      try {
        payload = JSON.parse(stdinValue);
      } catch (error) {
        throw new FrameworkError("Codex SessionStart hook stdin is not valid JSON", {
          cause: error,
        });
      }
    }
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const direct =
      stringCandidate(record.thread_id) ??
      stringCandidate(record.threadId) ??
      stringCandidate(record.session_id) ??
      stringCandidate(record.sessionId);
    if (direct) return direct;
    if (record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)) {
      const nested = stringCandidate((record.thread as Record<string, unknown>).id);
      if (nested) return nested;
    }
  }
  return stringCandidate(env.CODEX_THREAD_ID);
}

export async function renderCodexSessionStartHook(options: {
  readonly root: string;
  readonly stdin?: unknown;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CodexSessionStartHookOutput> {
  const sessionId = resolveCodexHookSessionId(options.stdin, options.env ?? process.env);
  const context = await getTrellisContext({
    root: options.root,
    host: "codex",
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return codexSessionStartHookOutputSchema.parse({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: JSON.stringify(context),
    },
  });
}
