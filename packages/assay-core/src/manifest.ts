import { lstat, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  safelyWriteAuthorityFile,
} from "./authority-file-write.js";
import { CURRENT_VERSION, LAYOUT_VERSION, MANIFEST_FILE } from "./constants.js";
import { InvalidManifestError, WorkspaceCutoverRequiredError } from "./errors.js";
import { identitySafePathNamesOpenFile, identitySafeRealpath } from "./filesystem-boundary.js";
import { defaultStandaloneLayout } from "./layout.js";
import {
  type FrameworkManifest,
  type ManifestEntry,
  frameworkManifestSchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";

let manifestSaveProbe: AuthorityWriteProbe | undefined;

export function setManifestSaveProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  manifestSaveProbe = probe;
}

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILE);
}

export function defaultManifest(entries: readonly ManifestEntry[] = []): FrameworkManifest {
  return frameworkManifestSchema.parse({
    __schema: 4,
    framework_version: CURRENT_VERSION,
    layout: { ...defaultStandaloneLayout(), entries },
  });
}

function observedTuple(data: unknown, location = ""): string {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const layout =
    record.layout && typeof record.layout === "object" && !Array.isArray(record.layout)
      ? (record.layout as Record<string, unknown>)
      : {};
  const version =
    typeof record.framework_version === "string" ? record.framework_version : "unknown";
  const schema = typeof record.__schema === "number" ? record.__schema : "unknown";
  const layoutVersion =
    typeof layout.version === "number"
      ? layout.version
      : typeof record.layout_version === "number"
        ? record.layout_version
        : "unknown";
  const tuple = `${version}+s${schema}+l${layoutVersion}`;
  return location ? `${location}:${tuple}` : tuple;
}

function assertCurrentEnvelope(data: unknown, location = ""): void {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const layout =
    record?.layout && typeof record.layout === "object" && !Array.isArray(record.layout)
      ? (record.layout as Record<string, unknown>)
      : null;
  if (
    record?.framework_version !== CURRENT_VERSION ||
    record?.__schema !== 4 ||
    layout?.version !== LAYOUT_VERSION
  ) {
    throw new WorkspaceCutoverRequiredError(observedTuple(data, location));
  }
}

function parseManifest(data: unknown, file: string): FrameworkManifest {
  assertCurrentEnvelope(data);
  const result = frameworkManifestSchema.safeParse(data);
  if (!result.success) {
    throw new InvalidManifestError(file, "Framework manifest failed validation.", {
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
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

async function readAndParse(file: string): Promise<FrameworkManifest | null> {
  let raw: string;
  try {
    raw = await readManifestAuthority(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new InvalidManifestError(file, "Framework manifest is not valid JSON.", { cause: error });
  }
  return parseManifest(data, file);
}

async function readManifestAuthority(file: string): Promise<string> {
  const namedBefore = await lstat(file);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1) {
    throw new InvalidManifestError(file, "Framework manifest must be an ordinary, unshared file.");
  }
  const safePath = await identitySafeRealpath(file);
  if (!safePath) {
    throw new InvalidManifestError(file, "Framework manifest must not resolve through a redirect.");
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw new InvalidManifestError(file, "Framework manifest identity changed while opening.");
    }
    const bytes = await handle.readFile();
    const namedAfter = await lstat(file);
    if (namedAfter.nlink !== 1 || !(await identitySafePathNamesOpenFile(file, handle, safePath))) {
      throw new InvalidManifestError(file, "Framework manifest identity changed while reading.");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function validateExistingManifestBytes(bytes: Buffer, file: string): void {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new InvalidManifestError(file, "Framework manifest is not valid JSON.", { cause: error });
  }
  parseManifest(data, file);
}

/**
 * Read the manifest without allowing an old, malformed, or redirected authority
 * file to trigger recovery writes. Recovery is admitted only after current
 * bytes and an ordinary-file boundary have been established.
 */
export async function loadManifest(root: string): Promise<FrameworkManifest | null> {
  const current = manifestPath(root);
  try {
    const parsed = await readAndParse(current);
    const recovered = await recoverAuthorityFile({
      root,
      file: current,
      error: (message, cause) =>
        new InvalidManifestError(current, message, cause === undefined ? {} : { cause }),
      ...(manifestSaveProbe ? { probe: manifestSaveProbe } : {}),
    });
    return recovered ? readAndParse(current) : parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const transaction = path.join(path.dirname(current), `.authority-${path.basename(current)}.txn`);
  if (await exists(transaction)) {
    throw new InvalidManifestError(
      current,
      `Framework manifest is missing while an authority transaction requires repair: ${transaction}`,
    );
  }

  const legacy = path.join(root, ".framework", "manifest.json");
  if (!(await exists(legacy))) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(await readFile(legacy, "utf8"));
  } catch {
    // The cutover tool owns legacy parsing.
  }
  throw new WorkspaceCutoverRequiredError(observedTuple(data, ".framework"));
}

export async function saveManifest(
  root: string,
  manifest: FrameworkManifest,
): Promise<FrameworkManifest> {
  const file = manifestPath(root);
  if (!(await exists(file))) await loadManifest(root);
  const next = frameworkManifestSchema.parse(manifest);
  await safelyWriteAuthorityFile({
    root,
    file,
    content: stringifySortedJson(next),
    validateExisting: (bytes) => {
      if (bytes) validateExistingManifestBytes(bytes, file);
    },
    error: (message, cause) =>
      new InvalidManifestError(file, message, cause === undefined ? {} : { cause }),
    ...(manifestSaveProbe ? { probe: manifestSaveProbe } : {}),
  });
  return next;
}
