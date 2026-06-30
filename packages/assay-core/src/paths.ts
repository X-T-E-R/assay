import { stat } from "node:fs/promises";
import path from "node:path";

import { MANAGED_DIR } from "./constants.js";
import { toPosixPath } from "./serialization.js";

const ROOT_MARKERS = [MANAGED_DIR, "references", "analyses", "systems", "iterations"] as const;

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
