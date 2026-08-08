import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { PLUGINS_STATE_FILE } from "../constants.js";
import { InvalidManifestError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import { type PluginsState, pluginsStateSchema } from "../schemas/index.js";
import { stringifySortedJson } from "../serialization.js";
import { withWorkspaceMutationCoordination } from "../tasks/task-storage.js";
import { nowIso } from "../time.js";
import { getPluginDefinition } from "./registry.js";

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

function validateCurrentPluginReceipts(state: PluginsState, file: string): PluginsState {
  for (const id of Object.keys(state.plugins)) {
    if (!getPluginDefinition(id)) {
      const message =
        id === "assay.intent"
          ? "Assay plugin state contains the retired assay.intent receipt."
          : `Assay plugin state contains an unsupported built-in receipt: ${id}.`;
      throw new InvalidManifestError(file, message);
    }
  }
  return state;
}

function parsePluginsState(text: string, file: string): PluginsState {
  try {
    return validateCurrentPluginReceipts(pluginsStateSchema.parse(JSON.parse(text)), file);
  } catch (error) {
    if (error instanceof InvalidManifestError) throw error;
    throw new InvalidManifestError(file, "Assay plugin state failed validation.", {
      cause: error,
    });
  }
}

function comparablePluginStatePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function validateExistingPluginStateBeforeOverwrite(file: string): Promise<void> {
  const before = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new InvalidManifestError(
      file,
      "Assay plugin state must be a single regular file, not a redirect.",
    );
  }
  if (comparablePluginStatePath(await realpath(file)) !== comparablePluginStatePath(file)) {
    throw new InvalidManifestError(file, "Assay plugin state resolves through a redirect.");
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.nlink !== 1
  ) {
    throw new InvalidManifestError(
      file,
      "Assay plugin state identity changed while it was being read.",
    );
  }
  parsePluginsState(bytes.toString("utf8"), file);
}

export async function loadPluginsState(root: string): Promise<PluginsState | null> {
  await loadManifest(root);
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

  return parsePluginsState(text, file);
}

export async function savePluginsState(
  root: string,
  state: PluginsState,
  now = new Date(),
): Promise<PluginsState> {
  await loadManifest(root);
  const file = pluginsStatePath(root);
  await validateExistingPluginStateBeforeOverwrite(file);
  const next = validateCurrentPluginReceipts(
    pluginsStateSchema.parse({
      ...state,
      updated_at: nowIso(now),
    }),
    file,
  );
  return withWorkspaceMutationCoordination(root, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stringifySortedJson(next), "utf8");
    return next;
  });
}
