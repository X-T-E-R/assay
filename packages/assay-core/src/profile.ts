import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { MANAGED_DIR, MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import type { ProjectArchetype, ProjectMode } from "./schemas/index.js";

export interface ArchetypeTemplateEntry {
  readonly path: string;
  readonly templateId: string;
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

export interface Archetype {
  readonly name: ProjectArchetype;
  readonly mode: ProjectMode;
  readonly modules: readonly CapabilityModule[];
  /** Directories created in all modes. */
  readonly dirs: readonly string[];
  /** Directories created only in learning mode. */
  readonly dirsLearning: readonly string[];
  /** Directories created only in absorption mode. */
  readonly dirsAbsorption: readonly string[];
  readonly templates: readonly ArchetypeTemplateEntry[];
}

export function dirsForArchetype(archetype: Archetype, mode: ProjectMode): readonly string[] {
  return [
    ...archetype.dirs,
    ...(mode === "absorption" ? archetype.dirsAbsorption : archetype.dirsLearning),
  ];
}

export type ProfileTemplateEntry = ArchetypeTemplateEntry;
export type Profile = Archetype;

export const SUPPORTED_CAPABILITY_MODULES = ["adr", "iteration"] as const;
export type CapabilityModule = (typeof SUPPORTED_CAPABILITY_MODULES)[number];

const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_CAPABILITY_MODULES);
const DEFAULT_ARCHETYPE: ProjectArchetype = "study";
const PROJECT_ARCHETYPES_DIR = path.join(MANAGED_DIR, "archetypes");
const BUILTIN_ARCHETYPES_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "profiles");

const BASE_ARCHETYPE: Archetype = {
  name: "base",
  mode: "learning",
  modules: [],
  dirs: [`${MANAGED_DIR}/backups`, `${MANAGED_DIR}/migrations`, "systems", "knowledge"],
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

interface ParsedArchetype extends Archetype {
  readonly extendsName: string | null;
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
 */
export async function loadArchetype(
  name: string | undefined = DEFAULT_ARCHETYPE,
  options: ArchetypeLookupOptions = {},
): Promise<Archetype> {
  const archetypeName = normalizeArchetypeName(name ?? DEFAULT_ARCHETYPE);
  if (archetypeName === "base") {
    throw await archetypeNotFoundError(archetypeName, options);
  }

  for (const location of archetypeLookupLocations(options)) {
    const archetypePath = path.join(location.directory, `${archetypeName}.yaml`);
    let raw: string;
    try {
      raw = await readFile(archetypePath, "utf8");
    } catch {
      continue;
    }
    return mergeBaseArchetype(parseArchetypeYaml(raw, archetypeName));
  }

  throw await archetypeNotFoundError(archetypeName, options);
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
  const dirs = parseStringList(record.dirs, "dirs", name);
  const dirsLearning = parseStringList(record.dirs_learning, "dirs_learning", name);
  const dirsAbsorption = parseStringList(record.dirs_absorption, "dirs_absorption", name);
  const templates = parseTemplateList(record.templates, name);

  if (!extendsName && dirs.length === 0) {
    throw new FrameworkError(`archetype '${name}' has no dirs`, { code: "IO_ERROR" });
  }

  return {
    name,
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

function parseTemplateList(value: unknown, archetypeName: string): ArchetypeTemplateEntry[] {
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
    return { path: record.path.trim(), templateId: record.templateId.trim() };
  });
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
    dirs: unique([...BASE_ARCHETYPE.dirs, ...archetype.dirs]),
    dirsLearning: unique([...BASE_ARCHETYPE.dirsLearning, ...archetype.dirsLearning]),
    dirsAbsorption: unique([...BASE_ARCHETYPE.dirsAbsorption, ...archetype.dirsAbsorption]),
    templates: [...BASE_ARCHETYPE.templates, ...archetype.templates],
  };
}

export function archetypeHasCapability(
  archetype: Archetype,
  capability: CapabilityModule,
): boolean {
  return archetype.modules.includes(capability);
}

export async function readInstalledArchetype(root: string): Promise<ProjectArchetype | null> {
  try {
    const manifest = await loadManifest(root);
    return manifest?.project.archetype ?? null;
  } catch {
    return null;
  }
}

export async function loadInstalledArchetype(root: string): Promise<Archetype | null> {
  const archetype = await readInstalledArchetype(root);
  return archetype ? loadArchetype(archetype, { root }) : null;
}

export async function installedArchetypeHasCapability(
  root: string,
  capability: CapabilityModule,
): Promise<boolean> {
  const archetype = await loadInstalledArchetype(root);
  return archetype ? archetypeHasCapability(archetype, capability) : false;
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
  if (!archetypeHasCapability(archetype, capability)) {
    throw new FrameworkError(
      `capability not enabled in archetype ${manifest.project.archetype}: ${capability}`,
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
  return new FrameworkError(
    `archetype not found: ${name}. Available archetypes: ${availableText}`,
    { code: "IO_ERROR" },
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
