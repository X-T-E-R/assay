import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveWorkspaceLayout, workspaceRelativePath } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { toPosixPath } from "./serialization.js";

/**
 * A rebuildable index of where each origin was already cloned.
 *
 * This is a cache, and it is written to stay one. Duplicated research starts at
 * the moment a repository is cloned a second time, and catching that costs one
 * lookup here; nothing else in Assay may depend on this file. Every read
 * re-verifies that the workspace and the alias it names still exist, a stale
 * entry is dropped rather than reported, and deleting the whole file loses
 * convenience and no facts. That is what keeps it from growing into the global
 * authority the design rejected.
 *
 * Homes only. A consumer's reference shell is not recorded: the registry
 * answers "where does this material actually live", and a shell is not where it
 * lives.
 */

export const CLONE_REGISTRY_SCHEMA = 1;
export const CLONE_REGISTRY_ENV = "ASSAY_CLONE_REGISTRY";

export interface CloneRegistryEntry {
  /** Normalized origin URI; the key a second clone would collide on. */
  readonly origin: string;
  /** Absolute path of the workspace that owns the Source. */
  readonly workspace: string;
  readonly alias: string;
  readonly last_seen: string;
}

export interface CloneRegistryOptions {
  /** Full path to the registry file; overrides the environment and the default. */
  readonly registryFile?: string;
}

export interface RecordSourceCloneInput extends CloneRegistryOptions {
  readonly workspace: string;
  readonly alias: string;
  readonly origin: string;
  readonly now?: Date;
}

export function cloneRegistryFile(options: CloneRegistryOptions = {}): string {
  const configured = options.registryFile ?? process.env[CLONE_REGISTRY_ENV];
  return path.resolve(
    configured && configured.trim() !== ""
      ? configured
      : path.join(homedir(), ".assay", "clone-registry.json"),
  );
}

/**
 * Collapse the ways of writing the same origin into one key.
 *
 * Deliberately coarse: this decides whether to print a hint, so treating two
 * spellings of one repository as the same thing is the useful failure and
 * missing a match is the harmless one. Scheme, credentials, a trailing `.git`,
 * and case all go; a local path is resolved so a relative add matches an
 * absolute one.
 */
export function normalizeOriginUri(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const scpLike = trimmed.match(/^[A-Za-z0-9._-]+@([^/:]+):(.+)$/);
  const remote = scpLike
    ? `${scpLike[1]}/${scpLike[2]}`
    : /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/^[^/@]*@/, "")
      : null;
  if (remote !== null) {
    return remote
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  }
  const local = toPosixPath(path.resolve(trimmed)).replace(/\/+$/, "");
  return process.platform === "win32" ? local.toLowerCase() : local;
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function asEntry(value: unknown): CloneRegistryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.origin !== "string" ||
    record.origin === "" ||
    typeof record.workspace !== "string" ||
    !path.isAbsolute(record.workspace) ||
    typeof record.alias !== "string" ||
    record.alias === "" ||
    typeof record.last_seen !== "string"
  ) {
    return null;
  }
  return {
    origin: record.origin,
    workspace: record.workspace,
    alias: record.alias,
    last_seen: record.last_seen,
  };
}

/** Read whatever is readable. A malformed file is an empty cache, not an error. */
async function readEntries(file: string): Promise<CloneRegistryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const entries = (parsed as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => asEntry(entry))
    .filter((entry): entry is CloneRegistryEntry => entry !== null);
}

/**
 * Replace the file's contents, swallowing every failure.
 *
 * A cache that can block a command is not a cache. A read-only home directory,
 * a locked file, a full disk: all of them mean the hint is unavailable, which
 * is the state the registry is designed to survive.
 */
async function writeEntries(
  file: string,
  entries: readonly CloneRegistryEntry[],
): Promise<boolean> {
  const content = `${JSON.stringify(
    {
      __schema: CLONE_REGISTRY_SCHEMA,
      entries: [...entries].sort(
        (a, b) => a.origin.localeCompare(b.origin) || a.workspace.localeCompare(b.workspace),
      ),
    },
    null,
    2,
  )}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, content, "utf8");
    await rename(temporary, file);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Whether this entry still describes a Source home.
 *
 * The workspace has to be a current Assay workspace and the alias has to be an
 * owned Source in it — a reference shell does not count, because the registry
 * points at homes. An old-envelope workspace fails verification rather than
 * triggering a migration: a hint never makes a decision.
 */
async function verifyEntry(entry: CloneRegistryEntry): Promise<boolean> {
  try {
    const manifest = await loadManifest(entry.workspace);
    const layout = resolveWorkspaceLayout(manifest);
    if (!manifest || !layout) return false;
    const sourcesRelative = workspaceRelativePath(layout, "sources");
    return exists(path.join(entry.workspace, sourcesRelative, entry.alias, "source.yaml"));
  } catch {
    return false;
  }
}

async function verifiedEntries(
  file: string,
  match: (entry: CloneRegistryEntry) => boolean,
): Promise<CloneRegistryEntry[]> {
  const entries = await readEntries(file);
  if (entries.length === 0) return [];
  const kept: CloneRegistryEntry[] = [];
  for (const entry of entries) {
    if (await verifyEntry(entry)) kept.push(entry);
  }
  if (kept.length !== entries.length) {
    await writeEntries(file, kept);
  }
  return kept.filter((entry) => match(entry));
}

/**
 * Note that this workspace holds this origin. Returns whether the note landed,
 * for callers that report cache state; no caller may branch on it.
 */
export async function recordSourceClone(input: RecordSourceCloneInput): Promise<boolean> {
  const origin = normalizeOriginUri(input.origin);
  if (origin === "") return false;
  const workspace = path.resolve(input.workspace);
  const file = cloneRegistryFile(input);
  const entry: CloneRegistryEntry = {
    origin,
    workspace,
    alias: input.alias,
    last_seen: (input.now ?? new Date()).toISOString(),
  };
  const entries = (await readEntries(file)).filter(
    (existing) =>
      !(
        existing.origin === origin &&
        existing.alias === entry.alias &&
        samePath(existing.workspace, workspace)
      ),
  );
  return writeEntries(file, [...entries, entry]);
}

/** Verified homes already holding this origin. Stale entries are pruned first. */
export async function findClonesByOrigin(
  origin: string,
  options: CloneRegistryOptions = {},
): Promise<CloneRegistryEntry[]> {
  const normalized = normalizeOriginUri(origin);
  if (normalized === "") return [];
  return verifiedEntries(cloneRegistryFile(options), (entry) => entry.origin === normalized);
}

/**
 * Verified homes that own a Source under this alias.
 *
 * This is the lookup that lets `source link` take a bare alias and the one that
 * lets a broken reference name where its Source is now, neither of which knows
 * the origin URI the shell deliberately does not duplicate.
 */
export async function findClonesByAlias(
  alias: string,
  options: CloneRegistryOptions = {},
): Promise<CloneRegistryEntry[]> {
  if (alias.trim() === "") return [];
  return verifiedEntries(cloneRegistryFile(options), (entry) => entry.alias === alias);
}

/** Drop this home from the cache. Best-effort, like every write here. */
export async function forgetSourceClone(
  input: { readonly workspace: string; readonly alias: string } & CloneRegistryOptions,
): Promise<boolean> {
  const file = cloneRegistryFile(input);
  const entries = await readEntries(file);
  const kept = entries.filter(
    (entry) => !(entry.alias === input.alias && samePath(entry.workspace, input.workspace)),
  );
  if (kept.length === entries.length) return false;
  return writeEntries(file, kept);
}
