import crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MANAGED_DIR, MANIFEST_FILE } from "./constants.js";
import { FrameworkError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import type { FrameworkManifest } from "./schemas/index.js";
import { loadSystemsRegistry } from "./systems-registry.js";

export type MetaSystemProjectRegistryCommand = "init" | "adopt" | "update" | "scan" | "uninstall";
export type MetaSystemProjectRegistryStatus = "active" | "missing" | "uninstalled";

export interface ProjectRegistryOptions {
  readonly registryRoot?: string;
  readonly now?: () => Date;
}

export interface MetaSystemProjectRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly path: string;
  readonly realpath: string;
  readonly name: string;
  readonly core: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly createdBy: MetaSystemProjectRegistryCommand;
  readonly lastCommand: MetaSystemProjectRegistryCommand;
  readonly frameworkVersion?: string;
  readonly layoutVersion?: number;
  readonly managedFiles: number;
  readonly status: MetaSystemProjectRegistryStatus;
}

export interface PruneProjectsOptions extends ProjectRegistryOptions {
  readonly dryRun?: boolean;
}

export class ProjectRegistryError extends FrameworkError {
  constructor(message: string) {
    super(message, { code: "NOT_FOUND" });
    this.name = "ProjectRegistryError";
  }
}

type ProjectRecordBuild = Omit<MetaSystemProjectRecord, "frameworkVersion" | "layoutVersion"> & {
  readonly frameworkVersion?: string | undefined;
  readonly layoutVersion?: number | undefined;
};

const SCHEMA_VERSION = 1;
const PROJECT_ID_LENGTH = 16;
const REGISTRY_ROOT_ENV = "METASYSTEM_PROJECT_REGISTRY_ROOT";
const PROJECT_ID_PATTERN = /^[0-9a-f]{16}$/;
const HEAVY_SCAN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  MANAGED_DIR,
  "node_modules",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
  ".next",
  ".turbo",
]);

export function projectRegistryRoot(options: ProjectRegistryOptions = {}): string {
  if (options.registryRoot) {
    return path.resolve(options.registryRoot);
  }

  const configuredRoot = process.env[REGISTRY_ROOT_ENV];
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }

  return path.join(os.homedir(), ".metasystem", "projects");
}

export function projectRecordPath(id: string, options: ProjectRegistryOptions = {}): string {
  return path.join(projectRegistryRoot(options), `${id}.json`);
}

export function canonicalProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function projectIdForPath(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return crypto
    .createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, PROJECT_ID_LENGTH);
}

export async function registerProject(
  projectPath: string,
  command: Exclude<MetaSystemProjectRegistryCommand, "uninstall">,
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord> {
  const record = await buildProjectRecord(projectPath, command, options);
  await writeProjectRecord(record, options);
  return record;
}

export async function markProjectUninstalled(
  projectPath: string,
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord> {
  const record = await buildProjectRecord(projectPath, "uninstall", options, {
    status: "uninstalled",
  });
  await writeProjectRecord(record, options);
  return record;
}

export async function listProjectRecords(
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord[]> {
  const root = projectRegistryRoot(options);
  if (!(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readProjectRecordFile(path.join(root, entry.name))),
  );

  const refreshed = await Promise.all(
    records
      .filter((record): record is MetaSystemProjectRecord => record !== null)
      .map((record) => refreshProjectRecordStatus(record)),
  );
  return refreshed.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function findProjectRecord(
  selector: string,
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord> {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new ProjectRegistryError("project selector cannot be empty");
  }

  if (looksLikePath(trimmed)) {
    const id = projectIdForPath(trimmed);
    const byId = await readProjectRecord(id, options);
    if (byId) {
      return refreshProjectRecordStatus(byId);
    }

    const canonical = canonicalProjectPath(trimmed);
    const match = (await listProjectRecords(options)).find(
      (record) =>
        samePath(record.path, trimmed) ||
        samePath(record.realpath, canonical) ||
        samePath(record.path, canonical),
    );
    if (match) {
      return match;
    }
  }

  const direct = await readProjectRecord(trimmed, options);
  if (direct) {
    return refreshProjectRecordStatus(direct);
  }

  const matches = (await listProjectRecords(options)).filter((record) =>
    record.id.startsWith(trimmed),
  );
  if (matches.length === 1) {
    const match = matches[0];
    if (match) {
      return match;
    }
  }
  if (matches.length > 1) {
    throw new ProjectRegistryError(
      `project selector '${selector}' is ambiguous (${matches.map((record) => record.id).join(", ")})`,
    );
  }
  throw new ProjectRegistryError(`project not found: ${selector}`);
}

export async function scanForProjects(
  roots: readonly string[],
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord[]> {
  const found = new Map<string, MetaSystemProjectRecord>();
  for (const root of roots) {
    await walkForProjects(path.resolve(root), async (projectPath) => {
      const record = await registerProject(projectPath, "scan", options);
      found.set(record.id, record);
    });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function forgetProject(
  selector: string,
  options: ProjectRegistryOptions = {},
): Promise<MetaSystemProjectRecord> {
  const record = await findProjectRecord(selector, options);
  await rm(projectRecordPath(record.id, options), { force: true });
  return record;
}

export async function pruneProjects(
  options: PruneProjectsOptions = {},
): Promise<MetaSystemProjectRecord[]> {
  const stale = (await listProjectRecords(options)).filter(
    (record) => record.status === "missing" || record.status === "uninstalled",
  );
  if (options.dryRun) {
    return stale;
  }

  await Promise.all(
    stale.map((record) => rm(projectRecordPath(record.id, options), { force: true })),
  );
  return stale;
}

export async function recordProjectLifecycleBestEffort(
  projectPath: string,
  command: MetaSystemProjectRegistryCommand,
): Promise<void> {
  try {
    if (command === "uninstall") {
      await markProjectUninstalled(projectPath);
    } else {
      await registerProject(projectPath, command);
    }
  } catch {
    // Registry writes are lifecycle metadata only; scaffold operations should remain successful.
  }
}

async function buildProjectRecord(
  projectPath: string,
  command: MetaSystemProjectRegistryCommand,
  options: ProjectRegistryOptions,
  overrides: Partial<Pick<MetaSystemProjectRecord, "status">> = {},
): Promise<MetaSystemProjectRecord> {
  const absolutePath = path.resolve(projectPath);
  const realpath = canonicalProjectPath(absolutePath);
  const id = projectIdForPath(absolutePath);
  const existing = await readProjectRecord(id, options);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const manifest = command === "uninstall" ? null : await safeLoadManifest(absolutePath);
  const systemsRegistry =
    command === "uninstall" ? null : await safeLoadSystemsRegistry(absolutePath);
  const fallbackName = path.basename(absolutePath);
  const status = overrides.status ?? (manifest ? "active" : "missing");

  return compactRecord({
    schemaVersion: SCHEMA_VERSION,
    id,
    path: absolutePath,
    realpath,
    name: manifest?.project.name || existing?.name || fallbackName,
    // Compatibility field for old project-registry records. Layout v3 must not
    // read manifest.project.core; if a core identity is needed, use the systems
    // registry primary.
    core: systemsRegistry?.primary ?? existing?.core ?? `${fallbackName}-core`,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
    createdBy: existing?.createdBy ?? command,
    lastCommand: command,
    frameworkVersion: manifest?.framework_version ?? existing?.frameworkVersion,
    layoutVersion: manifest?.layout_version ?? existing?.layoutVersion,
    managedFiles: manifest
      ? Object.keys(manifest.managed_files).length
      : (existing?.managedFiles ?? 0),
    status,
  });
}

function compactRecord(record: ProjectRecordBuild): MetaSystemProjectRecord {
  const { frameworkVersion, layoutVersion, ...rest } = record;
  return {
    ...rest,
    ...(frameworkVersion === undefined ? {} : { frameworkVersion }),
    ...(layoutVersion === undefined ? {} : { layoutVersion }),
  };
}

async function writeProjectRecord(
  record: MetaSystemProjectRecord,
  options: ProjectRegistryOptions,
): Promise<void> {
  const root = projectRegistryRoot(options);
  await mkdir(root, { recursive: true });
  const tmpPath = path.join(root, `${record.id}.${crypto.randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmpPath, projectRecordPath(record.id, options));
}

async function readProjectRecord(
  id: string,
  options: ProjectRegistryOptions,
): Promise<MetaSystemProjectRecord | null> {
  if (!isProjectId(id)) {
    return null;
  }
  return readProjectRecordFile(projectRecordPath(id, options));
}

async function readProjectRecordFile(filePath: string): Promise<MetaSystemProjectRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isProjectRecord(parsed)) {
      return null;
    }
    if (path.basename(filePath) !== `${parsed.id}.json`) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function refreshProjectRecordStatus(
  record: MetaSystemProjectRecord,
): Promise<MetaSystemProjectRecord> {
  if (record.status === "uninstalled") {
    return record;
  }
  const manifest = await safeLoadManifest(record.path);
  return {
    ...record,
    ...(manifest
      ? {
          frameworkVersion: manifest.framework_version,
          layoutVersion: manifest.layout_version,
          managedFiles: Object.keys(manifest.managed_files).length,
        }
      : {}),
    status: manifest ? "active" : "missing",
  };
}

async function safeLoadManifest(projectPath: string): Promise<FrameworkManifest | null> {
  try {
    return await loadManifest(projectPath);
  } catch {
    return null;
  }
}

async function safeLoadSystemsRegistry(
  projectPath: string,
): Promise<Awaited<ReturnType<typeof loadSystemsRegistry>> | null> {
  try {
    return await loadSystemsRegistry(projectPath);
  } catch {
    return null;
  }
}

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

function looksLikePath(selector: string): boolean {
  return (
    selector === "." ||
    selector === ".." ||
    path.isAbsolute(selector) ||
    selector.includes("/") ||
    selector.includes("\\")
  );
}

function samePath(leftPath: string, rightPath: string): boolean {
  const left = canonicalProjectPath(leftPath);
  const right = canonicalProjectPath(rightPath);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isProjectRecord(value: unknown): value is MetaSystemProjectRecord {
  if (!isObject(value)) {
    return false;
  }
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    typeof value.id === "string" &&
    isProjectId(value.id) &&
    typeof value.path === "string" &&
    typeof value.realpath === "string" &&
    typeof value.name === "string" &&
    typeof value.core === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    isRegistryCommand(value.createdBy) &&
    isRegistryCommand(value.lastCommand) &&
    (value.frameworkVersion === undefined || typeof value.frameworkVersion === "string") &&
    (value.layoutVersion === undefined || typeof value.layoutVersion === "number") &&
    typeof value.managedFiles === "number" &&
    isRegistryStatus(value.status)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRegistryCommand(value: unknown): value is MetaSystemProjectRegistryCommand {
  return (
    value === "init" ||
    value === "adopt" ||
    value === "update" ||
    value === "scan" ||
    value === "uninstall"
  );
}

function isRegistryStatus(value: unknown): value is MetaSystemProjectRegistryStatus {
  return value === "active" || value === "missing" || value === "uninstalled";
}

function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

async function walkForProjects(
  root: string,
  onProject: (projectPath: string) => Promise<void>,
): Promise<void> {
  const rootStat = await safeStat(root);
  if (!rootStat?.isDirectory()) {
    return;
  }

  if (path.basename(root) === MANAGED_DIR) {
    const parent = path.dirname(root);
    if (existsSync(path.join(parent, MANIFEST_FILE))) {
      await onProject(parent);
    }
    return;
  }

  if (existsSync(path.join(root, MANIFEST_FILE))) {
    await onProject(root);
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (HEAVY_SCAN_DIRS.has(entry.name)) {
      continue;
    }
    await walkForProjects(path.join(root, entry.name), onProject);
  }
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}
