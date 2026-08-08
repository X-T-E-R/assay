import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { safelyWriteAuthorityFile } from "./authority-file-write.js";
import { CURRENT_VERSION, LAYOUT_VERSION, MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError, WorkspaceCutoverRequiredError } from "./errors.js";
import { projectFileRelativePath } from "./project.js";
import {
  type FrameworkManifest,
  type NativeProject,
  frameworkManifestSchema,
  nativeProjectSchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";

export interface WorkspaceIndexOptions {
  readonly indexRoot?: string;
}
export interface WorkspaceIndexRecord {
  readonly __schema: 1;
  readonly project_id: string;
  readonly path: string;
}
export type WorkspaceIndexStatus = "current" | "missing" | "cutover_required" | "invalid";
export interface ListedWorkspaceRecord {
  readonly file: string;
  readonly status: WorkspaceIndexStatus;
  readonly record?: WorkspaceIndexRecord;
  readonly message?: string;
}
export interface TrackWorkspaceOptions extends WorkspaceIndexOptions {
  readonly root: string;
  readonly rebind?: string;
}

export function workspaceIndexRoot(options: WorkspaceIndexOptions = {}): string {
  return path.resolve(
    options.indexRoot ??
      process.env.ASSAY_WORKSPACES_ROOT ??
      path.join(homedir(), ".assay", "workspaces"),
  );
}

export async function canonicalWorkspacePath(root: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(root)));
}

export function workspaceRecordFilename(canonicalPath: string): string {
  return `${createHash("sha256").update(path.normalize(canonicalPath)).digest("hex")}.json`;
}

export async function trackWorkspace(
  options: TrackWorkspaceOptions,
): Promise<WorkspaceIndexRecord> {
  const canonical = await canonicalWorkspacePath(options.root);
  const { project } = await readIndexedWorkspace(canonical);
  const indexRoot = workspaceIndexRoot(options);
  const record: WorkspaceIndexRecord = { __schema: 1, project_id: project.id, path: canonical };
  const file = path.join(indexRoot, workspaceRecordFilename(canonical));

  if (options.rebind) {
    const oldCanonical = await canonicalSafeWorkspacePath(options.rebind);
    const oldFile = path.join(indexRoot, workspaceRecordFilename(oldCanonical));
    const old = await readRecord(oldFile);
    if (!old)
      throw new FrameworkNotFoundError(`Workspace rebind source is not tracked: ${options.rebind}`);
    if (!samePath(old.path, oldCanonical)) {
      throw new FrameworkError("workspace rebind source record is stale");
    }
    const oldWorkspace = await readIndexedWorkspace(oldCanonical);
    if (old.project_id !== oldWorkspace.project.id) {
      throw new FrameworkError("workspace rebind source record Project id is stale");
    }
    if (oldWorkspace.project.id !== project.id) {
      throw new FrameworkError(
        `workspace rebind requires the same Project id; old=${oldWorkspace.project.id}, new=${project.id}`,
      );
    }
    await writeRecord(indexRoot, file, record);
    if (path.normalize(oldFile).toLowerCase() !== path.normalize(file).toLowerCase())
      await removeRecordFile(oldFile);
    return record;
  }

  const existing = await readRecord(file);
  if (existing && existing.project_id !== project.id) {
    throw new FrameworkError(
      `workspace path is already tracked for another Project id: ${canonical}`,
    );
  }
  await writeRecord(indexRoot, file, record);
  return record;
}

async function canonicalSafeWorkspacePath(rootInput: string): Promise<string> {
  const lexical = path.normalize(path.resolve(rootInput));
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new FrameworkError(`workspace rebind source is redirected: ${lexical}`);
  }
  const canonical = path.normalize(await realpath(lexical));
  if (!samePath(canonical, lexical)) {
    throw new FrameworkError(`workspace rebind source is redirected: ${lexical}`);
  }
  return canonical;
}

export async function discoverWorkspaces(
  roots: readonly string[],
  options: WorkspaceIndexOptions = {},
): Promise<WorkspaceIndexRecord[]> {
  const found: WorkspaceIndexRecord[] = [];
  for (const root of roots) {
    for (const workspace of await findWorkspaceRoots(path.resolve(root))) {
      found.push(await trackWorkspace({ root: workspace, ...options }));
    }
  }
  return found;
}

export async function listWorkspaces(
  options: WorkspaceIndexOptions = {},
): Promise<ListedWorkspaceRecord[]> {
  const indexRoot = workspaceIndexRoot(options);
  let names: string[];
  try {
    names = (await readdir(indexRoot)).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const listed: ListedWorkspaceRecord[] = [];
  for (const name of names) {
    const file = path.join(indexRoot, name);
    let record: WorkspaceIndexRecord;
    try {
      record = requireRecord(JSON.parse(await readOrdinaryFile(file)));
      if (name !== workspaceRecordFilename(record.path)) {
        throw new FrameworkError("workspace index filename does not match its canonical path hash");
      }
    } catch (error) {
      listed.push({
        file,
        status: "invalid",
        message: error instanceof Error ? error.message : "invalid record",
      });
      continue;
    }
    try {
      const info = await lstat(record.path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        listed.push({ file, record, status: "invalid", message: "Workspace path is redirected" });
        continue;
      }
      if (!samePath(await realpath(record.path), record.path)) {
        listed.push({
          file,
          record,
          status: "invalid",
          message: "Workspace path is not canonical",
        });
        continue;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        listed.push({ file, record, status: "missing" });
        continue;
      }
      listed.push({
        file,
        record,
        status: "invalid",
        message: error instanceof Error ? error.message : "invalid path",
      });
      continue;
    }
    try {
      const { project } = await readIndexedWorkspace(record.path);
      if (project.id !== record.project_id) {
        listed.push({ file, record, status: "invalid", message: "Project id mismatch" });
        continue;
      }
      listed.push({ file, record, status: "current" });
    } catch (error) {
      if (error instanceof WorkspaceCutoverRequiredError) {
        listed.push({ file, record, status: "cutover_required", message: error.message });
      } else {
        listed.push({
          file,
          record,
          status: "invalid",
          message: error instanceof Error ? error.message : "invalid workspace",
        });
      }
    }
  }
  return listed;
}

export async function forgetWorkspace(
  selector: string,
  options: WorkspaceIndexOptions = {},
): Promise<WorkspaceIndexRecord> {
  const indexRoot = workspaceIndexRoot(options);
  const recordName = selector.toLowerCase().endsWith(".json") ? selector : `${selector}.json`;
  const isRecordSelector = /^[a-f0-9]{64}\.json$/i.test(recordName);
  let file = isRecordSelector ? path.join(indexRoot, recordName) : "";
  let record = isRecordSelector ? await readRecord(file) : null;
  if (!record) {
    const canonical = path.normalize(path.resolve(selector));
    file = path.join(indexRoot, workspaceRecordFilename(canonical));
    record = await readRecord(file);
  }
  if (!record) throw new FrameworkNotFoundError(`Tracked workspace not found: ${selector}`);
  await removeRecordFile(file);
  return record;
}

async function writeRecord(
  root: string,
  file: string,
  record: WorkspaceIndexRecord,
): Promise<void> {
  await safelyWriteAuthorityFile({
    root: await authorityRootForIndex(root),
    file,
    content: stringifySortedJson(record),
    validateExisting: (bytes) => {
      if (bytes) requireRecord(JSON.parse(bytes.toString("utf8")));
    },
    error: (message, cause) =>
      new FrameworkError(message, { code: "IO_ERROR", ...(cause === undefined ? {} : { cause }) }),
  });
}

async function authorityRootForIndex(indexRoot: string): Promise<string> {
  let cursor = path.dirname(path.resolve(indexRoot));
  while (true) {
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new FrameworkError(`workspace index ancestor is redirected: ${cursor}`);
      }
      if (!samePath(await realpath(cursor), cursor)) {
        throw new FrameworkError(`workspace index ancestor is not canonical: ${cursor}`);
      }
      return cursor;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor)
      throw new FrameworkError(`workspace index has no safe ancestor: ${indexRoot}`);
    cursor = parent;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function readRecord(file: string): Promise<WorkspaceIndexRecord | null> {
  try {
    return requireRecord(JSON.parse(await readOrdinaryFile(file)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOrdinaryFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new FrameworkError(`workspace index record must be an ordinary file: ${file}`);
  return readFile(file, "utf8");
}

function requireRecord(value: unknown): WorkspaceIndexRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FrameworkError("workspace index record must be an object");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "__schema,path,project_id" ||
    record.__schema !== 1 ||
    typeof record.project_id !== "string" ||
    record.project_id === "" ||
    typeof record.path !== "string" ||
    !path.isAbsolute(record.path)
  ) {
    throw new FrameworkError("workspace index record failed schema 1 validation");
  }
  return record as unknown as WorkspaceIndexRecord;
}

async function removeRecordFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new FrameworkError(`workspace index record must be an ordinary file: ${file}`);
  await rm(file, { force: false });
}

async function readCurrentManifestOnly(root: string): Promise<FrameworkManifest> {
  const file = path.join(root, MANIFEST_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await readWorkspaceAuthority(root, MANIFEST_FILE));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new FrameworkError(`manifest is not valid JSON: ${file}`);
    throw error;
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const layout =
    record.layout && typeof record.layout === "object" && !Array.isArray(record.layout)
      ? (record.layout as Record<string, unknown>)
      : {};
  if (
    record.framework_version !== CURRENT_VERSION ||
    record.__schema !== 4 ||
    layout.version !== LAYOUT_VERSION
  ) {
    const version =
      typeof record.framework_version === "string" ? record.framework_version : "unknown";
    const schema = typeof record.__schema === "number" ? record.__schema : "unknown";
    const layoutVersion = typeof layout.version === "number" ? layout.version : "unknown";
    throw new WorkspaceCutoverRequiredError(`${version}+s${schema}+l${layoutVersion}`);
  }
  const parsed = frameworkManifestSchema.safeParse(value);
  if (!parsed.success) throw new FrameworkError(`manifest failed validation: ${file}`);
  return parsed.data;
}

async function readIndexedWorkspace(
  root: string,
): Promise<{ readonly manifest: FrameworkManifest; readonly project: NativeProject }> {
  const manifest = await readCurrentManifestOnly(root);
  const projectRelative = projectFileRelativePath(manifest.layout);
  let value: unknown;
  try {
    value = parseYaml(await readWorkspaceAuthority(root, projectRelative));
  } catch (error) {
    if (error instanceof FrameworkError) throw error;
    throw new FrameworkError(`native Project failed closed parsing: ${projectRelative}`, {
      cause: error,
    });
  }
  const parsed = nativeProjectSchema.safeParse(value);
  if (!parsed.success)
    throw new FrameworkError(`native Project failed validation: ${projectRelative}`);
  return { manifest, project: parsed.data };
}

async function readWorkspaceAuthority(rootInput: string, relative: string): Promise<string> {
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new FrameworkError(`workspace authority escapes root: ${relative}`);
  }
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !samePath(await realpath(root), root)
  ) {
    throw new FrameworkError(`workspace root is redirected: ${root}`);
  }
  let cursor = root;
  for (const segment of path.dirname(rel).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(cursor), cursor)) {
      throw new FrameworkError(`workspace authority ancestor is redirected: ${cursor}`);
    }
  }
  const before = await lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 1024 * 1024 ||
    !samePath(await realpath(target), target)
  ) {
    throw new FrameworkError(`workspace authority file is unsafe: ${target}`);
  }
  const handle = await open(target, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size > 1024 * 1024
    ) {
      throw new FrameworkError(`workspace authority identity changed: ${target}`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > 1024 * 1024) {
      throw new FrameworkError(`workspace authority exceeds size limit: ${target}`);
    }
    const after = await lstat(target);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) {
      throw new FrameworkError(`workspace authority identity changed: ${target}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new FrameworkError(`workspace authority is not valid UTF-8: ${target}`, {
        cause: error,
      });
    }
  } finally {
    await handle.close();
  }
}

async function findWorkspaceRoots(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === ".assay")) {
      try {
        const manifest = await lstat(path.join(directory, ".assay", "manifest.json"));
        if (manifest.isFile() && !manifest.isSymbolicLink()) found.push(directory);
      } catch {
        /* continue */
      }
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        [".git", "node_modules", ".assay"].includes(entry.name)
      )
        continue;
      await visit(path.join(directory, entry.name));
    }
  };
  await visit(root);
  return found;
}
