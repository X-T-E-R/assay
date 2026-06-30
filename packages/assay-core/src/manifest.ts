import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_VERSION, LAYOUT_VERSION, MANIFEST_FILE } from "./constants.js";
import { InvalidManifestError } from "./errors.js";
import { computeHash } from "./hashing.js";
import {
  type FrameworkManifest,
  type ManagedFileRecord,
  type ProjectArchetype,
  type ProjectMode,
  frameworkManifestSchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";
import { nowIso } from "./time.js";

export interface TemplateLike {
  readonly path: string;
  readonly templateId?: string;
  readonly template_id?: string;
  readonly content: string;
  readonly executable?: boolean;
  readonly protected?: boolean;
}

export interface RecordManagedFileInput {
  readonly path: string;
  readonly templateId: string;
  readonly content: string;
  readonly executable?: boolean;
  readonly protected?: boolean;
}

export interface DefaultManifestOptions {
  readonly archetype?: ProjectArchetype;
  readonly mode?: ProjectMode;
}

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILE);
}

export function defaultManifest(
  project: string,
  manifestOptions: DefaultManifestOptions = {},
): FrameworkManifest {
  const createdAt = nowIso();
  return {
    __schema: 1,
    framework_version: CURRENT_VERSION,
    layout_version: LAYOUT_VERSION,
    created_at: createdAt,
    updated_at: createdAt,
    project: {
      name: project,
      archetype: manifestOptions.archetype ?? "research",
      mode: manifestOptions.mode ?? "learning",
    },
    managed_files: {},
    user_deleted: [],
    applied_migrations: [],
  };
}

function parseManifest(data: unknown, manifestFile: string): FrameworkManifest {
  const result = frameworkManifestSchema.safeParse(data);
  if (!result.success) {
    throw new InvalidManifestError(manifestFile, "Framework manifest failed validation.", {
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
}

export async function loadManifest(root: string): Promise<FrameworkManifest | null> {
  const file = manifestPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new InvalidManifestError(file, "Framework manifest is not valid JSON.", { cause: error });
  }

  return parseManifest(data, file);
}

export async function saveManifest(
  root: string,
  manifest: FrameworkManifest,
): Promise<FrameworkManifest> {
  const file = manifestPath(root);
  manifest.updated_at = nowIso();
  const nextManifest = frameworkManifestSchema.parse(manifest);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifySortedJson(nextManifest), "utf8");
  return nextManifest;
}

export function recordManagedFile(
  manifest: FrameworkManifest,
  input: RecordManagedFileInput,
): ManagedFileRecord {
  const record: ManagedFileRecord = {
    template_id: input.templateId,
    hash: computeHash(input.content),
    installed_version: CURRENT_VERSION,
    protected: input.protected ?? false,
    executable: input.executable ?? false,
    updated_at: nowIso(),
  };
  manifest.managed_files[input.path] = record;
  return record;
}

export function recordTemplate(
  manifest: FrameworkManifest,
  template: TemplateLike,
): ManagedFileRecord {
  const templateId = template.templateId ?? template.template_id;
  if (!templateId) {
    throw new InvalidManifestError(manifestPath("."), "Template record is missing a template id.");
  }
  return recordManagedFile(manifest, {
    path: template.path,
    templateId,
    content: template.content,
    ...(template.executable !== undefined ? { executable: template.executable } : {}),
    ...(template.protected !== undefined ? { protected: template.protected } : {}),
  });
}

export function projectFromManifest(
  manifest: FrameworkManifest | null | undefined,
  fallbackRoot: string,
): string {
  const fallbackName = path.basename(path.resolve(fallbackRoot));
  if (manifest) {
    return manifest.project.name || fallbackName;
  }
  return fallbackName;
}
