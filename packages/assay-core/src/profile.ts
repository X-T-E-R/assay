import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { MANAGED_DIR, MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import { pluginCapabilities } from "./plugins/registry.js";
import { loadPluginsState } from "./plugins/state.js";
import type {
  FrameworkManifest,
  PluginsState,
  ProjectArchetype,
  ProjectMode,
} from "./schemas/index.js";

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
  readonly modules: readonly CapabilityModule[];
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

export const SUPPORTED_CAPABILITY_MODULES = ["intent", "iteration"] as const;
export type CapabilityModule = (typeof SUPPORTED_CAPABILITY_MODULES)[number];

const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_CAPABILITY_MODULES);

/** Directories and templates one capability module owns. */
export interface ModuleScaffold {
  readonly dirs: readonly ArchetypeDirectory[];
  readonly templates: readonly ArchetypeTemplateEntry[];
}

/**
 * Structure each capability module contributes to a workspace. `init` and
 * `assay capability add` scaffold through this table, so a module enabled
 * after init lands the same layout it would have at init time. Paths are
 * declared workspace-root-relative like archetype templates and are translated
 * through the workspace layout before anything is written.
 *
 * Archetype YAML may declare the same paths; both scaffold paths merge by path
 * so an overlapping file is written once.
 */
export const MODULE_SCAFFOLDS: Readonly<Record<CapabilityModule, ModuleScaffold>> = {
  intent: {
    dirs: [
      { path: "intent/original", purpose: "Verbatim intent captures, append-only" },
      { path: "intent/requirements", purpose: "Requirements derived from a capture" },
    ],
    templates: [
      { path: "intent/README.md", templateId: "intent.readme" },
      { path: "intent/original/README.md", templateId: "intent.original.readme" },
      { path: "intent/requirements/README.md", templateId: "intent.requirements.readme" },
    ],
  },
  iteration: {
    dirs: [
      { path: "iterations", purpose: "Controlled changes to your own systems, one folder each" },
      { path: "iterations/templates", purpose: "Blank iteration plans" },
    ],
    templates: [
      { path: "iterations/README.md", templateId: "iterations.readme" },
      { path: "iterations/templates/iteration-plan.md", templateId: "iterations.template.plan" },
    ],
  },
};

/** Directories the given capability modules own, deduplicated by path. */
export function capabilityDirectories(
  capabilities: readonly CapabilityModule[],
): ArchetypeDirectory[] {
  return mergeDirectories(...capabilities.map((capability) => MODULE_SCAFFOLDS[capability].dirs));
}

export function isCapabilityModule(value: string): value is CapabilityModule {
  return SUPPORTED_CAPABILITY_SET.has(value);
}

/**
 * Narrow user input to a capability module this build can scaffold. Unknown
 * names are rejected here rather than recorded in the manifest, so a typo
 * cannot leave a workspace declaring a capability nothing implements.
 */
export function requireCapabilityModule(value: string): CapabilityModule {
  const trimmed = value.trim();
  if (isCapabilityModule(trimmed)) {
    return trimmed;
  }
  throw new FrameworkError(
    `unsupported capability module '${value}'; supported modules: ${SUPPORTED_CAPABILITY_MODULES.join(", ")}`,
  );
}

/** Supported capability modules a manifest declares, deduplicated and sorted. */
export function declaredCapabilities(
  manifest: Pick<FrameworkManifest, "project"> | null | undefined,
): CapabilityModule[] {
  const declared = new Set<CapabilityModule>();
  for (const value of manifest?.project.capabilities ?? []) {
    if (isCapabilityModule(value)) {
      declared.add(value);
    }
  }
  return [...declared].sort();
}

/**
 * Capability modules a workspace actually has: the archetype's own modules
 * plus every module added later through `assay capability add`. Manifest
 * entries this build does not implement are ignored here; `capability list`
 * reports them so they stay visible.
 */
export function effectiveCapabilities(
  archetype: Pick<Archetype, "modules"> | null | undefined,
  capabilities: readonly string[] | undefined,
  plugins?: FrameworkManifest["plugins"],
  pluginState?: PluginsState | null,
): CapabilityModule[] {
  const modules = new Set<CapabilityModule>(archetype?.modules ?? []);
  for (const value of [...(capabilities ?? []), ...pluginCapabilities(plugins, pluginState)]) {
    if (isCapabilityModule(value)) {
      modules.add(value);
    }
  }
  return [...modules].sort();
}
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
  modules: [],
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
  const extendsName = parseOptionalString(record.extends, "extends", name);
  if (extendsName && extendsName !== "base") {
    throw new FrameworkError(
      `unsupported archetype extension '${extendsName}' in archetype ${name}; supported extension: base`,
      { code: "IO_ERROR" },
    );
  }

  const mode = parseProjectMode(record.mode, name);
  const modules = parseModuleList(record.modules, name);
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
    modules,
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

function parseModuleList(value: unknown, archetypeName: ProjectArchetype): CapabilityModule[] {
  const modules = parseStringList(value, "modules", archetypeName);
  return modules.map((module) => parseCapabilityModule(module, archetypeName));
}

function parseStringList(value: unknown, field: string, archetypeName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FrameworkError(`invalid ${field} in archetype ${archetypeName}: expected list`, {
      code: "IO_ERROR",
    });
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new FrameworkError(`invalid ${field} entry in archetype ${archetypeName}`, {
        code: "IO_ERROR",
      });
    }
    return item.trim();
  });
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
      return { path: item.trim(), purpose: "" };
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
    return {
      path: record.path.trim(),
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
    const content = parseOptionalTemplateContent(record.content, "content", archetypeName);
    const file = parseOptionalString(record.file, "file", archetypeName);
    if (content !== null && file !== null) {
      throw new FrameworkError(
        `template entry '${record.path.trim()}' in archetype ${archetypeName} sets both content and file; use one`,
        { code: "IO_ERROR" },
      );
    }
    return {
      path: record.path.trim(),
      templateId: record.templateId.trim(),
      ...(content !== null ? { content } : {}),
      ...(file !== null ? { file } : {}),
    };
  });
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

function parseCapabilityModule(value: string, archetypeName: ProjectArchetype): CapabilityModule {
  if (SUPPORTED_CAPABILITY_SET.has(value)) {
    return value as CapabilityModule;
  }
  throw new FrameworkError(
    `unsupported capability module '${value}' in archetype ${archetypeName}; supported modules: ${SUPPORTED_CAPABILITY_MODULES.join(", ")}`,
    { code: "IO_ERROR" },
  );
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
 * declaration comes before the base and capability-module defaults, so an
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

export function archetypeHasCapability(
  archetype: Archetype,
  capability: CapabilityModule,
): boolean {
  return archetype.modules.includes(capability);
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

export async function installedArchetypeHasCapability(
  root: string,
  capability: CapabilityModule,
): Promise<boolean> {
  const manifest = await readInstalledManifest(root);
  if (!manifest) {
    return false;
  }
  const archetype = await loadArchetype(manifest.project.archetype, { root });
  const state = await loadPluginsState(root);
  return effectiveCapabilities(
    archetype,
    manifest.project.capabilities,
    manifest.plugins,
    state,
  ).includes(capability);
}

export const isCapabilityEnabled = installedArchetypeHasCapability;

export async function requireCapability(
  root: string,
  capability: CapabilityModule,
): Promise<Archetype> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}.`,
    );
  }
  const archetype = await loadArchetype(manifest.project.archetype, { root });
  const state = await loadPluginsState(root);
  if (
    !effectiveCapabilities(
      archetype,
      manifest.project.capabilities,
      manifest.plugins,
      state,
    ).includes(capability)
  ) {
    const enableCommand =
      capability === "intent"
        ? "assay plugin add assay.intent"
        : `assay capability add ${capability}`;
    throw new FrameworkError(
      `capability not enabled in archetype ${manifest.project.archetype}: ${capability}. Run \`${enableCommand}\` to enable it in this workspace.`,
    );
  }
  return archetype;
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
