import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  safelyWriteAuthorityFile,
} from "./authority-file-write.js";
import { CURRENT_VERSION, LAYOUT_VERSION, MANIFEST_FILE } from "./constants.js";
import { InvalidManifestError, WorkspaceCutoverRequiredError } from "./errors.js";
import { computeHash } from "./hashing.js";
import { defaultStandaloneLayout } from "./layout.js";
import {
  type FrameworkManifest,
  type ManagedFileRecord,
  type ProjectArchetype,
  type ProjectMode,
  frameworkManifestSchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";
import { nowIso } from "./time.js";
import { assertSupportedAssayVersion } from "./versioning.js";

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

let manifestSaveProbe: AuthorityWriteProbe | undefined;

export function setManifestSaveProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  manifestSaveProbe = probe;
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
    __schema: 3,
    framework_version: CURRENT_VERSION,
    minimum_assay_version: CURRENT_VERSION,
    layout_version: LAYOUT_VERSION,
    created_at: createdAt,
    updated_at: createdAt,
    project: {
      name: project,
      archetype: manifestOptions.archetype ?? "study",
      mode: manifestOptions.mode ?? "learning",
    },
    managed_files: {},
    user_deleted: [],
    applied_migrations: [],
    // Fresh workspaces always carry a v6 layout block. Standalone is the
    // default; `assay attach` overrides this with an overlay layout.
    layout: defaultStandaloneLayout(),
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
  assertSupportedAssayVersion(result.data.minimum_assay_version);
  return result.data;
}

function tuplePart(value: unknown, prefix = ""): string {
  if (typeof value === "string" || typeof value === "number") return `${prefix}${value}`;
  return `${prefix}unknown`;
}

function observedTuple(data: unknown, location = ""): string {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const tuple = `${tuplePart(record.framework_version)}+${tuplePart(record.__schema, "s")}+${tuplePart(record.layout_version, "l")}`;
  return location ? `${location}:${tuple}` : tuple;
}

function assertCurrentEnvelope(data: unknown, location = ""): void {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (
    record?.framework_version !== CURRENT_VERSION ||
    record?.minimum_assay_version !== CURRENT_VERSION ||
    record?.__schema !== 3 ||
    record?.layout_version !== LAYOUT_VERSION
  ) {
    throw new WorkspaceCutoverRequiredError(observedTuple(data, location));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function loadManifestFromFile(file: string): Promise<FrameworkManifest | null> {
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
  assertCurrentEnvelope(data);
  return parseManifest(data, file);
}

function validateExistingManifestBytes(bytes: Buffer, file: string): void {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new InvalidManifestError(file, "Framework manifest is not valid JSON.", { cause: error });
  }
  assertCurrentEnvelope(data);
  parseManifest(data, file);
}

export async function loadManifest(root: string): Promise<FrameworkManifest | null> {
  const current = manifestPath(root);
  await recoverAuthorityFile({
    root,
    file: current,
    error: (message, cause) =>
      new InvalidManifestError(current, message, cause === undefined ? {} : { cause }),
    ...(manifestSaveProbe ? { probe: manifestSaveProbe } : {}),
  });
  if (await exists(current)) return loadManifestFromFile(current);

  const legacy = path.join(root, ".framework", "manifest.json");
  if (!(await exists(legacy))) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(await readFile(legacy, "utf8"));
  } catch {
    // The cutover tool owns legacy parsing and recovery. Core only identifies
    // the old authority location and refuses to proceed.
  }
  throw new WorkspaceCutoverRequiredError(observedTuple(data, ".framework"));
}

export async function saveManifest(
  root: string,
  manifest: FrameworkManifest,
): Promise<FrameworkManifest> {
  const file = manifestPath(root);
  if (!(await exists(file))) {
    // Detect a legacy authority before a first create can make `.assay/`.
    await loadManifest(root);
  }

  assertCurrentEnvelope(manifest);
  const nextManifest = frameworkManifestSchema.parse({ ...manifest, updated_at: nowIso() });
  await safelyWriteAuthorityFile({
    root,
    file,
    content: stringifySortedJson(nextManifest),
    validateExisting: (bytes) => {
      if (bytes) validateExistingManifestBytes(bytes, file);
    },
    error: (message, cause) =>
      new InvalidManifestError(file, message, cause === undefined ? {} : { cause }),
    ...(manifestSaveProbe ? { probe: manifestSaveProbe } : {}),
  });
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
