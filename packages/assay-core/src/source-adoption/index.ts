import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { appendEvent } from "../events.js";
import { relativeDisplayPath } from "../paths.js";
import type { CheckRow } from "../results.js";
import { readSourceContentListing, resolveSourceObservation } from "../sources.js";
import {
  loadSystemsRegistry,
  resolveRegistryPath,
  systemRecordForSelector,
} from "../systems-registry.js";
import { nowIso } from "../time.js";
import {
  SOURCE_ADOPTION_SCHEMA,
  type SourceAdoptionMatch,
  type SourceAdoptionPathLocator,
  type SourceAdoptionPin,
  type SourceAdoptionRecord,
  type SourceAdoptionTakeMode,
  sourceAdoptionRecordSchema,
  sourceAdoptionRelativePathSchema,
} from "./schemas.js";
import {
  SourceAdoptionRecordFileError,
  assertSourceAdoptionId,
  deleteSourceAdoptionRecord,
  listSourceAdoptionIds,
  parseSourceAdoptionValue,
  readSourceAdoptionRecord,
  sourceAdoptionRecordFile,
  sourceAdoptionWorkspaceRoot,
  writeNewSourceAdoptionRecord,
} from "./storage.js";

export * from "./schemas.js";
export { SourceAdoptionRecordFileError } from "./storage.js";

/**
 * Whether a source-relative file path falls under a declared locator. `exact`
 * names one file; `prefix` names a file or everything beneath it. Shared by the
 * upstream impact report, so "did this change touch adopted material?" has one
 * answer.
 */
export function sourceAdoptionLocatorMatchesPath(
  locator: SourceAdoptionPathLocator,
  filePath: string,
): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (locator.match === "exact") {
    return normalized === locator.path;
  }
  return normalized === locator.path || normalized.startsWith(`${locator.path}/`);
}

async function appendSourceAdoptionEventBestEffort(
  root: string,
  event: Record<string, unknown>,
  now: Date,
): Promise<string | null> {
  try {
    return relativeDisplayPath(await appendEvent(root, event, now), root);
  } catch {
    return null;
  }
}

/** Identifier fragment accepted by `sourceAdoptionIdSchema`, derived from free text. */
function sourceAdoptionSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : `x${slug}`;
}

/**
 * Validate one endpoint before it becomes a record. Doing it here rather than
 * leaving it to schema validation is what lets the error name the argument the
 * caller typed — an absolute or drive-prefixed path is the likely mistake, and
 * "record failed validation" would not say which half of the command produced it.
 */
function normalizeEndpointPath(value: string, label: string): string {
  const parsed = sourceAdoptionRelativePathSchema.safeParse(value);
  if (!parsed.success) {
    throw new FrameworkError(
      `${label} must be a contained relative path (no leading '/', drive letter, or '..'): ${value}`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }
  return parsed.data;
}

/**
 * What the source path actually is, read off the observation's readable bytes: a
 * file is `exact`, a directory is `prefix`. A path that is neither is refused
 * here, because a mapping to material that was not there is not traceability.
 */
async function resolveSourceEndpoint(
  absoluteContentRoot: string,
  relativeContentPath: string,
  sourcePath: string,
): Promise<SourceAdoptionMatch> {
  const absolute = path.join(absoluteContentRoot, ...sourcePath.split("/"));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrameworkNotFoundError(
        `source path does not exist in ${relativeContentPath}: ${sourcePath}`,
      );
    }
    throw error;
  }
  if (info.isDirectory()) return "prefix";
  if (info.isFile()) return "exact";
  throw new FrameworkError(
    `source path is neither a file nor a directory: ${relativeContentPath}/${sourcePath}`,
    { code: "INVALID_SOURCE_ADOPTION" },
  );
}

/**
 * The tier-1 pin for what was adopted, or nothing when there is no identity to
 * be had.
 *
 * A checkout-backed source already carries one: the commit is identity, and the
 * origin says which repository it is the identity of. Both are free. Copied
 * content has no commit, so this is the one place a tree hash gets computed —
 * lazily, at the moment an adoption asks for it, which is exactly the demand the
 * tier model reserves it for.
 */
async function identityPin(input: {
  readonly root: string;
  readonly alias: string;
  readonly observation: string;
  readonly contentMode: "checkout" | "copy";
  readonly commit: string | null;
  readonly origin: string | null;
}): Promise<SourceAdoptionPin | undefined> {
  if (input.contentMode === "checkout") {
    return input.commit
      ? { kind: "git-commit", commit: input.commit, origin: input.origin }
      : undefined;
  }
  const listing = await readSourceContentListing({
    root: input.root,
    alias: input.alias,
    observation: input.observation,
  });
  return {
    kind: "content-hash",
    algorithm: "sha256-tree-v1",
    value: listing.fingerprint.value,
  };
}

async function requireRegisteredSystemPath(root: string, selector: string): Promise<string> {
  const registry = await loadSystemsRegistry(root);
  const system = registry ? systemRecordForSelector(registry, selector) : null;
  if (!system) {
    throw new FrameworkNotFoundError(
      `registered target system not found: ${selector}. Register it with \`assay system register\` before recording where material landed in it.`,
    );
  }
  return resolveRegistryPath(root, system.path);
}

async function canonicalPath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Canonical form of the deepest ancestor that exists, so a not-yet-created target still gets checked. */
async function canonicalExistingAncestor(target: string): Promise<string | null> {
  let current = target;
  for (;;) {
    const canonical = await canonicalPath(current);
    if (canonical !== null) return canonical;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Absolute target path, refusing anything that leaves the registered system.
 *
 * The schema already rejects textual escapes (`..`, absolute paths, drive
 * letters), which says nothing about symbolic links: under a system whose
 * `link` is a symlink elsewhere, `link/src/a.txt` resolves textually inside the
 * system while naming a file outside it, and the record would then claim that
 * this system holds material it does not. Both ends are canonicalized, and the
 * deepest existing ancestor stands in for a target that is not on disk yet.
 */
async function containedTargetPath(systemRoot: string, targetPath: string): Promise<string> {
  const absolute = path.resolve(systemRoot, ...targetPath.split("/"));
  const realSystemRoot = await canonicalPath(systemRoot);
  const realTarget = await canonicalExistingAncestor(absolute);
  if (realSystemRoot === null || realTarget === null) return absolute;
  const relative = path.relative(realSystemRoot, realTarget);
  if (
    realTarget !== realSystemRoot &&
    (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    throw new FrameworkError(
      `target path escapes registered system through a symbolic link: ${targetPath}`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }
  return absolute;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface TakeSourceAdoptionMaterialOptions {
  readonly root: string;
  /** Source alias the material came from. */
  readonly sourceAlias: string;
  /** Path inside that source's readable content. */
  readonly sourcePath: string;
  /** Registered system the material landed in. */
  readonly targetSystem: string;
  /** Path inside that system. */
  readonly targetPath: string;
  readonly mode?: SourceAdoptionTakeMode;
  /** Rationale worth re-reading later; the record works without one. */
  readonly note?: string;
  /** Source observation id or path; defaults to the latest. */
  readonly observation?: string;
  /** Adoption id; derived from alias, system, and source path when omitted. */
  readonly adoptionId?: string;
  readonly now?: Date;
}

export interface TakeSourceAdoptionMaterialResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly record: SourceAdoptionRecord;
  readonly path: string;
  /** False when the target path is not on disk yet; recorded either way. */
  readonly targetPresent: boolean;
  readonly eventFile: string | null;
}

/**
 * Record that material moved from a source into a system.
 *
 * This is the whole write path. The record is derived from the two endpoints the
 * caller names plus what the workspace can already see — which observation is
 * current, whether the source path is a file or a tree, and what identity the
 * source has — so the common case is one command and no preparation.
 */
export async function takeSourceAdoptionMaterial(
  options: TakeSourceAdoptionMaterialOptions,
): Promise<TakeSourceAdoptionMaterialResult> {
  const root = path.resolve(options.root);
  const sourcePath = normalizeEndpointPath(options.sourcePath, "source path");
  const targetPath = normalizeEndpointPath(options.targetPath, "target path");
  const now = options.now ?? new Date();

  const resolved = await resolveSourceObservation({
    root,
    alias: options.sourceAlias,
    ...(options.observation === undefined ? {} : { observation: options.observation }),
  });
  const match = await resolveSourceEndpoint(
    path.join(root, ...resolved.contentPath.split("/")),
    resolved.contentPath,
    sourcePath,
  );
  const systemRoot = await requireRegisteredSystemPath(root, options.targetSystem);
  const absoluteTarget = await containedTargetPath(systemRoot, targetPath);
  const pin = await identityPin({
    root,
    alias: resolved.alias,
    observation: resolved.observation.observation_id,
    contentMode: resolved.contentMode,
    commit: resolved.observation.vcs?.commit ?? null,
    origin: resolved.observation.vcs?.remote ?? null,
  });

  const adoptionId = assertSourceAdoptionId(
    (
      options.adoptionId ??
      `${sourceAdoptionSlug(resolved.alias)}-${sourceAdoptionSlug(options.targetSystem)}-${sourceAdoptionSlug(sourcePath)}`
    ).slice(0, 128),
  );
  const record = parseSourceAdoptionValue(
    sourceAdoptionRecordSchema,
    {
      schema: SOURCE_ADOPTION_SCHEMA,
      id: adoptionId,
      mode: options.mode ?? "adapt",
      source: {
        alias: resolved.alias,
        observation: resolved.observation.observation_id,
        path: sourcePath,
        match,
        ...(pin === undefined ? {} : { pin }),
      },
      target: { system: options.targetSystem, path: targetPath, match },
      ...(options.note === undefined ? {} : { note: options.note }),
      recorded_on: nowIso(now),
    },
    "Source adoption record",
  );

  // One record is one atomic file write, so there is no read-modify-write to
  // serialize here. The workspace mutation gate that keeps a write from landing
  // in a tree mid-conversion is applied once, on the public surface.
  let file: string;
  try {
    file = await writeNewSourceAdoptionRecord(root, record);
  } catch (error) {
    if (error instanceof FrameworkAlreadyExistsError && options.adoptionId === undefined) {
      throw new FrameworkAlreadyExistsError(
        `Source adoption already exists: ${adoptionId}. The id is derived from the source, the system, and the source path, so a second mapping from the same path needs \`--id <adoption-id>\`.`,
      );
    }
    throw error;
  }
  const eventFile = await appendSourceAdoptionEventBestEffort(
    root,
    {
      event: "source.adoption.recorded",
      adoption: adoptionId,
      source: `${record.source.alias}:${record.source.path}`,
      target: `${record.target.system}:${record.target.path}`,
    },
    now,
  );
  return {
    root,
    adoptionId,
    record,
    path: relativeDisplayPath(file, root),
    targetPresent: await pathExists(absoluteTarget),
    eventFile,
  };
}

export interface SourceAdoptionListResult {
  readonly root: string;
  readonly adoptions: readonly SourceAdoptionRecord[];
}

export async function listSourceAdoptions(options: {
  readonly root: string;
}): Promise<SourceAdoptionListResult> {
  const root = path.resolve(options.root);
  const adoptions: SourceAdoptionRecord[] = [];
  for (const adoptionId of await listSourceAdoptionIds(root)) {
    adoptions.push(await readSourceAdoptionRecord(root, adoptionId));
  }
  return { root, adoptions };
}

export interface SourceAdoptionResult {
  readonly root: string;
  readonly record: SourceAdoptionRecord;
  readonly path: string;
  /** Where the target resolves right now; null when the system is gone. */
  readonly targetPath: string | null;
  readonly targetPresent: boolean;
}

export async function getSourceAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
}): Promise<SourceAdoptionResult> {
  const root = path.resolve(options.root);
  const record = await readSourceAdoptionRecord(root, options.adoptionId);
  const registry = await loadSystemsRegistry(root);
  const system = registry ? systemRecordForSelector(registry, record.target.system) : null;
  if (!system) {
    return {
      root,
      record,
      path: relativeDisplayPath(await sourceAdoptionRecordFile(root, record.id), root),
      targetPath: null,
      targetPresent: false,
    };
  }
  const absolute = path.join(
    resolveRegistryPath(root, system.path),
    ...record.target.path.split("/"),
  );
  return {
    root,
    record,
    path: relativeDisplayPath(await sourceAdoptionRecordFile(root, record.id), root),
    targetPath: `${system.path}/${record.target.path}`,
    targetPresent: await pathExists(absolute),
  };
}

export interface RemoveSourceAdoptionResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly record: SourceAdoptionRecord;
  readonly path: string;
  readonly eventFile: string | null;
}

/**
 * Forget a mapping. The record is the only thing removed: the material in the
 * target system is the target project's, and Assay never wrote it.
 */
export async function removeSourceAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly now?: Date;
}): Promise<RemoveSourceAdoptionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const record = await readSourceAdoptionRecord(root, adoptionId);
  const now = options.now ?? new Date();
  const file = await deleteSourceAdoptionRecord(root, adoptionId);
  const eventFile = await appendSourceAdoptionEventBestEffort(
    root,
    { event: "source.adoption.removed", adoption: adoptionId },
    now,
  );
  return { root, adoptionId, record, path: relativeDisplayPath(file, root), eventFile };
}

export interface SourceAdoptionSourceMapping {
  readonly adoptionId: string;
  readonly sourceAlias: string;
  readonly locator: SourceAdoptionPathLocator;
}

/**
 * Every source locator across the workspace's Source adoptions.
 *
 * `assay status` intersects these with the paths an upstream change touched, so
 * "the source moved" is reported together with "it reaches N adopted places". A
 * damaged record is skipped rather than fatal: `check` is where record integrity
 * is reported, and status must not stop answering because one record is
 * unreadable.
 */
export async function listSourceAdoptionSourceMappings(
  root: string,
): Promise<readonly SourceAdoptionSourceMapping[]> {
  const resolvedRoot = path.resolve(root);
  const mappings: SourceAdoptionSourceMapping[] = [];
  for (const adoptionId of await listSourceAdoptionIds(resolvedRoot)) {
    try {
      const record = await readSourceAdoptionRecord(resolvedRoot, adoptionId);
      mappings.push({
        adoptionId,
        sourceAlias: record.source.alias,
        locator: { path: record.source.path, match: record.source.match },
      });
    } catch {
      // unreadable record; `check` reports the damaged file
    }
  }
  return mappings;
}

export interface SourceAdoptionSummary {
  readonly adoptions: number;
  /** Distinct systems material landed in. */
  readonly systems: number;
  /** Records carrying a tier-1 identity pin. */
  readonly pinned: number;
}

export async function getSourceAdoptionSummary(
  root: string,
): Promise<SourceAdoptionSummary | null> {
  const resolvedRoot = path.resolve(root);
  const ids = await listSourceAdoptionIds(resolvedRoot);
  if (ids.length === 0) return null;
  const systems = new Set<string>();
  let pinned = 0;
  for (const adoptionId of ids) {
    try {
      const record = await readSourceAdoptionRecord(resolvedRoot, adoptionId);
      systems.add(record.target.system);
      if (record.source.pin) pinned += 1;
    } catch {
      // unreadable record; `check` reports it
    }
  }
  return { adoptions: ids.length, systems: systems.size, pinned };
}

/**
 * Report each record's readability, and whether the system it names is still
 * registered. Ordinary source and target movement stays out of `check`: that is
 * what `assay status` answers, and a mapping is not wrong because upstream moved.
 */
export async function collectSourceAdoptionIntegrityRows(root: string): Promise<CheckRow[]> {
  const resolvedRoot = path.resolve(root);
  const storeRoot = await sourceAdoptionWorkspaceRoot(resolvedRoot);
  if (!(await pathExists(storeRoot))) return [];

  const registry = await loadSystemsRegistry(resolvedRoot);
  const rows: CheckRow[] = [];
  for (const adoptionId of await listSourceAdoptionIds(resolvedRoot)) {
    const file = await sourceAdoptionRecordFile(resolvedRoot, adoptionId);
    try {
      const record = await readSourceAdoptionRecord(resolvedRoot, adoptionId);
      const system = registry ? systemRecordForSelector(registry, record.target.system) : null;
      rows.push(
        system || !registry
          ? {
              path: relativeDisplayPath(file, resolvedRoot),
              status: "ok",
              message: "Source adoption record is valid",
            }
          : {
              path: relativeDisplayPath(file, resolvedRoot),
              status: "warning",
              message: `Source adoption names system '${record.target.system}', which is no longer registered. Re-register the system, or remove the mapping with \`assay source adoption remove ${adoptionId}\`.`,
            },
      );
    } catch (error) {
      rows.push({
        path: relativeDisplayPath(
          error instanceof SourceAdoptionRecordFileError ? error.file : file,
          resolvedRoot,
        ),
        status: "error",
        message:
          error instanceof Error ? error.message : "Source adoption record failed validation",
      });
    }
  }
  return rows;
}
