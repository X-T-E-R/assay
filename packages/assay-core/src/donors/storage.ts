import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { MANAGED_DIR } from "../constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import { stringifySortedJson } from "../serialization.js";
import { withWorkspaceMutationCoordination } from "../tasks/task-storage.js";
import {
  type DonorAdoptionDefinition,
  type DonorDecision,
  type DonorEvidence,
  type DonorInspection,
  type DonorState,
  donorAdoptionDefinitionSchema,
  donorDecisionSchema,
  donorEvidenceSchema,
  donorIdSchema,
  donorInspectionSchema,
  donorStateSchema,
} from "./schemas.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function recordDigest(value: unknown): string {
  return createHash("sha256").update(stringifySortedJson(value), "utf8").digest("hex");
}

/**
 * A donor record file that could not be read or validated. Carries the file so
 * callers report the record that is actually damaged instead of blaming
 * `state.json`, which is usually intact.
 */
export class DonorRecordFileError extends FrameworkError {
  readonly file: string;

  constructor(file: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { ...options, code: "INVALID_DONOR" });
    this.name = "DonorRecordFileError";
    this.file = file;
  }
}

function expectedRecordId(prefix: string, value: unknown): string {
  return `${prefix}-${recordDigest(value).slice(0, 24)}`;
}

/**
 * Root directory for donor state: always `<root>/.assay/donors`.
 *
 * Donor records are Assay-owned state, like the event log and systems registry,
 * systems registry, all of which address `.assay/` through the shared
 * constants rather than the layout path map. Every v4 layout — standalone and
 * overlay alike — puts state under `.assay/`, so using the constant costs
 * nothing and removes a whole failure mode: a manifest with a stale or
 * mis-derived `state_root` can no longer split donor records off from the rest
 * of the workspace state, where a partial copy would leave them behind and
 * `donor list` would report `(none)`.
 */
export async function donorWorkspaceRoot(root: string): Promise<string> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new FrameworkNotFoundError(`No Assay manifest found at ${root}.`);
  }
  return path.join(root, MANAGED_DIR, "donors");
}

export function assertDonorId(value: string): string {
  const result = donorIdSchema.safeParse(value);
  if (!result.success) {
    throw new FrameworkError(`invalid donor identifier '${value}'`, {
      code: "INVALID_DONOR",
      details: result.error.flatten(),
    });
  }
  return result.data;
}

export async function adoptionRoot(root: string, adoptionId: string): Promise<string> {
  const safeId = assertDonorId(adoptionId);
  return path.join(await donorWorkspaceRoot(root), safeId);
}

export async function readStructuredFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrameworkNotFoundError(`file not found: ${file}`);
    }
    throw error;
  }

  try {
    return file.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new FrameworkError(`file is not valid JSON or YAML: ${file}`, {
      code: "INVALID_DONOR",
      cause: error,
    });
  }
}

export function parseDonorValue<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  label: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new FrameworkError(`${label} failed validation`, {
      code: "INVALID_DONOR",
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
}

async function readJson<TSchema extends z.ZodTypeAny>(
  file: string,
  schema: TSchema,
  label: string,
): Promise<z.output<TSchema>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrameworkNotFoundError(`${label} not found: ${file}`);
    }
    throw new DonorRecordFileError(file, `${label} is not valid JSON: ${file}`, { cause: error });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DonorRecordFileError(file, `${label}: ${file} failed validation`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * True when `state.json` — directly or through a committed decision — attests
 * to the record stored in `file`. Committed records are history; anything else
 * on disk is a draft or the residue of an interrupted run.
 */
async function isCommittedRecordFile(file: string): Promise<boolean> {
  const kind = path.basename(path.dirname(file));
  const recordId = path.basename(file, ".json");
  const directory = path.dirname(path.dirname(file));
  const state = await readStateForCommitCheck(directory);
  if (!state) {
    return false;
  }
  if (kind === "decisions") {
    return state.decisions.includes(recordId);
  }
  if (
    kind === "definitions" &&
    (recordId === state.current_definition ||
      Object.values(state.targets).some(
        (target) => target.baseline?.definition_digest === recordId,
      ))
  ) {
    return true;
  }

  for (const decisionId of state.decisions) {
    const decision = await readDecisionForCommitCheck(directory, decisionId);
    if (!decision) continue;
    if (kind === "definitions" && decision.definition_digest === recordId) return true;
    if (kind === "inspections" && decision.inspection_id === recordId) return true;
    if (kind === "evidence" && decision.evidence_ids.includes(recordId)) return true;
  }
  return false;
}

async function readStateForCommitCheck(directory: string): Promise<DonorState | null> {
  try {
    return await readJson(stateFile(directory), donorStateSchema, "donor state");
  } catch {
    // No readable state means there is no committed history to protect.
    return null;
  }
}

async function readDecisionForCommitCheck(
  directory: string,
  decisionId: string,
): Promise<DonorDecision | null> {
  try {
    return await readJson(
      decisionFile(directory, decisionId),
      donorDecisionSchema,
      "donor decision",
    );
  } catch {
    return null;
  }
}

/**
 * Write a JSON record that must never be silently overwritten.
 *
 * The write goes through a temporary file and a rename so a process that dies
 * mid-write cannot leave a truncated record behind: readers see either the
 * previous state or the complete record. Exclusivity is preserved by checking
 * for the target first and by comparing content when it already exists.
 *
 * Returns true when this call produced the file (including a repaired one),
 * false when a byte-identical record was already present.
 */
export async function writeImmutableJson(file: string, value: unknown): Promise<boolean> {
  const content = stringifySortedJson(value);
  let existing: string | null;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    existing = null;
  }

  if (existing === content) {
    return false;
  }
  if (existing !== null && (await isCommittedRecordFile(file))) {
    // Committed history attests to these bytes. Rewriting them would rewrite
    // the record a decision already points at, so this stays an error.
    throw new FrameworkError(`content-addressed donor record collision: ${file}`, {
      code: "INVALID_DONOR",
    });
  }
  // Either the record is absent, or a partial/rejected record is present that
  // nothing in `state.json` references: an interrupted run's leftovers. The
  // record id is derived from the content being written, so the canonical
  // bytes are the ones we have here.
  await writeFileAtomically(file, content);
  return true;
}

export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomically(file, stringifySortedJson(value));
}

async function writeFileAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Grace period before a lock whose holder cannot be confirmed alive is treated
 * as abandoned. It covers the window between creating the lock file and writing
 * its payload, and the case of a lock written by another host or another user's
 * process, where liveness is unknowable from here.
 */
const LOCK_UNCONFIRMED_STALE_MS = 60_000;

/**
 * Age at which a lock is treated as abandoned even though its recorded pid is
 * alive. A donor operation takes seconds; a lock this old is either a crashed
 * run whose pid has since been reused by an unrelated process, or a hang. Both
 * would otherwise wedge the adoption permanently.
 */
const LOCK_MAX_AGE_MS = 15 * 60_000;

/** Approximate boot instant, used to detect pid values reused across reboots. */
function bootToken(): number {
  return Math.round((Date.now() - uptime() * 1000) / 1000);
}

interface AdoptionLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly boot: number;
  readonly owner: string;
  readonly acquired_at: string;
}

export interface DonorLockStatus {
  /** Absolute path of the lock file. */
  readonly file: string;
  readonly adoptionId: string;
  readonly pid: number | null;
  readonly host: string | null;
  readonly acquiredAt: string | null;
  readonly ageMs: number;
  /** True when the lock may be removed without interrupting a live operation. */
  readonly stale: boolean;
  readonly reason: string;
}

export async function withAdoptionLock<T>(
  root: string,
  adoptionId: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  return withWorkspaceMutationCoordination(root, async () => {
    const directory = await adoptionRoot(root, adoptionId);
    await mkdir(directory, { recursive: true });
    const lockFile = path.join(directory, ".lock");
    const payload: AdoptionLockPayload = {
      pid: process.pid,
      host: hostname(),
      boot: bootToken(),
      owner: randomUUID(),
      acquired_at: new Date().toISOString(),
    };
    const handle = await acquireAdoptionLock(lockFile, adoptionId);

    try {
      await handle.writeFile(stringifySortedJson(payload), "utf8");
      await handle.sync();
      return await operation(directory);
    } finally {
      await handle.close();
      await releaseOwnedLock(lockFile, payload.owner);
    }
  });
}

/**
 * Remove the lock only when it still carries our owner token. A lock judged
 * stale and taken over by another process must not be deleted from under it.
 */
async function releaseOwnedLock(lockFile: string, owner: string): Promise<void> {
  const current = await readLockPayload(lockFile);
  if (current !== null && current.owner !== owner) {
    return;
  }
  await rm(lockFile, { force: true });
}

async function readLockPayload(lockFile: string): Promise<AdoptionLockPayload | null> {
  let text: string;
  try {
    text = await readFile(lockFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    return null;
  }
  return {
    pid: record.pid,
    host: typeof record.host === "string" ? record.host : "",
    boot: typeof record.boot === "number" ? record.boot : Number.NaN,
    owner: typeof record.owner === "string" ? record.owner : "",
    acquired_at: typeof record.acquired_at === "string" ? record.acquired_at : "",
  };
}

/**
 * Decide whether an existing lock file may be taken over.
 *
 * Every branch that cannot prove the holder is alive resolves to stale after a
 * bounded wait, because the alternative — the previous behavior — was an
 * adoption that no command could ever unblock: an empty lock file waited an
 * hour, `process.kill` reporting EPERM waited forever, and a reused pid waited
 * forever.
 */
async function evaluateLock(lockFile: string, adoptionId: string): Promise<DonorLockStatus | null> {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const payload = await readLockPayload(lockFile);
  const base = {
    file: lockFile,
    adoptionId,
    pid: payload?.pid ?? null,
    host: payload && payload.host.length > 0 ? payload.host : null,
    acquiredAt: payload && payload.acquired_at.length > 0 ? payload.acquired_at : null,
    ageMs,
  };

  if (!payload) {
    return {
      ...base,
      stale: ageMs > LOCK_UNCONFIRMED_STALE_MS,
      reason: "lock file carries no usable owner record (interrupted acquisition)",
    };
  }
  if (payload.host !== hostname() || payload.boot !== bootToken()) {
    return {
      ...base,
      stale: ageMs > LOCK_UNCONFIRMED_STALE_MS,
      reason: "lock was taken by a process from another host or before the last reboot",
    };
  }

  let liveness: "alive" | "gone" | "unknown";
  try {
    process.kill(payload.pid, 0);
    liveness = "alive";
  } catch (error) {
    liveness = (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }

  if (liveness === "gone") {
    return { ...base, stale: true, reason: `holder process ${payload.pid} is no longer running` };
  }
  if (liveness === "unknown") {
    return {
      ...base,
      stale: ageMs > LOCK_UNCONFIRMED_STALE_MS,
      reason: `holder process ${payload.pid} cannot be signalled from this process`,
    };
  }
  return {
    ...base,
    stale: ageMs > LOCK_MAX_AGE_MS,
    reason:
      ageMs > LOCK_MAX_AGE_MS
        ? `lock is ${Math.round(ageMs / 60_000)} minutes old; pid ${payload.pid} is now an unrelated process or a hung run`
        : `held by process ${payload.pid}`,
  };
}

async function acquireAdoptionLock(lockFile: string, adoptionId: string): Promise<FileHandle> {
  try {
    return await open(lockFile, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const status = await evaluateLock(lockFile, adoptionId);
  if (status === null || status.stale) {
    if (status !== null) {
      await rm(lockFile, { force: true });
    }
    try {
      return await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Another process acquired the lock after the stale cleanup.
      throw busyError(adoptionId, "another process acquired the lock first");
    }
  }
  throw busyError(adoptionId, status.reason);
}

function busyError(adoptionId: string, reason: string): FrameworkError {
  return new FrameworkError(
    `donor adoption is busy: ${adoptionId} (${reason}). If no donor command is running, release the lock.`,
    { code: "DONOR_BUSY" },
  );
}

/** Report the current adoption lock, or null when the adoption is not locked. */
export async function inspectAdoptionLock(
  root: string,
  adoptionId: string,
): Promise<DonorLockStatus | null> {
  const directory = await adoptionRoot(root, adoptionId);
  return evaluateLock(path.join(directory, ".lock"), assertDonorId(adoptionId));
}

/**
 * Remove an adoption lock. Without `force` this refuses a lock that still
 * looks live, so the recovery path cannot be used to interrupt a running
 * operation.
 */
export async function releaseAdoptionLock(
  root: string,
  adoptionId: string,
  options: { readonly force?: boolean } = {},
): Promise<{ readonly released: boolean; readonly lock: DonorLockStatus | null }> {
  const lock = await inspectAdoptionLock(root, adoptionId);
  if (lock === null) {
    return { released: false, lock: null };
  }
  if (!lock.stale && options.force !== true) {
    throw busyError(adoptionId, `${lock.reason}; pass force to release it anyway`);
  }
  await rm(lock.file, { force: true });
  return { released: true, lock };
}

export function definitionFile(directory: string, digest: string): string {
  return path.join(directory, "definitions", `${digest}.json`);
}

export function inspectionFile(directory: string, inspectionId: string): string {
  return path.join(directory, "inspections", `${inspectionId}.json`);
}

export function evidenceFile(directory: string, evidenceId: string): string {
  return path.join(directory, "evidence", `${evidenceId}.json`);
}

export function decisionFile(directory: string, decisionId: string): string {
  return path.join(directory, "decisions", `${decisionId}.json`);
}

export function stateFile(directory: string): string {
  return path.join(directory, "state.json");
}

export async function readDonorState(root: string, adoptionId: string): Promise<DonorState> {
  const directory = await adoptionRoot(root, adoptionId);
  return readDonorStateFromDirectory(directory, adoptionId);
}

export async function readDonorStateFromDirectory(
  directory: string,
  adoptionId: string,
): Promise<DonorState> {
  const state = await readJson(
    stateFile(directory),
    donorStateSchema,
    `donor state '${adoptionId}'`,
  );
  if (state.adoption_id !== adoptionId) {
    throw new FrameworkError(
      `donor state identity mismatch: expected '${adoptionId}', found '${state.adoption_id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  return state;
}

export async function readDonorDefinition(
  root: string,
  adoptionId: string,
  digest?: string,
): Promise<{ readonly definition: DonorAdoptionDefinition; readonly digest: string }> {
  const directory = await adoptionRoot(root, adoptionId);
  const state = await readDonorStateFromDirectory(directory, adoptionId);
  const selected = digest ?? state.current_definition;
  const definition = await readJson(
    definitionFile(directory, selected),
    donorAdoptionDefinitionSchema,
    `donor definition '${adoptionId}'`,
  );
  if (recordDigest(definition) !== selected) {
    throw new FrameworkError(`donor definition digest mismatch: ${adoptionId}`, {
      code: "INVALID_DONOR",
    });
  }
  if (definition.id !== adoptionId) {
    throw new FrameworkError(
      `donor definition identity mismatch: expected '${adoptionId}', found '${definition.id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  return { definition, digest: selected };
}

export async function readDonorInspection(
  root: string,
  adoptionId: string,
  inspectionId: string,
): Promise<DonorInspection> {
  const directory = await adoptionRoot(root, adoptionId);
  const selectedId = assertDonorId(inspectionId);
  const inspection = await readJson(
    inspectionFile(directory, selectedId),
    donorInspectionSchema,
    `donor inspection '${inspectionId}'`,
  );
  if (inspection.id !== selectedId) {
    throw new FrameworkError(
      `donor inspection file identity mismatch: expected '${selectedId}', found '${inspection.id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  const { id, ...content } = inspection;
  if (expectedRecordId("inspection", content) !== id) {
    throw new FrameworkError(`donor inspection digest mismatch: ${inspectionId}`, {
      code: "INVALID_DONOR",
    });
  }
  if (inspection.adoption_id !== adoptionId) {
    throw new FrameworkError(
      `donor inspection identity mismatch: expected '${adoptionId}', found '${inspection.adoption_id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  return inspection;
}

export async function readDonorDecision(
  root: string,
  adoptionId: string,
  decisionId: string,
): Promise<DonorDecision> {
  const directory = await adoptionRoot(root, adoptionId);
  const selectedId = assertDonorId(decisionId);
  const decision = await readJson(
    decisionFile(directory, selectedId),
    donorDecisionSchema,
    `donor decision '${decisionId}'`,
  );
  if (decision.id !== selectedId) {
    throw new FrameworkError(
      `donor decision file identity mismatch: expected '${selectedId}', found '${decision.id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  const idInput = {
    adoption_id: decision.adoption_id,
    definition_digest: decision.definition_digest,
    target_id: decision.target_id,
    inspection_id: decision.inspection_id,
    outcome: decision.outcome,
    reason: decision.reason,
    evidence_ids: decision.evidence_ids,
    policy: decision.policy,
    baseline_before: decision.baseline_before,
    ...(decision.outcome === "rollback"
      ? { restored_from_decision: decision.restored_from_decision }
      : {}),
    state_generation: decision.state_generation,
    decided_at: decision.decided_at,
  };
  if (expectedRecordId("decision", idInput) !== decision.id) {
    throw new FrameworkError(`donor decision digest mismatch: ${decisionId}`, {
      code: "INVALID_DONOR",
    });
  }
  if (decision.adoption_id !== adoptionId) {
    throw new FrameworkError(
      `donor decision identity mismatch: expected '${adoptionId}', found '${decision.adoption_id}'`,
      { code: "INVALID_DONOR" },
    );
  }
  if (decision.baseline_after && decision.baseline_after.decision_id !== decision.id) {
    throw new FrameworkError(`donor decision baseline mismatch: ${decisionId}`, {
      code: "INVALID_DONOR",
    });
  }
  return decision;
}

interface RecordDirectoryScan<T> {
  readonly records: T[];
  readonly skipped: DonorRecordFileError[];
}

function asRecordFileError(file: string, error: unknown): DonorRecordFileError {
  if (error instanceof DonorRecordFileError) {
    return error;
  }
  return new DonorRecordFileError(
    file,
    error instanceof Error ? error.message : `donor record failed validation: ${file}`,
    { cause: error },
  );
}

/**
 * Read every `.json` record in a directory.
 *
 * A record `state.json` does not attest to is skipped rather than thrown: an
 * interrupted or rejected write leaves a file that no history depends on, and
 * failing the whole adoption over it would make every other record — including
 * a perfectly valid `state.json` — unreadable with no in-tool recovery path.
 * Damaged committed records still throw, because history must not be reported
 * as intact when it is not.
 */
async function scanRecordDirectory<TSchema extends z.ZodTypeAny>(
  directory: string,
  schema: TSchema,
  label: string,
  validate: (fileId: string, value: z.output<TSchema>) => void,
): Promise<RecordDirectoryScan<z.output<TSchema>>> {
  const scan: RecordDirectoryScan<z.output<TSchema>> = { records: [], skipped: [] };
  if (!(await exists(directory))) return scan;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    try {
      const value = await readJson(file, schema, label);
      validate(entry.name.slice(0, -".json".length), value);
      scan.records.push(value);
    } catch (error) {
      if (await isCommittedRecordFile(file)) {
        throw error;
      }
      scan.skipped.push(asRecordFileError(file, error));
    }
  }
  return scan;
}

async function scanDonorInspections(
  root: string,
  adoptionId: string,
): Promise<RecordDirectoryScan<DonorInspection>> {
  const directory = await adoptionRoot(root, adoptionId);
  const scan = await scanRecordDirectory(
    path.join(directory, "inspections"),
    donorInspectionSchema,
    `donor inspection '${adoptionId}'`,
    (fileId, record) => {
      if (fileId !== record.id) {
        throw new FrameworkError(
          `donor inspection file identity mismatch: expected '${fileId}', found '${record.id}'`,
          { code: "INVALID_DONOR" },
        );
      }
      const { id, ...content } = record;
      if (expectedRecordId("inspection", content) !== id) {
        throw new FrameworkError(`donor inspection digest mismatch: ${id}`, {
          code: "INVALID_DONOR",
        });
      }
      if (record.adoption_id !== adoptionId) {
        throw new FrameworkError(
          `donor inspection identity mismatch: expected '${adoptionId}', found '${record.adoption_id}'`,
          { code: "INVALID_DONOR" },
        );
      }
    },
  );
  scan.records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return scan;
}

async function scanDonorEvidence(
  root: string,
  adoptionId: string,
): Promise<RecordDirectoryScan<DonorEvidence>> {
  const directory = await adoptionRoot(root, adoptionId);
  const scan = await scanRecordDirectory(
    path.join(directory, "evidence"),
    donorEvidenceSchema,
    `donor evidence '${adoptionId}'`,
    (fileId, record) => {
      if (fileId !== record.id) {
        throw new FrameworkError(
          `donor evidence file identity mismatch: expected '${fileId}', found '${record.id}'`,
          { code: "INVALID_DONOR" },
        );
      }
      const { id, ...content } = record;
      if (expectedRecordId("evidence", content) !== id) {
        throw new FrameworkError(`donor evidence digest mismatch: ${id}`, {
          code: "INVALID_DONOR",
        });
      }
      if (record.adoption_id !== adoptionId) {
        throw new FrameworkError(
          `donor evidence identity mismatch: expected '${adoptionId}', found '${record.adoption_id}'`,
          { code: "INVALID_DONOR" },
        );
      }
    },
  );
  scan.records.sort(
    (a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id),
  );
  return scan;
}

export async function listDonorEvidence(
  root: string,
  adoptionId: string,
  inspectionId?: string,
): Promise<DonorEvidence[]> {
  const scan = await scanDonorEvidence(root, adoptionId);
  return scan.records.filter(
    (record) => inspectionId === undefined || record.inspection_id === inspectionId,
  );
}

export async function listDonorInspections(
  root: string,
  adoptionId: string,
): Promise<DonorInspection[]> {
  return (await scanDonorInspections(root, adoptionId)).records;
}

export async function listDonorDecisions(
  root: string,
  adoptionId: string,
  targetId?: string,
): Promise<DonorDecision[]> {
  const directory = await adoptionRoot(root, adoptionId);
  const state = await readDonorStateFromDirectory(directory, adoptionId);
  const committed = new Set(state.decisions);
  const scan = await scanRecordDirectory(
    path.join(directory, "decisions"),
    donorDecisionSchema,
    `donor decision '${adoptionId}'`,
    (fileId, record) => {
      if (fileId !== record.id) {
        throw new FrameworkError(
          `donor decision file identity mismatch: expected '${fileId}', found '${record.id}'`,
          { code: "INVALID_DONOR" },
        );
      }
    },
  );
  const validated: DonorDecision[] = [];
  for (const record of scan.records) {
    if (!committed.has(record.id)) continue;
    validated.push(await readDonorDecision(root, adoptionId, record.id));
  }
  return validated
    .filter((record) => targetId === undefined || record.target_id === targetId)
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.id.localeCompare(b.id));
}

/**
 * Record files that were skipped because nothing in `state.json` references
 * them. `assay check` reports these against the offending file so an operator
 * can see exactly what to remove.
 *
 * Damage to a committed record is not reported here: the integrity pass already
 * fails the adoption for it. This scan stops at the first such record rather
 * than duplicating the error under a different path.
 */
export async function collectDonorRecordIssues(
  root: string,
  adoptionId: string,
): Promise<DonorRecordFileError[]> {
  const issues: DonorRecordFileError[] = [];
  for (const scan of [
    () => scanDonorInspections(root, adoptionId),
    () => scanDonorEvidence(root, adoptionId),
    () => scanDonorDecisionFiles(root, adoptionId),
  ]) {
    try {
      issues.push(...(await scan()).skipped);
    } catch {
      // Committed-record failure; already reported by the integrity pass.
    }
  }
  return issues;
}

async function scanDonorDecisionFiles(
  root: string,
  adoptionId: string,
): Promise<RecordDirectoryScan<DonorDecision>> {
  const directory = await adoptionRoot(root, adoptionId);
  return scanRecordDirectory(
    path.join(directory, "decisions"),
    donorDecisionSchema,
    `donor decision '${adoptionId}'`,
    () => {},
  );
}

export async function listDonorStateIds(root: string): Promise<string[]> {
  const donorsRoot = await donorWorkspaceRoot(root);
  if (!(await exists(donorsRoot))) return [];
  const entries = await readdir(donorsRoot, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !donorIdSchema.safeParse(entry.name).success) continue;
    if (await exists(path.join(donorsRoot, entry.name, "state.json"))) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

export function assertNewAdoptionState(directory: string, adoptionId: string): Promise<void> {
  return exists(stateFile(directory)).then((present) => {
    if (present) {
      throw new FrameworkAlreadyExistsError(`donor adoption already exists: ${adoptionId}`);
    }
  });
}
