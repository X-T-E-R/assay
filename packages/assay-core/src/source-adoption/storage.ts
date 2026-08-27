import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

import { MANAGED_DIR } from "../constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import { stringifySortedJson } from "../serialization.js";
import {
  type SourceAdoptionRecord,
  sourceAdoptionIdSchema,
  sourceAdoptionRecordSchema,
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

/**
 * A Source adoption record file that could not be read or validated. Carries the
 * file so callers report the record that is actually damaged rather than the
 * store as a whole.
 */
export class SourceAdoptionRecordFileError extends FrameworkError {
  readonly file: string;

  constructor(file: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { ...options, code: "INVALID_SOURCE_ADOPTION" });
    this.name = "SourceAdoptionRecordFileError";
    this.file = file;
  }
}

/**
 * Root directory for Source adoption records: always
 * `<root>/.assay/source-adoptions`.
 *
 * These are Assay-owned state, like the event log and the systems registry, all
 * of which address `.assay/` through shared constants rather than the layout path
 * map. Every layout v8 workspace puts state under `.assay/`, so using the
 * constant removes a failure mode: a manifest with a stale `state_root` can no
 * longer split adoption records off from the rest of the workspace state.
 */
export async function sourceAdoptionWorkspaceRoot(root: string): Promise<string> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new FrameworkNotFoundError(`No Assay manifest found at ${root}.`);
  }
  return path.join(root, MANAGED_DIR, "source-adoptions");
}

export function assertSourceAdoptionId(value: string): string {
  const result = sourceAdoptionIdSchema.safeParse(value);
  if (!result.success) {
    throw new FrameworkError(`invalid Source adoption identifier '${value}'`, {
      code: "INVALID_SOURCE_ADOPTION",
      details: result.error.flatten(),
    });
  }
  return result.data;
}

export async function sourceAdoptionRecordFile(root: string, adoptionId: string): Promise<string> {
  const safeId = assertSourceAdoptionId(adoptionId);
  return path.join(await sourceAdoptionWorkspaceRoot(root), `${safeId}.json`);
}

export function parseSourceAdoptionValue<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  label: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new FrameworkError(`${label} failed validation`, {
      code: "INVALID_SOURCE_ADOPTION",
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Write through a temporary file and a rename, so a process that dies mid-write
 * cannot leave a truncated record behind: readers see either the previous
 * content or the complete record.
 */
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

export async function writeNewSourceAdoptionRecord(
  root: string,
  record: SourceAdoptionRecord,
): Promise<string> {
  const file = await sourceAdoptionRecordFile(root, record.id);
  if (await exists(file)) {
    throw new FrameworkAlreadyExistsError(`Source adoption already exists: ${record.id}`);
  }
  await writeFileAtomically(file, stringifySortedJson(record));
  return file;
}

export async function readSourceAdoptionRecordFile(file: string): Promise<SourceAdoptionRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrameworkNotFoundError(`Source adoption record not found: ${file}`);
    }
    throw new SourceAdoptionRecordFileError(file, "Source adoption record is not valid JSON", {
      cause: error,
    });
  }
  const result = sourceAdoptionRecordSchema.safeParse(value);
  if (!result.success) {
    throw new SourceAdoptionRecordFileError(file, "Source adoption record failed validation", {
      cause: result.error,
    });
  }
  const record = result.data;
  const expectedId = path.basename(file, ".json");
  if (record.id !== expectedId) {
    throw new SourceAdoptionRecordFileError(
      file,
      `Source adoption record identity mismatch: expected '${expectedId}', found '${record.id}'`,
    );
  }
  return record;
}

export async function readSourceAdoptionRecord(
  root: string,
  adoptionId: string,
): Promise<SourceAdoptionRecord> {
  return readSourceAdoptionRecordFile(await sourceAdoptionRecordFile(root, adoptionId));
}

/**
 * Ids of every record file in the store, sorted.
 *
 * Only `<id>.json` counts. A directory is ignored on purpose: a workspace
 * migrated from 0.13 keeps its retired per-adoption directories on disk, and
 * they are not records.
 */
export async function listSourceAdoptionIds(root: string): Promise<string[]> {
  const storeRoot = await sourceAdoptionWorkspaceRoot(root);
  if (!(await exists(storeRoot))) return [];
  const entries = await readdir(storeRoot, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    if (!sourceAdoptionIdSchema.safeParse(id).success) continue;
    ids.push(id);
  }
  return ids.sort();
}

export async function deleteSourceAdoptionRecord(
  root: string,
  adoptionId: string,
): Promise<string> {
  const file = await sourceAdoptionRecordFile(root, adoptionId);
  if (!(await exists(file))) {
    throw new FrameworkNotFoundError(`Source adoption not found: ${adoptionId}`);
  }
  await rm(file, { force: true });
  return file;
}
