import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { MANAGED_DIR } from "./constants.js";
import { FrameworkError } from "./errors.js";

export type BuiltinTemplateName = "study" | "solve" | "explore";
export type TemplateSelection = BuiltinTemplateName | string;

export interface TemplateDirectory {
  readonly path: string;
  readonly purpose: string;
}

export interface TemplateFileEntry {
  readonly path: string;
  readonly content?: string;
  readonly file?: string;
  readonly executable: boolean;
}

export interface WorkspaceTemplate {
  readonly name: string;
  readonly description: string;
  readonly source: "built-in" | "file";
  readonly path: string;
  readonly directories: readonly TemplateDirectory[];
  readonly files: readonly TemplateFileEntry[];
}

export interface AvailableTemplate {
  readonly name: BuiltinTemplateName;
  readonly description: string;
  readonly path: string;
}

const BUILTIN_NAMES: readonly BuiltinTemplateName[] = ["study", "solve", "explore"];
const BUILTIN_TEMPLATES_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "templates");
const ALLOWED_KEYS = new Set(["__schema", "description", "directories", "files"]);
const DIRECTORY_KEYS = new Set(["path", "purpose"]);
const FILE_KEYS = new Set(["path", "content", "file", "executable"]);
const RETIRED_ROOTS = [
  "iterations",
  `${MANAGED_DIR}/iterations`,
  "references",
  `${MANAGED_DIR}/references`,
  "sources/frozen",
  `${MANAGED_DIR}/sources/frozen`,
];
const NATIVE_ROOTS = [".assay", "project", "systems", "tasks"];
const MANAGED_CORE_FILES = [
  "README.md",
  "AGENTS.md",
  ".gitignore",
  ".assay/README.md",
  ".assay/backups/.gitkeep",
  "systems/README.md",
  "knowledge/README.md",
];

export async function loadTemplate(
  selection: string | undefined = "study",
): Promise<WorkspaceTemplate> {
  const requested = selection.trim();
  if (requested === "") throw templateError("template selection must not be empty");
  if ((BUILTIN_NAMES as readonly string[]).includes(requested)) {
    return loadTemplateFile(
      path.join(BUILTIN_TEMPLATES_DIR, `${requested}.yaml`),
      requested,
      "built-in",
    );
  }
  if (!looksLikeExplicitYamlPath(requested)) {
    throw templateError(
      `unknown template '${requested}'; built-ins are study, solve, explore; custom templates require an explicit YAML path`,
    );
  }
  return loadTemplateFile(
    path.resolve(requested),
    path.basename(requested, path.extname(requested)),
    "file",
  );
}

export async function listAvailableTemplates(): Promise<AvailableTemplate[]> {
  return Promise.all(
    BUILTIN_NAMES.map(async (name) => {
      const loaded = await loadTemplate(name);
      return { name, description: loaded.description, path: loaded.path };
    }),
  );
}

async function loadTemplateFile(
  file: string,
  name: string,
  source: WorkspaceTemplate["source"],
): Promise<WorkspaceTemplate> {
  await assertOrdinaryFile(file, "template descriptor");
  let value: unknown;
  try {
    value = parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof FrameworkError) throw error;
    throw templateError(`could not parse template YAML: ${file}`, error);
  }
  if (!isRecord(value)) throw templateError(`template ${file} must be a YAML object`);
  assertOnlyKeys(value, ALLOWED_KEYS, `template ${file}`);
  if (value.__schema !== 1) throw templateError(`template ${file} must declare __schema: 1`);
  if (typeof value.description !== "string" || value.description.trim() === "") {
    throw templateError(`template ${file} must declare a non-empty description`);
  }
  if (!Array.isArray(value.directories)) {
    throw templateError(`template ${file} must declare directories as a list`);
  }
  if (!Array.isArray(value.files)) {
    throw templateError(`template ${file} must declare files as a list`);
  }

  const directories = value.directories.map((item, index) => {
    if (!isRecord(item))
      throw templateError(`template ${file} directories[${index}] must be an object`);
    assertOnlyKeys(item, DIRECTORY_KEYS, `template ${file} directories[${index}]`);
    const entryPath = requiredString(item.path, `template ${file} directories[${index}].path`);
    const purpose = requiredString(item.purpose, `template ${file} directories[${index}].purpose`);
    assertScaffoldPath(entryPath, file);
    return { path: normalizeScaffoldPath(entryPath), purpose: collapseWhitespace(purpose) };
  });

  const descriptorDir = path.dirname(file);
  const files: TemplateFileEntry[] = [];
  for (const [index, item] of value.files.entries()) {
    if (!isRecord(item)) throw templateError(`template ${file} files[${index}] must be an object`);
    assertOnlyKeys(item, FILE_KEYS, `template ${file} files[${index}]`);
    const entryPath = requiredString(item.path, `template ${file} files[${index}].path`);
    assertScaffoldPath(entryPath, file);
    const hasContent = typeof item.content === "string";
    const hasFile = typeof item.file === "string" && item.file.trim() !== "";
    if (Number(hasContent) + Number(hasFile) !== 1) {
      throw templateError(
        `template ${file} files[${index}] must declare exactly one of content or file`,
      );
    }
    if (item.executable !== undefined && typeof item.executable !== "boolean") {
      throw templateError(`template ${file} files[${index}].executable must be boolean`);
    }
    if (hasContent) {
      files.push({
        path: normalizeScaffoldPath(entryPath),
        content: item.content as string,
        executable: item.executable === true,
      });
      continue;
    }
    const declaredFile = (item.file as string).trim();
    if (path.isAbsolute(declaredFile)) {
      throw templateError(`template content file must be relative: ${declaredFile}`);
    }
    const contentFile = path.resolve(descriptorDir, declaredFile);
    if (!isContained(descriptorDir, contentFile)) {
      throw templateError(
        `template content file escapes its descriptor directory: ${declaredFile}`,
      );
    }
    await assertOrdinaryFile(contentFile, "template content file");
    files.push({
      path: normalizeScaffoldPath(entryPath),
      file: declaredFile.replaceAll("\\", "/"),
      content: await readFile(contentFile, "utf8"),
      executable: item.executable === true,
    });
  }

  const paths = [...directories.map((entry) => entry.path), ...files.map((entry) => entry.path)];
  const duplicates = duplicatePaths(paths);
  if (duplicates.length > 0) {
    throw templateError(`template ${file} declares duplicate paths: ${duplicates.join(", ")}`);
  }
  assertNoNativeCollisions(paths, file);
  return {
    name,
    description: collapseWhitespace(value.description),
    source,
    path: file,
    directories,
    files,
  };
}

function assertNoNativeCollisions(paths: readonly string[], descriptor: string): void {
  for (const candidate of paths) {
    const value = candidate.toLowerCase();
    const nativeRoot = NATIVE_ROOTS.find(
      (root) => value === root || value.startsWith(`${root}/`) || root.startsWith(`${value}/`),
    );
    const managedFile = MANAGED_CORE_FILES.find(
      (file) =>
        value === file.toLowerCase() ||
        value.startsWith(`${file.toLowerCase()}/`) ||
        file.toLowerCase().startsWith(`${value}/`),
    );
    if (nativeRoot || managedFile) {
      throw templateError(
        `template path collides with native authority or managed core in ${descriptor}: ${candidate}`,
      );
    }
  }
}

export async function assertTemplateWriteBoundary(
  rootInput: string,
  paths: readonly string[],
): Promise<void> {
  const root = path.resolve(rootInput);
  const canonicalRoot = await realpath(await nearestExistingAncestor(root));
  for (const relative of paths) {
    assertScaffoldPath(relative, "template output");
    const target = path.join(root, relative);
    const existingAncestor = await nearestExistingAncestor(target);
    const canonicalAncestor = await realpath(existingAncestor);
    if (!isContained(canonicalRoot, canonicalAncestor)) {
      throw templateError(
        `template output boundary is redirected outside the workspace: ${relative}`,
      );
    }
    let cursor = existingAncestor;
    while (isContained(root, cursor)) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw templateError(
          `template output boundary contains a symlink or reparse point: ${cursor}`,
        );
      }
      if (path.resolve(cursor) === root) break;
      cursor = path.dirname(cursor);
    }
  }
}

function assertScaffoldPath(value: string, descriptor: string): void {
  const normalized = normalizeScaffoldPath(value);
  if (
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw templateError(
      `template path must be normalized and workspace-relative in ${descriptor}: ${value}`,
    );
  }
  const comparable = normalized.toLowerCase();
  if (RETIRED_ROOTS.some((root) => comparable === root || comparable.startsWith(`${root}/`))) {
    throw templateError(`retired template path in ${descriptor}: ${value}`);
  }
}

function normalizeScaffoldPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function looksLikeExplicitYamlPath(value: string): boolean {
  return value.toLowerCase().endsWith(".yaml") || value.toLowerCase().endsWith(".yml");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw templateError(`${label} must be a non-empty string`);
  return value.trim();
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw templateError(`${label} contains unsupported field(s): ${unknown.sort().join(", ")}`);
  }
}

function duplicatePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) duplicates.add(value);
    seen.add(key);
  }
  return [...duplicates];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let cursor = path.resolve(target);
  while (true) {
    try {
      await lstat(cursor);
      return cursor;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor)
      throw templateError(`template output has no existing ancestor: ${target}`);
    cursor = parent;
  }
}

async function assertOrdinaryFile(file: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    throw templateError(`${label} not found: ${file}`, error);
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw templateError(`${label} must be an ordinary file: ${file}`);
  const canonical = await realpath(file);
  if (path.resolve(canonical) !== path.resolve(file)) {
    throw templateError(`${label} must not cross a reparse point: ${file}`);
  }
}

function templateError(message: string, cause?: unknown): FrameworkError {
  return new FrameworkError(message, {
    code: "IO_ERROR",
    ...(cause === undefined ? {} : { cause }),
  });
}

export async function listTemplateAssetFiles(): Promise<string[]> {
  return (await readdir(BUILTIN_TEMPLATES_DIR))
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => path.join(BUILTIN_TEMPLATES_DIR, entry));
}
