import { stat } from "node:fs/promises";
import path from "node:path";

import { MANAGED_DIR } from "./constants.js";
import {
  FrameworkAlreadyExistsError,
  FrameworkError,
  WorkspaceCutoverRequiredError,
} from "./errors.js";
import { loadManifest } from "./manifest.js";
import { toPosixPath } from "./serialization.js";

// `.framework` is a locator-only marker. It lets commands started below a
// retired workspace reach `loadManifest`, whose raw envelope probe returns the
// stable cutover error; no legacy path is parsed or treated as active state.
const AUTHORITY_MARKERS = [`${MANAGED_DIR}/manifest.json`, ".framework/manifest.json"] as const;
const WEAK_ROOT_MARKERS = ["references", "analyses", "systems", "iterations"] as const;

async function pathExists(target: string): Promise<boolean> {
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

async function isExistingFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function relativeDisplayPath(targetPath: string, root: string): string {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosixPath(relative);
  }

  if (relative === "") {
    return ".";
  }

  return toPosixPath(targetPath);
}

/**
 * True when `target` resolves to `root` itself or to something inside it.
 * Comparison happens on resolved absolute paths, so `..` segments, mixed
 * separators, and absolute inputs are all handled.
 */
export function isContainedPath(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (resolvedTarget === resolvedRoot) {
    return true;
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve a caller-supplied workspace-relative path and refuse anything that
 * leaves `root`. Commands that accept a path argument (`analysis close`,
 * `iteration close`, `analysis new --for-reference`, ...) must route through
 * this before reading or writing, otherwise `../outside.md` lets a workspace
 * command rewrite files above its own root.
 *
 * Returns the absolute path plus the normalized POSIX form suitable for event
 * payloads and result fields.
 */
export function resolveContainedPath(
  root: string,
  relativePath: string,
  label: string,
): { readonly absolutePath: string; readonly relativePath: string } {
  const normalized = toPosixPath(relativePath).replace(/^\.\//, "");
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, normalized);
  if (path.isAbsolute(normalized) || !isContainedPath(resolvedRoot, normalized)) {
    throw new FrameworkError(`${label} escapes the workspace: ${relativePath}`, {
      code: "IO_ERROR",
    });
  }
  return {
    absolutePath,
    relativePath: toPosixPath(path.relative(resolvedRoot, absolutePath)),
  };
}

export function slugify(text: string): string {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return value || "untitled";
}

export async function discoverFrameworkRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  if (await isExistingFile(current)) {
    current = path.dirname(current);
  }

  const candidates = [current];
  let parent = path.dirname(current);
  while (parent !== current) {
    candidates.push(parent);
    current = parent;
    parent = path.dirname(current);
  }

  // Authority markers win across the entire ancestor chain. A nested weak
  // folder such as `systems/` must never hide an enclosing Assay workspace.
  for (const candidate of candidates) {
    for (const marker of AUTHORITY_MARKERS) {
      if (await pathExists(path.join(candidate, marker))) {
        return candidate;
      }
    }
  }

  for (const candidate of candidates) {
    for (const marker of WEAK_ROOT_MARKERS) {
      if (await pathExists(path.join(candidate, marker))) {
        return candidate;
      }
    }
  }

  return path.resolve(start);
}

/**
 * Creation/conversion entry points must not establish a second workspace
 * below an existing authority. Retired `.framework` ancestors are surfaced
 * through the same raw-envelope cutover error as direct workspace access.
 */
export async function assertNoAncestorWorkspaceAuthority(target: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  let candidate = path.dirname(resolvedTarget);
  while (candidate !== path.dirname(candidate)) {
    if (await pathExists(path.join(candidate, MANAGED_DIR, "manifest.json"))) {
      const manifest = await loadManifest(candidate);
      if (manifest) {
        throw new FrameworkAlreadyExistsError(
          `Target is nested under an existing Assay workspace: ${candidate}`,
        );
      }
    }
    if (await pathExists(path.join(candidate, ".framework", "manifest.json"))) {
      await loadManifest(candidate);
      throw new WorkspaceCutoverRequiredError(".framework:unknown+sunknown+lunknown");
    }
    candidate = path.dirname(candidate);
  }
}
