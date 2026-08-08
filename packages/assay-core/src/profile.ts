import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { MANAGED_DIR } from "./constants.js";
import { FrameworkError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import type { FrameworkManifest, ProjectArchetype, ProjectMode } from "./schemas/index.js";

export interface ArchetypeTemplateEntry {
  readonly path: string;
  readonly templateId: string;
  /**
   * Resolved template content carried by the archetype itself (inline
   * `content` or a `file` next to the archetype YAML). When absent, the
   * templateId must resolve to a built-in content generator.
   */
  readonly content?: string;
}

export type ArchetypeSource = "project" | "user" | "built-in";

export interface AvailableArchetype {
  readonly name: ProjectArchetype;
  readonly source: ArchetypeSource;
  readonly path: string;
}

export interface ArchetypeLookupOptions {
  /** Project root used for project-local `.assay/archetypes/<name>.yaml`. */
  readonly root?: string;
  /** Test/embedding override for the user-global archetype directory. */
  readonly userArchetypesDir?: string;
  /** Test/embedding override for bundled archetypes. */
  readonly builtinArchetypesDir?: string;
}

/**
 * One directory an archetype declares, with the one-line statement of what
 * belongs in it.
 *
 * `purpose` is what makes a directory self-explaining wherever it is shown —
 * the AGENTS.md layout table, `assay status` zones, and placement advisories
 * all read it from here. It is empty for archetypes that declare a directory
 * as a bare string, which stays valid.
 */
export interface ArchetypeDirectory {
  /** Workspace-root-relative directory path with POSIX separators. */
  readonly path: string;
  /** What belongs in this directory; empty when the archetype does not say. */
  readonly purpose: string;
}

export interface Archetype {
  readonly name: ProjectArchetype;
  /** One line stating what this archetype is for; empty when not declared. */
  readonly description: string;
  readonly mode: ProjectMode;
  /** Directories created in all modes. */
  readonly dirs: readonly ArchetypeDirectory[];
  /** Directories created only in learning mode. */
  readonly dirsLearning: readonly ArchetypeDirectory[];
  /** Directories created only in absorption mode. */
  readonly dirsAbsorption: readonly ArchetypeDirectory[];
  readonly templates: readonly ArchetypeTemplateEntry[];
}

/** Directories an archetype declares for the given mode, with their purposes. */
export function archetypeDirectories(
  archetype: Pick<Archetype, "dirs" | "dirsLearning" | "dirsAbsorption">,
  mode: ProjectMode,
): readonly ArchetypeDirectory[] {
  return [
    ...archetype.dirs,
    ...(mode === "absorption" ? archetype.dirsAbsorption : archetype.dirsLearning),
  ];
}

export function dirsForArchetype(archetype: Archetype, mode: ProjectMode): readonly string[] {
  return archetypeDirectories(archetype, mode).map((directory) => directory.path);
}

export type ProfileTemplateEntry = ArchetypeTemplateEntry;
export type Profile = Archetype;

const DEFAULT_ARCHETYPE: ProjectArchetype = "study";
const PROJECT_ARCHETYPES_DIR = path.join(MANAGED_DIR, "archetypes");
const BUILTIN_ARCHETYPES_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "profiles");

/**
 * Archetypes that were renamed after workspaces had already recorded the old
 * name. Loading resolves the old name to the current one, so an existing
 * manifest keeps working with no migration step; `assay update` rewrites the
 * manifest in passing. A project- or user-level archetype file with the old
 * name still wins, because the alias is only consulted after the lookup fails.
 */
const ARCHETYPE_ALIASES = new Map<string, ProjectArchetype>([["research", "study"]]);

/**
 * Archetypes this build no longer ships. Naming them keeps `--archetype
 * science` copied out of an older document failing for a reason the reader can
 * act on, instead of looking like a typo.
 */
const REMOVED_ARCHETYPES = new Map<string, { removedIn: string; hint: string }>([
  [
    "science",
    {
      removedIn: "0.4.0",
      hint: "use `study` for evidence work, or declare a custom archetype",
    },
  ],
  [
    "evaluation",
    {
      removedIn: "0.4.0",
      hint: "use `study` and record the current contract with `assay spec`",
    },
  ],
  [
    "library",
    { removedIn: "0.4.0", hint: "use `study`, or declare a custom archetype for a bare core" },
  ],
]);

/** The current name of an archetype recorded under a previous one. */
export function archetypeAliasTarget(name: string): ProjectArchetype | null {
  return ARCHETYPE_ALIASES.get(name.trim()) ?? null;
}

const BASE_ARCHETYPE: Archetype = {
  name: "base",
  description: "",
  mode: "learning",
  dirs: [
    { path: `${MANAGED_DIR}/backups`, purpose: "" },
    { path: `${MANAGED_DIR}/migrations`, purpose: "" },
    {
      path: "project",
      purpose:
        "Native Project charter, roadmap, specifications, selected Relay records, and extensions",
    },
    { path: "systems", purpose: "Registered systems and local implementations" },
    { path: "knowledge", purpose: "Accepted, reusable knowledge" },
  ],
  dirsLearning: [],
  dirsAbsorption: [],
  templates: [
    { path: "README.md", templateId: "root.readme" },
    { path: ".gitignore", templateId: "root.gitignore" },
    { path: `${MANAGED_DIR}/README.md`, templateId: "framework.readme" },
    { path: `${MANAGED_DIR}/VERSION`, templateId: "framework.version" },
    { path: `${MANAGED_DIR}/migrations/README.md`, templateId: "framework.migrations.readme" },
    { path: `${MANAGED_DIR}/backups/.gitkeep`, templateId: "framework.backups.gitkeep" },
    { path: "systems/README.md", templateId: "systems.readme" },
    { path: "knowledge/README.md", templateId: "knowledge.readme" },
  ],
};

interface ParsedTemplateEntry extends ArchetypeTemplateEntry {
  /** Relative path to a content file next to the archetype YAML. */
  readonly file?: string;
}

interface ParsedArchetype extends Omit<Archetype, "templates"> {
  readonly extendsName: string | null;
  readonly templates: readonly ParsedTemplateEntry[];
}

interface ArchetypeLookupLocation {
  readonly source: ArchetypeSource;
  readonly directory: string;
}

/**
 * Load an archetype by name using the public extension lookup order:
 * project-local `.assay/archetypes`, user-global `~/.assay/archetypes`,
 * then bundled built-ins. The internal `base` archetype remains reserved and
 * is only available through `extends: base`.
 *
 * A name that no longer resolves is retried under its current name, so a
 * manifest written before an archetype was renamed loads without asking anyone
 * to migrate it.
 */
export async function loadArchetype(
  name: string | undefined = DEFAULT_ARCHETYPE,
  options: ArchetypeLookupOptions = {},
): Promise<Archetype> {
  if (options.root) {
    await loadManifest(options.root);
  }
  const archetypeName = normalizeArchetypeName(name ?? DEFAULT_ARCHETYPE);
  if (archetypeName === "base") {
    throw await archetypeNotFoundError(archetypeName, options);
  }

  const direct = await readArchetypeByName(archetypeName, options);
  if (direct) {
    return direct;
  }

  const alias = ARCHETYPE_ALIASES.get(archetypeName);
  if (alias) {
    const aliased = await readArchetypeByName(alias, options);
    if (aliased) {
      return aliased;
    }
  }

  throw await archetypeNotFoundError(archetypeName, options);
}

async function readArchetypeByName(
  archetypeName: ProjectArchetype,
  options: ArchetypeLookupOptions,
): Promise<Archetype | null> {
  for (const location of archetypeLookupLocations(options)) {
    const archetypePath = path.join(location.directory, `${archetypeName}.yaml`);
    let raw: string;
    try {
      raw = await readFile(archetypePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseArchetypeYaml(raw, archetypeName);
    const resolved = await resolveTemplateFileContents(parsed, location.directory);
    return mergeBaseArchetype(resolved);
  }
  return null;
}

export async function listAvailableArchetypes(
  options: ArchetypeLookupOptions = {},
): Promise<AvailableArchetype[]> {
  if (options.root) {
    await loadManifest(options.root);
  }
  const byName = new Map<string, AvailableArchetype>();
  for (const location of archetypeLookupLocations(options)) {
    for (const archetype of await listArchetypesInDirectory(location)) {
      if (!byName.has(archetype.name)) {
        byName.set(archetype.name, archetype);
      }
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseArchetypeYaml(raw: string, name: ProjectArchetype): ParsedArchetype {
  const value = parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FrameworkError(`malformed archetype ${name}: expected YAML object`, {
      code: "IO_ERROR",
    });
  }

  const record = value as Record<string, unknown>;
  const retiredModulesKey = Object.keys(record).find((key) => key.toLowerCase() === "modules");
  if (retiredModulesKey !== undefined) {
    throw new FrameworkError(
      `retired archetype key 'modules' in archetype ${name}; remove '${retiredModulesKey}' before using this archetype`,
      {
        code: "RETIRED_ARCHETYPE_FIELD",
        details: { archetype: name, field: "modules", declared_field: retiredModulesKey },
      },
    );
  }
  const extendsName = parseOptionalString(record.extends, "extends", name);
  if (extendsName && extendsName !== "base") {
    throw new FrameworkError(
      `unsupported archetype extension '${extendsName}' in archetype ${name}; supported extension: base`,
      { code: "IO_ERROR" },
    );
  }

  const mode = parseProjectMode(record.mode, name);
  const description = parseOptionalString(record.description, "description", name) ?? "";
  const dirs = parseDirectoryList(record.dirs, "dirs", name);
  const dirsLearning = parseDirectoryList(record.dirs_learning, "dirs_learning", name);
  const dirsAbsorption = parseDirectoryList(record.dirs_absorption, "dirs_absorption", name);
  const templates = parseTemplateList(record.templates, name);

  if (!extendsName && dirs.length === 0) {
    throw new FrameworkError(`archetype '${name}' has no dirs`, { code: "IO_ERROR" });
  }

  return {
    name,
    description: collapseWhitespace(description),
    extendsName,
    mode,
    dirs,
    dirsLearning,
    dirsAbsorption,
    templates,
  };
}

function parseOptionalString(value: unknown, field: string, archetypeName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FrameworkError(`invalid ${field} in archetype ${archetypeName}`, {
      code: "IO_ERROR",
    });
  }
  return value.trim();
}

function parseProjectMode(value: unknown, archetypeName: string): ProjectMode {
  if (value === undefined || value === null) return "learning";
  if (value === "learning" || value === "absorption") return value;
  throw new FrameworkError(
    `unsupported mode '${String(value)}' in archetype ${archetypeName}; supported modes: learning, absorption`,
    { code: "IO_ERROR" },
  );
}

/**
 * Parse a directory list that accepts both shapes an archetype may use:
 * a bare string (no declared purpose) or `{ path, purpose }`. The string form
 * is the original format and stays valid, so archetypes written before
 * purposes existed keep loading unchanged.
 */
function parseDirectoryList(
  value: unknown,
  field: string,
  archetypeName: string,
): ArchetypeDirectory[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FrameworkError(`invalid ${field} in archetype ${archetypeName}: expected list`, {
      code: "IO_ERROR",
    });
  }
  return value.map((item) => {
    if (typeof item === "string") {
      if (item.trim() === "") {
        throw new FrameworkError(`invalid ${field} entry in archetype ${archetypeName}`, {
          code: "IO_ERROR",
        });
      }
      const directoryPath = item.trim();
      assertCurrentArchetypePath(directoryPath, field, archetypeName);
      return { path: directoryPath, purpose: "" };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new FrameworkError(`invalid ${field} entry in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path.trim() === "") {
      throw new FrameworkError(`invalid ${field} path in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    if (
      record.purpose !== undefined &&
      record.purpose !== null &&
      typeof record.purpose !== "string"
    ) {
      throw new FrameworkError(`invalid ${field} purpose in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    const directoryPath = record.path.trim();
    assertCurrentArchetypePath(directoryPath, field, archetypeName);
    return {
      path: directoryPath,
      purpose: collapseWhitespace(typeof record.purpose === "string" ? record.purpose : ""),
    };
  });
}

/** Purposes and descriptions are rendered on one line wherever they appear. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseTemplateList(value: unknown, archetypeName: string): ParsedTemplateEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FrameworkError(`invalid templates in archetype ${archetypeName}: expected list`, {
      code: "IO_ERROR",
    });
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new FrameworkError(`invalid template entry in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path.trim() === "") {
      throw new FrameworkError(`invalid template path in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    if (typeof record.templateId !== "string" || record.templateId.trim() === "") {
      throw new FrameworkError(`invalid templateId in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    const templatePath = record.path.trim();
    assertCurrentArchetypePath(templatePath, "templates", archetypeName);
    const content = parseOptionalTemplateContent(record.content, "content", archetypeName);
    const file = parseOptionalString(record.file, "file", archetypeName);
    if (content !== null && file !== null) {
      throw new FrameworkError(
        `template entry '${templatePath}' in archetype ${archetypeName} sets both content and file; use one`,
        { code: "IO_ERROR" },
      );
    }
    return {
      path: templatePath,
      templateId: record.templateId.trim(),
      ...(content !== null ? { content } : {}),
      ...(file !== null ? { file } : {}),
    };
  });
}

/**
 * Iteration storage is retired authority in layout v6. A custom archetype must
 * not recover it under either layout spelling, including lexical aliases that
 * resolve to the same workspace-relative path. Keep the check at YAML parsing
 * so init, attach, status, check, update, and convert all fail before scaffold
 * paths or template content are used.
 */
function assertCurrentArchetypePath(
  declaredPath: string,
  field: string,
  archetypeName: string,
): void {
  const normalizedPath = normalizeArchetypeScaffoldPath(declaredPath);
  const comparable = normalizedPath.toLowerCase();
  if (
    comparable !== "iterations" &&
    !comparable.startsWith("iterations/") &&
    comparable !== `${MANAGED_DIR}/iterations` &&
    !comparable.startsWith(`${MANAGED_DIR}/iterations/`)
  ) {
    return;
  }
  throw new FrameworkError(
    `retired archetype path '${declaredPath}' in ${field} of archetype ${archetypeName} resolves to '${normalizedPath}'`,
    {
      code: "RETIRED_ARCHETYPE_PATH",
      details: {
        archetype: archetypeName,
        field,
        declared_path: declaredPath,
        normalized_path: normalizedPath,
      },
    },
  );
}

function normalizeArchetypeScaffoldPath(value: string): string {
  const posix = value.replaceAll("\\", "/").replace(/^\/+/, "");
  return path.posix.normalize(posix);
}

function parseOptionalTemplateContent(
  value: unknown,
  field: string,
  archetypeName: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new FrameworkError(`invalid ${field} in archetype ${archetypeName}`, {
      code: "IO_ERROR",
    });
  }
  return value;
}

/**
 * Resolve `file:`-based template entries against the directory that contains
 * the archetype YAML. This lets custom archetypes ship their own template
 * content (for example `~/.assay/archetypes/<name>/*.md`) instead of being
 * limited to built-in templateIds.
 */
async function resolveTemplateFileContents(
  archetype: ParsedArchetype,
  archetypeDir: string,
): Promise<ParsedArchetype> {
  if (!archetype.templates.some((entry) => entry.file !== undefined)) {
    return archetype;
  }
  const baseDir = path.resolve(archetypeDir);
  const templates: ParsedTemplateEntry[] = [];
  for (const entry of archetype.templates) {
    if (entry.file === undefined) {
      templates.push(entry);
      continue;
    }
    if (path.isAbsolute(entry.file)) {
      throw new FrameworkError(
        `template file '${entry.file}' in archetype ${archetype.name} must be relative to the archetype directory`,
        { code: "IO_ERROR" },
      );
    }
    const resolved = path.resolve(baseDir, entry.file);
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
      throw new FrameworkError(
        `template file '${entry.file}' in archetype ${archetype.name} escapes the archetype directory`,
        { code: "IO_ERROR" },
      );
    }
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      throw new FrameworkError(
        `template file '${entry.file}' referenced by archetype ${archetype.name} not found at ${resolved}`,
        { code: "IO_ERROR" },
      );
    }
    const { file: _file, ...rest } = entry;
    templates.push({ ...rest, content });
  }
  return { ...archetype, templates };
}

function mergeBaseArchetype(archetype: ParsedArchetype): Archetype {
  const { extendsName: _extendsName, ...definition } = archetype;
  if (!archetype.extendsName) {
    return definition;
  }
  return {
    ...definition,
    dirs: mergeDirectories(archetype.dirs, BASE_ARCHETYPE.dirs),
    dirsLearning: mergeDirectories(archetype.dirsLearning, BASE_ARCHETYPE.dirsLearning),
    dirsAbsorption: mergeDirectories(archetype.dirsAbsorption, BASE_ARCHETYPE.dirsAbsorption),
    templates: mergeTemplatesByPath(BASE_ARCHETYPE.templates, archetype.templates),
  };
}

/**
 * Merge directory lists by path. The first list to declare a path owns its
 * position and its wording; later lists only fill in a purpose the earlier one
 * left empty. Callers order the lists by authority — an archetype's own
 * declaration comes before the base defaults, so an
 * archetype can name a shared directory in its own terms.
 */
export function mergeDirectories(
  ...lists: readonly (readonly ArchetypeDirectory[])[]
): ArchetypeDirectory[] {
  const merged = new Map<string, ArchetypeDirectory>();
  for (const list of lists) {
    for (const directory of list) {
      const existing = merged.get(directory.path);
      if (!existing) {
        merged.set(directory.path, directory);
      } else if (existing.purpose === "" && directory.purpose !== "") {
        merged.set(directory.path, { ...existing, purpose: directory.purpose });
      }
    }
  }
  return [...merged.values()];
}

/** Later entries win, so an archetype can override base templates such as README.md. */
function mergeTemplatesByPath(
  base: readonly ArchetypeTemplateEntry[],
  overrides: readonly ArchetypeTemplateEntry[],
): ArchetypeTemplateEntry[] {
  const merged = new Map<string, ArchetypeTemplateEntry>();
  for (const entry of [...base, ...overrides]) {
    merged.set(entry.path, entry);
  }
  return [...merged.values()];
}

async function readInstalledManifest(root: string): Promise<FrameworkManifest | null> {
  try {
    return await loadManifest(root);
  } catch {
    return null;
  }
}

export async function readInstalledArchetype(root: string): Promise<ProjectArchetype | null> {
  const manifest = await readInstalledManifest(root);
  return manifest?.project.archetype ?? null;
}

export async function loadInstalledArchetype(root: string): Promise<Archetype | null> {
  const archetype = await readInstalledArchetype(root);
  return archetype ? loadArchetype(archetype, { root }) : null;
}

function archetypeLookupLocations(options: ArchetypeLookupOptions): ArchetypeLookupLocation[] {
  const locations: ArchetypeLookupLocation[] = [];
  if (options.root) {
    locations.push({
      source: "project",
      directory: path.join(options.root, PROJECT_ARCHETYPES_DIR),
    });
  }
  locations.push({
    source: "user",
    directory: options.userArchetypesDir ?? path.join(homedir(), ".assay", "archetypes"),
  });
  locations.push({
    source: "built-in",
    directory: options.builtinArchetypesDir ?? BUILTIN_ARCHETYPES_DIR,
  });
  return locations;
}

async function listArchetypesInDirectory(
  location: ArchetypeLookupLocation,
): Promise<AvailableArchetype[]> {
  let entries: string[];
  try {
    entries = await readdir(location.directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => path.basename(entry, ".yaml"))
    .filter((name) => name !== "base")
    .filter(isValidArchetypeName)
    .map((name) => ({
      name,
      source: location.source,
      path: path.join(location.directory, `${name}.yaml`),
    }));
}

function normalizeArchetypeName(name: string): ProjectArchetype {
  const trimmed = name.trim();
  if (!isValidArchetypeName(trimmed)) {
    throw new FrameworkError(
      `invalid archetype name '${name}'; use a non-empty file stem without path separators`,
      { code: "IO_ERROR" },
    );
  }
  return trimmed;
}

function isValidArchetypeName(name: string): boolean {
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

async function archetypeNotFoundError(
  name: string,
  options: ArchetypeLookupOptions,
): Promise<FrameworkError> {
  const available = await listAvailableArchetypes(options);
  const availableText =
    available.length === 0
      ? "none"
      : available.map((archetype) => `${archetype.name} (${archetype.source})`).join(", ");
  const removal = REMOVED_ARCHETYPES.get(name);
  const headline = removal
    ? `archetype '${name}' was removed in Assay ${removal.removedIn} (${removal.hint})`
    : `archetype not found: ${name}`;
  return new FrameworkError(`${headline}. Available archetypes: ${availableText}`, {
    code: "IO_ERROR",
  });
}
