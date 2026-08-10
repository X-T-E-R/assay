import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, opendir, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AuthorityRepairRequiredError, AuthorityWriteConflictError } from "./errors.js";
import { identitySafePathNamesOpenFile, identitySafeRealpath } from "./filesystem-boundary.js";
import { stringifySortedJson } from "./serialization.js";

export type AuthorityWriteProbePhase =
  | "after-validation"
  | "after-txn-durable"
  | "after-stage"
  | "after-old-moved"
  | "after-new-installed"
  | "before-cleanup"
  | "recovery-after-owner";

export interface AuthorityWriteProbeContext {
  readonly root: string;
  readonly file: string;
  readonly transaction: string | null;
  readonly stage: string | null;
  readonly rollback: string | null;
}

export type AuthorityWriteProbe = (
  phase: AuthorityWriteProbePhase,
  context: AuthorityWriteProbeContext,
) => void | Promise<void>;

export type AuthorityReadProbePhase = "authority-after-size-stat" | "receipt-after-size-stat";
export type AuthorityReadProbe = (
  phase: AuthorityReadProbePhase,
  file: string,
) => void | Promise<void>;

let authorityReadProbe: AuthorityReadProbe | undefined;

export function setAuthorityReadProbeForTests(probe: AuthorityReadProbe | undefined): void {
  authorityReadProbe = probe;
}

interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileSnapshot extends NodeIdentity {
  readonly digest: string;
  readonly bytes: Buffer;
  readonly nlink: number;
  readonly mode: number;
}

interface ParentSnapshot extends NodeIdentity {
  readonly lexical: string;
  readonly canonical: string;
}

interface TransactionSnapshot extends NodeIdentity {
  readonly lexical: string;
  readonly canonical: string;
}

const MAX_CANONICAL_PATH_CHARS = 32_768;
const MAX_BASENAME_CHARS = 255;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TRANSACTION_ENTRIES = 16;
const MAX_AUTHORITY_FILE_BYTES = 16 * 1024 * 1024;

const nodeIdentitySchema = z.object({ dev: z.number(), ino: z.number() }).strict();
const expectedSchema = nodeIdentitySchema.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
const ownerSchema = z
  .object({
    __schema: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    target_basename: z.string().min(1).max(MAX_BASENAME_CHARS),
    parent: nodeIdentitySchema
      .extend({ canonical: z.string().min(1).max(MAX_CANONICAL_PATH_CHARS) })
      .strict(),
    transaction: nodeIdentitySchema
      .extend({ canonical: z.string().min(1).max(MAX_CANONICAL_PATH_CHARS) })
      .strict(),
    expected: expectedSchema.nullable(),
    replacement_digest: z.string().regex(/^[a-f0-9]{64}$/),
    stage_basename: z.string().min(1).max(MAX_BASENAME_CHARS),
    rollback_basename: z.string().min(1).max(MAX_BASENAME_CHARS),
  })
  .strict();
const stagedSchema = z
  .object({
    __schema: z.literal(1),
    token: z.string().uuid(),
    phase: z.literal("staged"),
    replacement_identity: nodeIdentitySchema,
    replacement_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const phaseSchema = z
  .object({
    __schema: z.literal(1),
    token: z.string().uuid(),
    phase: z.enum(["old-moved", "new-linked", "installed"]),
  })
  .strict();

type OwnerReceipt = z.infer<typeof ownerSchema>;
type StagedReceipt = z.infer<typeof stagedSchema>;
type PhaseReceipt = z.infer<typeof phaseSchema>;

interface TransactionPaths {
  readonly directory: string;
  readonly owner: string;
  readonly staged: string;
  readonly oldMoved: string;
  readonly newLinked: string;
  readonly installed: string;
  readonly stage: string;
  readonly rollback: string;
}

export interface SafeAuthorityWriteOptions {
  readonly root: string;
  readonly file: string;
  readonly content: string;
  readonly validateExisting: (bytes: Buffer | null) => void | Promise<void>;
  readonly error: (message: string, cause?: unknown) => Error;
  readonly probe?: AuthorityWriteProbe;
  /**
   * Opt-in behavior for ordinary text files. Existing targets retain their
   * permission bits; new targets use createMode subject to the process umask.
   * Authority JSON callers retain the protocol's 0600 default when omitted.
   */
  readonly textFileMode?: {
    readonly preserveExisting: true;
    readonly createMode: number;
  };
}

export interface RecoverAuthorityFileOptions {
  readonly root: string;
  readonly file: string;
  readonly error: (message: string, cause?: unknown) => Error;
  readonly probe?: AuthorityWriteProbe;
}

export type AuthorityRecoveryDisposition =
  | "none"
  | "replacement-installed"
  | "previous-retained"
  | "concurrent-winner-retained";

export interface AuthorityRecoveryResult {
  readonly disposition: AuthorityRecoveryDisposition;
  readonly recovered: boolean;
  readonly replacementInstalled: boolean;
}

const activeTokens = new Set<string>();

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(info: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): NodeIdentity {
  return { dev: Number(info.dev), ino: Number(info.ino) };
}

function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matches(
  snapshot: FileSnapshot | null,
  expected: { readonly dev: number; readonly ino: number; readonly digest: string } | null,
): boolean {
  if (!snapshot || !expected) return snapshot === null && expected === null;
  return sameIdentity(snapshot, expected) && snapshot.digest === expected.digest;
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(target).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

async function realDirectory(
  directory: string,
  error: SafeAuthorityWriteOptions["error"],
): Promise<ParentSnapshot> {
  const info = await lstatOrNull(directory);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw error(`authority parent is not a real directory or is a redirect: ${directory}`);
  }
  const safePath = await identitySafeRealpath(directory);
  if (!safePath) {
    throw error(`authority parent resolves through a redirect: ${directory}`);
  }
  return { lexical: directory, canonical: safePath.canonical, ...identity(info) };
}

async function prepareParent(
  rootValue: string,
  fileValue: string,
  error: SafeAuthorityWriteOptions["error"],
  create: boolean,
): Promise<ParentSnapshot | null> {
  const root = path.resolve(rootValue);
  const file = path.resolve(fileValue);
  const parent = path.dirname(file);
  const relative = path.relative(root, parent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw error(`authority path escapes its workspace: ${file}`);
  }
  if (!(await lstatOrNull(root))) {
    if (!create) return null;
    throw error(`authority workspace root is unavailable: ${root}`);
  }
  await realDirectory(root, error);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!(await lstatOrNull(cursor))) {
      if (!create) return null;
      try {
        await mkdir(cursor);
      } catch (mkdirError) {
        if (
          !(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")
        ) {
          throw mkdirError;
        }
      }
    }
    await realDirectory(cursor, error);
  }
  return realDirectory(parent, error);
}

async function assertParent(parent: ParentSnapshot): Promise<void> {
  const current = await realDirectory(
    parent.lexical,
    (message, cause) => new AuthorityRepairRequiredError(message, cause),
  );
  if (pathKey(current.canonical) !== pathKey(parent.canonical) || !sameIdentity(current, parent)) {
    throw new AuthorityRepairRequiredError(
      `authority parent identity changed during transaction: ${parent.lexical}`,
    );
  }
}

async function transactionSnapshot(directory: string): Promise<TransactionSnapshot> {
  const info = await lstatOrNull(directory);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new AuthorityRepairRequiredError(
      `authority transaction directory is not a real directory: ${directory}`,
    );
  }
  const safePath = await identitySafeRealpath(directory);
  if (!safePath) {
    throw new AuthorityRepairRequiredError(
      `authority transaction directory is redirected: ${directory}`,
    );
  }
  return { lexical: directory, canonical: safePath.canonical, ...identity(info) };
}

async function assertTransaction(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
): Promise<void> {
  await assertParent(parent);
  const current = await transactionSnapshot(transaction.lexical);
  if (
    pathKey(current.canonical) !== pathKey(transaction.canonical) ||
    !sameIdentity(current, transaction)
  ) {
    throw new AuthorityRepairRequiredError(
      `authority transaction directory identity changed: ${transaction.lexical}`,
    );
  }
}

async function boundedTransactionEntries(directory: string): Promise<string[]> {
  const entries: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      entries.push(entry.name);
      if (entries.length > MAX_TRANSACTION_ENTRIES) {
        throw new AuthorityRepairRequiredError(
          `authority transaction exceeds ${MAX_TRANSACTION_ENTRIES} entries: ${directory}`,
          undefined,
          {
            reason: "TRANSACTION_ENTRY_LIMIT",
            limit: MAX_TRANSACTION_ENTRIES,
            observed_at_least: entries.length,
          },
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return entries;
}

async function snapshotFile(file: string, allowHardlink = false): Promise<FileSnapshot | null> {
  const namedBefore = await lstatOrNull(file);
  if (!namedBefore) return null;
  if (
    !namedBefore.isFile() ||
    namedBefore.isSymbolicLink() ||
    (!allowHardlink && namedBefore.nlink !== 1)
  ) {
    throw new AuthorityRepairRequiredError(`authority transaction found an unsafe file: ${file}`);
  }
  const safePath = await identitySafeRealpath(file);
  if (!safePath) {
    throw new AuthorityRepairRequiredError(
      `authority transaction found a redirected file: ${file}`,
    );
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !(await identitySafePathNamesOpenFile(file, handle, safePath))) {
      throw new AuthorityRepairRequiredError(
        `authority file identity changed while opening: ${file}`,
      );
    }
    if (opened.size > MAX_AUTHORITY_FILE_BYTES) {
      throw new AuthorityRepairRequiredError(
        `authority file exceeds ${MAX_AUTHORITY_FILE_BYTES} bytes: ${file}`,
        undefined,
        {
          reason: "AUTHORITY_FILE_SIZE_LIMIT",
          limit: MAX_AUTHORITY_FILE_BYTES,
          observed: opened.size,
        },
      );
    }
    await authorityReadProbe?.("authority-after-size-stat", file);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_AUTHORITY_FILE_BYTES) {
      throw new AuthorityRepairRequiredError(
        `authority file read exceeds ${MAX_AUTHORITY_FILE_BYTES} bytes: ${file}`,
        undefined,
        {
          reason: "AUTHORITY_FILE_SIZE_LIMIT",
          limit: MAX_AUTHORITY_FILE_BYTES,
          observed: bytes.byteLength,
        },
      );
    }
    const namedAfter = await lstat(file);
    if (
      !(await identitySafePathNamesOpenFile(file, handle, safePath)) ||
      opened.nlink !== namedAfter.nlink
    ) {
      throw new AuthorityRepairRequiredError(
        `authority file identity changed while reading: ${file}`,
      );
    }
    return {
      ...identity(opened),
      digest: digest(bytes),
      bytes,
      nlink: opened.nlink,
      mode: opened.mode,
    };
  } finally {
    await handle.close();
  }
}

function transactionDirectory(parent: ParentSnapshot, file: string): string {
  return path.join(parent.canonical, `.authority-${path.basename(file)}.txn`);
}

function pathsFor(parent: ParentSnapshot, file: string, owner?: OwnerReceipt): TransactionPaths {
  const directory = transactionDirectory(parent, file);
  const token = owner?.token ?? "pending";
  return {
    directory,
    owner: path.join(directory, "owner.json"),
    staged: path.join(directory, "staged.json"),
    oldMoved: path.join(directory, "old-moved.json"),
    newLinked: path.join(directory, "new-linked.json"),
    installed: path.join(directory, "installed.json"),
    stage: path.join(directory, owner?.stage_basename ?? `stage-${token}`),
    rollback: path.join(directory, owner?.rollback_basename ?? `rollback-${token}`),
  };
}

async function writeDurableNewJson(file: string, value: unknown): Promise<void> {
  const content = stringifySortedJson(value);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_RECEIPT_BYTES) {
    throw new AuthorityRepairRequiredError(
      `authority transaction receipt exceeds ${MAX_RECEIPT_BYTES} bytes before write: ${file}`,
      undefined,
      { reason: "RECEIPT_SIZE_LIMIT", limit: MAX_RECEIPT_BYTES, observed: size },
    );
  }
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonReceipt<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  const info = await lstatOrNull(file);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new AuthorityRepairRequiredError(`authority transaction receipt is unsafe: ${file}`);
  }
  const safePath = await identitySafeRealpath(file);
  if (!safePath) {
    throw new AuthorityRepairRequiredError(`authority transaction receipt is redirected: ${file}`);
  }
  if (info.size > MAX_RECEIPT_BYTES) {
    throw new AuthorityRepairRequiredError(
      `authority transaction receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${file}`,
      undefined,
      {
        reason: "RECEIPT_SIZE_LIMIT",
        limit: MAX_RECEIPT_BYTES,
        observed: info.size,
      },
    );
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw new AuthorityRepairRequiredError(
        `authority transaction receipt identity changed while opening: ${file}`,
      );
    }
    if (opened.size > MAX_RECEIPT_BYTES) {
      throw new AuthorityRepairRequiredError(
        `authority transaction receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${file}`,
        undefined,
        {
          reason: "RECEIPT_SIZE_LIMIT",
          limit: MAX_RECEIPT_BYTES,
          observed: opened.size,
        },
      );
    }
    await authorityReadProbe?.("receipt-after-size-stat", file);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_RECEIPT_BYTES) {
      throw new AuthorityRepairRequiredError(
        `authority transaction receipt read exceeds ${MAX_RECEIPT_BYTES} bytes: ${file}`,
        undefined,
        {
          reason: "RECEIPT_SIZE_LIMIT",
          limit: MAX_RECEIPT_BYTES,
          observed: bytes.byteLength,
        },
      );
    }
    const after = await lstat(file);
    if (!(await identitySafePathNamesOpenFile(file, handle, safePath)) || after.nlink !== 1) {
      throw new AuthorityRepairRequiredError(
        `authority transaction receipt identity changed while reading: ${file}`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new AuthorityRepairRequiredError(
        `authority transaction receipt is not valid UTF-8: ${file}`,
        error,
        { reason: "RECEIPT_INVALID_UTF8" },
      );
    }
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof AuthorityRepairRequiredError) throw error;
    throw new AuthorityRepairRequiredError(
      `authority transaction receipt is invalid: ${file}`,
      error,
      { reason: "RECEIPT_INVALID_JSON_OR_SCHEMA" },
    );
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function validateTransactionDirectory(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  paths: TransactionPaths,
  owner: OwnerReceipt,
): Promise<void> {
  await assertTransaction(parent, transaction);
  const allowed = new Set([
    "owner.json",
    "staged.json",
    "old-moved.json",
    "new-linked.json",
    "installed.json",
    owner.stage_basename,
    owner.rollback_basename,
  ]);
  const unknown = (await boundedTransactionEntries(paths.directory)).filter(
    (entry) => !allowed.has(entry),
  );
  if (unknown.length > 0) {
    throw new AuthorityRepairRequiredError(
      `authority transaction contains unknown artifacts: ${unknown.sort().join(", ")}`,
    );
  }
}

async function writePhase(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  paths: TransactionPaths,
  token: string,
  phase: PhaseReceipt["phase"],
): Promise<void> {
  const file =
    phase === "old-moved"
      ? paths.oldMoved
      : phase === "new-linked"
        ? paths.newLinked
        : paths.installed;
  await assertTransaction(parent, transaction);
  if (await lstatOrNull(file)) return;
  await writeDurableNewJson(file, phaseSchema.parse({ __schema: 1, token, phase }));
}

async function readAndValidateMarkers(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  paths: TransactionPaths,
  owner: OwnerReceipt,
): Promise<{ readonly staged: StagedReceipt | null; readonly installed: boolean }> {
  await assertTransaction(parent, transaction);
  const staged = await readJsonReceipt(paths.staged, stagedSchema);
  if (
    staged &&
    (staged.token !== owner.token || staged.replacement_digest !== owner.replacement_digest)
  ) {
    throw new AuthorityRepairRequiredError("authority staged receipt does not match its owner");
  }
  let installed = false;
  for (const [file, phase] of [
    [paths.oldMoved, "old-moved"],
    [paths.newLinked, "new-linked"],
    [paths.installed, "installed"],
  ] as const) {
    await assertTransaction(parent, transaction);
    const marker = await readJsonReceipt(file, phaseSchema);
    if (marker && (marker.token !== owner.token || marker.phase !== phase)) {
      throw new AuthorityRepairRequiredError(`authority ${phase} receipt does not match its owner`);
    }
    if (phase === "installed" && marker) installed = true;
  }
  return { staged, installed };
}

async function removeOwnedFile(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  file: string,
  expected: FileSnapshot,
): Promise<void> {
  await assertTransaction(parent, transaction);
  const current = await snapshotFile(file, currentMayBeLinked(expected));
  if (!current || !sameIdentity(current, expected) || current.digest !== expected.digest) {
    throw new AuthorityRepairRequiredError(
      `authority cleanup refuses an unowned artifact: ${file}`,
    );
  }
  await assertTransaction(parent, transaction);
  const final = await snapshotFile(file, currentMayBeLinked(expected));
  if (!final || !sameIdentity(final, expected) || final.digest !== expected.digest) {
    throw new AuthorityRepairRequiredError(
      `authority cleanup artifact changed before removal: ${file}`,
    );
  }
  await rm(file, { force: false });
}

function currentMayBeLinked(snapshot: FileSnapshot): boolean {
  return snapshot.nlink > 1;
}

async function cleanupTransactionDirectory(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  paths: TransactionPaths,
  owner: OwnerReceipt,
): Promise<void> {
  await assertTransaction(parent, transaction);
  await validateTransactionDirectory(parent, transaction, paths, owner);
  const currentOwner = await readJsonReceipt(paths.owner, ownerSchema);
  if (
    !currentOwner ||
    currentOwner.token !== owner.token ||
    currentOwner.target_basename !== owner.target_basename ||
    currentOwner.stage_basename !== owner.stage_basename ||
    currentOwner.rollback_basename !== owner.rollback_basename
  ) {
    throw new AuthorityRepairRequiredError("authority cleanup refuses a changed owner receipt");
  }
  await readAndValidateMarkers(parent, transaction, paths, owner);
  for (const file of [
    paths.installed,
    paths.newLinked,
    paths.oldMoved,
    paths.staged,
    paths.owner,
  ]) {
    const info = await lstatOrNull(file);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new AuthorityRepairRequiredError(`authority cleanup refuses receipt: ${file}`);
      }
      await assertTransaction(parent, transaction);
      if (file === paths.owner) {
        const receipt = await readJsonReceipt(file, ownerSchema);
        if (!receipt || receipt.token !== owner.token) {
          throw new AuthorityRepairRequiredError("authority cleanup owner token changed");
        }
      } else if (file === paths.staged) {
        const receipt = await readJsonReceipt(file, stagedSchema);
        if (!receipt || receipt.token !== owner.token) {
          throw new AuthorityRepairRequiredError("authority cleanup staged token changed");
        }
      } else {
        const receipt = await readJsonReceipt(file, phaseSchema);
        if (!receipt || receipt.token !== owner.token) {
          throw new AuthorityRepairRequiredError("authority cleanup phase token changed");
        }
      }
      await assertTransaction(parent, transaction);
      await rm(file, { force: false });
    }
  }
  await assertTransaction(parent, transaction);
  const remaining = await boundedTransactionEntries(paths.directory);
  if (remaining.length !== 0) {
    throw new AuthorityRepairRequiredError(
      `authority transaction cleanup found remaining artifacts: ${remaining.sort().join(", ")}`,
    );
  }
  await assertTransaction(parent, transaction);
  await rmdir(paths.directory);
}

async function finishGovernedTransaction(
  parent: ParentSnapshot,
  transaction: TransactionSnapshot,
  file: string,
  owner: OwnerReceipt,
  paths: TransactionPaths,
  stagedReceipt: StagedReceipt,
  beforeCleanup?: () => void | Promise<void>,
): Promise<void> {
  await assertTransaction(parent, transaction);
  const replacement = {
    ...stagedReceipt.replacement_identity,
    digest: stagedReceipt.replacement_digest,
  };
  await assertTransaction(parent, transaction);
  let current = await snapshotFile(file, true);
  await assertTransaction(parent, transaction);
  let stage = await snapshotFile(paths.stage, true);
  await assertTransaction(parent, transaction);
  let rollback = await snapshotFile(paths.rollback);

  if (owner.expected) {
    if (!rollback) {
      if (
        !matches(current, owner.expected) ||
        !stage ||
        !matches(stage, replacement) ||
        stage.nlink !== 1
      ) {
        throw new AuthorityRepairRequiredError(
          "authority transaction cannot isolate its expected target",
        );
      }
      await assertTransaction(parent, transaction);
      const finalCurrent = await snapshotFile(file);
      if (!matches(finalCurrent, owner.expected)) {
        throw new AuthorityRepairRequiredError("authority target failed its final move CAS");
      }
      await rename(file, paths.rollback);
      await writePhase(parent, transaction, paths, owner.token, "old-moved");
      current = null;
      await assertTransaction(parent, transaction);
      rollback = await snapshotFile(paths.rollback);
    }
    if (!rollback || !matches(rollback, owner.expected)) {
      throw new AuthorityRepairRequiredError("authority rollback does not match its owner receipt");
    }
  } else if (rollback) {
    throw new AuthorityRepairRequiredError("first-create transaction unexpectedly has a rollback");
  }

  if (!current) {
    if (!stage || !matches(stage, replacement) || stage.nlink !== 1) {
      throw new AuthorityRepairRequiredError(
        "authority transaction has no installable staged inode",
      );
    }
    await assertTransaction(parent, transaction);
    try {
      await link(paths.stage, file);
    } catch (error) {
      throw new AuthorityWriteConflictError(
        `authority target was concurrently created: ${file}`,
        error,
      );
    }
    await writePhase(parent, transaction, paths, owner.token, "new-linked");
    await assertTransaction(parent, transaction);
    current = await snapshotFile(file, true);
    await assertTransaction(parent, transaction);
    stage = await snapshotFile(paths.stage, true);
  }

  if (!current || !matches(current, replacement)) {
    throw new AuthorityRepairRequiredError("authority target is an unknown concurrent winner");
  }
  if (stage) {
    if (
      !matches(stage, replacement) ||
      !sameIdentity(stage, current) ||
      stage.nlink !== 2 ||
      current.nlink !== 2
    ) {
      throw new AuthorityRepairRequiredError(
        "authority linked replacement has an invalid identity",
      );
    }
    await removeOwnedFile(parent, transaction, paths.stage, stage);
    stage = null;
    await assertTransaction(parent, transaction);
    current = await snapshotFile(file);
  }
  if (!current || !matches(current, replacement) || current.nlink !== 1) {
    throw new AuthorityRepairRequiredError("authority installed target is not terminal");
  }
  await writePhase(parent, transaction, paths, owner.token, "installed");
  await beforeCleanup?.();

  if (rollback) {
    await removeOwnedFile(parent, transaction, paths.rollback, rollback);
  }
  await cleanupTransactionDirectory(parent, transaction, paths, owner);
}

async function recoverExistingTransaction(
  parent: ParentSnapshot,
  file: string,
  probe?: AuthorityWriteProbe,
): Promise<AuthorityRecoveryResult> {
  const initialPaths = pathsFor(parent, file);
  if (!(await lstatOrNull(initialPaths.directory))) {
    return { disposition: "none", recovered: false, replacementInstalled: false };
  }
  const transaction = await transactionSnapshot(initialPaths.directory);
  await assertTransaction(parent, transaction);
  const owner = await readJsonReceipt(initialPaths.owner, ownerSchema);
  if (!owner) {
    throw new AuthorityRepairRequiredError(
      `authority transaction has no durable owner receipt: ${initialPaths.directory}`,
    );
  }
  const paths = pathsFor(parent, file, owner);
  await validateTransactionDirectory(parent, transaction, paths, owner);
  if (
    owner.target_basename !== path.basename(file) ||
    pathKey(owner.parent.canonical) !== pathKey(parent.canonical) ||
    !sameIdentity(owner.parent, parent) ||
    pathKey(owner.transaction.canonical) !== pathKey(transaction.canonical) ||
    !sameIdentity(owner.transaction, transaction) ||
    owner.stage_basename !== `stage-${owner.token}` ||
    owner.rollback_basename !== `rollback-${owner.token}`
  ) {
    throw new AuthorityRepairRequiredError(
      "authority transaction owner does not match this target",
    );
  }
  await probe?.("recovery-after-owner", {
    root: path.dirname(parent.lexical),
    file,
    transaction: paths.directory,
    stage: paths.stage,
    rollback: paths.rollback,
  });
  await assertTransaction(parent, transaction);
  if (
    (owner.pid === process.pid && activeTokens.has(owner.token)) ||
    (owner.pid !== process.pid && processIsAlive(owner.pid))
  ) {
    throw new AuthorityWriteConflictError(`authority writer is already active for ${file}`);
  }

  const markers = await readAndValidateMarkers(parent, transaction, paths, owner);
  let stagedReceipt = markers.staged;
  await assertTransaction(parent, transaction);
  const current = await snapshotFile(file, true);
  await assertTransaction(parent, transaction);
  const rollback = await snapshotFile(paths.rollback);
  await assertTransaction(parent, transaction);
  const stage = await snapshotFile(paths.stage, true);

  if (!stagedReceipt) {
    if (stage) {
      if (stage.digest !== owner.replacement_digest || stage.nlink !== 1) {
        throw new AuthorityRepairRequiredError("authority unmarked stage does not match its owner");
      }
      stagedReceipt = {
        __schema: 1,
        token: owner.token,
        phase: "staged",
        replacement_identity: { dev: stage.dev, ino: stage.ino },
        replacement_digest: owner.replacement_digest,
      };
      await assertTransaction(parent, transaction);
      await writeDurableNewJson(paths.staged, stagedSchema.parse(stagedReceipt));
    } else if (matches(current, owner.expected) && !rollback) {
      await cleanupTransactionDirectory(parent, transaction, paths, owner);
      return { disposition: "previous-retained", recovered: true, replacementInstalled: false };
    } else {
      throw new AuthorityRepairRequiredError("authority transaction lacks its governed stage");
    }
  }

  const replacement = {
    ...stagedReceipt.replacement_identity,
    digest: stagedReceipt.replacement_digest,
  };
  if (owner.expected && !rollback && matches(current, owner.expected) && stage?.nlink === 1) {
    await removeOwnedFile(parent, transaction, paths.stage, stage);
    await cleanupTransactionDirectory(parent, transaction, paths, owner);
    return { disposition: "previous-retained", recovered: true, replacementInstalled: false };
  }
  if (!owner.expected && !rollback && !current && stage?.nlink === 1) {
    await finishGovernedTransaction(parent, transaction, file, owner, paths, stagedReceipt);
    return {
      disposition: "replacement-installed",
      recovered: true,
      replacementInstalled: true,
    };
  }
  if (
    !owner.expected &&
    !rollback &&
    current &&
    !matches(current, replacement) &&
    stage?.nlink === 1
  ) {
    await removeOwnedFile(parent, transaction, paths.stage, stage);
    await cleanupTransactionDirectory(parent, transaction, paths, owner);
    return {
      disposition: "concurrent-winner-retained",
      recovered: true,
      replacementInstalled: false,
    };
  }
  if (matches(current, replacement) || rollback) {
    await finishGovernedTransaction(parent, transaction, file, owner, paths, stagedReceipt);
    return {
      disposition: "replacement-installed",
      recovered: true,
      replacementInstalled: true,
    };
  }
  throw new AuthorityRepairRequiredError(
    `authority transaction requires repair before reading ${file}`,
  );
}

export async function recoverAuthorityFile(options: RecoverAuthorityFileOptions): Promise<boolean> {
  return (await recoverAuthorityFileWithResult(options)).recovered;
}

export async function recoverAuthorityFileWithResult(
  options: RecoverAuthorityFileOptions,
): Promise<AuthorityRecoveryResult> {
  const parent = await prepareParent(options.root, options.file, options.error, false);
  if (!parent) return { disposition: "none", recovered: false, replacementInstalled: false };
  return recoverExistingTransaction(parent, path.resolve(options.file), options.probe);
}

/**
 * Authority transaction protocol:
 *
 * claimed(owner durable) -> staged -> [old isolated] -> new linked -> installed -> cleaned.
 * State receipts are append-only and token-bound. Recovery derives any crash
 * window from the receipt plus exact stage/rollback/target identity and digest;
 * unknown artifacts or a live owner fail closed instead of being overwritten.
 */
export async function safelyWriteAuthorityFile(options: SafeAuthorityWriteOptions): Promise<void> {
  const root = path.resolve(options.root);
  const file = path.resolve(options.file);
  const parent = await prepareParent(root, file, options.error, true);
  if (!parent) throw options.error(`authority parent is unavailable: ${path.dirname(file)}`);
  await recoverExistingTransaction(parent, file, options.probe);
  const contentBytes = Buffer.byteLength(options.content, "utf8");
  if (contentBytes > MAX_AUTHORITY_FILE_BYTES) {
    throw new AuthorityRepairRequiredError(
      `authority replacement exceeds ${MAX_AUTHORITY_FILE_BYTES} bytes: ${file}`,
      undefined,
      {
        reason: "AUTHORITY_FILE_SIZE_LIMIT",
        limit: MAX_AUTHORITY_FILE_BYTES,
        observed: contentBytes,
      },
    );
  }

  const expected = await snapshotFile(file);
  await options.validateExisting(expected?.bytes ?? null);
  await options.probe?.("after-validation", {
    root,
    file,
    transaction: null,
    stage: null,
    rollback: null,
  });
  await assertParent(parent);
  const current = await snapshotFile(file);
  if (!matches(current, expected)) {
    throw new AuthorityWriteConflictError(`authority file changed after validation: ${file}`);
  }

  const createMode = options.textFileMode?.createMode ?? 0o600;
  if (!Number.isInteger(createMode) || createMode < 0 || createMode > 0o7777) {
    throw options.error(`authority create mode is invalid: ${createMode}`);
  }

  const token = randomUUID();
  const initialPaths = pathsFor(parent, file);
  activeTokens.add(token);
  try {
    await assertParent(parent);
    try {
      await mkdir(initialPaths.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new AuthorityWriteConflictError(
          `authority transaction already exists: ${file}`,
          error,
        );
      }
      throw error;
    }
    const transaction = await transactionSnapshot(initialPaths.directory);
    const owner: OwnerReceipt = {
      __schema: 1,
      token,
      pid: process.pid,
      target_basename: path.basename(file),
      parent: { canonical: parent.canonical, dev: parent.dev, ino: parent.ino },
      transaction: {
        canonical: transaction.canonical,
        dev: transaction.dev,
        ino: transaction.ino,
      },
      expected: expected ? { dev: expected.dev, ino: expected.ino, digest: expected.digest } : null,
      replacement_digest: digest(options.content),
      stage_basename: `stage-${token}`,
      rollback_basename: `rollback-${token}`,
    };
    ownerSchema.parse(owner);
    const paths = pathsFor(parent, file, owner);
    await assertTransaction(parent, transaction);
    await writeDurableNewJson(paths.owner, owner);
    await options.probe?.("after-txn-durable", {
      root,
      file,
      transaction: paths.directory,
      stage: paths.stage,
      rollback: paths.rollback,
    });
    await assertTransaction(parent, transaction);
    const handle = await open(paths.stage, "wx", createMode);
    let stagedReceipt: StagedReceipt;
    try {
      await handle.writeFile(options.content, "utf8");
      if (options.textFileMode?.preserveExisting && expected) {
        await handle.chmod(expected.mode & 0o7777);
      }
      await handle.sync();
      const stageInfo = await handle.stat();
      stagedReceipt = {
        __schema: 1,
        token,
        phase: "staged",
        replacement_identity: identity(stageInfo),
        replacement_digest: owner.replacement_digest,
      };
    } finally {
      await handle.close();
    }
    await assertTransaction(parent, transaction);
    await writeDurableNewJson(paths.staged, stagedSchema.parse(stagedReceipt));
    await options.probe?.("after-stage", {
      root,
      file,
      transaction: paths.directory,
      stage: paths.stage,
      rollback: paths.rollback,
    });

    if (owner.expected) {
      await assertTransaction(parent, transaction);
      const finalCurrent = await snapshotFile(file);
      if (!matches(finalCurrent, owner.expected)) {
        throw new AuthorityWriteConflictError(
          `authority target failed its final move CAS: ${file}`,
        );
      }
      await rename(file, paths.rollback);
      await options.probe?.("after-old-moved", {
        root,
        file,
        transaction: paths.directory,
        stage: paths.stage,
        rollback: paths.rollback,
      });
      await writePhase(parent, transaction, paths, token, "old-moved");
    }

    await assertTransaction(parent, transaction);
    try {
      await link(paths.stage, file);
    } catch (error) {
      throw new AuthorityWriteConflictError(
        `authority target was concurrently created: ${file}`,
        error,
      );
    }
    await options.probe?.("after-new-installed", {
      root,
      file,
      transaction: paths.directory,
      stage: paths.stage,
      rollback: paths.rollback,
    });
    await writePhase(parent, transaction, paths, token, "new-linked");
    await finishGovernedTransaction(parent, transaction, file, owner, paths, stagedReceipt, () =>
      options.probe?.("before-cleanup", {
        root,
        file,
        transaction: paths.directory,
        stage: null,
        rollback: paths.rollback,
      }),
    );
  } finally {
    activeTokens.delete(token);
  }
}
