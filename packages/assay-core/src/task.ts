import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspaceWorkRelativePath,
} from "./layout.js";
import { loadManifest } from "./manifest.js";
import { allocateReadableId, isReadableId, readableIdSlug } from "./readable-id.js";
import { TASK_HANDOFF_HEADINGS, renderTaskPrd } from "./tasks/task-contract.js";
import {
  TASK_ENVELOPE_KEYS,
  type TaskEnvelope,
  isJsonObject,
  newTaskEnvelope,
  taskEnvelopeSchema,
} from "./tasks/task-record.js";
import {
  TaskInvalidEncodingError,
  TaskLockUnavailableError,
  TaskStorageBoundaryError,
  assertTaskStorageBoundary,
  atomicWriteTaskText,
  listTaskDirectories,
  readTaskText,
  removeTaskFile,
  withTaskLock,
} from "./tasks/task-storage.js";

const MAX_TASK_FILE_BYTES = 1024 * 1024;
const MAX_TASK_RECORDS = 4096;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CHECKPOINT_TRANSACTION_FILE = ".assay-checkpoint.json";

export type TaskTransactionProbeStage = "after-prepare" | "after-handoff" | "after-task";
type TaskTransactionProbe = (
  stage: TaskTransactionProbeStage,
  taskId: string,
) => "crash" | undefined | Promise<"crash" | undefined>;

let transactionProbe: TaskTransactionProbe | undefined;
type TaskArchiveProbe = (taskId: string) => void | Promise<void>;
let archiveProbe: TaskArchiveProbe | undefined;

/** Test-only crash injection at durable checkpoint transaction boundaries. */
export function setTaskTransactionProbeForTests(probe: TaskTransactionProbe | undefined): void {
  transactionProbe = probe;
}

/** Test-only hook for allocator/archive coordination. */
export function setTaskArchiveProbeForTests(probe: TaskArchiveProbe | undefined): void {
  archiveProbe = probe;
}

export const TASK_WRITE_STATUSES = ["active", "paused", "done", "cancelled", "superseded"] as const;
export type TaskStatus = (typeof TASK_WRITE_STATUSES)[number];
export const TASK_RELATION_TYPES = ["contributes_to", "continues", "supersedes"] as const;
export type TaskRelationType = (typeof TASK_RELATION_TYPES)[number];
export interface TaskRelation {
  readonly type: TaskRelationType;
  readonly task_id: string;
}

export type TaskErrorCode =
  | "TASK_INVALID"
  | "TASK_INVALID_ENCODING"
  | "TASK_ID_INVALID"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_EXISTS"
  | "TASK_CONFLICT"
  | "TASK_TERMINAL"
  | "TASK_NOT_TERMINAL"
  | "TASK_REVISION_CONFLICT"
  | "TASK_CONTEXT_INVALID"
  | "TASK_CONTEXT_CONFLICT"
  | "TASK_RELATION_INVALID"
  | "TASK_RELATION_CYCLE"
  | "TASK_STORAGE_BOUNDARY"
  | "TASK_IO_ERROR"
  | "WORKSPACE_NOT_FOUND";

export class TaskError extends Error {
  readonly code: TaskErrorCode;
  readonly details?: unknown;

  constructor(
    code: TaskErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly details?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaskError";
    this.code = code;
    this.details = options.details;
  }
}

export interface CreateTaskOptions {
  readonly root: string;
  readonly title: string;
  readonly description?: string;
  readonly name?: string;
  readonly creator?: string;
  readonly assignee?: string;
  readonly priority?: string;
  readonly relations?: readonly TaskRelation[];
  readonly now?: Date;
}

export interface TaskRecordResult {
  readonly root: string;
  readonly path: string;
  readonly archived: boolean;
  readonly revision: number;
  readonly relations: readonly TaskRelation[];
  readonly task: TaskEnvelope & { readonly status: TaskStatus };
  readonly prd: string;
  readonly handoff?: string;
}

export interface ShowTaskOptions {
  readonly root: string;
  readonly id: string;
}

export interface ListTasksOptions {
  readonly root: string;
  readonly status?: TaskStatus;
  readonly archived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TaskListEntry {
  readonly id: string;
  readonly path: string;
  readonly archived: boolean;
  readonly valid: boolean;
  readonly title?: string;
  readonly name?: string;
  readonly status?: TaskStatus;
  readonly revision?: number;
  readonly issues: readonly TaskValidationIssue[];
}

export interface ListTasksResult {
  readonly root: string;
  readonly tasks: readonly TaskListEntry[];
  readonly issues: readonly TaskValidationEntry[];
  readonly next_cursor?: string;
}

export interface UpdateTaskStatusOptions {
  readonly root: string;
  readonly id: string;
  readonly status: TaskStatus | string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}

export interface CheckpointTaskOptions {
  readonly root: string;
  readonly id: string;
  readonly handoff: string;
  readonly expectedRevision?: number;
}

export interface FinishTaskOptions {
  readonly root: string;
  readonly id: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}

export interface ArchiveTaskOptions {
  readonly root: string;
  readonly id: string;
}

export interface BindTaskOptions {
  readonly root: string;
  readonly contextKey: string;
  readonly id: string;
  readonly rebind?: boolean;
}

export interface ClearTaskContextOptions {
  readonly root: string;
  readonly contextKey: string;
}

export interface CurrentTaskOptions {
  readonly root: string;
  readonly id?: string;
  readonly contextKey?: string;
}

export type CurrentTaskResult =
  | { readonly root: string; readonly status: "none" }
  | ({ readonly status: "current"; readonly context_key?: string } & TaskRecordResult);

export interface TaskContextResult {
  readonly root: string;
  readonly context_key: string;
  readonly task_id?: string;
}

export interface SetTaskRelationsOptions {
  readonly root: string;
  readonly id: string;
  readonly relations: readonly TaskRelation[];
  readonly expectedRevision?: number;
}

export interface ValidateTasksOptions {
  readonly root: string;
  readonly id?: string;
  readonly includeArchived?: boolean;
}

export interface TaskValidationIssue {
  readonly code: TaskErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface TaskValidationEntry {
  readonly id: string;
  readonly path: string;
  readonly archived: boolean;
  readonly valid: boolean;
  readonly status?: TaskStatus;
  readonly issues: readonly TaskValidationIssue[];
}

export interface ValidateTasksResult {
  readonly root: string;
  readonly valid: boolean;
  readonly tasks: readonly TaskValidationEntry[];
  readonly context_issues: readonly TaskValidationIssue[];
  readonly context_path: string;
}

interface TaskLocation {
  readonly root: string;
  readonly directory: string;
  readonly archiveDirectory: string;
  readonly contextsFile: string;
  readonly locksDirectory: string;
}

interface RawTask {
  readonly record: TaskEnvelope;
  readonly raw: Record<string, unknown>;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly relations: readonly TaskRelation[];
}

interface LocatedTask {
  readonly directory: string;
  readonly archived: boolean;
}

interface ContextFile {
  readonly version: 1;
  readonly bindings: Record<string, string>;
}

interface CheckpointTransaction {
  readonly version: 1;
  readonly task_id: string;
  readonly base_revision: number;
  readonly target_revision: number;
  readonly old_handoff: string | null;
  readonly new_handoff: string;
  readonly old_task_json: string;
  readonly new_task_json: string;
}

class SimulatedTaskCrash extends Error {}

const STATUS_ALIASES: Readonly<Record<string, TaskStatus>> = {
  active: "active",
  planning: "active",
  in_progress: "active",
  review: "active",
  open: "active",
  paused: "paused",
  done: "done",
  completed: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
  superseded: "superseded",
};

function normalizeStatus(value: string): TaskStatus {
  const status = STATUS_ALIASES[value];
  if (!status) {
    throw new TaskError("TASK_INVALID", `unknown task status: ${value}`, {
      details: { status: value },
    });
  }
  return status;
}

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled" || status === "superseded";
}

function assertTaskId(id: string): string {
  if (!isReadableId("task", id)) {
    throw new TaskError("TASK_ID_INVALID", `invalid task id: ${id}`, {
      details: { id },
    });
  }
  return id;
}

function assertContextKey(contextKey: string): string {
  const hasControlCharacter = [...contextKey].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (contextKey.length === 0 || contextKey.length > 512 || hasControlCharacter) {
    throw new TaskError(
      "TASK_CONTEXT_INVALID",
      "task context key must be 1-512 printable characters",
    );
  }
  return contextKey;
}

function assertRevision(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) {
    throw new TaskError(
      "TASK_REVISION_CONFLICT",
      `task revision changed: expected ${expected}, found ${current}`,
      { details: { expected_revision: expected, actual_revision: current } },
    );
  }
}

function taskErrorFrom(error: unknown, fallback = "task storage operation failed"): TaskError {
  if (error instanceof TaskError) return error;
  if (error instanceof TaskInvalidEncodingError) {
    return new TaskError("TASK_INVALID_ENCODING", error.message, {
      cause: error,
      details: { target: error.target },
    });
  }
  if (error instanceof TaskLockUnavailableError) {
    return new TaskError("TASK_CONFLICT", error.message, {
      cause: error,
      details: { target: error.target },
    });
  }
  if (error instanceof TaskStorageBoundaryError) {
    return new TaskError("TASK_STORAGE_BOUNDARY", error.message, {
      cause: error,
      details: { target: error.target },
    });
  }
  return new TaskError("TASK_IO_ERROR", fallback, {
    cause: error,
  });
}

function throwStorage(error: unknown): never {
  throw taskErrorFrom(error);
}

async function taskLocation(rootInput: string): Promise<TaskLocation> {
  const root = path.resolve(rootInput);
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new TaskError("WORKSPACE_NOT_FOUND", `No Assay manifest found at ${root}.`, {
      details: { root },
    });
  }
  const layout = resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
  const directory = path.join(root, workspaceWorkRelativePath(layout, "tasks"));
  const archiveDirectory = path.join(directory, "archive");
  const contextsFile = path.join(root, layout.state_root, "task-contexts.json");
  const locksDirectory = path.join(root, layout.state_root, "task-locks");
  try {
    await assertTaskStorageBoundary(root, directory);
    await assertTaskStorageBoundary(root, contextsFile);
    await assertTaskStorageBoundary(root, locksDirectory);
  } catch (error) {
    throwStorage(error);
  }
  return { root, directory, archiveDirectory, contextsFile, locksDirectory };
}

function taskDirectory(location: TaskLocation, id: string, archived: boolean): string {
  return path.join(archived ? location.archiveDirectory : location.directory, assertTaskId(id));
}

function displayPath(location: TaskLocation, target: string): string {
  return path.relative(location.root, target).split(path.sep).join("/");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function locateTask(location: TaskLocation, idInput: string): Promise<LocatedTask> {
  const id = assertTaskId(idInput);
  const live = taskDirectory(location, id, false);
  const archived = taskDirectory(location, id, true);
  const [hasLive, hasArchived] = await Promise.all([pathExists(live), pathExists(archived)]);
  if (hasLive && hasArchived) {
    throw new TaskError("TASK_CONFLICT", `task exists in both live and archive storage: ${id}`, {
      details: { id },
    });
  }
  if (!hasLive && !hasArchived) {
    throw new TaskError("TASK_NOT_FOUND", `task not found: ${id}`, {
      details: { id },
    });
  }
  return { directory: hasLive ? live : archived, archived: hasArchived };
}

async function readBoundedText(
  location: TaskLocation,
  file: string,
  required: boolean,
  maxBytes = MAX_TASK_FILE_BYTES,
): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) {
      return undefined;
    }
    throw error;
  }
  if (info.size > maxBytes) {
    throw new TaskError("TASK_INVALID", `task file exceeds ${maxBytes} bytes`, {
      details: { path: displayPath(location, file) },
    });
  }
  return readTaskText(location.root, file);
}

function parseRelations(meta: Record<string, unknown>): readonly TaskRelation[] {
  const assay = meta.assay;
  if (assay === undefined) return [];
  if (!isJsonObject(assay)) {
    throw new TaskError("TASK_INVALID", "task.meta.assay must be an object");
  }
  const value = assay.relations;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TaskError("TASK_RELATION_INVALID", "task.meta.assay.relations must be an array");
  }
  return value.map((relation, index) => {
    if (
      !isJsonObject(relation) ||
      typeof relation.type !== "string" ||
      !TASK_RELATION_TYPES.includes(relation.type as TaskRelationType) ||
      typeof relation.task_id !== "string"
    ) {
      throw new TaskError("TASK_RELATION_INVALID", `invalid task relation at index ${index}`);
    }
    return {
      type: relation.type as TaskRelationType,
      task_id: assertTaskId(relation.task_id),
    };
  });
}

function parseRevision(meta: Record<string, unknown>): number {
  const assay = meta.assay;
  if (assay === undefined) return 0;
  if (!isJsonObject(assay)) {
    throw new TaskError("TASK_INVALID", "task.meta.assay must be an object");
  }
  const revision = assay.revision;
  if (revision === undefined) return 0;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new TaskError(
      "TASK_INVALID",
      "task.meta.assay.revision must be a non-negative safe integer",
    );
  }
  return revision as number;
}

function parseRawTask(value: unknown): RawTask {
  if (!isJsonObject(value)) {
    throw new TaskError("TASK_INVALID", "task.json must contain an object");
  }
  const parsed = taskEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskError("TASK_INVALID", parsed.error.message, {
      cause: parsed.error,
    });
  }
  return {
    record: parsed.data,
    raw: value,
    status: normalizeStatus(parsed.data.status),
    revision: parseRevision(parsed.data.meta),
    relations: parseRelations(parsed.data.meta),
  };
}

function validateHandoff(markdown: string): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let previous = -1;
  for (const heading of TASK_HANDOFF_HEADINGS) {
    const index = lines.indexOf(heading);
    if (index < 0 || index <= previous) {
      throw new TaskError(
        "TASK_INVALID",
        `handoff.md must contain the required Assay heading in order: ${heading}`,
        { details: { heading } },
      );
    }
    previous = index;
  }
}

const TASK_DIRECTORY_ENTRIES = new Set([
  "task.json",
  "prd.md",
  "handoff.md",
  "design.md",
  "research",
  CHECKPOINT_TRANSACTION_FILE,
]);

function checkpointTransactionPath(directory: string): string {
  return path.join(directory, CHECKPOINT_TRANSACTION_FILE);
}

async function runTransactionProbe(stage: TaskTransactionProbeStage, id: string): Promise<void> {
  if ((await transactionProbe?.(stage, id)) === "crash") {
    throw new SimulatedTaskCrash(`simulated task process crash at ${stage}`);
  }
}

function parseCheckpointTransaction(value: unknown, expectedId: string): CheckpointTransaction {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    value.task_id !== expectedId ||
    !Number.isSafeInteger(value.base_revision) ||
    !Number.isSafeInteger(value.target_revision) ||
    value.target_revision !== (value.base_revision as number) + 1 ||
    (value.old_handoff !== null && typeof value.old_handoff !== "string") ||
    typeof value.new_handoff !== "string" ||
    typeof value.old_task_json !== "string" ||
    typeof value.new_task_json !== "string"
  ) {
    throw new TaskError("TASK_INVALID", `checkpoint transaction is invalid for task ${expectedId}`);
  }
  return value as unknown as CheckpointTransaction;
}

async function readCheckpointTransaction(
  location: TaskLocation,
  located: LocatedTask,
  id: string,
): Promise<CheckpointTransaction | undefined> {
  const file = checkpointTransactionPath(located.directory);
  const text = await readBoundedText(location, file, false, MAX_TASK_FILE_BYTES * 4 + 4096);
  if (text === undefined) return undefined;
  try {
    return parseCheckpointTransaction(JSON.parse(text) as unknown, id);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TaskError("TASK_INVALID", `checkpoint transaction is not valid JSON: ${id}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function rawTaskAtDirectory(
  location: TaskLocation,
  located: LocatedTask,
  id: string,
): Promise<RawTask> {
  const text = await readBoundedText(location, path.join(located.directory, "task.json"), true);
  if (text === undefined) {
    throw new TaskError("TASK_INVALID", `task is missing task.json: ${id}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TaskError("TASK_INVALID", `task.json is not valid JSON: ${id}`, {
      cause: error,
    });
  }
  const raw = parseRawTask(value);
  if (raw.record.id !== id) {
    throw new TaskError("TASK_INVALID", `task id does not match its directory: ${id}`, {
      details: { directory_id: id, record_id: raw.record.id },
    });
  }
  return raw;
}

async function restoreHandoff(
  location: TaskLocation,
  located: LocatedTask,
  value: string | null,
): Promise<void> {
  const handoffFile = path.join(located.directory, "handoff.md");
  if (value === null) {
    await removeTaskFile(location.root, handoffFile);
  } else {
    await atomicWriteTaskText(location.root, handoffFile, value);
  }
}

async function recoverCheckpointTransaction(
  location: TaskLocation,
  located: LocatedTask,
  id: string,
): Promise<void> {
  const transaction = await readCheckpointTransaction(location, located, id);
  if (transaction === undefined) return;
  const taskText = await readBoundedText(location, path.join(located.directory, "task.json"), true);
  if (taskText === undefined) {
    throw new TaskError("TASK_INVALID", `task is missing task.json: ${id}`);
  }
  const current = await rawTaskAtDirectory(location, located, id);
  if (current.revision === transaction.base_revision) {
    if (taskText !== transaction.old_task_json) {
      throw new TaskError("TASK_CONFLICT", `checkpoint base bytes do not match task ${id}`);
    }
    await restoreHandoff(location, located, transaction.old_handoff);
  } else if (current.revision === transaction.target_revision) {
    if (taskText !== transaction.new_task_json) {
      throw new TaskError("TASK_CONFLICT", `checkpoint target bytes do not match task ${id}`);
    }
    await restoreHandoff(location, located, transaction.new_handoff);
  } else {
    throw new TaskError(
      "TASK_CONFLICT",
      `checkpoint transaction revision does not match task ${id}`,
      {
        details: {
          task_revision: current.revision,
          base_revision: transaction.base_revision,
          target_revision: transaction.target_revision,
        },
      },
    );
  }
  await removeTaskFile(location.root, checkpointTransactionPath(located.directory));
}

async function assertOrdinaryTree(location: TaskLocation, directory: string): Promise<void> {
  await assertTaskStorageBoundary(location.root, directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new TaskError(
        "TASK_STORAGE_BOUNDARY",
        `task content must not contain a symlink, junction, or reparse point: ${displayPath(location, entryPath)}`,
      );
    }
    await assertTaskStorageBoundary(location.root, entryPath);
    if (info.isDirectory()) await assertOrdinaryTree(location, entryPath);
    else if (!info.isFile()) {
      throw new TaskError(
        "TASK_STORAGE_BOUNDARY",
        `task content must be a regular file: ${displayPath(location, entryPath)}`,
      );
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      await readTaskText(location.root, entryPath);
    }
  }
}

async function assertTaskDirectoryShape(location: TaskLocation, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!TASK_DIRECTORY_ENTRIES.has(entry.name)) {
      throw new TaskError(
        "TASK_INVALID",
        `unexpected task entry: ${displayPath(location, path.join(directory, entry.name))}`,
      );
    }
    const entryPath = path.join(directory, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new TaskError(
        "TASK_STORAGE_BOUNDARY",
        `task content must not contain a symlink, junction, or reparse point: ${displayPath(location, entryPath)}`,
      );
    }
    if (entry.name === "research") {
      if (!info.isDirectory()) {
        throw new TaskError("TASK_INVALID", "task research entry must be a directory");
      }
      await assertOrdinaryTree(location, entryPath);
    } else if (!info.isFile()) {
      throw new TaskError(
        "TASK_INVALID",
        `task Markdown/envelope entry must be a regular file: ${entry.name}`,
      );
    } else if (entry.name.endsWith(".md")) {
      await readTaskText(location.root, entryPath);
    }
  }
}

async function readTaskAt(
  location: TaskLocation,
  located: LocatedTask,
  expectedId: string,
): Promise<TaskRecordResult> {
  try {
    await assertTaskStorageBoundary(location.root, located.directory);
    const info = await lstat(located.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TaskStorageBoundaryError(located.directory, "task entry is not a real directory");
    }
    const taskText = await readBoundedText(
      location,
      path.join(located.directory, "task.json"),
      true,
    );
    const prd = await readBoundedText(location, path.join(located.directory, "prd.md"), true);
    const handoff = await readBoundedText(
      location,
      path.join(located.directory, "handoff.md"),
      false,
    );
    if (taskText === undefined || prd === undefined) {
      throw new TaskError("TASK_INVALID", `task ${expectedId} is missing required files`);
    }
    let json: unknown;
    try {
      json = JSON.parse(taskText) as unknown;
    } catch (error) {
      throw new TaskError("TASK_INVALID", `task.json is not valid JSON: ${expectedId}`, {
        cause: error,
      });
    }
    const raw = parseRawTask(json);
    if (raw.record.id !== expectedId) {
      throw new TaskError("TASK_INVALID", `task id does not match its directory: ${expectedId}`, {
        details: { directory_id: expectedId, record_id: raw.record.id },
      });
    }
    if (handoff !== undefined) validateHandoff(handoff);
    return {
      root: location.root,
      path: displayPath(location, located.directory),
      archived: located.archived,
      revision: raw.revision,
      relations: raw.relations,
      task: { ...raw.record, status: raw.status },
      prd,
      ...(handoff === undefined ? {} : { handoff }),
    };
  } catch (error) {
    throwStorage(error);
  }
}

async function readRawLocated(
  location: TaskLocation,
  id: string,
): Promise<{ located: LocatedTask; raw: RawTask }> {
  const located = await locateTask(location, id);
  return { located, raw: await rawTaskAtDirectory(location, located, id) };
}

function recordWithAssay(
  raw: RawTask,
  updates: Partial<TaskEnvelope>,
  relations: readonly TaskRelation[] = raw.relations,
): Record<string, unknown> {
  const previousAssay = isJsonObject(raw.record.meta.assay) ? raw.record.meta.assay : {};
  const meta = {
    ...raw.record.meta,
    assay: {
      ...previousAssay,
      record_version: "0.1",
      revision: raw.revision + 1,
      relations: relations.map((relation) => ({ ...relation })),
    },
  };
  const canonical: TaskEnvelope = {
    ...raw.record,
    ...updates,
    meta,
  };
  const output: Record<string, unknown> = {};
  for (const field of TASK_ENVELOPE_KEYS) output[field] = canonical[field];
  for (const [key, value] of Object.entries(raw.raw)) {
    if (!Object.hasOwn(output, key)) output[key] = value;
  }
  return output;
}

function renderTaskJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slugify(title: string): string {
  const slug = readableIdSlug(title, 64);
  return slug || "task";
}

function normalizeRelations(
  id: string,
  relations: readonly TaskRelation[],
): readonly TaskRelation[] {
  const seen = new Set<string>();
  return relations.map((relation, index) => {
    if (!TASK_RELATION_TYPES.includes(relation.type)) {
      throw new TaskError(
        "TASK_RELATION_INVALID",
        `invalid relation type at index ${index}: ${String(relation.type)}`,
      );
    }
    const target = assertTaskId(relation.task_id);
    if (target === id) {
      throw new TaskError("TASK_RELATION_INVALID", `task relation cannot target itself: ${id}`);
    }
    const key = `${relation.type}\u0000${target}`;
    if (seen.has(key)) {
      throw new TaskError(
        "TASK_RELATION_INVALID",
        `duplicate task relation: ${relation.type} ${target}`,
      );
    }
    seen.add(key);
    return { type: relation.type, task_id: target };
  });
}

async function assertRelationsAcyclic(
  location: TaskLocation,
  sourceId: string,
  relationsInput: readonly TaskRelation[],
): Promise<readonly TaskRelation[]> {
  const relations = normalizeRelations(sourceId, relationsInput);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = async (id: string): Promise<void> => {
    if (id === sourceId) {
      throw new TaskError(
        "TASK_RELATION_CYCLE",
        `task relations would create a lineage cycle through ${sourceId}`,
        { details: { strategy: "reject-all-directed-cycles" } },
      );
    }
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      // Historical cycles not involving the source are malformed but cannot be
      // repaired by writing a third task. Reject conservatively.
      throw new TaskError("TASK_RELATION_CYCLE", `task relation graph contains a cycle at ${id}`, {
        details: { strategy: "reject-all-directed-cycles" },
      });
    }
    visiting.add(id);
    const { raw } = await readRawLocated(location, id);
    for (const relation of raw.relations) await visit(relation.task_id);
    visiting.delete(id);
    visited.add(id);
  };
  for (const relation of relations) await visit(relation.task_id);
  return relations;
}

function taskLockDirectory(location: TaskLocation, id: string): string {
  return path.join(location.locksDirectory, assertTaskId(id));
}

function relationLockDirectory(location: TaskLocation): string {
  return path.join(location.locksDirectory, ".relations");
}

async function storedTaskIds(location: TaskLocation): Promise<string[]> {
  const [live, archived] = await Promise.all([
    listTaskDirectories(location.root, location.directory),
    listTaskDirectories(location.root, location.archiveDirectory),
  ]);
  return [...live, ...archived].map((entry) => entry.name);
}

async function writeMutation(
  location: TaskLocation,
  id: string,
  expectedRevision: number | undefined,
  update: (raw: RawTask) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<TaskRecordResult> {
  return withTaskLock(location.root, taskLockDirectory(location, id), async () => {
    const located = await locateTask(location, id);
    await recoverCheckpointTransaction(location, located, id);
    const raw = await rawTaskAtDirectory(location, located, id);
    if (located.archived) {
      throw new TaskError("TASK_TERMINAL", `archived task cannot be changed: ${id}`);
    }
    assertRevision(raw.revision, expectedRevision);
    const output = await update(raw);
    await atomicWriteTaskText(
      location.root,
      path.join(located.directory, "task.json"),
      renderTaskJson(output),
    );
    return readTaskAt(location, located, id);
  }).catch(throwStorage);
}

export async function createTask(options: CreateTaskOptions): Promise<TaskRecordResult> {
  const title = options.title.trim();
  if (title.length === 0) {
    throw new TaskError("TASK_INVALID", "task title must not be empty");
  }
  const location = await taskLocation(options.root);
  // Allocation and initial relation validation share the global graph/create
  // lock. This makes max(live + archive) + 1 safe across concurrent creators.
  return withTaskLock(location.root, relationLockDirectory(location), async () => {
    let id: string;
    try {
      id = allocateReadableId("task", title, await storedTaskIds(location));
    } catch (error) {
      throw new TaskError("TASK_INVALID", "task id allocation failed", { cause: error });
    }
    return withTaskLock(location.root, taskLockDirectory(location, id), async () => {
      const live = taskDirectory(location, id, false);
      const archived = taskDirectory(location, id, true);
      if ((await pathExists(live)) || (await pathExists(archived))) {
        throw new TaskError("TASK_ALREADY_EXISTS", `task already exists: ${id}`);
      }
      const relationInput = options.relations ?? [];
      const relations =
        relationInput.length === 0 ? [] : await assertRelationsAcyclic(location, id, relationInput);
      const date = (options.now ?? new Date()).toISOString().slice(0, 10);
      const record = newTaskEnvelope({
        id,
        name: options.name?.trim() || slugify(title),
        title,
        description: options.description?.trim() ?? "",
        status: "active",
        priority: options.priority?.trim() || "P2",
        creator: options.creator?.trim() ?? "",
        assignee: options.assignee?.trim() ?? "",
        createdAt: date,
        meta: {
          assay: {
            record_version: "0.1",
            revision: 0,
            relations: relations.map((relation) => ({ ...relation })),
          },
        },
      });
      await mkdir(location.directory, { recursive: true });
      await assertTaskStorageBoundary(location.root, location.directory);
      const temporary = path.join(location.directory, `.create-${id}-${randomUUID()}`);
      try {
        await mkdir(temporary, { recursive: false });
        await atomicWriteTaskText(
          location.root,
          path.join(temporary, "task.json"),
          renderTaskJson(record as unknown as Record<string, unknown>),
        );
        await atomicWriteTaskText(
          location.root,
          path.join(temporary, "prd.md"),
          renderTaskPrd(title, options.description),
        );
        await rename(temporary, live);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
      return readTaskAt(location, { directory: live, archived: false }, id);
    });
  }).catch(throwStorage);
}

export async function showTask(options: ShowTaskOptions): Promise<TaskRecordResult> {
  const location = await taskLocation(options.root);
  const id = assertTaskId(options.id);
  return withTaskLock(location.root, taskLockDirectory(location, id), async () => {
    const located = await locateTask(location, id);
    await recoverCheckpointTransaction(location, located, id);
    return readTaskAt(location, located, id);
  }).catch(throwStorage);
}

async function validationForEntry(
  location: TaskLocation,
  entry: Dirent,
  archived: boolean,
): Promise<TaskValidationEntry> {
  const id = entry.name;
  const directory = path.join(archived ? location.archiveDirectory : location.directory, id);
  const relative = displayPath(location, directory);
  try {
    assertTaskId(id);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new TaskError("TASK_STORAGE_BOUNDARY", "task entry is not a real directory");
    }
    const task = await withTaskLock(location.root, taskLockDirectory(location, id), async () => {
      const located = { directory, archived };
      await recoverCheckpointTransaction(location, located, id);
      await assertTaskDirectoryShape(location, directory);
      return readTaskAt(location, located, id);
    });
    await assertRelationsAcyclic(location, id, task.relations);
    return {
      id,
      path: relative,
      archived,
      valid: true,
      status: task.task.status,
      issues: [],
    };
  } catch (error) {
    const taskError = taskErrorFrom(error, "task validation failed");
    return {
      id,
      path: relative,
      archived,
      valid: false,
      issues: [{ code: taskError.code, message: taskError.message }],
    };
  }
}

async function allValidationEntries(
  location: TaskLocation,
  includeArchived: boolean,
): Promise<TaskValidationEntry[]> {
  const live = await listTaskDirectories(location.root, location.directory);
  const archived = includeArchived
    ? await listTaskDirectories(location.root, location.archiveDirectory)
    : [];
  if (live.length + archived.length > MAX_TASK_RECORDS) {
    throw new TaskError("TASK_INVALID", `task storage exceeds ${MAX_TASK_RECORDS} records`);
  }
  const results: TaskValidationEntry[] = [];
  for (const entry of live) {
    results.push(await validationForEntry(location, entry, false));
  }
  for (const entry of archived) {
    results.push(await validationForEntry(location, entry, true));
  }
  const locationsById = new Map<string, TaskValidationEntry[]>();
  for (const result of results) {
    const matching = locationsById.get(result.id) ?? [];
    matching.push(result);
    locationsById.set(result.id, matching);
  }
  for (const [id, matching] of locationsById) {
    if (matching.length < 2) continue;
    for (const conflict of matching) {
      const index = results.indexOf(conflict);
      const { status: _status, ...withoutStatus } = conflict;
      results[index] = {
        ...withoutStatus,
        valid: false,
        issues: [
          ...conflict.issues,
          {
            code: "TASK_CONFLICT",
            message: `task exists in both live and archive storage: ${id}`,
          },
        ],
      };
    }
  }
  return results.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || Number(left.archived) - Number(right.archived),
  );
}

export async function listTasks(options: ListTasksOptions): Promise<ListTasksResult> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new TaskError("TASK_INVALID", `task list limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const status = options.status === undefined ? undefined : normalizeStatus(options.status);
  if (options.cursor !== undefined) assertTaskId(options.cursor);
  const location = await taskLocation(options.root);
  const validation = await allValidationEntries(location, true);
  const issues = validation.filter((entry) => !entry.valid);
  const afterCursor = validation.filter(
    (entry) =>
      entry.valid &&
      (options.archived === true || !entry.archived) &&
      (options.cursor === undefined || entry.id > options.cursor),
  );
  const matching: TaskListEntry[] = [];
  for (const entry of afterCursor) {
    const task = await showTask({ root: location.root, id: entry.id });
    if (status !== undefined && task.task.status !== status) continue;
    matching.push({
      ...entry,
      title: task.task.title,
      name: task.task.name,
      status: task.task.status,
      revision: task.revision,
    });
  }
  const page = matching.slice(0, limit);
  const last = page.at(-1);
  return {
    root: location.root,
    tasks: page,
    issues,
    ...(matching.length > page.length && last !== undefined ? { next_cursor: last.id } : {}),
  };
}

export async function updateTaskStatus(
  options: UpdateTaskStatusOptions,
): Promise<TaskRecordResult> {
  const status = normalizeStatus(options.status);
  const location = await taskLocation(options.root);
  return writeMutation(location, options.id, options.expectedRevision, (raw) => {
    if (isTerminal(raw.status) && status !== raw.status) {
      throw new TaskError("TASK_TERMINAL", `terminal task cannot change status: ${options.id}`, {
        details: { status: raw.status },
      });
    }
    const completedAt = isTerminal(status)
      ? (raw.record.completedAt ?? (options.now ?? new Date()).toISOString().slice(0, 10))
      : null;
    return recordWithAssay(raw, { status, completedAt });
  });
}

export async function checkpointTask(options: CheckpointTaskOptions): Promise<TaskRecordResult> {
  validateHandoff(options.handoff);
  const location = await taskLocation(options.root);
  return withTaskLock(location.root, taskLockDirectory(location, options.id), async () => {
    const id = assertTaskId(options.id);
    const located = await locateTask(location, id);
    await recoverCheckpointTransaction(location, located, id);
    const raw = await rawTaskAtDirectory(location, located, id);
    if (located.archived) {
      throw new TaskError("TASK_TERMINAL", `archived task cannot be checkpointed: ${id}`);
    }
    assertRevision(raw.revision, options.expectedRevision);
    const oldHandoff = await readBoundedText(
      location,
      path.join(located.directory, "handoff.md"),
      false,
    );
    const oldTaskJson = await readBoundedText(
      location,
      path.join(located.directory, "task.json"),
      true,
    );
    if (oldTaskJson === undefined) {
      throw new TaskError("TASK_INVALID", `task is missing task.json: ${id}`);
    }
    const newTaskJson = renderTaskJson(recordWithAssay(raw, {}));
    const transaction: CheckpointTransaction = {
      version: 1,
      task_id: id,
      base_revision: raw.revision,
      target_revision: raw.revision + 1,
      old_handoff: oldHandoff ?? null,
      new_handoff: options.handoff,
      old_task_json: oldTaskJson,
      new_task_json: newTaskJson,
    };
    let prepared = false;
    try {
      await atomicWriteTaskText(
        location.root,
        checkpointTransactionPath(located.directory),
        renderTaskJson(transaction as unknown as Record<string, unknown>),
      );
      prepared = true;
      await runTransactionProbe("after-prepare", id);
      await atomicWriteTaskText(
        location.root,
        path.join(located.directory, "handoff.md"),
        options.handoff,
      );
      await runTransactionProbe("after-handoff", id);
      await atomicWriteTaskText(
        location.root,
        path.join(located.directory, "task.json"),
        newTaskJson,
      );
      await runTransactionProbe("after-task", id);
      await removeTaskFile(location.root, checkpointTransactionPath(located.directory));
      return readTaskAt(location, located, id);
    } catch (error) {
      if (error instanceof SimulatedTaskCrash) throw error;
      if (prepared) await recoverCheckpointTransaction(location, located, id);
      throw error;
    }
  }).catch(throwStorage);
}

export async function finishTask(options: FinishTaskOptions): Promise<TaskRecordResult> {
  return updateTaskStatus({
    ...options,
    status: "done",
  });
}

export async function archiveTask(options: ArchiveTaskOptions): Promise<TaskRecordResult> {
  const location = await taskLocation(options.root);
  const id = assertTaskId(options.id);
  return withTaskLock(location.root, relationLockDirectory(location), () =>
    withTaskLock(location.root, taskLockDirectory(location, id), async () => {
      const live = taskDirectory(location, id, false);
      const archived = taskDirectory(location, id, true);
      const [hasLive, hasArchived] = await Promise.all([pathExists(live), pathExists(archived)]);
      if (hasLive && hasArchived) {
        throw new TaskError("TASK_CONFLICT", `task exists in both live and archive storage: ${id}`);
      }
      if (hasArchived) {
        return readTaskAt(location, { directory: archived, archived: true }, id);
      }
      if (!hasLive) {
        throw new TaskError("TASK_NOT_FOUND", `task not found: ${id}`);
      }
      await recoverCheckpointTransaction(location, { directory: live, archived: false }, id);
      const current = await readTaskAt(location, { directory: live, archived: false }, id);
      await assertTaskDirectoryShape(location, live);
      if (!isTerminal(current.task.status)) {
        throw new TaskError("TASK_NOT_TERMINAL", `only terminal tasks can be archived: ${id}`);
      }
      await archiveProbe?.(id);
      await mkdir(location.archiveDirectory, { recursive: true });
      if (await pathExists(archived)) {
        throw new TaskError("TASK_ALREADY_EXISTS", `archive target already exists: ${id}`);
      }
      await rename(live, archived);
      return readTaskAt(location, { directory: archived, archived: true }, id);
    }),
  ).catch(throwStorage);
}

async function readContexts(location: TaskLocation): Promise<ContextFile> {
  let text: string;
  try {
    text = await readTaskText(location.root, location.contextsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, bindings: {} };
    }
    throwStorage(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TaskError("TASK_CONTEXT_INVALID", "task context bindings are not valid JSON", {
      cause: error,
    });
  }
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !isJsonObject(value.bindings) ||
    Object.values(value.bindings).some((id) => typeof id !== "string")
  ) {
    throw new TaskError("TASK_CONTEXT_INVALID", "task context bindings have an invalid shape");
  }
  for (const id of Object.values(value.bindings)) assertTaskId(id as string);
  return {
    version: 1,
    bindings: { ...(value.bindings as Record<string, string>) },
  };
}

function contextLockDirectory(location: TaskLocation): string {
  return path.join(path.dirname(location.contextsFile), ".task-context.lock");
}

async function writeContexts(location: TaskLocation, contexts: ContextFile): Promise<void> {
  await atomicWriteTaskText(
    location.root,
    location.contextsFile,
    `${JSON.stringify(contexts, null, 2)}\n`,
  );
}

export async function bindTask(options: BindTaskOptions): Promise<TaskContextResult> {
  const contextKey = assertContextKey(options.contextKey);
  const selected = await showTask({ root: options.root, id: options.id });
  const location = await taskLocation(selected.root);
  return withTaskLock(location.root, contextLockDirectory(location), async () => {
    const contexts = await readContexts(location);
    const existing = contexts.bindings[contextKey];
    if (existing !== undefined && existing !== selected.task.id && !options.rebind) {
      throw new TaskError(
        "TASK_CONTEXT_CONFLICT",
        `context is already bound to task ${existing}; explicit rebind is required`,
        { details: { context_key: contextKey, task_id: existing } },
      );
    }
    contexts.bindings[contextKey] = selected.task.id;
    await writeContexts(location, contexts);
    return {
      root: location.root,
      context_key: contextKey,
      task_id: selected.task.id,
    };
  }).catch(throwStorage);
}

export async function clearTaskContext(
  options: ClearTaskContextOptions,
): Promise<TaskContextResult> {
  const contextKey = assertContextKey(options.contextKey);
  const location = await taskLocation(options.root);
  return withTaskLock(location.root, contextLockDirectory(location), async () => {
    const contexts = await readContexts(location);
    delete contexts.bindings[contextKey];
    await writeContexts(location, contexts);
    return { root: location.root, context_key: contextKey };
  }).catch(throwStorage);
}

export async function contextTask(options: CurrentTaskOptions): Promise<TaskContextResult> {
  const location = await taskLocation(options.root);
  if (options.id !== undefined) {
    const selected = await showTask({ root: location.root, id: options.id });
    return { root: location.root, context_key: "", task_id: selected.task.id };
  }
  if (options.contextKey === undefined) {
    return { root: location.root, context_key: "" };
  }
  const contextKey = assertContextKey(options.contextKey);
  const contexts = await readContexts(location);
  return {
    root: location.root,
    context_key: contextKey,
    ...(contexts.bindings[contextKey] === undefined
      ? {}
      : { task_id: contexts.bindings[contextKey] }),
  };
}

export async function currentTask(options: CurrentTaskOptions): Promise<CurrentTaskResult> {
  const location = await taskLocation(options.root);
  if (options.id !== undefined) {
    const selected = await showTask({ root: location.root, id: options.id });
    return { status: "current", ...selected };
  }
  if (options.contextKey === undefined) {
    return { root: location.root, status: "none" };
  }
  const contextKey = assertContextKey(options.contextKey);
  const contexts = await readContexts(location);
  const id = contexts.bindings[contextKey];
  if (id === undefined) return { root: location.root, status: "none" };
  const selected = await showTask({ root: location.root, id });
  return { status: "current", context_key: contextKey, ...selected };
}

export async function setTaskRelations(
  options: SetTaskRelationsOptions,
): Promise<TaskRecordResult> {
  const location = await taskLocation(options.root);
  return withTaskLock(location.root, relationLockDirectory(location), () =>
    writeMutation(location, options.id, options.expectedRevision, async (raw) => {
      const relations = await assertRelationsAcyclic(location, options.id, options.relations);
      return recordWithAssay(raw, {}, relations);
    }),
  ).catch(throwStorage);
}

export async function validateTasks(options: ValidateTasksOptions): Promise<ValidateTasksResult> {
  const location = await taskLocation(options.root);
  if (options.id !== undefined) {
    const id = assertTaskId(options.id);
    try {
      const located = await locateTask(location, id);
      const info = await lstat(located.directory);
      const entry = {
        name: id,
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
      } as Dirent;
      const result = await validationForEntry(location, entry, located.archived);
      return {
        root: location.root,
        valid: result.valid,
        tasks: [result],
        context_issues: [],
        context_path: displayPath(location, location.contextsFile),
      };
    } catch (error) {
      const taskError = taskErrorFrom(error, "task validation failed");
      const result: TaskValidationEntry = {
        id,
        path: displayPath(location, taskDirectory(location, id, false)),
        archived: false,
        valid: false,
        issues: [{ code: taskError.code, message: taskError.message }],
      };
      return {
        root: location.root,
        valid: false,
        tasks: [result],
        context_issues: [],
        context_path: displayPath(location, location.contextsFile),
      };
    }
  }
  const tasks = await allValidationEntries(location, options.includeArchived ?? true);
  const contextIssues: TaskValidationIssue[] = [];
  try {
    const contexts = await readContexts(location);
    for (const [contextKey, id] of Object.entries(contexts.bindings)) {
      try {
        assertContextKey(contextKey);
        const located = await locateTask(location, assertTaskId(id));
        await readTaskAt(location, located, id);
      } catch (error) {
        const taskError = taskErrorFrom(error, "task context validation failed");
        contextIssues.push({
          code: taskError.code,
          message: `${contextKey}: ${taskError.message}`,
        });
      }
    }
  } catch (error) {
    const taskError = taskErrorFrom(error, "task context validation failed");
    contextIssues.push({ code: taskError.code, message: taskError.message });
  }
  return {
    root: location.root,
    valid: tasks.every((task) => task.valid) && contextIssues.length === 0,
    tasks,
    context_issues: contextIssues,
    context_path: displayPath(location, location.contextsFile),
  };
}
