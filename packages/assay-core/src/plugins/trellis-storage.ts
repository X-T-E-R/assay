import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { FrameworkError } from "../errors.js";
import { stringifySortedJson } from "../serialization.js";
import { withWorkspaceMutationCoordination } from "../tasks/task-storage.js";

export const TRELLIS_LOCK_STALE_MS = 30_000;

const verifiedRemoveReceiptSchema = z
  .object({
    path: z.string().min(1),
    tombstone: z.string().min(1),
    identity: z.object({ dev: z.number().int(), ino: z.number().int() }).strict().nullable(),
  })
  .strict();

const walSchema = z
  .object({
    __schema: z.literal(1),
    id: z.string().uuid(),
    operation: z.string().min(1),
    prepared_at: z.string().min(1),
    writes: z.array(
      z
        .object({
          path: z.string().min(1),
          content: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    deletes: z.array(z.union([z.string().min(1), verifiedRemoveReceiptSchema])),
  })
  .strict();

const walControlSchema = z
  .object({
    __schema: z.literal(1),
    wal_id: z.string().uuid(),
    active: verifiedRemoveReceiptSchema.extend({
      identity: z.object({ dev: z.number().int(), ino: z.number().int() }).strict(),
    }),
  })
  .strict();

export type TrellisWal = z.infer<typeof walSchema>;

export type TrellisStorageProbePhase =
  | "atomic-before-open"
  | "atomic-before-rename"
  | "lock-before-snapshot"
  | "lock-before-stale-takeover"
  | "remove-before-rename"
  | "remove-after-rename"
  | "wal-after-active-remove"
  | "exchange-before-stage-open"
  | "exchange-after-stage-sync"
  | "exchange-before-target-move"
  | "exchange-after-target-move"
  | "exchange-before-target-link"
  | "exchange-after-target-link"
  | "exchange-before-stage-unlink"
  | "exchange-after-stage-unlink"
  | "exchange-before-rollback-cleanup"
  | "exchange-after-rollback-cleanup";
let storageProbe:
  | ((phase: TrellisStorageProbePhase, target: string) => void | Promise<void>)
  | null = null;

/** Deterministic race barrier for hardening probes; tests must always restore null. */
export function setTrellisStorageProbeForTests(
  probe: ((phase: TrellisStorageProbePhase, target: string) => void | Promise<void>) | null,
): void {
  storageProbe = probe;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifiedDirectory(
  root: string,
  directory: string,
): Promise<{
  readonly canonical: string;
  readonly identity: FileIdentity;
}> {
  const canonicalRoot = await realpath(root);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new FrameworkError(`Trellis parent is not a safe directory: '${directory}'`);
  const canonical = await realpath(directory);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
    throw new FrameworkError(`Trellis parent escapes workspace: '${directory}'`);
  return { canonical, identity: { dev: info.dev, ino: info.ino } };
}

async function assertDirectoryIdentity(
  root: string,
  directory: string,
  expected: { readonly canonical: string; readonly identity: FileIdentity },
): Promise<void> {
  const current = await verifiedDirectory(root, directory);
  if (
    current.canonical !== expected.canonical ||
    !sameIdentity(current.identity, expected.identity)
  )
    throw new FrameworkError(`Trellis parent identity changed during operation: '${directory}'`);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve a workspace-owned relative path and reject traversal and reparse points. */
export async function safeTrellisPath(
  rootValue: string,
  relative: string,
  allowMissing = true,
): Promise<string> {
  const root = path.resolve(rootValue);
  try {
    if ((await lstat(root)).isSymbolicLink())
      throw new FrameworkError(`Trellis workspace root is a reparse point: '${root}'`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && allowMissing))
      throw error;
  }
  if (path.isAbsolute(relative) || !relative || relative.includes("\0")) {
    throw new FrameworkError(`unsafe Trellis path '${relative}'`);
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new FrameworkError(`Trellis path escapes workspace: '${relative}'`);
  }
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let canonicalRoot = root;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && allowMissing))
      throw error;
  }
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink())
        throw new FrameworkError(`Trellis path crosses a reparse point: '${relative}'`);
      if (info.isFile() && info.nlink > 1)
        throw new FrameworkError(`Trellis path is a hardlink: '${relative}'`);
      const canonical = await realpath(cursor);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
        throw new FrameworkError(`Trellis path escapes through an ancestor: '${relative}'`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && allowMissing)
        break;
      throw error;
    }
  }
  return target;
}

export async function atomicWriteText(
  root: string,
  relative: string,
  content: string,
): Promise<void> {
  const file = await safeTrellisPath(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await safeTrellisPath(root, relative);
  const parentPath = path.dirname(file);
  const parent = await verifiedDirectory(path.resolve(root), parentPath);
  await storageProbe?.("atomic-before-open", file);
  await assertDirectoryIdentity(path.resolve(root), parentPath, parent);
  const temporary = path.join(
    parent.canonical,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const temporaryIdentity = await handle.stat();
    await handle.close();
    await storageProbe?.("atomic-before-rename", file);
    await assertDirectoryIdentity(path.resolve(root), parentPath, parent);
    await safeTrellisPath(root, relative);
    const canonicalTarget = path.join(parent.canonical, path.basename(file));
    await rename(temporary, canonicalTarget);
    const installed = await lstat(canonicalTarget);
    if (!sameIdentity(installed, temporaryIdentity))
      throw new FrameworkError(`Trellis target identity changed during rename: '${relative}'`);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(
  root: string,
  relative: string,
  value: unknown,
): Promise<void> {
  await atomicWriteText(root, relative, stringifySortedJson(value));
}

export interface AtomicTextExchangeIntent {
  readonly target: string;
  readonly stage: string;
  readonly rollback: string;
  readonly expected_identity: FileIdentity;
  readonly expected_sha256: string;
  readonly replacement_sha256: string;
}

export interface PreparedAtomicTextExchange extends AtomicTextExchangeIntent {
  readonly replacement_identity: FileIdentity;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function verifiedFileSnapshot(
  file: string,
  options: { readonly allowHardlink?: boolean } = {},
): Promise<{ readonly identity: FileIdentity; readonly sha256: string; readonly nlink: number }> {
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const named = await lstat(file);
    if (
      !opened.isFile() ||
      !sameIdentity(opened, named) ||
      (options.allowHardlink !== true && opened.nlink > 1)
    ) {
      throw new FrameworkError(`Trellis exchange file identity changed: '${file}'`);
    }
    return {
      identity: { dev: opened.dev, ino: opened.ino },
      sha256: digest(bytes),
      nlink: opened.nlink,
    };
  } finally {
    await handle.close();
  }
}

function exchangeChild(relative: string, transactionId: string, suffix: string): string {
  const normalized = relative.replaceAll("\\", "/");
  const directory = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  const safeId = transactionId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${directory}/.${base}.${safeId}.${suffix}`;
}

async function exchangeLexicalPath(root: string, relative: string): Promise<string> {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\0")) {
    throw new FrameworkError(`unsafe Trellis exchange path '${relative}'`);
  }
  const directory = path.posix.dirname(normalized);
  const parent = await safeTrellisPath(root, directory, false);
  const target = path.resolve(parent, path.posix.basename(normalized));
  if (path.dirname(target) !== parent) {
    throw new FrameworkError(`Trellis exchange path escapes its parent: '${relative}'`);
  }
  return target;
}

/**
 * Prepare a same-parent replacement whose inode is known before the owner
 * persists its transaction receipt. Commit uses a no-clobber hardlink install
 * after moving the expected target aside, so a non-cooperating writer is never
 * overwritten by the exchange.
 */
export function createAtomicTextExchangeIntent(
  relative: string,
  content: string,
  options: {
    readonly transactionId: string;
    readonly expectedIdentity: FileIdentity;
    readonly expectedSha256: string;
  },
): AtomicTextExchangeIntent {
  const stageRelative = exchangeChild(relative, options.transactionId, "stage");
  const rollbackRelative = exchangeChild(relative, options.transactionId, "rollback");
  return {
    target: relative.replaceAll("\\", "/"),
    stage: stageRelative,
    rollback: rollbackRelative,
    expected_identity: options.expectedIdentity,
    expected_sha256: options.expectedSha256,
    replacement_sha256: digest(content),
  };
}

export async function prepareAtomicTextExchange(
  rootValue: string,
  intent: AtomicTextExchangeIntent,
  content: string,
): Promise<PreparedAtomicTextExchange> {
  const root = path.resolve(rootValue);
  const target = await safeTrellisPath(root, intent.target, false);
  const stage = await safeTrellisPath(root, intent.stage);
  const rollback = await safeTrellisPath(root, intent.rollback);
  if (
    path.dirname(target) !== path.dirname(stage) ||
    path.dirname(target) !== path.dirname(rollback)
  ) {
    throw new FrameworkError("Trellis exchange artifacts must share the target parent");
  }
  const parentPath = path.dirname(target);
  const parent = await verifiedDirectory(root, parentPath);
  const rollbackInfo = await lstat(rollback).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (rollbackInfo) {
    throw new FrameworkError("Trellis exchange cannot prepare after target isolation");
  }
  const existingStage = await lstat(stage).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existingStage) {
    const snapshot = await verifiedFileSnapshot(stage);
    if (snapshot.sha256 !== intent.replacement_sha256) {
      throw new FrameworkError("Trellis exchange existing stage does not match its intent");
    }
    return { ...intent, replacement_identity: snapshot.identity };
  }
  await assertDirectoryIdentity(root, parentPath, parent);
  const canonicalStage = path.join(parent.canonical, path.basename(stage));
  await storageProbe?.("exchange-before-stage-open", canonicalStage);
  const handle = await open(canonicalStage, "wx");
  let durable = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new FrameworkError(
        `Trellis exchange stage is not an ordinary file: '${intent.target}'`,
      );
    }
    if (digest(content) !== intent.replacement_sha256) {
      throw new FrameworkError("Trellis exchange content does not match its intent");
    }
    durable = true;
    await storageProbe?.("exchange-after-stage-sync", canonicalStage);
    return {
      ...intent,
      replacement_identity: { dev: info.dev, ino: info.ino },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (!durable) await rm(canonicalStage, { force: true });
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function matchesSnapshot(
  snapshot: { readonly identity: FileIdentity; readonly sha256: string },
  identity: FileIdentity,
  sha256: string,
): boolean {
  return sameIdentity(snapshot.identity, identity) && snapshot.sha256 === sha256;
}

async function optionalVerifiedFileSnapshot(
  file: string,
  allowHardlink = false,
): Promise<Awaited<ReturnType<typeof verifiedFileSnapshot>> | null> {
  return verifiedFileSnapshot(file, { allowHardlink }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

/** Read-only validation used before a receipt owner acquires its mutation lock. */
export async function validateAtomicTextExchangeState(
  rootValue: string,
  exchange: AtomicTextExchangeIntent & { readonly replacement_identity?: FileIdentity | null },
): Promise<void> {
  const root = path.resolve(rootValue);
  const target = await exchangeLexicalPath(root, exchange.target);
  const stage = await exchangeLexicalPath(root, exchange.stage);
  const rollback = await exchangeLexicalPath(root, exchange.rollback);
  if (
    path.dirname(target) !== path.dirname(stage) ||
    path.dirname(target) !== path.dirname(rollback)
  ) {
    throw new FrameworkError("Trellis exchange receipt crosses target parents");
  }
  const current = await optionalVerifiedFileSnapshot(target, true);
  const staged = await optionalVerifiedFileSnapshot(stage, true);
  const rollbackSnapshot = await optionalVerifiedFileSnapshot(rollback);
  if (
    rollbackSnapshot &&
    !matchesSnapshot(rollbackSnapshot, exchange.expected_identity, exchange.expected_sha256)
  ) {
    throw new FrameworkError("Trellis exchange rollback does not match its receipt");
  }
  if (exchange.replacement_identity === null || exchange.replacement_identity === undefined) {
    if (
      rollbackSnapshot ||
      !current ||
      !matchesSnapshot(current, exchange.expected_identity, exchange.expected_sha256) ||
      (staged && (staged.sha256 !== exchange.replacement_sha256 || staged.nlink !== 1))
    ) {
      throw new FrameworkError("Trellis exchange intent artifacts are not in a resumable state");
    }
    return;
  }
  if (
    staged &&
    !matchesSnapshot(staged, exchange.replacement_identity, exchange.replacement_sha256)
  ) {
    throw new FrameworkError("Trellis exchange stage does not match its receipt");
  }
  const currentExpected =
    current && matchesSnapshot(current, exchange.expected_identity, exchange.expected_sha256);
  const currentReplacement =
    current && matchesSnapshot(current, exchange.replacement_identity, exchange.replacement_sha256);
  const legal =
    (!rollbackSnapshot && currentExpected && staged?.nlink === 1) ||
    (!rollbackSnapshot && currentReplacement && !staged && current?.nlink === 1) ||
    (rollbackSnapshot && !current && staged?.nlink === 1) ||
    (rollbackSnapshot && currentReplacement && staged?.nlink === 2 && current?.nlink === 2) ||
    (rollbackSnapshot && currentReplacement && !staged && current?.nlink === 1) ||
    // A non-cooperating writer may have recreated the active target; preserve it and the rollback.
    (rollbackSnapshot && current && !currentExpected && !currentReplacement && staged?.nlink === 1);
  if (!legal) {
    throw new FrameworkError("Trellis exchange artifacts are not in a resumable receipt state");
  }
}

export async function commitAtomicTextExchange(
  rootValue: string,
  exchange: PreparedAtomicTextExchange,
): Promise<void> {
  const root = path.resolve(rootValue);
  const target = await exchangeLexicalPath(root, exchange.target);
  const stage = await exchangeLexicalPath(root, exchange.stage);
  const rollback = await exchangeLexicalPath(root, exchange.rollback);
  if (
    path.dirname(target) !== path.dirname(stage) ||
    path.dirname(target) !== path.dirname(rollback)
  ) {
    throw new FrameworkError("Trellis exchange receipt crosses target parents");
  }
  const parentPath = path.dirname(target);
  const parent = await verifiedDirectory(root, parentPath);
  const canonicalTarget = path.join(parent.canonical, path.basename(target));
  const canonicalStage = path.join(parent.canonical, path.basename(stage));
  const canonicalRollback = path.join(parent.canonical, path.basename(rollback));
  for (let step = 0; step < 4; step += 1) {
    const current = await optionalVerifiedFileSnapshot(canonicalTarget, true);
    const staged = await optionalVerifiedFileSnapshot(canonicalStage, true);
    const rollbackSnapshot = await optionalVerifiedFileSnapshot(canonicalRollback);
    if (
      rollbackSnapshot &&
      !matchesSnapshot(rollbackSnapshot, exchange.expected_identity, exchange.expected_sha256)
    ) {
      throw new FrameworkError("Trellis exchange rollback does not match its receipt");
    }
    if (
      staged &&
      !matchesSnapshot(staged, exchange.replacement_identity, exchange.replacement_sha256)
    ) {
      throw new FrameworkError("Trellis exchange stage does not match its receipt");
    }
    if (!rollbackSnapshot) {
      if (
        !current ||
        !staged ||
        !matchesSnapshot(current, exchange.expected_identity, exchange.expected_sha256) ||
        staged.nlink !== 1
      ) {
        throw new FrameworkError("Trellis exchange target failed its initial CAS");
      }
      await storageProbe?.("atomic-before-rename", canonicalTarget);
      await storageProbe?.("exchange-before-target-move", canonicalTarget);
      await assertDirectoryIdentity(root, parentPath, parent);
      const finalCurrent = await verifiedFileSnapshot(canonicalTarget);
      if (!matchesSnapshot(finalCurrent, exchange.expected_identity, exchange.expected_sha256)) {
        throw new FrameworkError("Trellis exchange target failed its final CAS");
      }
      await rename(canonicalTarget, canonicalRollback);
      await storageProbe?.("exchange-after-target-move", canonicalRollback);
      continue;
    }
    if (!current) {
      if (!staged || staged.nlink !== 1) {
        throw new FrameworkError(
          "Trellis exchange target is absent without its staged replacement",
        );
      }
      await storageProbe?.("exchange-before-target-link", canonicalTarget);
      try {
        await link(canonicalStage, canonicalTarget);
      } catch (error) {
        throw new FrameworkError(
          "Trellis exchange target was concurrently recreated; rollback is preserved",
          { cause: error },
        );
      }
      await storageProbe?.("exchange-after-target-link", canonicalTarget);
      continue;
    }
    if (!matchesSnapshot(current, exchange.replacement_identity, exchange.replacement_sha256)) {
      throw new FrameworkError(
        "Trellis exchange target is a concurrent replacement; rollback is preserved",
      );
    }
    if (staged) {
      if (current.nlink !== 2 || staged.nlink !== 2) {
        throw new FrameworkError("Trellis exchange linked stage has an invalid link count");
      }
      await storageProbe?.("exchange-before-stage-unlink", canonicalStage);
      await rm(canonicalStage, { force: false });
      await storageProbe?.("exchange-after-stage-unlink", canonicalTarget);
      continue;
    }
    if (current.nlink !== 1) {
      throw new FrameworkError("Trellis exchange installed target remains multiply linked");
    }
    return;
  }
  throw new FrameworkError("Trellis exchange did not reach a terminal installed state");
}

export async function cleanupAtomicTextExchange(
  rootValue: string,
  exchange: PreparedAtomicTextExchange,
): Promise<void> {
  const root = path.resolve(rootValue);
  const target = await exchangeLexicalPath(root, exchange.target);
  const installed = await verifiedFileSnapshot(target);
  if (!matchesSnapshot(installed, exchange.replacement_identity, exchange.replacement_sha256)) {
    throw new FrameworkError("Trellis exchange cleanup refuses a changed target");
  }
  const rollback = await exchangeLexicalPath(root, exchange.rollback);
  const rollbackInfo = await lstat(rollback).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (rollbackInfo) {
    const original = await verifiedFileSnapshot(rollback);
    if (!matchesSnapshot(original, exchange.expected_identity, exchange.expected_sha256)) {
      throw new FrameworkError("Trellis exchange cleanup refuses a changed rollback artifact");
    }
    await storageProbe?.("exchange-before-rollback-cleanup", rollback);
    await rm(rollback, { force: false });
    await storageProbe?.("exchange-after-rollback-cleanup", rollback);
  }
  const stage = await exchangeLexicalPath(root, exchange.stage);
  const stageInfo = await lstat(stage).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (stageInfo) {
    const staged = await verifiedFileSnapshot(stage);
    if (!matchesSnapshot(staged, exchange.replacement_identity, exchange.replacement_sha256)) {
      throw new FrameworkError("Trellis exchange cleanup refuses a changed stage artifact");
    }
    await rm(stage, { force: false });
  }
  const cleanedTarget = await verifiedFileSnapshot(
    await exchangeLexicalPath(root, exchange.target),
  );
  if (!matchesSnapshot(cleanedTarget, exchange.replacement_identity, exchange.replacement_sha256)) {
    throw new FrameworkError("Trellis exchange cleanup verification found a changed target");
  }
  const verifiedRollback = await exchangeLexicalPath(root, exchange.rollback);
  const verifiedStage = await exchangeLexicalPath(root, exchange.stage);
  const [remainingRollback, remainingStage] = await Promise.all([
    lstat(verifiedRollback).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }),
    lstat(verifiedStage).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (remainingRollback || remainingStage) {
    throw new FrameworkError("Trellis exchange cleanup verification found remaining artifacts");
  }
}

/**
 * Remove a verified workspace entry without following a replaced ancestor.
 * The target is first atomically renamed inside its canonical parent; a failed
 * final deletion therefore leaves an isolated, explicitly named tombstone.
 */
export interface VerifiedRemoveReceipt {
  readonly path: string;
  readonly tombstone: string;
  readonly identity: FileIdentity | null;
}

export function deterministicRemoveTombstone(relative: string, transactionId: string): string {
  const normalized = relative.replaceAll("\\", "/");
  const directory = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  const safeId = transactionId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${directory}/.${base}.${safeId}.tombstone`;
}

export async function prepareVerifiedRemove(
  rootValue: string,
  relative: string,
  transactionId: string,
): Promise<VerifiedRemoveReceipt> {
  const root = path.resolve(rootValue);
  const tombstone = deterministicRemoveTombstone(relative, transactionId);
  const original = await safeTrellisPath(root, relative);
  const tombstoneFile = await safeTrellisPath(root, tombstone);
  if (path.dirname(original) !== path.dirname(tombstoneFile))
    throw new FrameworkError("Trellis remove tombstone must share the target parent");
  const originalInfo = await lstat(original).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const tombstoneInfo = await lstat(tombstoneFile).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (tombstoneInfo) {
    if (tombstoneInfo.isSymbolicLink())
      throw new FrameworkError(`Trellis remove rejects reparse tombstone: '${tombstone}'`);
    throw new FrameworkError(`Trellis remove tombstone collision: '${tombstone}'`);
  }
  if (originalInfo?.isSymbolicLink())
    throw new FrameworkError(`Trellis remove rejects reparse target: '${relative}'`);
  const identity = originalInfo ? { dev: originalInfo.dev, ino: originalInfo.ino } : null;
  return { path: relative.replaceAll("\\", "/"), tombstone, identity };
}

export async function verifiedRemove(
  rootValue: string,
  receipt: VerifiedRemoveReceipt,
  options: { readonly recursive?: boolean } = {},
): Promise<{ readonly removed: boolean; readonly tombstone: string }> {
  const root = path.resolve(rootValue);
  const relative = receipt.path;
  const lexicalTarget = await safeTrellisPath(root, relative);
  const lexicalTombstone = await safeTrellisPath(root, receipt.tombstone);
  if (path.dirname(lexicalTarget) !== path.dirname(lexicalTombstone))
    throw new FrameworkError("Trellis remove receipt crosses target parents");
  const parentPath = path.dirname(lexicalTarget);
  const parent = await verifiedDirectory(root, parentPath);
  const canonicalTarget = path.join(parent.canonical, path.basename(lexicalTarget));
  const tombstone = path.join(parent.canonical, path.basename(lexicalTombstone));
  const originalInfo = await lstat(canonicalTarget).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const tombstoneInfo = await lstat(tombstone).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (originalInfo && tombstoneInfo)
    throw new FrameworkError(
      `Trellis remove receipt has both original and tombstone: '${relative}'`,
    );
  if (!originalInfo && !tombstoneInfo)
    return { removed: receipt.identity !== null, tombstone: receipt.tombstone };
  const present = originalInfo ?? tombstoneInfo;
  if (!present || !receipt.identity || !sameIdentity(present, receipt.identity))
    throw new FrameworkError(`Trellis remove receipt identity mismatch: '${relative}'`);
  if (present.isSymbolicLink())
    throw new FrameworkError(`Trellis remove rejects reparse entry: '${relative}'`);
  if (present.isFile() && present.nlink > 1)
    throw new FrameworkError(`Trellis remove rejects hardlink entry: '${relative}'`);
  if (originalInfo) {
    await storageProbe?.("remove-before-rename", lexicalTarget);
    await assertDirectoryIdentity(root, parentPath, parent);
    const current = await lstat(canonicalTarget);
    if (!sameIdentity(receipt.identity, current))
      throw new FrameworkError(`Trellis remove target identity changed: '${relative}'`);
    await rename(canonicalTarget, tombstone);
    const moved = await lstat(tombstone);
    if (!sameIdentity(receipt.identity, moved)) {
      await rename(tombstone, canonicalTarget).catch(() => undefined);
      throw new FrameworkError(`Trellis remove tombstone identity mismatch: '${relative}'`);
    }
  }
  await storageProbe?.("remove-after-rename", tombstone);
  try {
    await rm(tombstone, { recursive: options.recursive === true, force: true });
  } catch (error) {
    throw new FrameworkError(`Trellis remove left its governed tombstone for '${relative}'`, {
      code: "IO_ERROR",
      cause: error,
      details: { tombstone: receipt.tombstone },
    });
  }
  return { removed: true, tombstone: receipt.tombstone };
}

async function openVerifiedFile(rootValue: string, relative: string) {
  const root = path.resolve(rootValue);
  const file = await safeTrellisPath(root, relative, false);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    const current = await lstat(file);
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(file);
    if (
      opened.nlink > 1 ||
      !sameIdentity(opened, current) ||
      (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
    )
      throw new FrameworkError(`Trellis file identity changed during open: '${relative}'`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readJson<T>(
  root: string,
  relative: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let handle: Awaited<ReturnType<typeof openVerifiedFile>> | null = null;
  try {
    handle = await openVerifiedFile(root, relative);
    return schema.parse(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    throw new FrameworkError(`Trellis record is missing or invalid: ${relative}`, {
      code: "PROVIDER_UNAVAILABLE",
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

export async function readJsonLines<T>(
  root: string,
  relative: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  let handle: Awaited<ReturnType<typeof openVerifiedFile>> | null = null;
  let text: string;
  try {
    handle = await openVerifiedFile(root, relative);
    text = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return schema.parse(JSON.parse(line));
      } catch (error) {
        throw new FrameworkError(`Trellis JSONL record ${relative}:${index + 1} is invalid`, {
          code: "PROVIDER_UNAVAILABLE",
          cause: error,
        });
      }
    });
}

export async function atomicWriteJsonLines(
  root: string,
  relative: string,
  records: readonly unknown[],
): Promise<void> {
  await atomicWriteText(
    root,
    relative,
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
  );
}

interface LockSnapshot extends FileIdentity {
  readonly pid: number;
  readonly token: string | null;
  readonly mtimeMs: number;
  readonly nlink: number;
}

type LockSnapshotRead =
  | { readonly kind: "present"; readonly snapshot: LockSnapshot }
  | { readonly kind: "missing" }
  | { readonly kind: "contended" };

async function readLockSnapshot(lockFile: string): Promise<LockSnapshotRead> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await storageProbe?.("lock-before-snapshot", lockFile);
      handle = await open(lockFile, "r");
      const info = await handle.stat();
      const raw = (await handle.readFile("utf8")).trim();
      let pid = Number.parseInt(raw, 10);
      let token: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
        if (typeof parsed.token === "string") token = parsed.token;
      } catch {
        /* legacy pid lock */
      }
      return {
        kind: "present",
        snapshot: {
          dev: info.dev,
          ino: info.ino,
          pid,
          token,
          mtimeMs: info.mtimeMs,
          nlink: info.nlink,
        },
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { kind: "missing" };
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return { kind: "contended" };
}

function lockSnapshotIsStale(snapshot: LockSnapshot, staleMs: number): boolean {
  if (Number.isInteger(snapshot.pid) && snapshot.pid > 0) {
    try {
      process.kill(snapshot.pid, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    }
  }
  return Date.now() - snapshot.mtimeMs > staleMs;
}

async function withLockMetadataGate<T>(lockFile: string, action: () => Promise<T>): Promise<T> {
  const gateFile = `${lockFile}.gate`;
  const recoveryFile = `${gateFile}.recovery`;
  const recoveryQuarantine = `${recoveryFile}.stale`;
  const cleanupRecoveryQuarantine = async (): Promise<void> => {
    const read = await readLockSnapshot(recoveryQuarantine);
    // Quarantine files never grant ownership; after a short grace period they
    // are reapable even if their historical PID has been reused.
    if (read.kind === "present" && Date.now() - read.snapshot.mtimeMs > 1_000)
      await rm(recoveryQuarantine, { force: true });
  };
  const completeRecovery = async (): Promise<boolean> => {
    await cleanupRecoveryQuarantine();
    const recoveryRead = await readLockSnapshot(recoveryFile);
    if (recoveryRead.kind !== "present") return false;
    const recovery = recoveryRead.snapshot;
    const gateRead = await readLockSnapshot(gateFile);
    const gate = gateRead.kind === "present" ? gateRead.snapshot : null;
    if (
      gate &&
      sameIdentity(gate, recovery) &&
      gate.token === recovery.token &&
      lockSnapshotIsStale(gate, TRELLIS_LOCK_STALE_MS)
    ) {
      await rm(gateFile, { force: true });
    }
    const currentRecoveryRead = await readLockSnapshot(recoveryFile);
    const currentRecovery =
      currentRecoveryRead.kind === "present" ? currentRecoveryRead.snapshot : null;
    if (
      currentRecovery &&
      sameIdentity(currentRecovery, recovery) &&
      currentRecovery.token === recovery.token
    ) {
      try {
        await rename(recoveryFile, recoveryQuarantine);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      }
      const moved = await lstat(recoveryQuarantine);
      if (!sameIdentity(moved, recovery)) {
        await rename(recoveryQuarantine, recoveryFile).catch(() => undefined);
        return false;
      }
      await rm(recoveryQuarantine, { force: true });
    }
    return true;
  };
  const recoverDeadGate = async (): Promise<boolean> => {
    if (await completeRecovery()) return true;
    const gateRead = await readLockSnapshot(gateFile);
    if (gateRead.kind !== "present") return false;
    const gate = gateRead.snapshot;
    if (!lockSnapshotIsStale(gate, TRELLIS_LOCK_STALE_MS)) return false;
    try {
      await link(gateFile, recoveryFile);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "EEXIST" || code === "ENOENT" || code === "EPERM" || code === "EACCES")
        return false;
      throw error;
    }
    return completeRecovery();
  };
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await cleanupRecoveryQuarantine();
    if (await pathExists(recoveryFile)) {
      await completeRecovery();
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    try {
      const handle = await open(gateFile, "wx");
      const token = randomUUID();
      let identity: FileIdentity | null = null;
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
        identity = await handle.stat();
        if (await pathExists(recoveryFile)) {
          await handle.close();
          const currentRead = await readLockSnapshot(gateFile);
          const current = currentRead.kind === "present" ? currentRead.snapshot : null;
          if (current && sameIdentity(current, identity) && current.token === token)
            await rm(gateFile, { force: true });
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        try {
          for (let releaseAttempt = 0; releaseAttempt < 120; releaseAttempt += 1) {
            const currentRead = await readLockSnapshot(gateFile);
            if (currentRead.kind === "contended") {
              await new Promise((resolve) => setTimeout(resolve, 5));
              continue;
            }
            const current = currentRead.kind === "present" ? currentRead.snapshot : null;
            if (
              !current ||
              !identity ||
              !sameIdentity(identity, current) ||
              current.token !== token
            )
              break;
            if (current.nlink > 1 || (await pathExists(recoveryFile))) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              continue;
            }
            await rm(gateFile, { force: true });
            break;
          }
        } catch {
          /* another process owns or already removed the metadata gate */
        }
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")
        throw error;
      await recoverDeadGate();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new FrameworkError("Trellis lock metadata is busy; try again", { code: "IO_ERROR" });
}

export async function withTrellisLock<T>(
  rootValue: string,
  action: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  return withWorkspaceMutationCoordination(rootValue, () =>
    withPidFileLock(rootValue, ".assay/trellis/.lock", action, options),
  );
}

export async function withPidFileLock<T>(
  rootValue: string,
  relativeLockFile: string,
  action: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  const root = path.resolve(rootValue);
  const lexicalLockFile = await safeTrellisPath(root, relativeLockFile);
  await mkdir(path.dirname(lexicalLockFile), { recursive: true });
  await safeTrellisPath(root, relativeLockFile);
  const parent = await verifiedDirectory(root, path.dirname(lexicalLockFile));
  const lockFile = path.join(parent.canonical, path.basename(lexicalLockFile));
  const staleQuarantine = `${lockFile}.stale`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const acquisition = await withLockMetadataGate(lockFile, async () => {
      const quarantinedRead = await readLockSnapshot(staleQuarantine);
      if (quarantinedRead.kind === "contended") return { kind: "wait" as const };
      if (quarantinedRead.kind === "present") {
        if (Date.now() - quarantinedRead.snapshot.mtimeMs <= 1_000)
          return { kind: "wait" as const };
        await rm(staleQuarantine, { force: true });
      }
      try {
        const handle = await open(lockFile, "wx");
        const token = randomUUID();
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`,
          "utf8",
        );
        const opened = await handle.stat();
        return { kind: "acquired" as const, handle, token, identity: opened };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "EPERM" || code === "EACCES" || code === "EBUSY")
          return { kind: "wait" as const };
        if (code !== "EEXIST") throw error;
        const snapshotRead = await readLockSnapshot(lockFile);
        if (snapshotRead.kind !== "present") return { kind: "wait" as const };
        const snapshot = snapshotRead.snapshot;
        if (!lockSnapshotIsStale(snapshot, options.staleMs ?? TRELLIS_LOCK_STALE_MS))
          return { kind: "wait" as const };
        await storageProbe?.("lock-before-stale-takeover", lockFile);
        const currentRead = await readLockSnapshot(lockFile);
        const current = currentRead.kind === "present" ? currentRead.snapshot : null;
        if (
          !current ||
          !sameIdentity(snapshot, current) ||
          snapshot.token !== current.token ||
          !lockSnapshotIsStale(current, options.staleMs ?? TRELLIS_LOCK_STALE_MS)
        )
          return { kind: "wait" as const };
        await rename(lockFile, staleQuarantine);
        const moved = await lstat(staleQuarantine);
        if (!sameIdentity(current, moved)) {
          await rename(staleQuarantine, lockFile).catch(() => undefined);
          throw new FrameworkError("Trellis stale lock identity changed during takeover", {
            code: "IO_ERROR",
          });
        }
        await rm(staleQuarantine, { force: true });
        return { kind: "retry" as const };
      }
    });
    if (acquisition.kind === "acquired") {
      const { handle, token, identity } = acquisition;
      try {
        return await action();
      } finally {
        await handle.close();
        await withLockMetadataGate(lockFile, async () => {
          try {
            for (let releaseAttempt = 0; releaseAttempt < 120; releaseAttempt += 1) {
              const currentRead = await readLockSnapshot(lockFile);
              if (currentRead.kind === "contended") {
                await new Promise((resolve) => setTimeout(resolve, 5));
                continue;
              }
              const current = currentRead.kind === "present" ? currentRead.snapshot : null;
              if (current && sameIdentity(identity, current) && current.token === token)
                await rm(lockFile, { force: true });
              break;
            }
          } catch {
            // Never mask the protected action with release cleanup; token mismatch
            // deliberately leaves the successor's lock intact.
          }
        }).catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, acquisition.kind === "retry" ? 0 : 25));
  }
  throw new FrameworkError("Trellis runtime is busy; try again", { code: "IO_ERROR" });
}

const WAL_FILE = ".assay/trellis/wal/active.json";
const WAL_CONTROL_FILE = ".assay/trellis/wal/control.json";

async function recoverTrellisWalControl(root: string): Promise<boolean> {
  let control: z.infer<typeof walControlSchema>;
  try {
    control = await readJson(root, WAL_CONTROL_FILE, walControlSchema);
  } catch (error) {
    if (!(await pathExists(path.join(root, WAL_CONTROL_FILE)))) return false;
    throw error;
  }
  const expectedTombstone = deterministicRemoveTombstone(WAL_FILE, `${control.wal_id}-receipt`);
  if (control.active.path !== WAL_FILE || control.active.tombstone !== expectedTombstone)
    throw new FrameworkError("Trellis WAL control receipt does not govern active.json", {
      code: "PROVIDER_UNAVAILABLE",
    });
  await verifiedRemove(root, control.active, { recursive: false });
  await storageProbe?.("wal-after-active-remove", path.join(root, WAL_CONTROL_FILE));
  const current = await readJson(root, WAL_CONTROL_FILE, walControlSchema);
  if (
    current.wal_id !== control.wal_id ||
    current.active.path !== control.active.path ||
    current.active.tombstone !== control.active.tombstone ||
    !sameIdentity(current.active.identity, control.active.identity)
  )
    throw new FrameworkError("Trellis WAL control receipt changed during recovery", {
      code: "PROVIDER_UNAVAILABLE",
    });
  await rm(await safeTrellisPath(root, WAL_CONTROL_FILE, false), { force: false });
  return true;
}

export async function recoverTrellisWal(root: string): Promise<boolean> {
  if (await recoverTrellisWalControl(root)) return true;
  let wal: TrellisWal;
  try {
    wal = await readJson(root, WAL_FILE, walSchema);
  } catch (error) {
    if (!(await pathExists(path.join(root, WAL_FILE)))) return false;
    throw error;
  }
  for (const write of wal.writes) {
    if (createHash("sha256").update(write.content).digest("hex") !== write.sha256)
      throw new FrameworkError("Trellis WAL content digest mismatch", {
        code: "PROVIDER_UNAVAILABLE",
      });
    await atomicWriteText(root, write.path, write.content);
  }
  for (const [index, deletion] of wal.deletes.entries()) {
    const receipt =
      typeof deletion === "string"
        ? await prepareVerifiedRemove(root, deletion, `${wal.id}-delete-${index}`)
        : deletion;
    await verifiedRemove(root, receipt, { recursive: false });
  }
  const walReceipt = await prepareVerifiedRemove(root, WAL_FILE, `${wal.id}-receipt`);
  if (!walReceipt.identity)
    throw new FrameworkError("Trellis WAL active receipt has no file identity", {
      code: "PROVIDER_UNAVAILABLE",
    });
  await atomicWriteJson(
    root,
    WAL_CONTROL_FILE,
    walControlSchema.parse({
      __schema: 1,
      wal_id: wal.id,
      active: walReceipt,
    }),
  );
  await recoverTrellisWalControl(root);
  return true;
}

/** Durable multi-file reducer. Caller must already hold the Trellis lock. */
export async function applyTrellisWal(
  root: string,
  operation: string,
  writes: readonly { path: string; value: unknown; jsonl?: boolean }[],
  deletes: readonly string[] = [],
): Promise<void> {
  const encoded = writes.map((write) => {
    const content = write.jsonl
      ? (write.value as readonly unknown[]).map((record) => JSON.stringify(record)).join("\n") +
        ((write.value as readonly unknown[]).length ? "\n" : "")
      : stringifySortedJson(write.value);
    return {
      path: write.path,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const walId = randomUUID();
  const deleteReceipts = await Promise.all(
    deletes.map((relative, index) =>
      prepareVerifiedRemove(root, relative, `${walId}-delete-${index}`),
    ),
  );
  const wal = walSchema.parse({
    __schema: 1,
    id: walId,
    operation,
    prepared_at: new Date().toISOString(),
    writes: encoded,
    deletes: deleteReceipts,
  });
  await atomicWriteJson(root, WAL_FILE, wal);
  await recoverTrellisWal(root);
}

export async function listSafeFiles(root: string, relative: string): Promise<string[]> {
  const base = await safeTrellisPath(root, relative);
  if (!(await pathExists(base))) return [];
  const canonicalRoot = await realpath(path.resolve(root));
  const canonicalBase = await realpath(base);
  if (canonicalBase !== canonicalRoot && !canonicalBase.startsWith(`${canonicalRoot}${path.sep}`))
    throw new FrameworkError(`Trellis listing root escapes workspace: ${relative}`);
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (entry.isSymbolicLink() || info.isSymbolicLink())
        throw new FrameworkError(
          `Trellis path crosses a reparse point: ${path.relative(root, target)}`,
        );
      const canonical = await realpath(target);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
        throw new FrameworkError(`Trellis listing entry escapes workspace: ${target}`);
      if (entry.isDirectory()) await visit(canonical);
      else if (entry.isFile()) {
        if (info.nlink > 1) throw new FrameworkError(`Trellis listing rejects hardlink: ${target}`);
        output.push(path.relative(root, target).replaceAll("\\", "/"));
      }
    }
  };
  await visit(canonicalBase);
  return output.sort();
}
