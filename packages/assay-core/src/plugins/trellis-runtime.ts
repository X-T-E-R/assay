import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { MANAGED_DIR } from "../constants.js";
import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import { stringifySortedJson } from "../serialization.js";
import { nowIso } from "../time.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import { loadPluginsState } from "./state.js";
import {
  applyTrellisWal,
  recoverTrellisWal,
  safeTrellisPath,
  withTrellisLock,
} from "./trellis-storage.js";

export const TRELLIS_PROTOCOL_VERSION = 1 as const;
export const TRELLIS_RUNTIME_STATE_VERSION = 1 as const;
export const TRELLIS_RUNTIME_DIR = `${MANAGED_DIR}/trellis`;
export const TRELLIS_TASKS_DIR = `${TRELLIS_RUNTIME_DIR}/tasks`;
export const TRELLIS_RUNTIME_STATE_FILE = `${TRELLIS_RUNTIME_DIR}/state.json`;
export const TRELLIS_TRANSACTION_FILE = `${TRELLIS_RUNTIME_DIR}/transaction.json`;
export const TRELLIS_RUNTIME_DOMAIN_DIRS = [
  `${TRELLIS_RUNTIME_DIR}/archive/tasks`,
  `${TRELLIS_RUNTIME_DIR}/journal`,
  `${TRELLIS_RUNTIME_DIR}/channels`,
  `${TRELLIS_RUNTIME_DIR}/wal`,
  `${TRELLIS_RUNTIME_DIR}/migrations`,
] as const;

const taskIdSchema = z.string().regex(/^task-[0-9a-f]{8}-[0-9a-f-]{27}$/);
const sessionIdSchema = z.string().trim().min(1).max(256);

export const trellisTaskRecordSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().trim().min(1).max(500),
    status: z.enum(["open", "completed", "cancelled"]),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const trellisRuntimeStateSchema = z
  .object({
    __schema: z.literal(TRELLIS_RUNTIME_STATE_VERSION),
    protocol_version: z.literal(TRELLIS_PROTOCOL_VERSION),
    current_task_id: taskIdSchema.nullable(),
    session_currents: z.record(sessionIdSchema, taskIdSchema),
    hook_registrations: z
      .record(
        z.string().trim().min(1),
        z
          .object({
            marker: z.string().trim().min(1),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            target: z.string().trim().min(1),
            installed_at: z.string().min(1),
            updated_at: z.string().min(1),
          })
          .strict(),
      )
      .default({}),
    updated_at: z.string().min(1),
  })
  .strict();

export const trellisTaskTransactionSchema = z
  .object({
    __schema: z.literal(TRELLIS_RUNTIME_STATE_VERSION),
    protocol_version: z.literal(TRELLIS_PROTOCOL_VERSION),
    transaction_id: z.string().uuid(),
    operation: z.literal("task.create"),
    task: trellisTaskRecordSchema,
    next_state: trellisRuntimeStateSchema,
    prepared_at: z.string().min(1),
  })
  .strict();

export type TrellisTaskRecord = z.infer<typeof trellisTaskRecordSchema>;
export type TrellisRuntimeState = z.infer<typeof trellisRuntimeStateSchema>;
export type TrellisTaskTransaction = z.infer<typeof trellisTaskTransactionSchema>;
export type TrellisHookRegistration = TrellisRuntimeState["hook_registrations"][string];

export interface TrellisRuntimeProbe {
  readonly health: "healthy" | "unhealthy";
  readonly missingPaths: readonly string[];
  readonly message: string;
}

export interface TrellisTaskResult {
  readonly protocol_version: typeof TRELLIS_PROTOCOL_VERSION;
  readonly plugin: typeof TRELLIS_PLUGIN_ID;
  readonly session_id: string | null;
  readonly task: TrellisTaskRecord | null;
}

export interface TrellisContextResult extends TrellisTaskResult {
  readonly host: "codex";
  readonly workspace_root: string;
}

function runtimeStatePath(root: string): string {
  return path.join(root, TRELLIS_RUNTIME_STATE_FILE);
}

function transactionPath(root: string): string {
  return path.join(root, TRELLIS_TRANSACTION_FILE);
}

function taskPath(root: string, taskId: string): string {
  const safeId = taskIdSchema.parse(taskId);
  const tasksRoot = path.resolve(root, TRELLIS_TASKS_DIR);
  const target = path.resolve(tasksRoot, `${safeId}.json`);
  if (path.dirname(target) !== tasksRoot) {
    throw new FrameworkError(`unsafe Trellis task id '${taskId}'`);
  }
  return target;
}

function defaultRuntimeState(now = new Date()): TrellisRuntimeState {
  return {
    __schema: TRELLIS_RUNTIME_STATE_VERSION,
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    current_task_id: null,
    session_currents: {},
    hook_registrations: {},
    updated_at: nowIso(now),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, stringifySortedJson(value), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function configuredLockStaleMs(root: string): Promise<number> {
  let value = 30_000;
  try {
    const raw = JSON.parse(
      await readFile(await safeTrellisPath(root, `${TRELLIS_RUNTIME_DIR}/config.json`), "utf8"),
    ) as { values?: { lock_stale_ms?: unknown } };
    if (raw.values?.lock_stale_ms !== undefined)
      value = z.number().int().min(1000).max(600_000).parse(raw.values.lock_stale_ms);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const fromEnvironment = process.env.ASSAY_TRELLIS_LOCK_STALE_MS;
  return fromEnvironment === undefined
    ? value
    : z.coerce.number().int().min(1000).max(600_000).parse(fromEnvironment);
}

async function withRuntimeLock<T>(
  root: string,
  action: () => Promise<T>,
  staleMs?: number,
): Promise<T> {
  return withTrellisLock(root, action, staleMs === undefined ? {} : { staleMs });
}

async function readRuntimeState(root: string): Promise<TrellisRuntimeState> {
  try {
    return trellisRuntimeStateSchema.parse(
      JSON.parse(await readFile(runtimeStatePath(root), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new FrameworkError("assay.trellis runtime state is missing; reconcile the plugin", {
        code: "PROVIDER_UNAVAILABLE",
        cause: error,
      });
    }
    throw new FrameworkError("assay.trellis runtime state failed validation", {
      code: "PROVIDER_UNAVAILABLE",
      cause: error,
    });
  }
}

async function readTask(root: string, taskId: string): Promise<TrellisTaskRecord> {
  try {
    const task = trellisTaskRecordSchema.parse(
      JSON.parse(await readFile(taskPath(root, taskId), "utf8")),
    );
    if (task.id !== taskId) {
      throw new FrameworkError(
        `assay.trellis task file '${taskId}.json' contains record '${task.id}'`,
      );
    }
    return task;
  } catch (error) {
    throw new FrameworkError(`assay.trellis task '${taskId}' is missing or invalid`, {
      code: "PROVIDER_UNAVAILABLE",
      cause: error,
    });
  }
}

async function readTaskTransaction(root: string): Promise<TrellisTaskTransaction | null> {
  try {
    return trellisTaskTransactionSchema.parse(
      JSON.parse(await readFile(transactionPath(root), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new FrameworkError("assay.trellis task transaction failed validation", {
      code: "PROVIDER_UNAVAILABLE",
      cause: error,
    });
  }
}

function referencedTaskIds(state: TrellisRuntimeState): readonly string[] {
  return [
    ...(state.current_task_id ? [state.current_task_id] : []),
    ...Object.values(state.session_currents),
  ];
}

async function validateTaskReferenceClosure(
  root: string,
  state: TrellisRuntimeState,
): Promise<readonly string[]> {
  const invalid: string[] = [];
  for (const taskId of [...new Set(referencedTaskIds(state))]) {
    try {
      const task = await readTask(root, taskId);
      if (task.status !== "open") {
        invalid.push(path.relative(root, taskPath(root, taskId)).replaceAll("\\", "/"));
      }
    } catch {
      invalid.push(path.relative(root, taskPath(root, taskId)).replaceAll("\\", "/"));
    }
  }
  return invalid;
}

async function recoverPendingTaskTransactionUnlocked(root: string): Promise<boolean> {
  const transaction = await readTaskTransaction(root);
  if (!transaction) return false;
  const targetTaskPath = taskPath(root, transaction.task.id);
  if (await pathExists(targetTaskPath)) {
    const existing = await readTask(root, transaction.task.id);
    if (stringifySortedJson(existing) !== stringifySortedJson(transaction.task)) {
      throw new FrameworkError(
        `assay.trellis task transaction conflicts with existing task '${transaction.task.id}'`,
        { code: "PROVIDER_UNAVAILABLE" },
      );
    }
  } else {
    await atomicWriteJson(targetTaskPath, transaction.task);
  }
  const invalid = await validateTaskReferenceClosure(root, transaction.next_state);
  if (invalid.length > 0) {
    throw new FrameworkError(
      `assay.trellis task transaction has dangling references: ${invalid.join(", ")}`,
      { code: "PROVIDER_UNAVAILABLE", details: { invalid } },
    );
  }
  await atomicWriteJson(runtimeStatePath(root), transaction.next_state);
  await rm(transactionPath(root), { force: true });
  return true;
}

export async function recoverTrellisRuntime(rootValue: string): Promise<boolean> {
  const root = path.resolve(rootValue);
  return withRuntimeLock(root, () => recoverPendingTaskTransactionUnlocked(root));
}

export async function probeTrellisRuntime(rootValue: string): Promise<TrellisRuntimeProbe> {
  const root = path.resolve(rootValue);
  const missingPaths: string[] = [];
  const problems: string[] = [];
  for (const relative of [TRELLIS_RUNTIME_DIR, TRELLIS_TASKS_DIR, ...TRELLIS_RUNTIME_DOMAIN_DIRS]) {
    try {
      if (!(await stat(path.join(root, relative))).isDirectory()) missingPaths.push(relative);
    } catch {
      missingPaths.push(relative);
    }
  }
  let state: TrellisRuntimeState | null = null;
  try {
    state = await readRuntimeState(root);
  } catch {
    missingPaths.push(TRELLIS_RUNTIME_STATE_FILE);
  }
  if (state) {
    const dangling = await validateTaskReferenceClosure(root, state);
    if (dangling.length > 0) {
      missingPaths.push(...dangling);
      problems.push(`dangling current-task references: ${dangling.join(", ")}`);
    }
  }
  if (await pathExists(transactionPath(root))) {
    missingPaths.push(TRELLIS_TRANSACTION_FILE);
    problems.push("pending task transaction requires recovery");
  }
  if (await pathExists(path.join(root, TRELLIS_RUNTIME_DIR, "wal", "active.json"))) {
    missingPaths.push(`${TRELLIS_RUNTIME_DIR}/wal/active.json`);
    problems.push("pending domain WAL requires recovery");
  }
  if (missingPaths.length > 0) {
    const uniquePaths = [...new Set(missingPaths)];
    return {
      health: "unhealthy",
      missingPaths: uniquePaths,
      message:
        problems.length > 0
          ? `assay.trellis runtime is unhealthy: ${problems.join("; ")}`
          : `assay.trellis runtime is incomplete: ${uniquePaths.join(", ")}`,
    };
  }
  return { health: "healthy", missingPaths: [], message: "assay.trellis runtime is healthy" };
}

export async function initializeTrellisRuntime(
  rootValue: string,
  now = new Date(),
): Promise<{ readonly createdDirs: string[]; readonly createdFiles: string[] }> {
  const root = path.resolve(rootValue);
  await safeTrellisPath(root, TRELLIS_RUNTIME_DIR);
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  for (const relative of [TRELLIS_RUNTIME_DIR, TRELLIS_TASKS_DIR, ...TRELLIS_RUNTIME_DOMAIN_DIRS]) {
    const target = path.join(root, relative);
    try {
      if (!(await stat(target)).isDirectory()) {
        throw new FrameworkError(`${relative} exists but is not a directory`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(target, { recursive: true });
      createdDirs.push(relative);
    }
  }
  try {
    await readRuntimeState(root);
  } catch (error) {
    try {
      await stat(runtimeStatePath(root));
      throw error;
    } catch (statError) {
      if (!(statError instanceof Error && "code" in statError && statError.code === "ENOENT")) {
        throw error;
      }
      await atomicWriteJson(runtimeStatePath(root), defaultRuntimeState(now));
      createdFiles.push(TRELLIS_RUNTIME_STATE_FILE);
    }
  }
  await recoverTrellisRuntime(root);
  return { createdDirs, createdFiles };
}

export async function getTrellisProtocol(rootValue: string): Promise<{
  readonly plugin: typeof TRELLIS_PLUGIN_ID;
  readonly plugin_spi: 1;
  readonly trellis_protocol: 1;
  readonly state_schema: 1;
}> {
  await requireInstalledTrellisRuntime(rootValue);
  return { plugin: TRELLIS_PLUGIN_ID, plugin_spi: 1, trellis_protocol: 1, state_schema: 1 };
}

export async function requireInstalledTrellisRuntime(rootValue: string): Promise<void> {
  const root = path.resolve(rootValue);
  await safeTrellisPath(root, TRELLIS_RUNTIME_DIR, false);
  const manifest = await loadManifest(root);
  if (!manifest) throw new FrameworkNotFoundError(`No Assay manifest found under ${root}.`);
  const declaration = manifest.plugins?.[TRELLIS_PLUGIN_ID];
  const receipt = (await loadPluginsState(root))?.plugins[TRELLIS_PLUGIN_ID];
  if (
    declaration?.kind !== "workspace-runtime" ||
    receipt?.kind !== "workspace-runtime" ||
    receipt.state_version !== TRELLIS_RUNTIME_STATE_VERSION
  ) {
    throw new FrameworkError(
      "assay.trellis is not installed; run `assay plugin add assay.trellis` first",
      { code: "PROVIDER_UNAVAILABLE" },
    );
  }
  await recoverTrellisRuntime(root);
  await withRuntimeLock(root, async () => {
    await recoverTrellisWal(root);
    const probe = await probeTrellisRuntime(root);
    if (probe.health !== "healthy") {
      throw new FrameworkError(probe.message, { code: "PROVIDER_UNAVAILABLE", details: probe });
    }
  });
}

/** One serialization boundary for every installed runtime mutation. */
export async function withInstalledTrellisMutation<T>(
  rootValue: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = path.resolve(rootValue);
  await safeTrellisPath(root, TRELLIS_RUNTIME_DIR, false);
  const manifestBeforeLock = await loadManifest(root);
  const receiptBeforeLock = (await loadPluginsState(root))?.plugins[TRELLIS_PLUGIN_ID];
  if (
    manifestBeforeLock?.plugins?.[TRELLIS_PLUGIN_ID]?.kind !== "workspace-runtime" ||
    receiptBeforeLock?.kind !== "workspace-runtime" ||
    receiptBeforeLock.state_version !== TRELLIS_RUNTIME_STATE_VERSION
  ) {
    throw new FrameworkError("assay.trellis is not installed", {
      code: "PROVIDER_UNAVAILABLE",
    });
  }
  const staleMs = await configuredLockStaleMs(root);
  return withRuntimeLock(
    root,
    async () => {
      const manifest = await loadManifest(root);
      const receipt = (await loadPluginsState(root))?.plugins[TRELLIS_PLUGIN_ID];
      if (
        manifest?.plugins?.[TRELLIS_PLUGIN_ID]?.kind !== "workspace-runtime" ||
        receipt?.kind !== "workspace-runtime" ||
        receipt.state_version !== TRELLIS_RUNTIME_STATE_VERSION
      ) {
        throw new FrameworkError("assay.trellis is not installed", {
          code: "PROVIDER_UNAVAILABLE",
        });
      }
      await recoverPendingTaskTransactionUnlocked(root);
      await recoverTrellisWal(root);
      return action(root);
    },
    staleMs,
  );
}

/** Validate installation and health without performing recovery or any write. */
export async function requireInstalledTrellisRuntimeReadOnly(rootValue: string): Promise<void> {
  const root = path.resolve(rootValue);
  await safeTrellisPath(root, TRELLIS_RUNTIME_DIR, false);
  const manifest = await loadManifest(root);
  if (!manifest) throw new FrameworkNotFoundError(`No Assay manifest found under ${root}.`);
  const declaration = manifest.plugins?.[TRELLIS_PLUGIN_ID];
  const receipt = (await loadPluginsState(root))?.plugins[TRELLIS_PLUGIN_ID];
  if (
    declaration?.kind !== "workspace-runtime" ||
    receipt?.kind !== "workspace-runtime" ||
    receipt.state_version !== TRELLIS_RUNTIME_STATE_VERSION
  ) {
    throw new FrameworkError(
      "assay.trellis is not installed; run `assay plugin add assay.trellis` first",
      { code: "PROVIDER_UNAVAILABLE" },
    );
  }
  const probe = await probeTrellisRuntime(root);
  if (probe.health !== "healthy")
    throw new FrameworkError(probe.message, { code: "PROVIDER_UNAVAILABLE", details: probe });
}

function normalizeSessionId(sessionId: string | undefined): string | null {
  return sessionId === undefined ? null : sessionIdSchema.parse(sessionId);
}

export async function getTrellisHookRegistration(
  rootValue: string,
  host: string,
): Promise<TrellisHookRegistration | null> {
  const root = path.resolve(rootValue);
  await requireInstalledTrellisRuntime(root);
  return (await readRuntimeState(root)).hook_registrations[host] ?? null;
}

export async function recordTrellisHookRegistration(options: {
  readonly root: string;
  readonly host: string;
  readonly marker: string;
  readonly fingerprint: string;
  readonly target: string;
  readonly now?: Date;
}): Promise<TrellisHookRegistration> {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const state = await readRuntimeState(root);
    const timestamp = nowIso(options.now ?? new Date());
    const previous = state.hook_registrations[options.host];
    const registration: TrellisHookRegistration = {
      marker: options.marker,
      fingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(options.fingerprint),
      target: options.target,
      installed_at: previous?.installed_at ?? timestamp,
      updated_at: timestamp,
    };
    const nextState = trellisRuntimeStateSchema.parse({
      ...state,
      hook_registrations: { ...state.hook_registrations, [options.host]: registration },
      updated_at: timestamp,
    });
    await applyTrellisWal(root, "hook.registration.record", [
      { path: TRELLIS_RUNTIME_STATE_FILE, value: nextState },
    ]);
    return registration;
  });
}

export async function clearTrellisHookRegistration(
  rootValue: string,
  host: string,
  now = new Date(),
): Promise<boolean> {
  const root = path.resolve(rootValue);
  return withInstalledTrellisMutation(root, async () => {
    const state = await readRuntimeState(root);
    if (!state.hook_registrations[host]) return false;
    const registrations = { ...state.hook_registrations };
    delete registrations[host];
    await applyTrellisWal(root, "hook.registration.clear", [
      {
        path: TRELLIS_RUNTIME_STATE_FILE,
        value: trellisRuntimeStateSchema.parse({
          ...state,
          hook_registrations: registrations,
          updated_at: nowIso(now),
        }),
      },
    ]);
    return true;
  });
}

function resolveCurrentTaskId(state: TrellisRuntimeState, sessionId: string | null): string | null {
  if (sessionId !== null) return state.session_currents[sessionId] ?? null;
  if (state.current_task_id) return state.current_task_id;
  const candidates = [...new Set(Object.values(state.session_currents))];
  if (candidates.length <= 1) return candidates[0] ?? null;
  throw new FrameworkError(
    "current Trellis task is ambiguous across sessions; pass --session-id or set ASSAY_TRELLIS_SESSION_ID",
    { details: { session_ids: Object.keys(state.session_currents).sort() } },
  );
}

export async function createTrellisTask(options: {
  readonly root: string;
  readonly title: string;
  readonly sessionId?: string;
  readonly now?: Date;
}): Promise<TrellisTaskResult> {
  const root = path.resolve(options.root);
  const title = options.title.trim();
  if (!title) throw new FrameworkError("task title must not be empty");
  const sessionId = normalizeSessionId(options.sessionId);
  return withInstalledTrellisMutation(root, async () => {
    const state = await readRuntimeState(root);
    const timestamp = nowIso(options.now ?? new Date());
    const task = trellisTaskRecordSchema.parse({
      id: `task-${randomUUID()}`,
      title,
      status: "open",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const nextState = trellisRuntimeStateSchema.parse({
      ...state,
      ...(sessionId === null
        ? { current_task_id: task.id }
        : { session_currents: { ...state.session_currents, [sessionId]: task.id } }),
      updated_at: timestamp,
    });
    await applyTrellisWal(root, "task.create", [
      { path: path.relative(root, taskPath(root, task.id)).replaceAll("\\", "/"), value: task },
      { path: TRELLIS_RUNTIME_STATE_FILE, value: nextState },
    ]);
    return {
      protocol_version: TRELLIS_PROTOCOL_VERSION,
      plugin: TRELLIS_PLUGIN_ID,
      session_id: sessionId,
      task,
    };
  });
}

export async function getCurrentTrellisTask(options: {
  readonly root: string;
  readonly sessionId?: string;
}): Promise<TrellisTaskResult> {
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntime(root);
  const sessionId = normalizeSessionId(options.sessionId);
  const taskId = resolveCurrentTaskId(await readRuntimeState(root), sessionId);
  return {
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    plugin: TRELLIS_PLUGIN_ID,
    session_id: sessionId,
    task: taskId ? await readTask(root, taskId) : null,
  };
}

export async function getTrellisContext(options: {
  readonly root: string;
  readonly host: string;
  readonly sessionId?: string;
}): Promise<TrellisContextResult> {
  if (options.host !== "codex") {
    throw new FrameworkError(
      `unsupported Trellis context host '${options.host}'; supported: codex`,
    );
  }
  const root = path.resolve(options.root);
  const current = await getCurrentTrellisTask({
    root,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  return { ...current, host: "codex", workspace_root: root };
}
