import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { MANIFEST_FILE } from "./constants.js";
import { FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import type { ProjectArchetype, ProjectMode } from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";

/**
 * An archetype is the framework's structure definition expressed as data.
 * It declares which directories `init` creates, which template files it writes,
 * the default absorb mode, and which optional capability modules are enabled.
 */
export interface ArchetypeTemplateEntry {
  readonly path: string;
  readonly templateId: string;
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

/**
 * Return the full directory list for a given mode: shared dirs + mode-specific
 * dirs. Used by `init` to create the right structure per mode.
 */
export function dirsForArchetype(archetype: Archetype, mode: ProjectMode): readonly string[] {
  return [
    ...archetype.dirs,
    ...(mode === "absorption" ? archetype.dirsAbsorption : archetype.dirsLearning),
  ];
}

export type ProfileTemplateEntry = ArchetypeTemplateEntry;
export type Profile = Archetype;

export const SUPPORTED_CAPABILITY_MODULES = ["adr", "iteration", "events"] as const;
export type CapabilityModule = (typeof SUPPORTED_CAPABILITY_MODULES)[number];

const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_CAPABILITY_MODULES);

const CAPABILITY_SCAFFOLD: Readonly<
  Record<
    CapabilityModule,
    {
      readonly dirs: readonly string[];
      readonly templates: readonly ArchetypeTemplateEntry[];
    }
  >
> = {
  adr: {
    dirs: ["knowledge/decisions"],
    templates: [
      { path: "knowledge/decisions/README.md", templateId: "knowledge.decisions.readme" },
      {
        path: "knowledge/decisions/ADR-TEMPLATE.md",
        templateId: "knowledge.decisions.adr_template",
      },
    ],
  },
  iteration: {
    dirs: ["iterations/templates"],
    templates: [
      { path: "iterations/README.md", templateId: "iterations.readme" },
      { path: "iterations/templates/iteration-plan.md", templateId: "iterations.template.plan" },
    ],
  },
  events: {
    dirs: [".framework/events"],
    templates: [{ path: ".framework/events/.gitkeep", templateId: "framework.events.gitkeep" }],
  },
};

const OPTIONAL_CAPABILITY_DIRS = new Set(
  Object.values(CAPABILITY_SCAFFOLD).flatMap((capability) => capability.dirs),
);
const OPTIONAL_CAPABILITY_TEMPLATE_PATHS = new Set(
  Object.values(CAPABILITY_SCAFFOLD).flatMap((capability) =>
    capability.templates.map((template) => template.path),
  ),
);
const OPTIONAL_CAPABILITY_TEMPLATE_IDS = new Set(
  Object.values(CAPABILITY_SCAFFOLD).flatMap((capability) =>
    capability.templates.map((template) => template.templateId),
  ),
);

export const DEFAULT_ARCHETYPE: ProjectArchetype = "research";
const DEPRECATED_ARCHETYPE_ALIASES: Readonly<Record<string, ProjectArchetype>> = {
  metasystem: "research",
};

// Resolve the profiles/ directory relative to this module. In ESM there is no
// __dirname, so use import.meta.url. The profiles directory sits beside src/
// (at the package root), so from dist/profile.js we go up one level.
const PROFILES_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "profiles");

/**
 * Load an archetype by name from the profiles/ directory bundled with the core
 * package. `metasystem` is a deprecated one-cycle alias for `research`.
 */
export async function loadArchetype(name: string = DEFAULT_ARCHETYPE): Promise<Archetype> {
  const archetypeName = canonicalArchetypeName(name);
  const profilePath = path.join(PROFILES_DIR, `${archetypeName}.yaml`);
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch {
    throw new FrameworkError(`archetype not found: ${name} (looked at ${profilePath})`, {
      code: "IO_ERROR",
    });
  }
  return parseArchetypeYaml(raw, archetypeName);
}

/**
 * Minimal YAML parser for the subset of syntax our archetypes use: top-level
 * `key: value`, `key:` followed by a list of `- item` lines, and inline
 * `{ path: "...", templateId: "..." }` flow mappings. We avoid a YAML
 * dependency because archetypes are small and structured.
 */
function parseArchetypeYaml(raw: string, name: ProjectArchetype): Archetype {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  let mode: ProjectMode = "learning";
  const modules: CapabilityModule[] = [];
  const dirs: string[] = [];
  const dirsLearning: string[] = [];
  const dirsAbsorption: string[] = [];
  const templates: ArchetypeTemplateEntry[] = [];
  let currentList: "modules" | "dirs" | "dirs_learning" | "dirs_absorption" | "templates" | null =
    null;

  for (const line of lines) {
    // Skip comments and blank lines.
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // List item under a current list section.
    if (trimmed.startsWith("-") && currentList) {
      const value = trimmed.slice(1).trim();
      if (currentList === "modules") {
        modules.push(parseCapabilityModule(value, name));
      } else if (currentList === "dirs") {
        dirs.push(value);
      } else if (currentList === "dirs_learning") {
        dirsLearning.push(value);
      } else if (currentList === "dirs_absorption") {
        dirsAbsorption.push(value);
      } else if (currentList === "templates") {
        templates.push(parseTemplateEntry(value));
      }
      continue;
    }

    // Top-level key: value.
    currentList = null;
    const match = trimmed.match(/^([a-z_]+):\s*(.*)$/);
    if (!match || match[1] === undefined) continue;
    const key = match[1];
    const value = match[2]?.trim() ?? "";

    if (key === "mode") {
      mode = value === "absorption" ? "absorption" : "learning";
    } else if (key === "modules") {
      currentList = "modules";
    } else if (key === "dirs") {
      currentList = "dirs";
    } else if (key === "dirs_learning") {
      currentList = "dirs_learning";
    } else if (key === "dirs_absorption") {
      currentList = "dirs_absorption";
    } else if (key === "templates") {
      currentList = "templates";
    }
  }

  if (dirs.length === 0) {
    throw new FrameworkError(`archetype '${name}' has no dirs`, { code: "IO_ERROR" });
  }

  return withCapabilityScaffold({
    name,
    mode,
    modules,
    dirs,
    dirsLearning,
    dirsAbsorption,
    templates,
  });
}

function canonicalArchetypeName(name: string): ProjectArchetype {
  if (name === "research" || name === "contest" || name === "library") return name;
  const alias = DEPRECATED_ARCHETYPE_ALIASES[name];
  if (alias) return alias;
  throw new FrameworkError(`unsupported archetype: ${name}`);
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function withCapabilityScaffold(archetype: Archetype): Archetype {
  const enabled = new Set(archetype.modules);
  const capabilityDirs = archetype.modules.flatMap((module) => CAPABILITY_SCAFFOLD[module].dirs);
  const capabilityTemplates = archetype.modules.flatMap(
    (module) => CAPABILITY_SCAFFOLD[module].templates,
  );

  return {
    ...archetype,
    dirs: unique([
      ...archetype.dirs.filter((directory) => !OPTIONAL_CAPABILITY_DIRS.has(directory)),
      ...capabilityDirs,
    ]),
    templates: [
      ...archetype.templates.filter(
        (template) =>
          !OPTIONAL_CAPABILITY_TEMPLATE_PATHS.has(template.path) &&
          !OPTIONAL_CAPABILITY_TEMPLATE_IDS.has(template.templateId),
      ),
      ...capabilityTemplates.filter((template) => enabled.has(capabilityForTemplate(template))),
    ],
  };
}

function capabilityForTemplate(template: ArchetypeTemplateEntry): CapabilityModule {
  for (const [capability, scaffold] of Object.entries(CAPABILITY_SCAFFOLD) as Array<
    [CapabilityModule, (typeof CAPABILITY_SCAFFOLD)[CapabilityModule]]
  >) {
    if (
      scaffold.templates.some(
        (candidate) =>
          candidate.path === template.path || candidate.templateId === template.templateId,
      )
    ) {
      return capability;
    }
  }
  throw new FrameworkError(`internal error: unknown capability template ${template.templateId}`);
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
  return archetype ? loadArchetype(archetype) : null;
}

export async function isCapabilityEnabled(
  root: string,
  capability: CapabilityModule,
): Promise<boolean> {
  const archetype = await loadInstalledArchetype(root);
  return archetype ? archetypeHasCapability(archetype, capability) : false;
}

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
  const archetype = await loadArchetype(manifest.project.archetype);
  if (!archetypeHasCapability(archetype, capability)) {
    throw new FrameworkError(
      `capability not enabled in archetype ${manifest.project.archetype}: ${capability}`,
    );
  }
  return archetype;
}

/**
 * Parse an inline flow mapping like `{ path: "...", templateId: "..." }`.
 */
function parseTemplateEntry(value: string): ArchetypeTemplateEntry {
  const inner = value.replace(/^\{/, "").replace(/\}$/, "").trim();
  let entryPath = "";
  let templateId = "";
  for (const part of inner.split(",")) {
    const kv = part.trim().match(/^([a-zA-Z_]+):\s*"(.*)"$/);
    if (!kv || kv[1] === undefined || kv[2] === undefined) continue;
    if (kv[1] === "path") entryPath = kv[2];
    else if (kv[1] === "templateId") templateId = kv[2];
  }
  if (!entryPath || !templateId) {
    throw new FrameworkError(`malformed template entry: ${value}`, { code: "IO_ERROR" });
  }
  return { path: entryPath, templateId };
}

export const DEFAULT_PROFILE = DEFAULT_ARCHETYPE;
export const dirsForMode = dirsForArchetype;
export const loadProfile = loadArchetype;

export { CURRENT_VERSION, LAYOUT_VERSION, toPosixPath };
