import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  safelyWriteAuthorityFile,
} from "./authority-file-write.js";
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

let managedFilesWriteProbe: AuthorityWriteProbe | undefined;

export function setManagedFilesWriteProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  managedFilesWriteProbe = probe;
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
  const transaction = path.join(path.dirname(file), `.authority-${path.basename(file)}.txn`);
  const transactionInfo = await lstat(transaction).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!transactionInfo) return parseReceipt(await readReceiptAuthority(file), file);

  const targetInfo = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  // Existing bytes must be valid before a transaction may trigger writes.
  // A missing target is the governed after-old-moved crash window.
  if (targetInfo) parseReceipt(await readReceiptAuthority(file, true), file);
  await recoverAuthorityFile({
    root,
    file,
    error: (message, cause) => invalid(file, message, cause),
    ...(managedFilesWriteProbe ? { probe: managedFilesWriteProbe } : {}),
  });
  return parseReceipt(await readReceiptAuthority(file), file);
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
      await loadManagedFiles(root);
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
    ...(managedFilesWriteProbe ? { probe: managedFilesWriteProbe } : {}),
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

async function readReceiptAuthority(file: string, allowTransactionLink = false): Promise<string> {
  let namedBefore: Awaited<ReturnType<typeof lstat>>;
  try {
    namedBefore = await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw invalid(file, "Managed receipt is missing.");
    }
    throw error;
  }
  const safeLinkCount = (count: number): boolean =>
    count === 1 || (allowTransactionLink && count === 2);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || !safeLinkCount(namedBefore.nlink)) {
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
      !safeLinkCount(opened.nlink) ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw invalid(file, "Managed receipt identity changed while opening.");
    }
    const bytes = await handle.readFile();
    const namedAfter = await lstat(file);
    if (
      !safeLinkCount(namedAfter.nlink) ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
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
