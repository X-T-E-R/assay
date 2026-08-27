import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { stringifySortedJson, toPosixPath } from "../serialization.js";
import { readSourceContentListing, resolveSourceObservation } from "../sources.js";
import { collectGitMetadata } from "../sources/git.js";
import {
  requireSystemsRegistry,
  resolveRegistryPath,
  systemRecordForSelector,
} from "../systems-registry.js";
import type {
  SourceAdoptionDefinition,
  SourceAdoptionLocatorSnapshot,
  SourceAdoptionMapping,
  SourceAdoptionPathLocator,
  SourceAdoptionSourceSnapshot,
  SourceAdoptionTargetSnapshot,
} from "./schemas.js";
import {
  sourceAdoptionLocatorSnapshotSchema,
  sourceAdoptionSourceSnapshotSchema,
  sourceAdoptionTargetSnapshotSchema,
} from "./schemas.js";

const sourceManifestFileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const sourceManifestSchema = z
  .object({
    __schema: z.literal(1),
    generated_on: z.string().min(1),
    root: z.string().min(1),
    fingerprint: z
      .object({
        algorithm: z.literal("sha256-tree-v1"),
        value: z.string().regex(/^[a-f0-9]{64}$/),
        file_count: z.number().int().nonnegative(),
        byte_count: z.number().int().nonnegative(),
        excluded: z.array(z.string()),
      })
      .strict(),
    files: z.array(sourceManifestFileSchema),
  })
  .strict();

function hashJson(value: unknown): string {
  return createHash("sha256").update(stringifySortedJson(value), "utf8").digest("hex");
}

function recomputeSourceManifestFingerprint(manifest: {
  readonly files: readonly z.infer<typeof sourceManifestFileSchema>[];
}): {
  readonly value: string;
  readonly byteCount: number;
} {
  const hash = createHash("sha256");
  let byteCount = 0;
  for (const file of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\n");
    byteCount += file.size;
  }
  return { value: hash.digest("hex"), byteCount };
}

function mappingsForTarget(
  definition: SourceAdoptionDefinition,
  targetId: string,
): SourceAdoptionMapping[] {
  return definition.mappings.filter((mapping) => mapping.target.target_id === targetId);
}

function snapshotFromFiles(
  locator: SourceAdoptionPathLocator,
  files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[],
): SourceAdoptionLocatorSnapshot {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sourceAdoptionLocatorSnapshotSchema.parse({
    locator,
    state: sorted.length > 0 ? "present" : "missing",
    digest: sorted.length > 0 ? hashJson({ locator, files: sorted }) : null,
    files: sorted,
  });
}

/**
 * Whether a repository-relative file path falls under a declared locator.
 * `exact` names one file; `prefix` names a file or everything beneath it.
 * Shared by snapshotting and by the upstream impact report, so both answer
 * "does this change touch adopted material?" the same way.
 */
export function sourceAdoptionLocatorMatchesPath(
  locator: SourceAdoptionPathLocator,
  filePath: string,
): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (locator.match === "exact") {
    return normalized === locator.path;
  }
  return normalized === locator.path || normalized.startsWith(`${locator.path}/`);
}

export function snapshotManifestLocator(
  listing: { readonly files: readonly z.infer<typeof sourceManifestFileSchema>[] },
  locator: SourceAdoptionPathLocator,
): SourceAdoptionLocatorSnapshot {
  const files = listing.files.filter((file) =>
    sourceAdoptionLocatorMatchesPath(locator, file.path),
  );
  return snapshotFromFiles(locator, files);
}

/**
 * Pin what was adopted, at the moment of adoption.
 *
 * This is the tier-1 act: the file listing and its tree hash are computed here
 * rather than carried by every observation, so recording that material moved is
 * where the cost lands and nowhere else.
 */
export async function snapshotSourceAdoptionSource(
  root: string,
  definition: SourceAdoptionDefinition,
  targetId: string,
  observation?: string,
): Promise<SourceAdoptionSourceSnapshot> {
  const listing = await readSourceContentListing({
    root,
    alias: definition.source.alias,
    ...(observation === undefined ? {} : { observation }),
  });
  const parsedFiles = z.array(sourceManifestFileSchema).safeParse(listing.files);
  if (!parsedFiles.success) {
    throw new FrameworkError(`source content listing failed validation: ${listing.relativeRoot}`, {
      code: "INVALID_SOURCE_ADOPTION",
      details: parsedFiles.error.flatten(),
      cause: parsedFiles.error,
    });
  }
  const files = parsedFiles.data;
  const recomputed = recomputeSourceManifestFingerprint({ files });
  if (
    listing.fingerprint.value !== recomputed.value ||
    files.length !== listing.fingerprint.file_count ||
    listing.fingerprint.byte_count !== recomputed.byteCount
  ) {
    throw new FrameworkError(
      `source content and its recorded identity disagree: ${listing.observationId}`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }

  const locators: Record<string, SourceAdoptionLocatorSnapshot> = {};
  for (const mapping of mappingsForTarget(definition, targetId)) {
    locators[mapping.id] = snapshotManifestLocator({ files }, mapping.source);
  }

  const resolved = await resolveSourceObservation({
    root,
    alias: definition.source.alias,
    ...(observation === undefined ? {} : { observation }),
  });
  return sourceAdoptionSourceSnapshotSchema.parse({
    alias: definition.source.alias,
    lineage_id: resolved.observation.lineage_id,
    observation_id: resolved.observation.observation_id,
    manifest_fingerprint: listing.fingerprint.value,
    vcs_commit: resolved.observation.vcs?.commit ?? null,
    locators,
  });
}

async function snapshotFile(
  systemRoot: string,
  absoluteFile: string,
): Promise<{ readonly path: string; readonly size: number; readonly sha256: string }> {
  const content = await readFile(absoluteFile);
  return {
    path: toPosixPath(path.relative(systemRoot, absoluteFile)),
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function collectTargetFiles(
  systemRoot: string,
  current: string,
  files: Array<{ readonly path: string; readonly size: number; readonly sha256: string }>,
): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new FrameworkError(
        `target locator contains a symbolic link: ${toPosixPath(path.relative(systemRoot, absolute))}`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    if (entry.isDirectory()) {
      await collectTargetFiles(systemRoot, absolute, files);
    } else if (entry.isFile()) {
      files.push(await snapshotFile(systemRoot, absolute));
    }
  }
}

/**
 * Resolve a locator to an absolute path and refuse anything that leaves the
 * registered system.
 *
 * `path.resolve` alone only handles textual escapes (`..`, absolute paths). It
 * says nothing about symbolic links, so `link/src/a.txt` under a system whose
 * `link` is a symlink to an unrelated directory resolves textually inside the
 * system while reading bytes from outside it — and those bytes would then be
 * recorded in an accepted baseline as if they belonged to the target system.
 * Both the system root and the locator are canonicalized before comparison,
 * and the deepest existing ancestor stands in for locators that do not exist
 * yet (a draft target), so a missing file cannot bypass the check.
 */
async function containedTargetPath(
  systemRoot: string,
  locator: SourceAdoptionPathLocator,
): Promise<string> {
  const absolute = path.resolve(systemRoot, ...locator.path.split("/"));
  const relative = path.relative(systemRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FrameworkError(`target locator escapes registered system: ${locator.path}`, {
      code: "INVALID_SOURCE_ADOPTION",
    });
  }

  const realSystemRoot = await canonicalPath(systemRoot);
  const realTarget = await canonicalExistingAncestor(absolute);
  if (realSystemRoot === null || realTarget === null) {
    return absolute;
  }
  const realRelative = path.relative(realSystemRoot, realTarget.canonical);
  if (
    realTarget.canonical !== realSystemRoot &&
    (realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative))
  ) {
    throw new FrameworkError(
      `target locator escapes registered system through a symbolic link: ${locator.path}`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }
  return absolute;
}

async function canonicalPath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Canonical path of `target`, or of its closest existing ancestor when the
 * locator itself is absent. Containment of the ancestor is what matters: a
 * missing file under a symlinked parent is still outside the system.
 */
async function canonicalExistingAncestor(
  target: string,
): Promise<{ readonly canonical: string } | null> {
  let current = target;
  for (;;) {
    const canonical = await canonicalPath(current);
    if (canonical !== null) {
      return { canonical };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function snapshotTargetLocator(
  systemRoot: string,
  locator: SourceAdoptionPathLocator,
): Promise<SourceAdoptionLocatorSnapshot> {
  const absolute = await containedTargetPath(systemRoot, locator);
  let info: Stats;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return sourceAdoptionLocatorSnapshotSchema.parse({
        locator,
        state: "missing",
        digest: null,
        files: [],
      });
    }
    return sourceAdoptionLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (info.isSymbolicLink()) {
    return sourceAdoptionLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message: "symbolic-link locators are not followed",
    });
  }

  try {
    if (info.isFile()) {
      return snapshotFromFiles(locator, [await snapshotFile(systemRoot, absolute)]);
    }
    if (info.isDirectory() && locator.match === "prefix") {
      const files: Array<{
        readonly path: string;
        readonly size: number;
        readonly sha256: string;
      }> = [];
      await collectTargetFiles(systemRoot, absolute, files);
      return snapshotFromFiles(locator, files);
    }
    return sourceAdoptionLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message:
        locator.match === "exact"
          ? "exact locator resolved to a directory; use match: prefix"
          : "locator did not resolve to a regular file or directory",
    });
  } catch (error) {
    return sourceAdoptionLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function snapshotSourceAdoptionTarget(
  root: string,
  definition: SourceAdoptionDefinition,
  targetId: string,
): Promise<SourceAdoptionTargetSnapshot> {
  const target = definition.targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new FrameworkNotFoundError(
      `target '${targetId}' is not declared by Source adoption '${definition.id}'`,
    );
  }
  const registry = await requireSystemsRegistry(root);
  const system = systemRecordForSelector(registry, target.system);
  if (!system) {
    throw new FrameworkNotFoundError(`registered target system not found: ${target.system}`);
  }
  const systemRoot = resolveRegistryPath(root, system.path);
  let systemInfo: Stats;
  try {
    systemInfo = await lstat(systemRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const locators = Object.fromEntries(
        mappingsForTarget(definition, targetId).map((mapping) => [
          mapping.id,
          sourceAdoptionLocatorSnapshotSchema.parse({
            locator: {
              path: mapping.target.path,
              match: mapping.target.match,
            },
            state: "unresolvable",
            digest: null,
            files: [],
            message: `registered target system is missing: ${system.path}`,
          }),
        ]),
      );
      return sourceAdoptionTargetSnapshotSchema.parse({
        system: target.system,
        registered_path: system.path,
        adapter: target.adapter,
        revision: null,
        working_tree: "unknown",
        fingerprint: hashJson({
          system: target.system,
          registered_path: system.path,
          locators,
        }),
        locators,
      });
    }
    throw error;
  }
  if (!systemInfo.isDirectory()) {
    const locators = Object.fromEntries(
      mappingsForTarget(definition, targetId).map((mapping) => [
        mapping.id,
        sourceAdoptionLocatorSnapshotSchema.parse({
          locator: {
            path: mapping.target.path,
            match: mapping.target.match,
          },
          state: "unresolvable",
          digest: null,
          files: [],
          message: `registered target system is not a directory: ${system.path}`,
        }),
      ]),
    );
    return sourceAdoptionTargetSnapshotSchema.parse({
      system: target.system,
      registered_path: system.path,
      adapter: target.adapter,
      revision: null,
      working_tree: "unknown",
      fingerprint: hashJson({
        system: target.system,
        registered_path: system.path,
        locators,
      }),
      locators,
    });
  }

  const locators: Record<string, SourceAdoptionLocatorSnapshot> = {};
  for (const mapping of mappingsForTarget(definition, targetId)) {
    locators[mapping.id] = await snapshotTargetLocator(systemRoot, {
      path: mapping.target.path,
      match: mapping.target.match,
    });
  }

  const vcs = system.vcs === "none" ? undefined : await collectGitMetadata(systemRoot);
  const workingTree = vcs ? (vcs.dirty ? "dirty" : "clean") : "not-versioned";
  const fingerprint = hashJson({
    system: target.system,
    registered_path: system.path,
    locators,
  });
  return sourceAdoptionTargetSnapshotSchema.parse({
    system: target.system,
    registered_path: system.path,
    adapter: target.adapter,
    revision: vcs ? { kind: "git-commit", value: vcs.commit } : null,
    working_tree: workingTree,
    fingerprint,
    locators,
  });
}

export function sameLocatorSnapshot(
  left: SourceAdoptionLocatorSnapshot | null | undefined,
  right: SourceAdoptionLocatorSnapshot,
): boolean {
  if (!left) return false;
  return left.state === right.state && left.digest === right.digest;
}

export function sameTargetSnapshot(
  left: SourceAdoptionTargetSnapshot,
  right: SourceAdoptionTargetSnapshot,
): boolean {
  return left.system === right.system && left.fingerprint === right.fingerprint;
}
