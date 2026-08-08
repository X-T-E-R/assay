import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PLUGINS_STATE_FILE } from "../constants.js";
import { InvalidManifestError } from "../errors.js";
import { type PluginsState, pluginsStateSchema } from "../schemas/index.js";
import { stringifySortedJson } from "../serialization.js";
import { withWorkspaceMutationCoordination } from "../tasks/task-storage.js";
import { nowIso } from "../time.js";

export function pluginsStatePath(root: string): string {
  return path.join(root, PLUGINS_STATE_FILE);
}

export function defaultPluginsState(now = new Date()): PluginsState {
  return {
    __schema: 1,
    plugins: {},
    updated_at: nowIso(now),
  };
}

export async function loadPluginsState(root: string): Promise<PluginsState | null> {
  const file = pluginsStatePath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return pluginsStateSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new InvalidManifestError(file, "Assay plugin state failed validation.", {
      cause: error,
    });
  }
}

export async function savePluginsState(
  root: string,
  state: PluginsState,
  now = new Date(),
): Promise<PluginsState> {
  return withWorkspaceMutationCoordination(root, async () => {
    const file = pluginsStatePath(root);
    const next = pluginsStateSchema.parse({
      ...state,
      updated_at: nowIso(now),
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stringifySortedJson(next), "utf8");
    return next;
  });
}
