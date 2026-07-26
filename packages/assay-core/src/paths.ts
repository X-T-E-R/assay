import { stat } from "node:fs/promises";
import path from "node:path";

import { LEGACY_MANAGED_DIR, MANAGED_DIR } from "./constants.js";
import { FrameworkError } from "./errors.js";
import { toPosixPath } from "./serialization.js";

// `.assay` (v4+) is the primary marker; `.framework` is kept as a legacy
// fallback so v3 workspaces are still discovered until they are migrated.
const ROOT_MARKERS = [
  MANAGED_DIR,
  LEGACY_MANAGED_DIR,
  "references",
  "analyses",
  "systems",
  "iterations",
] as const;

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

  for (const candidate of candidates) {
    for (const marker of ROOT_MARKERS) {
      if (await pathExists(path.join(candidate, marker))) {
        return candidate;
      }
    }
  }

  return path.resolve(start);
}
