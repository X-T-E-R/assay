import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { TempDirectoryFixture } from "./filesystem.js";
import { pathExists } from "./filesystem.js";

export async function createIsolatedRegistryRoot(
  tempDirs: TempDirectoryFixture,
  directoryName = "registry",
): Promise<string> {
  return path.join(await tempDirs.createTempDir(), directoryName);
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
