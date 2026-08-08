import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { recoverAuthorityFile, safelyWriteAuthorityFile } from "./authority-file-write.js";
import { MANAGED_FILES_FILE } from "./constants.js";
import { InvalidManifestError } from "./errors.js";
import { identitySafePathNamesOpenFile, identitySafeRealpath } from "./filesystem-boundary.js";
import { computeHash } from "./hashing.js";
import {
  type ManagedFileRecord,
  type ManagedFilesReceipt,
  managedFileRecordSchema,
  managedFilesReceiptSchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";
import type { TemplateFile } from "./templates.js";

export function managedFilesPath(root: string): string {
  return path.join(root, MANAGED_FILES_FILE);
}

export function defaultManagedFilesReceipt(): ManagedFilesReceipt {
  return { __schema: 1, files: [] };
}

export function managedFileRecord(template: TemplateFile): ManagedFileRecord {
  const source = template.asset
    ? { asset: template.asset }
    : { generator: template.generator ?? template.path };
  return managedFileRecordSchema.parse({
    path: template.path,
    ...source,
    baseline_hash: computeHash(template.content),
    protected: template.protected,
    executable: template.executable,
  });
}

export function receiptForTemplates(templates: readonly TemplateFile[]): ManagedFilesReceipt {
  return managedFilesReceiptSchema.parse({
    __schema: 1,
    files: templates.filter((template) => template.managed).map(managedFileRecord),
  });
}

export async function loadManagedFiles(root: string): Promise<ManagedFilesReceipt> {
  const file = managedFilesPath(root);
  const parsed = parseReceipt(await readReceiptAuthority(file), file);
  const recovered = await recoverAuthorityFile({
    root,
    file,
    error: (message, cause) => invalid(file, message, cause),
  });
  return recovered ? parseReceipt(await readReceiptAuthority(file), file) : parsed;
}

export async function saveManagedFiles(
  root: string,
  receipt: ManagedFilesReceipt,
): Promise<ManagedFilesReceipt> {
  const file = managedFilesPath(root);
  const next = managedFilesReceiptSchema.parse(receipt);
  try {
    await lstat(file);
    await loadManagedFiles(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const transaction = path.join(path.dirname(file), `.authority-${path.basename(file)}.txn`);
    try {
      await lstat(transaction);
      throw invalid(
        file,
        `Managed receipt is missing while an authority transaction requires repair: ${transaction}`,
      );
    } catch (transactionError) {
      if (
        !(
          transactionError instanceof Error &&
          "code" in transactionError &&
          transactionError.code === "ENOENT"
        )
      ) {
        throw transactionError;
      }
    }
  }
  await safelyWriteAuthorityFile({
    root,
    file,
    content: stringifySortedJson(next),
    validateExisting: (bytes) => {
      if (bytes) parseReceipt(bytes.toString("utf8"), file);
    },
    error: (message, cause) => invalid(file, message, cause),
  });
  return next;
}

function parseReceipt(raw: string, file: string): ManagedFilesReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalid(file, "Managed receipt is not valid JSON.", error);
  }
  const result = managedFilesReceiptSchema.safeParse(value);
  if (!result.success) {
    throw invalid(file, "Managed receipt failed validation.", result.error);
  }
  const paths = new Set<string>();
  for (const record of result.data.files) {
    const normalized = record.path.replaceAll("\\", "/");
    if (
      path.isAbsolute(record.path) ||
      /^[A-Za-z]:/.test(record.path) ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw invalid(file, `Managed receipt path is not workspace-relative: ${record.path}`);
    }
    const key = normalized.toLowerCase();
    if (paths.has(key))
      throw invalid(file, `Managed receipt contains duplicate path: ${record.path}`);
    paths.add(key);
  }
  return result.data;
}

async function readReceiptAuthority(file: string): Promise<string> {
  let namedBefore: Awaited<ReturnType<typeof lstat>>;
  try {
    namedBefore = await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw invalid(file, "Managed receipt is missing.");
    }
    throw error;
  }
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1) {
    throw invalid(file, "Managed receipt must be an ordinary, unshared file.");
  }
  const safePath = await identitySafeRealpath(file);
  if (!safePath) {
    throw invalid(file, "Managed receipt must not resolve through a redirect.");
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw invalid(file, "Managed receipt identity changed while opening.");
    }
    const bytes = await handle.readFile();
    const namedAfter = await lstat(file);
    if (namedAfter.nlink !== 1 || !(await identitySafePathNamesOpenFile(file, handle, safePath))) {
      throw invalid(file, "Managed receipt identity changed while reading.");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function invalid(file: string, message: string, cause?: unknown): InvalidManifestError {
  return new InvalidManifestError(file, message, cause === undefined ? {} : { cause });
}
