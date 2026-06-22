import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { FrameworkError } from "./errors.js";
import { toPosixPath } from "./serialization.js";

/**
 * A profile is the framework's structure definition expressed as data (ADR-0005).
 * It declares which directories `init` creates, which template files it writes,
 * the default mode, and which governance modules are enabled. Profiles are
 * versioned and can evolve without editing source constants.
 */
export interface ProfileTemplateEntry {
  readonly path: string;
  readonly templateId: string;
}

export interface Profile {
  readonly name: string;
  readonly version: number;
  readonly mode: "learning" | "absorption";
  readonly modules: readonly string[];
  /** Directories created in all modes. */
  readonly dirs: readonly string[];
  /** Directories created only in learning mode. */
  readonly dirsLearning: readonly string[];
  /** Directories created only in absorption mode. */
  readonly dirsAbsorption: readonly string[];
  readonly templates: readonly ProfileTemplateEntry[];
}

/**
 * Return the full directory list for a given mode: shared dirs + mode-specific
 * dirs. Used by `init` to create the right structure per mode.
 */
export function dirsForMode(profile: Profile, mode: "learning" | "absorption"): readonly string[] {
  return [
    ...profile.dirs,
    ...(mode === "absorption" ? profile.dirsAbsorption : profile.dirsLearning),
  ];
}

const DEFAULT_PROFILE_NAME = "metasystem";

// Resolve the profiles/ directory relative to this module. In ESM there is no
// __dirname, so use import.meta.url. The profiles directory sits beside src/
// (at the package root), so from dist/profile.js we go up one level.
const PROFILES_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "profiles");

/**
 * Load a profile by name from the profiles/ directory bundled with the core
 * package. Returns the parsed profile. Throws if the profile is missing or
 * malformed.
 */
export async function loadProfile(name: string = DEFAULT_PROFILE_NAME): Promise<Profile> {
  const profilePath = path.join(PROFILES_DIR, `${name}.yaml`);
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch {
    throw new FrameworkError(`profile not found: ${name} (looked at ${profilePath})`, {
      code: "IO_ERROR",
    });
  }
  return parseProfileYaml(raw, name);
}

/**
 * Minimal YAML parser for the subset of syntax our profiles use: top-level
 * `key: value`, `key:` followed by a list of `- item` lines, and inline
 * `{ path: "...", templateId: "..." }` flow mappings. We avoid a YAML
 * dependency because profiles are small and structured.
 */
function parseProfileYaml(raw: string, name: string): Profile {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  let version = 1;
  let mode: "learning" | "absorption" = "learning";
  const modules: string[] = [];
  const dirs: string[] = [];
  const dirsLearning: string[] = [];
  const dirsAbsorption: string[] = [];
  const templates: ProfileTemplateEntry[] = [];
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
        modules.push(value);
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

    if (key === "version") {
      version = Number.parseInt(value, 10);
    } else if (key === "mode") {
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
    throw new FrameworkError(`profile '${name}' has no dirs`, { code: "IO_ERROR" });
  }

  return { name, version, mode, modules, dirs, dirsLearning, dirsAbsorption, templates };
}

/**
 * Parse an inline flow mapping like `{ path: "...", templateId: "..." }`.
 */
function parseTemplateEntry(value: string): ProfileTemplateEntry {
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

export const DEFAULT_PROFILE = DEFAULT_PROFILE_NAME;

export { CURRENT_VERSION, LAYOUT_VERSION, toPosixPath };
