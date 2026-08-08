import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

export type TaskStorageProbePhase = "after-temp-sync" | "before-commit";
type TaskStorageProbe = (phase: TaskStorageProbePhase, target: string) => void | Promise<void>;
export type TaskLockProbeStage =
  | "after-owner-sync"
  | "before-claim"
  | "after-owner-entry-inspection";
type TaskLockProbe = (
  stage: TaskLockProbeStage,
  finalDirectory: string,
  temporaryDirectory: string,
) => void | Promise<void>;

let storageProbe: TaskStorageProbe | undefined;
let lockProbe: TaskLockProbe | undefined;
let lockWaitMs = 10_000;
const workspaceMutationContext = new AsyncLocalStorage<ReadonlySet<string>>();
const workspaceConversionContext = new AsyncLocalStorage<ReadonlySet<string>>();
const TRANSIENT_COORDINATION_MARKER = ".workspace-coordination-transient";

export type WorkspaceMutationProbeStage = "before-acquire" | "after-acquire";
type WorkspaceMutationProbe = (
  stage: WorkspaceMutationProbeStage,
  root: string,
  lockDirectory: string,
) => void | Promise<void>;
let workspaceMutationProbe: WorkspaceMutationProbe | undefined;

/** Test-only failure injection for proving the atomic replacement boundary. */
export function setTaskStorageProbeForTests(probe: TaskStorageProbe | undefined): void {
  storageProbe = probe;
}

/** Test-only override for lock contention timing. */
export function setTaskLockWaitForTests(milliseconds: number | undefined): void {
  lockWaitMs = milliseconds ?? 10_000;
}

/** Test-only failure injection around the prepared-lock claim. */
export function setTaskLockProbeForTests(probe: TaskLockProbe | undefined): void {
  lockProbe = probe;
}

/** Test-only observation hook for the cross-owner workspace mutation gate. */
export function setWorkspaceMutationProbeForTests(probe: WorkspaceMutationProbe | undefined): void {
  workspaceMutationProbe = probe;
}

export class TaskStorageBoundaryError extends Error {
  readonly target: string;

  constructor(target: string, message: string) {
    super(message);
    this.name = "TaskStorageBoundaryError";
    this.target = target;
  }
}

export class TaskInvalidEncodingError extends Error {
  readonly target: string;

  constructor(target: string, cause?: unknown) {
    super(`task file is not valid UTF-8: ${target}`, cause === undefined ? undefined : { cause });
    this.name = "TaskInvalidEncodingError";
    this.target = target;
  }
}

export class TaskLockUnavailableError extends Error {
  readonly target: string;

  constructor(target: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TaskLockUnavailableError";
    this.target = target;
  }
}

interface CoordinationDirectories {
  readonly stateDirectory: string;
  readonly coordinationDirectory: string;
  readonly transientStateDirectory: boolean;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Reject redirecting path components below the workspace root. */
export async function assertTaskStorageBoundary(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isContained(resolvedRoot, resolvedTarget)) {
    throw new TaskStorageBoundaryError(target, "task storage path escapes the workspace root");
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new TaskStorageBoundaryError(
          current,
          "task storage crosses a symbolic link or junction",
        );
      }
      const canonical = await realpath(current);
      if (pathKey(canonical) !== pathKey(current)) {
        throw new TaskStorageBoundaryError(current, "task storage crosses a reparse boundary");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function readTaskText(root: string, file: string): Promise<string> {
  await assertTaskStorageBoundary(root, file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TaskStorageBoundaryError(file, "task file is not a regular file");
  }
  const bytes = await readFile(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TaskInvalidEncodingError(file, error);
  }
}

export async function removeTaskFile(root: string, file: string): Promise<void> {
  await assertTaskStorageBoundary(root, file);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new TaskStorageBoundaryError(file, "task file is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(file, { force: true });
}

export async function listTaskDirectories(root: string, directory: string): Promise<Dirent[]> {
  await assertTaskStorageBoundary(root, directory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.name !== "archive")
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function atomicWriteTaskText(
  root: string,
  target: string,
  text: string,
): Promise<void> {
  await assertTaskStorageBoundary(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await assertTaskStorageBoundary(root, path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await storageProbe?.("after-temp-sync", target);
    await handle.close();
    handle = undefined;
    await storageProbe?.("before-commit", target);
    await assertTaskStorageBoundary(root, target);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withTaskLockRaw<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
  probe: TaskLockProbe | undefined,
): Promise<T> {
  await assertTaskStorageBoundary(root, lockDirectory);
  const parent = path.dirname(lockDirectory);
  await mkdir(parent, { recursive: true });
  await assertTaskStorageBoundary(root, parent);
  const deadline = Date.now() + lockWaitMs;
  const token = randomUUID();
  while (true) {
    await assertTaskStorageBoundary(root, parent);
    if (await tryClaimLock(root, lockDirectory, token, probe)) break;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(lockDirectory);
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw inspectionError;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TaskStorageBoundaryError(lockDirectory, "task lock path is not a real directory");
    }
    try {
      await lstat(path.join(lockDirectory, "owner.json"));
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") {
        const current = await lstatIfPresent(lockDirectory);
        if (current === undefined || !sameDirectoryIdentity(info, current)) continue;
        if (Date.now() - Number(current.mtimeMs) >= STALE_LOCK_AGE_MS) {
          if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
          await quarantineLock(lockDirectory, `ownerless-${token}`);
          continue;
        }
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
        throw new TaskLockUnavailableError(
          lockDirectory,
          `ownerless task lock is too new for recovery; explicit repair is required: ${lockDirectory}`,
        );
      }
      throw ownerError;
    }
    await probe?.("after-owner-entry-inspection", lockDirectory, lockDirectory);
    let owner: LockOwner;
    try {
      owner = await readLockOwner(root, lockDirectory);
    } catch (error) {
      const current = await lstatIfPresent(lockDirectory);
      if (current === undefined) continue;
      if (errorHasCode(error, "ENOENT")) {
        if ((await lstatIfPresent(path.join(lockDirectory, "owner.json"))) !== undefined) {
          continue;
        }
        if (Date.now() - Number(current.mtimeMs) >= STALE_LOCK_AGE_MS) {
          if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
          await quarantineLock(lockDirectory, `ownerless-read-${token}`);
          continue;
        }
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
        throw new TaskLockUnavailableError(
          lockDirectory,
          `ownerless task lock is too new for recovery; explicit repair is required: ${lockDirectory}`,
        );
      }
      if (!sameDirectoryIdentity(info, current)) continue;
      throw error;
    }
    const age = Date.now() - Date.parse(owner.created_at);
    const processState = processIsDead(owner.pid);
    if (processState === "unknown") {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      throw new TaskLockUnavailableError(
        lockDirectory,
        `task lock owner state is unknown; refusing recovery: ${lockDirectory}`,
      );
    }
    if (processState === "dead" && age >= STALE_LOCK_AGE_MS) {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      await quarantineLock(lockDirectory, `dead-${owner.token}`);
      continue;
    }
    if (Date.now() >= deadline) {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      throw new TaskLockUnavailableError(
        lockDirectory,
        `task lock is held by pid ${owner.pid}: ${lockDirectory}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await callback() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let owner: LockOwner;
  try {
    owner = await readLockOwner(root, lockDirectory);
  } catch (releaseError) {
    // A callback that already detected a redirect/identity violation must not
    // have that security finding masked by our intentionally fail-closed
    // refusal to release a lock through the changed path.
    if (!outcome.ok) throw outcome.error;
    throw releaseError;
  }
  if (owner.token !== token) {
    throw new TaskLockUnavailableError(
      lockDirectory,
      `task lock ownership changed; refusing release: ${lockDirectory}`,
    );
  }
  await rm(lockDirectory, { recursive: true, force: true });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Serialize conversion with every mutable owner that participates in this
 * gate. Async-local reentrancy preserves the established nested lock order for
 * Task, Roadmap, Spec, Source adoption, and external plugin operations.
 */
export async function withWorkspaceMutationCoordination<T>(
  rootValue: string,
  callback: () => Promise<T>,
): Promise<T> {
  const root = path.resolve(rootValue);
  const key = pathKey(root);
  const current = workspaceMutationContext.getStore();
  if (current?.has(key)) return callback();

  const prepared = await prepareCoordinationDirectories(root);
  const { coordinationDirectory } = prepared;
  const conversionBoundary = path.join(coordinationDirectory, "conversion-boundary");
  const conversionOwned = workspaceConversionContext.getStore()?.has(key) === true;
  if (!conversionOwned && (await lstatIfPresent(conversionBoundary)) !== undefined) {
    throw new TaskLockUnavailableError(
      conversionBoundary,
      `workspace conversion is in progress: ${root}`,
    );
  }
  const lockDirectory = path.join(coordinationDirectory, "workspace-mutation");
  await workspaceMutationProbe?.("before-acquire", root, lockDirectory);
  try {
    return await withTaskLockRaw(
      root,
      lockDirectory,
      async () => {
        if (!conversionOwned && (await lstatIfPresent(conversionBoundary)) !== undefined) {
          throw new TaskLockUnavailableError(
            conversionBoundary,
            `workspace conversion began before mutation lock acquisition: ${root}`,
          );
        }
        await workspaceMutationProbe?.("after-acquire", root, lockDirectory);
        return workspaceMutationContext.run(new Set([...(current ?? []), key]), callback);
      },
      undefined,
    );
  } finally {
    await cleanupCoordinationDirectories(root, prepared);
  }
}

/**
 * Establish a fail-closed conversion boundary, then wait for any mutation that
 * acquired the shared gate before the boundary. Later mutations cannot cross
 * the boundary, so preflight, transfer, and source cleanup form one snapshot.
 */
export async function withWorkspaceConversionCoordination<T>(
  rootValue: string,
  callback: () => Promise<T>,
  options: { readonly removeStateDirectoryWhenEmpty?: boolean } = {},
): Promise<T> {
  const root = path.resolve(rootValue);
  const key = pathKey(root);
  const current = workspaceConversionContext.getStore();
  if (current?.has(key)) return callback();
  const prepared = await prepareCoordinationDirectories(root);
  const { coordinationDirectory } = prepared;
  const boundary = path.join(coordinationDirectory, "conversion-boundary");
  await assertTaskStorageBoundary(root, path.join(root, ".assay"));
  await assertTaskStorageBoundary(root, coordinationDirectory);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(boundary, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TaskLockUnavailableError(
        boundary,
        `workspace conversion is already active: ${root}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    return await workspaceConversionContext.run(new Set([...(current ?? []), key]), () =>
      withWorkspaceMutationCoordination(root, callback),
    );
  } finally {
    await handle.close().catch(() => undefined);
    await rm(boundary, { force: true });
    await cleanupCoordinationDirectories(root, prepared);
    if (options.removeStateDirectoryWhenEmpty) {
      await rmdir(prepared.stateDirectory).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      });
    }
  }
}

export async function withTaskLock<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withWorkspaceMutationCoordination(root, () =>
    withTaskLockRaw(root, lockDirectory, callback, lockProbe),
  );
}

/** Test-only access to the task-lock protocol without the workspace owner gate. */
export async function withTaskLockUncoordinatedForTests<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withTaskLockRaw(root, lockDirectory, callback, lockProbe);
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly created_at: string;
}

const STALE_LOCK_AGE_MS = 5 * 60 * 1000;

function errorHasCode(error: unknown, expected: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if ((current as NodeJS.ErrnoException).code === expected) return true;
    current = current.cause;
  }
  return false;
}

async function lstatIfPresent(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepareCoordinationDirectories(root: string): Promise<CoordinationDirectories> {
  const stateDirectory = path.join(root, ".assay");
  const coordinationDirectory = path.join(stateDirectory, "coordination");
  const marker = path.join(stateDirectory, TRANSIENT_COORDINATION_MARKER);
  await assertTaskStorageBoundary(root, stateDirectory);
  await assertTaskStorageBoundary(root, coordinationDirectory);

  let transientStateDirectory = false;
  const existingState = await lstatIfPresent(stateDirectory);
  if (existingState === undefined) {
    const staging = path.join(root, `.assay.coordination-${randomUUID()}.tmp`);
    await assertTaskStorageBoundary(root, staging);
    await mkdir(staging);
    let markerHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      markerHandle = await open(path.join(staging, TRANSIENT_COORDINATION_MARKER), "wx", 0o600);
      await markerHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      await markerHandle.sync();
      await markerHandle.close();
      markerHandle = undefined;
      try {
        await rename(staging, stateDirectory);
        transientStateDirectory = true;
      } catch (error) {
        if ((await lstatIfPresent(stateDirectory)) === undefined) throw error;
      }
    } finally {
      await markerHandle?.close().catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  await assertTaskStorageBoundary(root, stateDirectory);
  const stateInfo = await lstat(stateDirectory);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new TaskStorageBoundaryError(
      stateDirectory,
      "workspace coordination state root is not a real directory",
    );
  }
  transientStateDirectory ||= (await lstatIfPresent(marker))?.isFile() === true;

  await assertTaskStorageBoundary(root, coordinationDirectory);
  try {
    await mkdir(coordinationDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertTaskStorageBoundary(root, coordinationDirectory);
  const coordinationInfo = await lstat(coordinationDirectory);
  if (!coordinationInfo.isDirectory() || coordinationInfo.isSymbolicLink()) {
    throw new TaskStorageBoundaryError(
      coordinationDirectory,
      "workspace coordination path is not a real directory",
    );
  }
  return { stateDirectory, coordinationDirectory, transientStateDirectory };
}

async function cleanupCoordinationDirectories(
  root: string,
  prepared: CoordinationDirectories,
): Promise<void> {
  let coordinationRemoved = false;
  try {
    await rmdir(prepared.coordinationDirectory);
    coordinationRemoved = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") coordinationRemoved = true;
    else if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
  if (!coordinationRemoved || !prepared.transientStateDirectory) return;
  const marker = path.join(prepared.stateDirectory, TRANSIENT_COORDINATION_MARKER);
  await assertTaskStorageBoundary(root, prepared.stateDirectory);
  await rm(marker, { force: true });
  await rmdir(prepared.stateDirectory).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  });
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function observedOwnerIsCurrent(
  root: string,
  directory: string,
  observedDirectory: Awaited<ReturnType<typeof lstat>>,
  observedToken: string,
): Promise<boolean> {
  const currentDirectory = await lstatIfPresent(directory);
  if (
    currentDirectory === undefined ||
    !sameDirectoryIdentity(observedDirectory, currentDirectory)
  ) {
    return false;
  }
  try {
    return (await readLockOwner(root, directory)).token === observedToken;
  } catch (error) {
    const afterFailure = await lstatIfPresent(directory);
    if (afterFailure === undefined || !sameDirectoryIdentity(currentDirectory, afterFailure)) {
      return false;
    }
    throw error;
  }
}

async function observedOwnerlessIsCurrent(
  directory: string,
  observedDirectory: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  const currentDirectory = await lstatIfPresent(directory);
  if (
    currentDirectory === undefined ||
    !sameDirectoryIdentity(observedDirectory, currentDirectory)
  ) {
    return false;
  }
  try {
    await lstat(path.join(directory, "owner.json"));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const afterOwnerCheck = await lstatIfPresent(directory);
  return afterOwnerCheck !== undefined && sameDirectoryIdentity(currentDirectory, afterOwnerCheck);
}

async function tryClaimLock(
  root: string,
  finalDirectory: string,
  token: string,
  probe: TaskLockProbe | undefined,
): Promise<boolean> {
  const temporaryDirectory = `${finalDirectory}.claim-${token}`;
  await assertTaskStorageBoundary(root, temporaryDirectory);
  try {
    await mkdir(temporaryDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path.dirname(temporaryDirectory), { recursive: true });
    return false;
  }
  let claimed = false;
  try {
    await writeLockOwner(root, temporaryDirectory, token);
    await probe?.("after-owner-sync", finalDirectory, temporaryDirectory);
    await assertTaskStorageBoundary(root, path.dirname(finalDirectory));
    try {
      await lstat(finalDirectory);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await probe?.("before-claim", finalDirectory, temporaryDirectory);
    try {
      await rename(temporaryDirectory, finalDirectory);
      claimed = true;
    } catch (error) {
      try {
        await lstat(finalDirectory);
        return false;
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw inspectionError;
      }
    }
    const owner = await readLockOwner(root, finalDirectory);
    if (owner.token !== token) {
      throw new TaskLockUnavailableError(
        finalDirectory,
        `prepared task lock claim has the wrong owner: ${finalDirectory}`,
      );
    }
    return true;
  } catch (error) {
    if (claimed) {
      const owner = await readLockOwner(root, finalDirectory).catch(() => undefined);
      if (owner?.token === token) {
        await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (!claimed) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function quarantineLock(directory: string, suffix: string): Promise<void> {
  const quarantine = `${directory}.quarantine-${suffix}-${randomUUID()}`;
  try {
    await rename(directory, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}

async function writeLockOwner(root: string, directory: string, token: string): Promise<void> {
  const file = path.join(directory, "owner.json");
  await assertTaskStorageBoundary(root, file);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockOwner(root: string, directory: string): Promise<LockOwner> {
  const file = path.join(directory, "owner.json");
  let value: unknown;
  try {
    value = JSON.parse(await readTaskText(root, file)) as unknown;
  } catch (error) {
    throw new TaskLockUnavailableError(
      directory,
      `task lock owner metadata is missing or invalid: ${directory}`,
      error,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { token?: unknown }).token !== "string" ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
    typeof (value as { created_at?: unknown }).created_at !== "string" ||
    !Number.isFinite(Date.parse((value as { created_at: string }).created_at))
  ) {
    throw new TaskLockUnavailableError(
      directory,
      `task lock owner metadata is invalid: ${directory}`,
    );
  }
  return value as LockOwner;
}

function processIsDead(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}
