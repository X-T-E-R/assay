import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { resolveWorkspaceLayout } from "../layout.js";
import { loadManifest } from "../manifest.js";
import { stringifySortedJson } from "../serialization.js";
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

function expectedRecordId(prefix: string, value: unknown): string {
  return `${prefix}-${recordDigest(value).slice(0, 24)}`;
}

export async function donorWorkspaceRoot(root: string): Promise<string> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new FrameworkNotFoundError(`No Assay manifest found at ${root}.`);
  }
  const layout = resolveWorkspaceLayout(manifest);
  if (!layout) {
    throw new FrameworkNotFoundError("Assay workspace layout could not be resolved.");
  }
  return path.join(root, layout.state_root, "donors");
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
    throw new FrameworkError(`${label} is not valid JSON: ${file}`, {
      code: "INVALID_DONOR",
      cause: error,
    });
  }
  return parseDonorValue(schema, value, `${label}: ${file}`);
}

export async function writeImmutableJson(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const content = stringifySortedJson(value);
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(file, "utf8");
    if (existing !== content) {
      throw new FrameworkError(`content-addressed donor record collision: ${file}`, {
        code: "INVALID_DONOR",
      });
    }
    return false;
  }
}

export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(stringifySortedJson(value), "utf8");
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

export async function withAdoptionLock<T>(
  root: string,
  adoptionId: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await adoptionRoot(root, adoptionId);
  await mkdir(directory, { recursive: true });
  const lockFile = path.join(directory, ".lock");
  const handle = await acquireAdoptionLock(lockFile, adoptionId);

  try {
    await handle.writeFile(
      stringifySortedJson({ pid: process.pid, acquired_at: new Date().toISOString() }),
      "utf8",
    );
    await handle.sync();
    return await operation(directory);
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

async function acquireAdoptionLock(lockFile: string, adoptionId: string): Promise<FileHandle> {
  try {
    return await open(lockFile, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  let stale = false;
  try {
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as {
      readonly pid?: unknown;
      readonly acquired_at?: unknown;
    };
    if (typeof lock.pid === "number" && Number.isInteger(lock.pid)) {
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        stale = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } else {
      const info = await stat(lockFile);
      stale = Date.now() - info.mtimeMs > 60 * 60 * 1000;
    }
  } catch {
    const info = await stat(lockFile);
    stale = Date.now() - info.mtimeMs > 60 * 60 * 1000;
  }

  if (stale) {
    await rm(lockFile, { force: true });
    try {
      return await open(lockFile, "wx");
    } catch {
      // Another process may have acquired the lock after stale cleanup.
    }
  }
  throw new FrameworkError(`donor adoption is busy: ${adoptionId}`, {
    code: "DONOR_BUSY",
  });
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

interface StoredJsonRecord<T> {
  readonly fileId: string;
  readonly value: T;
}

async function readRecordDirectory<TSchema extends z.ZodTypeAny>(
  directory: string,
  schema: TSchema,
  label: string,
): Promise<Array<StoredJsonRecord<z.output<TSchema>>>> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const records: Array<StoredJsonRecord<z.output<TSchema>>> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    records.push({
      fileId: entry.name.slice(0, -".json".length),
      value: await readJson(path.join(directory, entry.name), schema, label),
    });
  }
  return records;
}

export async function listDonorEvidence(
  root: string,
  adoptionId: string,
  inspectionId?: string,
): Promise<DonorEvidence[]> {
  const directory = await adoptionRoot(root, adoptionId);
  const records = await readRecordDirectory(
    path.join(directory, "evidence"),
    donorEvidenceSchema,
    `donor evidence '${adoptionId}'`,
  );
  for (const stored of records) {
    const record = stored.value;
    if (stored.fileId !== record.id) {
      throw new FrameworkError(
        `donor evidence file identity mismatch: expected '${stored.fileId}', found '${record.id}'`,
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
  }
  return records
    .map((stored) => stored.value)
    .filter((record) => inspectionId === undefined || record.inspection_id === inspectionId)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id));
}

export async function listDonorInspections(
  root: string,
  adoptionId: string,
): Promise<DonorInspection[]> {
  const directory = await adoptionRoot(root, adoptionId);
  const records = await readRecordDirectory(
    path.join(directory, "inspections"),
    donorInspectionSchema,
    `donor inspection '${adoptionId}'`,
  );
  for (const stored of records) {
    const record = stored.value;
    if (stored.fileId !== record.id) {
      throw new FrameworkError(
        `donor inspection file identity mismatch: expected '${stored.fileId}', found '${record.id}'`,
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
  }
  return records
    .map((stored) => stored.value)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function listDonorDecisions(
  root: string,
  adoptionId: string,
  targetId?: string,
): Promise<DonorDecision[]> {
  const directory = await adoptionRoot(root, adoptionId);
  const state = await readDonorStateFromDirectory(directory, adoptionId);
  const committed = new Set(state.decisions);
  const records = await readRecordDirectory(
    path.join(directory, "decisions"),
    donorDecisionSchema,
    `donor decision '${adoptionId}'`,
  );
  const validated: DonorDecision[] = [];
  for (const stored of records) {
    const record = stored.value;
    if (stored.fileId !== record.id) {
      throw new FrameworkError(
        `donor decision file identity mismatch: expected '${stored.fileId}', found '${record.id}'`,
        { code: "INVALID_DONOR" },
      );
    }
    if (!committed.has(record.id)) continue;
    validated.push(await readDonorDecision(root, adoptionId, record.id));
  }
  return validated
    .filter((record) => targetId === undefined || record.target_id === targetId)
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.id.localeCompare(b.id));
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
