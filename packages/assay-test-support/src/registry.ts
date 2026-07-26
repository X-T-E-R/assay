import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TempDirectoryFixture } from "./filesystem.js";
import { pathExists } from "./filesystem.js";

/** Environment variable that redirects Assay's project registry. */
export const REGISTRY_ROOT_ENV = "ASSAY_PROJECT_REGISTRY_ROOT";

export async function createIsolatedRegistryRoot(
  tempDirs: TempDirectoryFixture,
  directoryName = "registry",
): Promise<string> {
  return path.join(await tempDirs.createTempDir(), directoryName);
}

/**
 * A registry root unique to the current process, derived rather than random so
 * repeated imports inside one worker agree on the same location.
 */
export function isolatedRegistryRootForProcess(): string {
  return path.join(os.tmpdir(), `assay-test-registry-${process.pid}`, "projects");
}

/** Where Assay writes project records when nothing redirects it. */
export function userProjectRegistryRoot(): string {
  return path.join(os.homedir(), ".assay", "projects");
}

/**
 * Content-independent fingerprint of a registry directory: entry names with
 * their size and modification time. Enough to detect a record being added,
 * removed, or rewritten without reading hundreds of files, and it treats a
 * missing directory as empty so "the tests created it" is also a difference.
 */
export async function fingerprintRegistry(registryRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(registryRoot);
  } catch {
    return [];
  }
  const fingerprints = await Promise.all(
    entries.sort().map(async (entry) => {
      try {
        const stats = await stat(path.join(registryRoot, entry));
        return `${entry} ${stats.size} ${stats.mtimeMs}`;
      } catch {
        return `${entry} (unreadable)`;
      }
    }),
  );
  return fingerprints;
}

/**
 * Entries that differ between two registry fingerprints, as
 * `+ added` / `- removed` lines. Empty means the registry is untouched.
 */
export function diffRegistryFingerprints(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.filter((entry) => !beforeSet.has(entry)).map((entry) => `+ ${entry}`),
    ...before.filter((entry) => !afterSet.has(entry)).map((entry) => `- ${entry}`),
  ];
}

export async function readRegistrySnapshot(registryRoot: string): Promise<Record<string, string>> {
  if (!(await pathExists(registryRoot))) {
    return {};
  }
  const entries = (await readdir(registryRoot)).sort();
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(path.join(registryRoot, entry), "utf8")]),
    ),
  );
}
