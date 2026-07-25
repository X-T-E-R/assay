import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { stringifySortedJson, toPosixPath } from "../serialization.js";
import { resolveSourceObservation } from "../sources.js";
import { collectGitMetadata } from "../sources/git.js";
import { requireSystemsRegistry } from "../systems-registry.js";
import type {
  DonorAdoptionDefinition,
  DonorLocatorSnapshot,
  DonorMapping,
  DonorPathLocator,
  DonorSourceSnapshot,
  DonorTargetSnapshot,
} from "./schemas.js";
import {
  donorLocatorSnapshotSchema,
  donorSourceSnapshotSchema,
  donorTargetSnapshotSchema,
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

function recomputeSourceManifestFingerprint(manifest: z.infer<typeof sourceManifestSchema>): {
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

function mappingsForTarget(definition: DonorAdoptionDefinition, targetId: string): DonorMapping[] {
  return definition.mappings.filter((mapping) => mapping.target.target_id === targetId);
}

function snapshotFromFiles(
  locator: DonorPathLocator,
  files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[],
): DonorLocatorSnapshot {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return donorLocatorSnapshotSchema.parse({
    locator,
    state: sorted.length > 0 ? "present" : "missing",
    digest: sorted.length > 0 ? hashJson({ locator, files: sorted }) : null,
    files: sorted,
  });
}

export function snapshotManifestLocator(
  manifest: z.infer<typeof sourceManifestSchema>,
  locator: DonorPathLocator,
): DonorLocatorSnapshot {
  const files = manifest.files.filter((file) =>
    locator.match === "exact"
      ? file.path === locator.path
      : file.path === locator.path || file.path.startsWith(`${locator.path}/`),
  );
  return snapshotFromFiles(locator, files);
}

export async function snapshotDonorSource(
  root: string,
  definition: DonorAdoptionDefinition,
  targetId: string,
  observation?: string,
): Promise<DonorSourceSnapshot> {
  const resolved = await resolveSourceObservation({
    root,
    alias: definition.source.alias,
    ...(observation === undefined ? {} : { observation }),
  });
  const manifestPath = path.resolve(root, resolved.manifestFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new FrameworkError(`source manifest is not valid JSON: ${resolved.manifestFile}`, {
      code: "INVALID_DONOR",
      cause: error,
    });
  }
  const result = sourceManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new FrameworkError(`source manifest failed validation: ${resolved.manifestFile}`, {
      code: "INVALID_DONOR",
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  const manifest = result.data;
  const recomputed = recomputeSourceManifestFingerprint(manifest);
  if (
    manifest.fingerprint.value !== resolved.observation.fingerprint.value ||
    manifest.fingerprint.value !== recomputed.value ||
    manifest.files.length !== manifest.fingerprint.file_count ||
    manifest.fingerprint.byte_count !== recomputed.byteCount
  ) {
    throw new FrameworkError(
      `source observation and manifest fingerprints do not agree: ${resolved.observation.observation_id}`,
      { code: "INVALID_DONOR" },
    );
  }

  const locators: Record<string, DonorLocatorSnapshot> = {};
  for (const mapping of mappingsForTarget(definition, targetId)) {
    locators[mapping.id] = snapshotManifestLocator(manifest, mapping.source);
  }

  return donorSourceSnapshotSchema.parse({
    alias: definition.source.alias,
    lineage_id: resolved.observation.lineage_id,
    observation_id: resolved.observation.observation_id,
    manifest_fingerprint: manifest.fingerprint.value,
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
        { code: "INVALID_DONOR" },
      );
    }
    if (entry.isDirectory()) {
      await collectTargetFiles(systemRoot, absolute, files);
    } else if (entry.isFile()) {
      files.push(await snapshotFile(systemRoot, absolute));
    }
  }
}

function containedTargetPath(systemRoot: string, locator: DonorPathLocator): string {
  const absolute = path.resolve(systemRoot, ...locator.path.split("/"));
  const relative = path.relative(systemRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FrameworkError(`target locator escapes registered system: ${locator.path}`, {
      code: "INVALID_DONOR",
    });
  }
  return absolute;
}

async function snapshotTargetLocator(
  systemRoot: string,
  locator: DonorPathLocator,
): Promise<DonorLocatorSnapshot> {
  const absolute = containedTargetPath(systemRoot, locator);
  let info: Stats;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return donorLocatorSnapshotSchema.parse({
        locator,
        state: "missing",
        digest: null,
        files: [],
      });
    }
    return donorLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (info.isSymbolicLink()) {
    return donorLocatorSnapshotSchema.parse({
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
    return donorLocatorSnapshotSchema.parse({
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
    return donorLocatorSnapshotSchema.parse({
      locator,
      state: "unresolvable",
      digest: null,
      files: [],
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function snapshotDonorTarget(
  root: string,
  definition: DonorAdoptionDefinition,
  targetId: string,
): Promise<DonorTargetSnapshot> {
  const target = definition.targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new FrameworkNotFoundError(
      `target '${targetId}' is not declared by donor adoption '${definition.id}'`,
    );
  }
  const registry = await requireSystemsRegistry(root);
  const system = registry.systems[target.system];
  if (!system) {
    throw new FrameworkNotFoundError(`registered target system not found: ${target.system}`);
  }
  const systemRoot = path.resolve(root, system.path);
  let systemInfo: Stats;
  try {
    systemInfo = await lstat(systemRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const locators = Object.fromEntries(
        mappingsForTarget(definition, targetId).map((mapping) => [
          mapping.id,
          donorLocatorSnapshotSchema.parse({
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
      return donorTargetSnapshotSchema.parse({
        system: system.name,
        registered_path: system.path,
        adapter: target.adapter,
        revision: null,
        working_tree: "unknown",
        fingerprint: hashJson({
          system: system.name,
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
        donorLocatorSnapshotSchema.parse({
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
    return donorTargetSnapshotSchema.parse({
      system: system.name,
      registered_path: system.path,
      adapter: target.adapter,
      revision: null,
      working_tree: "unknown",
      fingerprint: hashJson({
        system: system.name,
        registered_path: system.path,
        locators,
      }),
      locators,
    });
  }

  const locators: Record<string, DonorLocatorSnapshot> = {};
  for (const mapping of mappingsForTarget(definition, targetId)) {
    locators[mapping.id] = await snapshotTargetLocator(systemRoot, {
      path: mapping.target.path,
      match: mapping.target.match,
    });
  }

  const vcs = system.vcs === "none" ? undefined : await collectGitMetadata(systemRoot);
  const workingTree = vcs ? (vcs.dirty ? "dirty" : "clean") : "not-versioned";
  const fingerprint = hashJson({
    system: system.name,
    registered_path: system.path,
    locators,
  });
  return donorTargetSnapshotSchema.parse({
    system: system.name,
    registered_path: system.path,
    adapter: target.adapter,
    revision: vcs ? { kind: "git-commit", value: vcs.commit } : null,
    working_tree: workingTree,
    fingerprint,
    locators,
  });
}

export function sameLocatorSnapshot(
  left: DonorLocatorSnapshot | null | undefined,
  right: DonorLocatorSnapshot,
): boolean {
  if (!left) return false;
  return left.state === right.state && left.digest === right.digest;
}

export function sameTargetSnapshot(left: DonorTargetSnapshot, right: DonorTargetSnapshot): boolean {
  return (
    left.system === right.system &&
    left.registered_path === right.registered_path &&
    left.fingerprint === right.fingerprint
  );
}
