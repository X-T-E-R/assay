import type { Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { FrameworkError } from "../errors.js";
import type { FileIdentity } from "./trellis-storage.js";

export const CONFINED_READER_MAX_ITEMS = 4_096;
export const CONFINED_READER_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CONFINED_READER_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ConfinedReaderProbePhase =
  | "before-enumerate-entry"
  | "before-open"
  | "after-open"
  | "after-read";

let confinedReaderProbe:
  | ((phase: ConfinedReaderProbePhase, target: string) => void | Promise<void>)
  | null = null;

/** Deterministic race barrier for confined-reader tests. */
export function setConfinedReaderProbeForTests(
  probe: ((phase: ConfinedReaderProbePhase, target: string) => void | Promise<void>) | null,
): void {
  confinedReaderProbe = probe;
}

export interface ConfinedReadRoot {
  readonly requested_path: string;
  readonly canonical_path: string;
  readonly identity: FileIdentity;
}

export interface ConfinedReadFile {
  readonly relative_path: string;
  readonly canonical_path: string;
  readonly identity: FileIdentity;
  readonly size: number;
}

function identity(info: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function assertNoReparseAncestors(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new FrameworkError(`confined reader rejects reparse path: '${cursor}'`);
    }
  }
}

export async function openConfinedReadRoot(value: string): Promise<ConfinedReadRoot> {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new FrameworkError("confined reader root must be a canonicalizable absolute path");
  }
  const requested = path.resolve(value);
  if (requested === path.parse(requested).root) {
    throw new FrameworkError("confined reader rejects a filesystem root source");
  }
  await assertNoReparseAncestors(requested);
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new FrameworkError(`confined reader source is not an ordinary directory: '${requested}'`);
  }
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new FrameworkError(`confined reader root is not canonical: '${requested}'`);
  }
  return { requested_path: requested, canonical_path: canonical, identity: identity(info) };
}

async function assertRoot(root: ConfinedReadRoot): Promise<void> {
  await assertNoReparseAncestors(root.requested_path);
  const info = await lstat(root.requested_path);
  const canonical = await realpath(root.requested_path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonical !== root.canonical_path ||
    !sameIdentity(info, root.identity)
  ) {
    throw new FrameworkError(`confined reader root identity changed: '${root.requested_path}'`);
  }
}

export async function listConfinedReadFiles(root: ConfinedReadRoot): Promise<ConfinedReadFile[]> {
  await assertRoot(root);
  const output: ConfinedReadFile[] = [];
  let items = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries: Dirent[] = [];
    for await (const entry of await opendir(directory)) {
      items += 1;
      if (items > CONFINED_READER_MAX_ITEMS) {
        throw new FrameworkError(
          `confined reader item limit exceeded (${CONFINED_READER_MAX_ITEMS})`,
        );
      }
      entries.push(entry);
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      await confinedReaderProbe?.("before-enumerate-entry", target);
      const info = await lstat(target);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new FrameworkError(`confined reader rejects reparse entry: '${target}'`);
      }
      const canonical = await realpath(target);
      if (!isWithin(root.canonical_path, canonical)) {
        throw new FrameworkError(`confined reader entry escapes source root: '${target}'`);
      }
      if (info.isDirectory()) {
        await visit(canonical);
        continue;
      }
      if (!info.isFile()) {
        throw new FrameworkError(`confined reader rejects non-file entry: '${target}'`);
      }
      if (info.nlink > 1) {
        throw new FrameworkError(`confined reader rejects hardlink entry: '${target}'`);
      }
      if (info.size > CONFINED_READER_MAX_FILE_BYTES) {
        throw new FrameworkError(
          `confined reader file exceeds ${CONFINED_READER_MAX_FILE_BYTES} bytes: '${target}'`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > CONFINED_READER_MAX_TOTAL_BYTES) {
        throw new FrameworkError(
          `confined reader total byte limit exceeded (${CONFINED_READER_MAX_TOTAL_BYTES})`,
        );
      }
      output.push({
        relative_path: path.relative(root.canonical_path, canonical).replaceAll("\\", "/"),
        canonical_path: canonical,
        identity: identity(info),
        size: info.size,
      });
    }
  };
  await visit(root.canonical_path);
  await assertRoot(root);
  return output;
}

export async function inspectConfinedReadFile(
  root: ConfinedReadRoot,
  relative: string,
): Promise<ConfinedReadFile> {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new FrameworkError(`confined reader rejects unsafe relative path '${relative}'`);
  }
  await assertRoot(root);
  const lexical = path.resolve(root.canonical_path, relative);
  if (!isWithin(root.canonical_path, lexical)) {
    throw new FrameworkError(`confined reader file escapes its root: '${relative}'`);
  }
  let cursor = root.canonical_path;
  for (const part of path.relative(root.canonical_path, lexical).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new FrameworkError(`confined reader rejects reparse entry: '${cursor}'`);
    }
  }
  const info = await lstat(lexical);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new FrameworkError(`confined reader rejects non-file entry: '${lexical}'`);
  }
  if (info.nlink > 1) {
    throw new FrameworkError(`confined reader rejects hardlink entry: '${lexical}'`);
  }
  if (info.size > CONFINED_READER_MAX_FILE_BYTES) {
    throw new FrameworkError(
      `confined reader file exceeds ${CONFINED_READER_MAX_FILE_BYTES} bytes: '${lexical}'`,
    );
  }
  const canonical = await realpath(lexical);
  if (!isWithin(root.canonical_path, canonical) || canonical !== lexical) {
    throw new FrameworkError(`confined reader file is not canonically contained: '${relative}'`);
  }
  return {
    relative_path: relative.replaceAll("\\", "/"),
    canonical_path: canonical,
    identity: identity(info),
    size: info.size,
  };
}

export async function readConfinedFile(
  root: ConfinedReadRoot,
  file: ConfinedReadFile,
): Promise<Buffer> {
  if (
    !file.relative_path ||
    path.isAbsolute(file.relative_path) ||
    file.relative_path.includes("\0")
  ) {
    throw new FrameworkError(
      `confined reader rejects unsafe relative path '${file.relative_path}'`,
    );
  }
  await assertRoot(root);
  const lexical = path.resolve(root.canonical_path, file.relative_path);
  if (!isWithin(root.canonical_path, lexical) || lexical !== file.canonical_path) {
    throw new FrameworkError(
      `confined reader file plan is outside its root: '${file.relative_path}'`,
    );
  }
  await confinedReaderProbe?.("before-open", lexical);
  const handle = await open(lexical, "r");
  try {
    const opened = await handle.stat();
    await confinedReaderProbe?.("after-open", lexical);
    const named = await lstat(lexical);
    const canonical = await realpath(lexical);
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.size > CONFINED_READER_MAX_FILE_BYTES ||
      !sameIdentity(opened, named) ||
      !sameIdentity(opened, file.identity) ||
      canonical !== file.canonical_path ||
      !isWithin(root.canonical_path, canonical)
    ) {
      throw new FrameworkError(`confined reader file identity changed: '${file.relative_path}'`);
    }
    const bytes = await handle.readFile();
    await confinedReaderProbe?.("after-read", lexical);
    const afterHandle = await handle.stat();
    const afterNamed = await lstat(lexical);
    const afterCanonical = await realpath(lexical);
    if (
      bytes.byteLength !== opened.size ||
      !sameIdentity(opened, afterHandle) ||
      !sameIdentity(opened, afterNamed) ||
      opened.size !== afterHandle.size ||
      opened.mtimeMs !== afterHandle.mtimeMs ||
      opened.ctimeMs !== afterHandle.ctimeMs ||
      afterCanonical !== file.canonical_path ||
      !isWithin(root.canonical_path, afterCanonical)
    ) {
      throw new FrameworkError(
        `confined reader source changed during read: '${file.relative_path}'`,
      );
    }
    await assertRoot(root);
    return bytes;
  } finally {
    await handle.close();
  }
}
