import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  type CloneRegistryEntry,
  findClonesByOrigin,
  recordSourceClone,
} from "./clone-registry.js";
import { MANAGED_DIR } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { resolveWorkspaceLayout, workspacePath, workspaceRelativePath } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import type { CheckRow } from "./results.js";
import type { FrameworkManifest } from "./schemas/index.js";
import { withSemanticModel } from "./semantics.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";
import {
  type BrokenSourceReference,
  SOURCE_REFERENCE_FILE,
  type SourceEntryReference,
  brokenReferenceMessage,
  describeBrokenReference,
  readSourceReferenceShell,
  referenceForHome,
  resolveSourceReference,
} from "./source-reference.js";
import {
  CHECKOUT_ADVISORY_LOCAL_MODIFICATIONS,
  assertManagedCheckout,
  changedPathsBetween,
  checkoutGitRef,
  cloneGitSource,
  collectGitMetadata,
  countTrackedFiles,
  ensureGitCheckout,
  isGitCheckout,
  readCheckoutLocalSignals,
  syncTargetForCheckout,
  updateManagedCheckout,
} from "./sources/git.js";
import { withWorkspaceMutationCoordination } from "./tasks/task-storage.js";
import { nowIso } from "./time.js";

/**
 * Sources: external material kept where its origin and its changes stay
 * readable.
 *
 * The shape follows what the material is, not a flag the caller picks:
 *
 * - `checkout` — a Git repository or URL, cloned into `checkout/`. Git already
 *   records what it looked like when, so the commit is its identity and
 *   `source sync` moves it.
 * - `copy` — a plain directory or archive, copied once into `content/`. There
 *   is no upstream to follow, so there is nothing to sync; new bytes arrive
 *   through an explicit `source import`.
 *
 * Evidence is pinned in tiers. The ordinary observation is a cheap append
 * record — date, commit when there is one, a note, and any advisories. An
 * identity pin is the commit, or for a non-Git source a tree hash computed on
 * demand. Byte-level preservation is always an explicit `source capture`. No
 * default path hashes a tree.
 *
 * A Source entry has two physical shapes. An owned entry holds `source.yaml`
 * and is the Source's home. A reference holds only `source.ref.yaml`, naming
 * the workspace that owns it; every operation below resolves the alias first
 * and then runs against the home, which is also the workspace whose lock and
 * event ledger a write uses. See `source-reference.ts` for the relationship
 * itself.
 */

export const SOURCE_CONTENT_MODES = ["checkout", "copy"] as const;
export type SourceContentMode = (typeof SOURCE_CONTENT_MODES)[number];

export const SOURCE_CHANGE_CLASSES = ["same", "patch", "normal", "major", "replacement"] as const;
export type SourceChangeClass = (typeof SOURCE_CHANGE_CLASSES)[number];

/** What produced an observation. Every entry says how it came to be recorded. */
export const SOURCE_OBSERVATION_KINDS = ["add", "sync", "capture", "import"] as const;
export type SourceObservationKind = (typeof SOURCE_OBSERVATION_KINDS)[number];

export type SourceKind = "git" | "directory" | "archive" | "url" | "unknown";
export interface SourceVcsMetadata {
  readonly type: "git";
  readonly remote: string | null;
  readonly ref: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly commit_date: string | null;
  readonly common_ancestor_with_previous?: boolean;
}

export interface SourceFingerprint {
  readonly algorithm: "sha256-tree-v1";
  readonly value: string;
  readonly file_count: number;
  readonly byte_count: number;
  readonly excluded: readonly string[];
}

export interface SourceLineage {
  readonly lineage_id: string;
  readonly lineage_name: string;
  readonly source_kind: SourceKind;
  readonly source_uri: string;
  readonly created_on: string;
  readonly latest_observation: string | null;
  readonly content_mode: SourceContentMode;
  readonly checkout?: {
    readonly path: "checkout";
    readonly ref: string | null;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
}

/** A byte-level capture: the explicit tier, with its own integrity hash. */
export interface SourceCapture {
  readonly path: string;
  readonly manifest: string;
  readonly algorithm: "sha256-tree-v1";
  readonly value: string;
  readonly file_count: number;
  readonly byte_count: number;
}

/**
 * One entry in a Source's append-only ledger.
 *
 * Cheap by design: the date, what produced it, the commit when the source is
 * Git-backed, a one-line note, and any advisories worth carrying forward. A
 * `capture` block appears only on the observations that preserved bytes.
 */
export interface SourceObservation {
  readonly observation_id: string;
  readonly observed_on: string;
  readonly lineage_id: string;
  readonly source_path: string;
  readonly previous_observation: string | null;
  readonly kind: SourceObservationKind;
  readonly change_class: SourceChangeClass;
  readonly note: string;
  readonly advisories: readonly string[];
  readonly vcs?: SourceVcsMetadata;
  readonly capture?: SourceCapture;
}

export interface SourceManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SourceManifest {
  readonly __schema: 1;
  readonly generated_on: string;
  readonly root: string;
  readonly fingerprint: SourceFingerprint;
  readonly files: readonly SourceManifestFile[];
}

export interface SourceAddOptions {
  readonly root: string;
  readonly source: string;
  readonly alias?: string;
  readonly branch?: string;
  readonly now?: Date;
  /**
   * Advisories as they happen, so the "this is already cloned somewhere" line
   * reaches the caller before the clone runs rather than after it.
   */
  readonly onNotice?: (notice: string) => void;
  /** Clone-registry file; the environment or the user default when omitted. */
  readonly registryFile?: string;
}

export interface SourceAddResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly sourceFile: string;
  readonly observationFile: string;
  readonly contentMode: SourceContentMode;
  readonly contentPath: string;
  readonly materialsPath: string;
  readonly observation: SourceObservation;
  readonly eventFile: string;
  /** Advisory lines this add produced; never a refusal. */
  readonly notices: readonly string[];
}

/** Write-through announcement: a Source command that lands in another workspace says so first. */
export interface SourceWriteThroughNotice {
  readonly onNotice?: (notice: string) => void;
}

export interface SourceSyncOptions extends SourceWriteThroughNotice {
  readonly root: string;
  readonly alias?: string;
  readonly branch?: string;
  readonly ref?: string;
  readonly changeClass?: SourceChangeClass;
  readonly now?: Date;
  /** Test seam: full path to the clone registry file. */
  readonly registryFile?: string;
}

export interface SourceSyncResult {
  /** Workspace this write landed in: the Source's home, not always the caller's. */
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly changeClass: SourceChangeClass;
  readonly observationFile: string | null;
  readonly observation: SourceObservation | null;
  /** What the update noticed; recorded on the observation, never a refusal. */
  readonly advisories: readonly string[];
  readonly eventFile: string;
  readonly comparison?: SourceDiffResult;
  /** Set when the alias was a reference, so output can name the real home. */
  readonly reference: SourceEntryReference | null;
}

export interface SourceCaptureOptions extends SourceWriteThroughNotice {
  readonly root: string;
  readonly alias: string;
  readonly note?: string;
  readonly now?: Date;
}

export interface SourceCaptureResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly observationFile: string;
  readonly observation: SourceObservation;
  readonly capture: SourceCapture;
  readonly capturePath: string;
  readonly manifestFile: string;
  readonly eventFile: string;
  readonly reference: SourceEntryReference | null;
}

export interface SourceImportOptions extends SourceWriteThroughNotice {
  readonly root: string;
  readonly alias: string;
  readonly from: string;
  readonly note?: string;
  readonly now?: Date;
}

export interface SourceImportResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly contentPath: string;
  readonly observationFile: string;
  readonly observation: SourceObservation;
  /** Capture that preserved the bytes the import replaced, when there were any. */
  readonly preservedCapture: SourceCapture | null;
  readonly changeClass: SourceChangeClass;
  readonly eventFile: string;
  readonly reference: SourceEntryReference | null;
}

export interface SourceSwitchOptions extends SourceWriteThroughNotice {
  readonly root: string;
  readonly alias: string;
  readonly target: string;
  readonly sync?: boolean;
  readonly now?: Date;
}

export interface SourceSwitchResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly target: string;
  readonly vcs: SourceVcsMetadata;
  readonly eventFile: string;
  readonly sync?: SourceSyncResult;
  readonly reference: SourceEntryReference | null;
}

export interface SourceStatusEntry {
  readonly alias: string;
  /** Path to the material, relative to the workspace that owns it. */
  readonly path: string;
  /** Absolute path of the Source directory, wherever its home is. */
  readonly absolutePath: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly uri: string;
  readonly contentMode: SourceContentMode;
  readonly latestObservation: string | null;
  readonly latestChangeClass: SourceChangeClass | null;
  readonly latestAdvisories: readonly string[];
  /** Byte captures recorded for this source; 0 means nothing was pinned that deep. */
  readonly captures: number;
  readonly relation: "owned" | "ref";
  /** Set for a referenced Source; read output must show it rather than hide it. */
  readonly reference: SourceEntryReference | null;
  readonly vcs?: SourceVcsMetadata;
  readonly checkout?: SourceLineage["checkout"];
}

export interface SourceStatusResult {
  readonly root: string;
  readonly sources: readonly SourceStatusEntry[];
  /**
   * References whose home could not be reached. Listed separately because they
   * have no lineage to report, and reported at all because a reference that
   * silently disappeared from `source list` is worse than one marked broken.
   */
  readonly broken: readonly BrokenSourceReference[];
}

export interface SourceLogEntry {
  readonly observation: SourceObservation;
  readonly path: string;
}

export interface SourceLogResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly entries: readonly SourceLogEntry[];
  readonly reference: SourceEntryReference | null;
}

export interface SourceDiffOptions {
  readonly root: string;
  readonly alias: string;
  readonly since?: string;
}

export interface SourceDiffResult {
  readonly root: string;
  readonly alias: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly reference?: SourceEntryReference | null;
}

export interface SourceObservationResolveOptions {
  readonly root: string;
  readonly alias: string;
  readonly observation?: string;
}

export interface SourceObservationResolution {
  /** Workspace the resolved paths are relative to: the Source's home. */
  readonly root: string;
  readonly alias: string;
  readonly sourcePath: string;
  readonly observationFile: string;
  readonly observation: SourceObservation;
  readonly contentMode: SourceContentMode;
  /** Where the readable bytes for this observation are, home-relative. */
  readonly contentPath: string;
  readonly materialsPath: string;
  readonly capturePath: string | null;
  /**
   * Set when the local alias is a reference. Evidence records the observation
   * and the home it resolved to, because the alias is only a navigation name.
   */
  readonly reference: SourceEntryReference | null;
}

/**
 * A file listing for a Source, computed when something actually needs it.
 *
 * This is the lazy half of the tier model: a capture already carries its
 * manifest, and anything else is hashed here, at the moment a decision wants a
 * content pin. Nothing on the ordinary observation path calls it.
 */
export interface SourceContentListing {
  readonly alias: string;
  readonly observationId: string;
  /** Whether the listing came from a stored capture or from current content. */
  readonly origin: "capture" | "content";
  readonly relativeRoot: string;
  readonly fingerprint: SourceFingerprint;
  readonly files: readonly SourceManifestFile[];
}

/**
 * One resolved Source, whether this workspace owns it or references it.
 *
 * `relativePath` and `absolutePath` address the material in its home, because
 * that is where the ledger and the bytes are; `homeRoot` is the workspace root
 * they are relative to, and it is the consumer root only for an owned entry.
 * `reference` is set exactly when the local alias came from a shell.
 */
interface SourceEntry {
  readonly alias: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly lineage: SourceLineage;
  readonly homeRoot: string;
  readonly reference: SourceEntryReference | null;
}

type SourceEntryListing =
  | { readonly kind: "entry"; readonly entry: SourceEntry }
  | { readonly kind: "broken"; readonly broken: BrokenSourceReference };

const GENERATED_SOURCE_PARTS = new Set([
  ".assay",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

const SELECTED_MATERIAL_FILES = [
  "README.md",
  "README.MD",
  "readme.md",
  "Readme.md",
  "LICENSE",
  "LICENSE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireManifestPresent(
  manifest: FrameworkManifest | null,
  root: string,
): FrameworkManifest {
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No Assay manifest found at ${path.join(root, MANAGED_DIR, "manifest.json")}.`,
    );
  }
  return manifest;
}

function layoutForManifest(manifest: FrameworkManifest) {
  const layout = resolveWorkspaceLayout(manifest);
  if (!layout) {
    throw new FrameworkNotFoundError("Assay workspace layout could not be resolved.");
  }
  return layout;
}

async function preflightSourceWorkspace(root: string): Promise<FrameworkManifest> {
  return requireManifestPresent(await loadManifest(root), root);
}

function sourcesRootForManifest(root: string, manifest: FrameworkManifest): string {
  return workspacePath(root, layoutForManifest(manifest), "sources");
}

function sourcesRelativeForManifest(manifest: FrameworkManifest): string {
  return workspaceRelativePath(layoutForManifest(manifest), "sources");
}

function assertChangeClass(value: SourceChangeClass): void {
  if (!SOURCE_CHANGE_CLASSES.includes(value)) {
    throw new FrameworkError(`change class must be one of: ${SOURCE_CHANGE_CLASSES.join(", ")}`);
  }
}

function dateCompact(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}

function displaySourceName(source: string): string {
  const trimmed = source.replace(/[\\/]+$/, "");
  const parsed = trimmed.match(/([^/\\#:]+?)(?:\.git)?$/);
  return parsed?.[1] && parsed[1] !== "" ? parsed[1] : "source";
}

function aliasForSource(source: string, alias?: string): string {
  return slugify(alias ?? displaySourceName(source));
}

function looksLikeGitUri(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(value) || value.endsWith(".git");
}

function shouldSkipRelative(relativePath: string): boolean {
  if (relativePath === "") return false;
  return relativePath.split("/").some((part) => GENERATED_SOURCE_PARTS.has(part));
}

function shouldCopySource(sourceRoot: string, destination: string): boolean {
  const relative = toPosixPath(path.relative(sourceRoot, destination));
  return !shouldSkipRelative(relative);
}

function shouldCopyCheckout(sourceRoot: string, destination: string): boolean {
  const relative = toPosixPath(path.relative(sourceRoot, destination));
  if (relative === "") return true;
  return !relative.split("/").some((part) => part !== ".git" && GENERATED_SOURCE_PARTS.has(part));
}

async function readYamlFile<T>(file: string): Promise<T> {
  const parsed = parseYaml(await readFile(file, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new FrameworkError(`YAML file is not an object: ${file}`, { code: "IO_ERROR" });
  }
  return parsed as T;
}

/** Fields that named a retired concept; a workspace still carrying one needs `assay update`. */
const RETIRED_LINEAGE_FIELDS = ["status", "relation", "mode", "default_capture_mode"] as const;
const RETIRED_OBSERVATION_FIELDS = [
  "analysis_status",
  "analysis_path",
  "analysis_exit",
  "analysis_closed_on",
  "capture_mode",
  "fingerprint",
  "manifest",
] as const;

async function readSourceLineageFile(file: string): Promise<SourceLineage> {
  const value = await readYamlFile<Record<string, unknown>>(file);
  for (const field of RETIRED_LINEAGE_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new FrameworkError(`source lineage contains retired field '${field}': ${file}`, {
        code: "IO_ERROR",
      });
    }
  }
  if (
    typeof value.content_mode !== "string" ||
    !SOURCE_CONTENT_MODES.includes(value.content_mode as SourceContentMode)
  ) {
    throw new FrameworkError(
      `source content mode must be one of: ${SOURCE_CONTENT_MODES.join(", ")}: ${file}`,
      { code: "IO_ERROR" },
    );
  }
  return value as unknown as SourceLineage;
}

async function readSourceObservationFile(file: string): Promise<SourceObservation> {
  const value = await readYamlFile<Record<string, unknown>>(file);
  for (const field of RETIRED_OBSERVATION_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new FrameworkError(`source observation contains retired field '${field}': ${file}`, {
        code: "IO_ERROR",
      });
    }
  }
  if (
    typeof value.kind !== "string" ||
    !SOURCE_OBSERVATION_KINDS.includes(value.kind as SourceObservationKind)
  ) {
    throw new FrameworkError(
      `source observation kind must be one of: ${SOURCE_OBSERVATION_KINDS.join(", ")}: ${file}`,
      { code: "IO_ERROR" },
    );
  }
  return {
    ...(value as unknown as SourceObservation),
    advisories: Array.isArray(value.advisories) ? (value.advisories as string[]) : [],
  };
}

async function writeYamlFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(value), "utf8");
}

// Source-entry ledger directories live directly under sources/<alias>/.
const OBSERVATIONS_DIR = "observations";
const CAPTURES_DIR = "captures";
const CHECKOUT_DIR = "checkout";
const COPY_CONTENT_DIR = "content";
const MATERIALS_DIR = "materials";

function observationPath(observationId: string): string {
  return `${OBSERVATIONS_DIR}/${observationId}.yaml`;
}

function capturePath(observationId: string): string {
  return `${CAPTURES_DIR}/${observationId}/source`;
}

function captureManifestPath(observationId: string): string {
  return `${CAPTURES_DIR}/${observationId}/manifest.json`;
}

/** Where a Source keeps its readable bytes, by content mode. */
export function sourceContentDir(mode: SourceContentMode): string {
  return mode === "checkout" ? CHECKOUT_DIR : COPY_CONTENT_DIR;
}

function isGitMetadata(value: SourceVcsMetadata | undefined): value is SourceVcsMetadata {
  return value !== undefined && value.type === "git" && value.commit.length > 0;
}

async function collectManifest(
  sourceRoot: string,
  generatedOn: string,
  recordedRoot?: string,
): Promise<SourceManifest> {
  const files: SourceManifestFile[] = [];
  await collectFiles(sourceRoot, sourceRoot, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const treeHash = createHash("sha256");
  let byteCount = 0;
  for (const file of files) {
    treeHash.update(file.path);
    treeHash.update("\0");
    treeHash.update(file.sha256);
    treeHash.update("\0");
    treeHash.update(String(file.size));
    treeHash.update("\n");
    byteCount += file.size;
  }

  const fingerprint: SourceFingerprint = {
    algorithm: "sha256-tree-v1",
    value: treeHash.digest("hex"),
    file_count: files.length,
    byte_count: byteCount,
    excluded: [...GENERATED_SOURCE_PARTS].sort(),
  };

  return {
    __schema: 1,
    generated_on: generatedOn,
    root: recordedRoot ?? sourceRoot,
    fingerprint,
    files,
  };
}

async function collectFiles(
  root: string,
  current: string,
  files: SourceManifestFile[],
): Promise<void> {
  if (!(await exists(current))) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = toPosixPath(path.relative(root, absolute));
    if (shouldSkipRelative(relative)) continue;

    if (entry.isDirectory()) {
      await collectFiles(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const content = await readFile(absolute);
    files.push({
      path: relative,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
}

async function writeManifest(file: string, manifest: SourceManifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifySortedJson(manifest), "utf8");
}

async function readManifest(file: string): Promise<SourceManifest> {
  return JSON.parse(await readFile(file, "utf8")) as SourceManifest;
}

async function writeStructure(root: string, outputFile: string): Promise<void> {
  const lines = await treeLines(root, root, 2);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `# Structure\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`, "utf8");
}

async function treeLines(root: string, current: string, depth: number): Promise<string[]> {
  if (depth < 0 || !(await exists(current))) return [];
  const entries = (await readdir(current, { withFileTypes: true }))
    .filter(
      (entry) =>
        !shouldSkipRelative(toPosixPath(path.relative(root, path.join(current, entry.name)))),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 80);
  const lines: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = toPosixPath(path.relative(root, absolute));
    lines.push(entry.isDirectory() ? `${relative}/` : relative);
    if (entry.isDirectory()) {
      lines.push(...(await treeLines(root, absolute, depth - 1)));
    }
  }
  return lines;
}

async function materializeSelectedFiles(sourceRoot: string, materialsDir: string): Promise<number> {
  let copied = 0;
  for (const file of SELECTED_MATERIAL_FILES) {
    const source = path.join(sourceRoot, file);
    if (!(await exists(source))) continue;
    const target = path.join(materialsDir, "files", file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: false });
    copied += 1;
  }
  return copied;
}

/**
 * Copy a directory (or a single archive file) into the Source's own content
 * root, so a copied source is readable without its origin still being there.
 */
async function copyContentInto(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  if (info.isDirectory()) {
    await cp(source, destination, {
      recursive: true,
      filter: (_source, dest) => shouldCopyCheckout(destination, dest),
    });
    return;
  }
  await mkdir(destination, { recursive: true });
  await cp(source, path.join(destination, path.basename(source)));
}

/**
 * Decide what a Source is and put its bytes in place.
 *
 * A Git repository or URL becomes a checkout, because Git is what makes
 * "what did it look like then" free. Everything else is copied in once.
 */
async function prepareSourceContent(
  entryRoot: string,
  source: string,
  branch: string | undefined,
): Promise<{
  readonly contentMode: SourceContentMode;
  readonly contentRoot: string;
  readonly sourceKind: SourceKind;
}> {
  const sourceExists = await exists(source);
  const sourceIsGit = sourceExists && (await exists(path.join(source, ".git")));
  if (!sourceExists && !looksLikeGitUri(source)) {
    throw new FrameworkNotFoundError(`source not found: ${source}`);
  }

  if (sourceIsGit || !sourceExists) {
    const checkout = path.join(entryRoot, CHECKOUT_DIR);
    await cloneGitSource(
      source,
      checkout,
      branch ? { kind: "branch", value: branch } : null,
      !sourceExists,
    );
    return { contentMode: "checkout", contentRoot: checkout, sourceKind: "git" };
  }

  const content = path.join(entryRoot, COPY_CONTENT_DIR);
  const info = await stat(source);
  await copyContentInto(source, content);
  return {
    contentMode: "copy",
    contentRoot: content,
    sourceKind: info.isDirectory() ? "directory" : "archive",
  };
}

/**
 * Update a checkout-backed Source in place, recording what it could not do.
 *
 * Nothing here refuses: a checkout carrying uncommitted work is observed as it
 * stands with an advisory, and Git's own guards keep the bytes.
 */
async function refreshCheckoutForSync(
  entry: SourceEntry,
  options: Pick<SourceSyncOptions, "branch" | "ref">,
): Promise<{ readonly checkout: string; readonly advisories: readonly string[] }> {
  const checkout = path.join(entry.absolutePath, CHECKOUT_DIR);
  const cloned = (await isGitCheckout(checkout))
    ? false
    : await ensureCheckoutPresent(entry, checkout, options);
  if (cloned || !(await isGitCheckout(checkout))) {
    return { checkout, advisories: [] };
  }

  const target = await syncTargetForCheckout(options, checkout, entry.lineage);
  const update = await updateManagedCheckout({
    entryRoot: entry.absolutePath,
    sourceUri: entry.lineage.source_uri,
    target,
    requested: options.branch !== undefined || options.ref !== undefined,
  });
  return { checkout, advisories: update.advisories };
}

/** Re-clone a checkout whose bytes are gone; a present checkout is never replaced. */
async function ensureCheckoutPresent(
  entry: SourceEntry,
  checkout: string,
  options: Pick<SourceSyncOptions, "branch" | "ref">,
): Promise<boolean> {
  if (await exists(checkout)) {
    return false;
  }
  const target = options.ref
    ? ({ kind: "ref", value: options.ref } as const)
    : options.branch
      ? ({ kind: "branch", value: options.branch } as const)
      : entry.lineage.checkout?.ref && entry.lineage.checkout.ref !== "HEAD"
        ? ({ kind: "branch", value: entry.lineage.checkout.ref } as const)
        : null;
  return ensureGitCheckout(
    entry.absolutePath,
    entry.lineage.source_uri,
    target,
    !(await exists(entry.lineage.source_uri)),
  );
}

async function ensureSourceScaffold(entryRoot: string): Promise<void> {
  await mkdir(path.join(entryRoot, MATERIALS_DIR), { recursive: true });
  await mkdir(path.join(entryRoot, OBSERVATIONS_DIR), { recursive: true });
}

async function nextObservationId(entryRoot: string, now: Date, suffix: string): Promise<string> {
  const base = `${dateCompact(now)}-${suffix.slice(0, 12)}`;
  const obsDir = path.join(entryRoot, OBSERVATIONS_DIR);
  if (!(await exists(path.join(obsDir, `${base}.yaml`)))) {
    return base;
  }
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${base}-${String(i).padStart(2, "0")}`;
    if (!(await exists(path.join(obsDir, `${candidate}.yaml`)))) {
      return candidate;
    }
  }
  throw new FrameworkAlreadyExistsError(`too many observations for ${base}`);
}

/**
 * Identity suffix for an observation id: the commit for a Git source, and the
 * kind for anything else. Neither costs a tree hash.
 */
function observationSuffix(kind: SourceObservationKind, vcs?: SourceVcsMetadata): string {
  return isGitMetadata(vcs) ? vcs.commit : kind;
}

function compareManifests(
  previous: SourceManifest | null,
  current: SourceManifest,
): SourceDiffResult {
  const previousMap = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const currentMap = new Map(current.files.map((file) => [file.path, file]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [filePath, file] of currentMap) {
    const old = previousMap.get(filePath);
    if (!old) {
      added.push(filePath);
    } else if (old.sha256 !== file.sha256 || old.size !== file.size) {
      changed.push(filePath);
    }
  }

  for (const filePath of previousMap.keys()) {
    if (!currentMap.has(filePath)) {
      removed.push(filePath);
    }
  }

  return {
    root: "",
    alias: "",
    from: null,
    to: null,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

function classFromRatio(changedCount: number, total: number): SourceChangeClass {
  const ratio = changedCount / Math.max(total, 1);
  if (changedCount === 0) return "patch";
  if (ratio <= 0.05) return "patch";
  if (ratio <= 0.4) return "normal";
  return "major";
}

/**
 * Grade how much a checkout-backed Source moved, using only what Git already
 * knows: which commit it was on, whether the remote is the same one, and which
 * paths differ between the two commits. No tree is hashed to answer this.
 */
async function classifyCheckoutChange(input: {
  readonly checkout: string;
  readonly previous: SourceObservation | null;
  readonly vcs: SourceVcsMetadata | undefined;
  readonly dirtyPaths: readonly string[];
  readonly forced?: SourceChangeClass;
}): Promise<SourceChangeClass> {
  if (input.forced) {
    assertChangeClass(input.forced);
    return input.forced;
  }
  const previousVcs = input.previous?.vcs;
  if (!input.previous || !isGitMetadata(previousVcs) || !isGitMetadata(input.vcs)) {
    return "normal";
  }
  if (previousVcs.commit === input.vcs.commit) {
    if (previousVcs.dirty === input.vcs.dirty) {
      return "same";
    }
    const tracked = await countTrackedFiles(input.checkout);
    return classFromRatio(input.dirtyPaths.length, tracked ?? input.dirtyPaths.length);
  }
  if (previousVcs.remote && input.vcs.remote && previousVcs.remote !== input.vcs.remote) {
    return "replacement";
  }
  if (input.vcs.common_ancestor_with_previous === false) {
    return "replacement";
  }
  const changes = await changedPathsBetween(input.checkout, previousVcs.commit, input.vcs.commit);
  if (!changes) {
    return "normal";
  }
  const tracked = await countTrackedFiles(input.checkout);
  const changedCount = changes.added.length + changes.removed.length + changes.changed.length;
  return classFromRatio(changedCount, tracked ?? changedCount);
}

interface AppendObservationInput {
  readonly entryRoot: string;
  readonly relativePath: string;
  readonly lineage: SourceLineage;
  readonly now: Date;
  readonly kind: SourceObservationKind;
  readonly changeClass: SourceChangeClass;
  readonly note: string;
  readonly advisories: readonly string[];
  readonly previousObservation: SourceObservation | null;
  readonly vcs?: SourceVcsMetadata | undefined;
  readonly capture?: SourceCapture;
  readonly id?: string;
}

/** Append one cheap entry to the ledger. Nothing here reads or hashes content. */
async function appendObservation(input: AppendObservationInput): Promise<{
  readonly observation: SourceObservation;
  readonly observationFile: string;
}> {
  const observedOn = nowIso(input.now);
  const id =
    input.id ??
    (await nextObservationId(input.entryRoot, input.now, observationSuffix(input.kind, input.vcs)));
  const observation: SourceObservation = {
    observation_id: id,
    observed_on: observedOn,
    lineage_id: input.lineage.lineage_id,
    source_path: input.relativePath,
    previous_observation: input.previousObservation
      ? observationPath(input.previousObservation.observation_id)
      : null,
    kind: input.kind,
    change_class: input.changeClass,
    note: input.note,
    advisories: [...input.advisories],
    ...(input.vcs ? { vcs: input.vcs } : {}),
    ...(input.capture ? { capture: input.capture } : {}),
  };
  await writeYamlFile(path.join(input.entryRoot, observationPath(id)), observation);
  return { observation, observationFile: observationPath(id) };
}

function updateLineageForObservation(
  lineage: SourceLineage,
  observation: SourceObservation,
): SourceLineage {
  return {
    ...lineage,
    latest_observation: observationPath(observation.observation_id),
    ...(lineage.content_mode === "checkout" && observation.vcs
      ? {
          checkout: {
            path: CHECKOUT_DIR,
            ref: observation.vcs.ref,
            commit: observation.vcs.commit,
            dirty: observation.vcs.dirty,
          },
        }
      : {}),
  };
}

async function writeSourceCard(
  entryRoot: string,
  lineage: SourceLineage,
  observation: SourceObservation,
): Promise<void> {
  const contentDir = sourceContentDir(lineage.content_mode);
  const lines = [
    `# ${lineage.lineage_name}`,
    "",
    `- Source kind: ${lineage.source_kind}`,
    `- Source URI: ${lineage.source_uri}`,
    `- Latest observation: ${lineage.latest_observation ?? observationPath(observation.observation_id)}`,
    `- Content: ${contentDir}/ (${lineage.content_mode === "checkout" ? "checkout-backed, moved by `assay source sync`" : "copied content, replaced by `assay source import`"})`,
    `- Change class: ${observation.change_class}`,
    "",
    "## Entrypoints",
    "",
    "- `source.yaml`: durable source identity",
    `- \`${contentDir}/\`: the readable bytes of this source`,
    "- `materials/`: selected extracts and supporting files",
    "- `observations/`: append-only ledger of what was seen and when",
    "- `captures/`: byte captures, each with its own integrity manifest",
    "",
  ];
  await writeFile(path.join(entryRoot, "README.md"), lines.join("\n"), "utf8");
}

/** Owned entry: the workspace it was found in is also its home. */
async function ownedSourceEntry(
  root: string,
  sourcesRelative: string,
  alias: string,
): Promise<SourceEntry> {
  const entryRoot = path.join(root, sourcesRelative, alias);
  return {
    alias,
    relativePath: `${sourcesRelative}/${alias}`,
    absolutePath: entryRoot,
    lineage: await readSourceLineageFile(path.join(entryRoot, "source.yaml")),
    homeRoot: root,
    reference: null,
  };
}

/**
 * Resolve a reference shell into an entry addressed in its home.
 *
 * The alias stays the local one — that is the name the caller typed and the name
 * every record in this workspace uses — while the paths, the ledger, and the
 * lock all move to the home.
 */
async function referencedSourceEntry(
  localAlias: string,
  reference: SourceEntryReference,
  homeSourcesRelative: string,
  homeEntryRoot: string,
): Promise<SourceEntry> {
  return {
    alias: localAlias,
    relativePath: `${homeSourcesRelative}/${reference.homeAlias}`,
    absolutePath: homeEntryRoot,
    lineage: await readSourceLineageFile(path.join(homeEntryRoot, "source.yaml")),
    homeRoot: reference.homeRoot,
    reference,
  };
}

async function sourceEntryListingForAlias(
  root: string,
  sourcesRelative: string,
  alias: string,
  registryFile?: string,
): Promise<SourceEntryListing | null> {
  const entryRoot = path.join(root, sourcesRelative, alias);
  if (await exists(path.join(entryRoot, "source.yaml"))) {
    return { kind: "entry", entry: await ownedSourceEntry(root, sourcesRelative, alias) };
  }
  const shell = await readSourceReferenceShell({ consumerRoot: root, sourcesRelative, alias });
  if (!shell) return null;
  const resolution = await resolveSourceReference(shell);
  if (!resolution.ok) {
    return {
      kind: "broken",
      broken: await describeBrokenReference({
        shell,
        reason: resolution.reason,
        ...(registryFile === undefined ? {} : { registryFile }),
      }),
    };
  }
  return {
    kind: "entry",
    entry: await referencedSourceEntry(
      alias,
      referenceForHome(shell, resolution.home),
      resolution.home.sourcesRelative,
      resolution.home.entryRoot,
    ),
  };
}

async function sourceEntryForAlias(root: string, alias?: string): Promise<SourceEntry> {
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const sourcesRoot = sourcesRootForManifest(root, manifest);
  const sourcesRelative = sourcesRelativeForManifest(manifest);
  if (!(await exists(sourcesRoot))) {
    throw new FrameworkNotFoundError(`no sources directory found: ${sourcesRelative}`);
  }

  if (alias) {
    const normalized = slugify(alias);
    const listing = await sourceEntryListingForAlias(root, sourcesRelative, normalized);
    if (!listing) {
      throw new FrameworkNotFoundError(`source not found: ${normalized}`);
    }
    // A broken reference fails here and nowhere else: the alias is unusable,
    // and every other object in this workspace is unaffected.
    if (listing.kind === "broken") {
      throw new FrameworkNotFoundError(brokenReferenceMessage(listing.broken));
    }
    return listing.entry;
  }

  const entries = (await listSourceEntryListings(root))
    .filter(
      (listing): listing is Extract<SourceEntryListing, { kind: "entry" }> =>
        listing.kind === "entry",
    )
    .map((listing) => listing.entry);
  if (entries.length === 0) {
    throw new FrameworkNotFoundError("no sources found");
  }
  if (entries.length > 1) {
    throw new FrameworkError(
      `source alias required; found ${entries.map((entry) => entry.alias).join(", ")}`,
    );
  }
  const [entry] = entries;
  if (!entry) {
    throw new FrameworkNotFoundError("no sources found");
  }
  return entry;
}

/** Every alias this workspace offers, resolved, with broken references named. */
async function listSourceEntryListings(
  root: string,
  registryFile?: string,
): Promise<SourceEntryListing[]> {
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const sourcesRoot = sourcesRootForManifest(root, manifest);
  const sourcesRelative = sourcesRelativeForManifest(manifest);
  if (!(await exists(sourcesRoot))) return [];
  const listings: SourceEntryListing[] = [];
  for (const entry of await readdir(sourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const listing = await sourceEntryListingForAlias(
      root,
      sourcesRelative,
      entry.name,
      registryFile,
    );
    if (listing) listings.push(listing);
  }
  return listings.sort((a, b) =>
    (a.kind === "entry" ? a.entry.alias : a.broken.alias).localeCompare(
      b.kind === "entry" ? b.entry.alias : b.broken.alias,
    ),
  );
}

async function loadObservation(
  entryRoot: string,
  observationRef: string | null,
): Promise<SourceObservation | null> {
  if (!observationRef) return null;
  const normalized = observationRef.replace(/\\/g, "/");
  const file = normalized.endsWith(".yaml")
    ? path.join(entryRoot, normalized)
    : path.join(entryRoot, OBSERVATIONS_DIR, `${normalized}.yaml`);
  if (!(await exists(file))) return null;
  return readSourceObservationFile(file);
}

async function loadCaptureManifest(
  entryRoot: string,
  observation: SourceObservation | null,
): Promise<SourceManifest | null> {
  if (!observation?.capture) return null;
  const file = path.join(entryRoot, observation.capture.manifest);
  return (await exists(file)) ? readManifest(file) : null;
}

async function writeLineage(entryRoot: string, lineage: SourceLineage): Promise<void> {
  await writeYamlFile(path.join(entryRoot, "source.yaml"), lineage);
}

async function materializeMaterials(contentRoot: string, materialsDir: string): Promise<number> {
  await mkdir(materialsDir, { recursive: true });
  await writeStructure(contentRoot, path.join(materialsDir, "structure.md"));
  return materializeSelectedFiles(contentRoot, materialsDir);
}

/** Absolute content root for a source entry, whatever its content mode. */
function contentRootFor(entry: SourceEntry): string {
  return path.join(entry.absolutePath, sourceContentDir(entry.lineage.content_mode));
}

function contentRelativeFor(entry: SourceEntry): string {
  return `${entry.relativePath}/${sourceContentDir(entry.lineage.content_mode)}`;
}

/**
 * Copy the source's current bytes into `captures/<id>/source` and write the
 * integrity manifest beside them. This is the one place a tree hash is part of
 * the primary purpose rather than a tax: a capture without a hash cannot prove
 * it still holds what it captured.
 */
async function materializeCapture(
  entryRoot: string,
  observationId: string,
  contentRoot: string,
  generatedOn: string,
): Promise<SourceCapture> {
  const relativePath = capturePath(observationId);
  const destination = path.join(entryRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(contentRoot, destination, {
    recursive: true,
    filter: (_source, dest) => shouldCopySource(destination, dest),
  });
  const manifest = await collectManifest(destination, generatedOn, relativePath);
  const manifestRelative = captureManifestPath(observationId);
  await writeManifest(path.join(entryRoot, manifestRelative), manifest);
  return {
    path: relativePath,
    manifest: manifestRelative,
    algorithm: manifest.fingerprint.algorithm,
    value: manifest.fingerprint.value,
    file_count: manifest.fingerprint.file_count,
    byte_count: manifest.fingerprint.byte_count,
  };
}

export async function addSource(options: SourceAddOptions): Promise<SourceAddResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withWorkspaceMutationCoordination(root, () => addSourceUnlocked({ ...options, root }));
}

async function addSourceUnlocked(options: SourceAddOptions): Promise<SourceAddResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const source =
    looksLikeGitUri(options.source) && !(await exists(options.source))
      ? options.source
      : path.resolve(options.source);
  const alias = aliasForSource(options.source, options.alias);
  const relativePath = `${sourcesRelativeForManifest(manifest)}/${alias}`;
  const entryRoot = path.join(root, relativePath);
  if (await exists(entryRoot)) {
    throw new FrameworkAlreadyExistsError(`source already exists: ${relativePath}`);
  }

  const notices: string[] = [];
  const notice = (line: string): void => {
    notices.push(line);
    options.onNotice?.(line);
  };
  // Duplicated study starts at the second clone, and this is the cheapest place
  // to say so. It stays an advisory: the caller may have good reason to want a
  // separate checkout, and a cache does not get to refuse a command.
  for (const line of await existingHomeAdvisories(root, source, options)) {
    notice(line);
  }

  await ensureSourceScaffold(entryRoot);
  const { contentMode, contentRoot, sourceKind } = await prepareSourceContent(
    entryRoot,
    source,
    options.branch,
  );
  const selectedFiles = await materializeMaterials(
    contentRoot,
    path.join(entryRoot, MATERIALS_DIR),
  );
  const lineage: SourceLineage = {
    lineage_id: alias,
    lineage_name: options.alias ?? displaySourceName(options.source),
    source_kind: sourceKind,
    source_uri: source,
    created_on: nowIso(now),
    latest_observation: null,
    content_mode: contentMode,
  };

  const vcs = await collectGitMetadata(contentRoot);
  const recorded = await appendObservation({
    entryRoot,
    relativePath,
    lineage,
    now,
    kind: "add",
    changeClass: "normal",
    note:
      contentMode === "checkout"
        ? `checkout-backed source added from ${source}`
        : `content copied once from ${source}`,
    advisories: [],
    previousObservation: null,
    vcs,
  });
  const updatedLineage = updateLineageForObservation(lineage, recorded.observation);
  await writeLineage(entryRoot, updatedLineage);
  await writeSourceCard(entryRoot, updatedLineage, recorded.observation);
  const eventFile = await appendEvent(
    root,
    {
      event: "source.added",
      source: alias,
      path: relativePath,
      source_uri: source,
      content_mode: contentMode,
      observation: recorded.observationFile,
      materials_selected_files: selectedFiles,
    },
    now,
  );
  // This workspace now holds the material, so it is a home the next `source add`
  // of the same origin can be pointed at.
  await recordSourceClone({
    workspace: root,
    alias,
    origin: source,
    now,
    ...(options.registryFile === undefined ? {} : { registryFile: options.registryFile }),
  });

  return {
    root,
    alias,
    path: relativePath,
    sourceFile: `${relativePath}/source.yaml`,
    observationFile: `${relativePath}/${recorded.observationFile}`,
    contentMode,
    contentPath: `${relativePath}/${sourceContentDir(contentMode)}`,
    materialsPath: `${relativePath}/${MATERIALS_DIR}`,
    observation: recorded.observation,
    eventFile: relativeDisplayPath(eventFile, root),
    notices,
  };
}

/**
 * Homes the registry already knows for this origin, as lines to print.
 *
 * The current workspace is left out: adding a second alias for material this
 * workspace already owns is a local decision, not a duplicate clone across
 * workspaces, and the existing `source already exists` check covers the rest.
 */
async function existingHomeAdvisories(
  root: string,
  origin: string,
  options: Pick<SourceAddOptions, "registryFile">,
): Promise<string[]> {
  let candidates: CloneRegistryEntry[];
  try {
    candidates = await findClonesByOrigin(
      origin,
      options.registryFile === undefined ? {} : { registryFile: options.registryFile },
    );
  } catch {
    return [];
  }
  return candidates
    .filter((candidate) => !samePath(candidate.workspace, root))
    .map(
      (candidate) =>
        `Advisory: '${candidate.alias}' in ${candidate.workspace} is already a home for this origin. \`assay source link ${candidate.workspace} ${candidate.alias}\` shares that one checkout, ledger, and brief instead of starting a second.`,
    );
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertCheckoutBacked(entry: SourceEntry, action: string): void {
  if (entry.lineage.content_mode === "checkout") return;
  throw new FrameworkError(
    withSemanticModel(
      `source '${entry.alias}' keeps copied content, so there is no checkout to ${action}`,
      "sourceNotCheckoutBacked",
    ),
  );
}

/**
 * Resolve the alias, then run under the lock of the workspace that owns it.
 *
 * Shared safety comes from one mutation authority, not from refusing to write:
 * a Source with two consumers still has exactly one home, one lock, and one
 * ledger, so a sync started from either side serializes against the other.
 */
async function withResolvedSourceHome<T>(
  root: string,
  options: { readonly alias?: string; readonly onNotice?: (notice: string) => void },
  run: (entry: SourceEntry) => Promise<T>,
): Promise<T> {
  const entry = await sourceEntryForAlias(root, options.alias);
  // Said before the work starts, not only in the summary: a write that lands in
  // another workspace is fine, and being surprised by it is not.
  if (entry.reference) {
    options.onNotice?.(
      `${entry.alias} is referenced from ${entry.reference.display}; writing through to the Source home: ${entry.absolutePath}`,
    );
  }
  return withWorkspaceMutationCoordination(entry.homeRoot, () => run(entry));
}

export async function syncSource(options: SourceSyncOptions): Promise<SourceSyncResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withResolvedSourceHome(root, options, async (entry) => {
    const result = await syncSourceUnlocked({ ...options, root }, entry);
    // Syncing is the one thing that happens to a Source after it moves house,
    // so it is where the cache learns the home's new location. Best-effort: the
    // sync already succeeded and this cannot change that.
    await recordSourceClone({
      workspace: entry.homeRoot,
      alias: entry.reference?.homeAlias ?? entry.alias,
      origin: entry.lineage.source_uri,
      now: options.now ?? new Date(),
      ...(options.registryFile === undefined ? {} : { registryFile: options.registryFile }),
    });
    return result;
  });
}

function sameAdvisories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Observe a checkout-backed Source again.
 *
 * Sync never refuses. A dirty checkout, a local commit upstream does not have,
 * an unreachable remote — each becomes an advisory on the observation and the
 * command still succeeds, because the ledger's job is to say what was there,
 * not to hold the bytes hostage until they look tidy.
 */
async function syncSourceUnlocked(
  options: SourceSyncOptions,
  entry: SourceEntry,
): Promise<SourceSyncResult> {
  const home = entry.homeRoot;
  const now = options.now ?? new Date();
  if (options.changeClass) assertChangeClass(options.changeClass);
  assertCheckoutBacked(entry, "sync");
  const previousObservation = await loadObservation(
    entry.absolutePath,
    entry.lineage.latest_observation,
  );

  const { checkout, advisories } = await refreshCheckoutForSync(entry, options);
  await materializeMaterials(checkout, path.join(entry.absolutePath, MATERIALS_DIR));
  const vcs = await collectGitMetadata(checkout, previousObservation?.vcs);
  const signals = await readCheckoutLocalSignals(checkout);
  const changeClass = await classifyCheckoutChange({
    checkout,
    previous: previousObservation,
    vcs,
    dirtyPaths: signals?.dirtyPaths ?? [],
    ...(options.changeClass ? { forced: options.changeClass } : {}),
  });

  if (
    changeClass === "same" &&
    previousObservation &&
    sameAdvisories(previousObservation.advisories, advisories)
  ) {
    const eventFile = await appendEvent(
      home,
      {
        event: "source.sync.noop",
        source: entry.alias,
        path: entry.relativePath,
        previous_observation: entry.lineage.latest_observation,
        change_class: "same",
      },
      now,
    );
    return {
      root: home,
      alias: entry.alias,
      path: entry.relativePath,
      changeClass: "same",
      observationFile: null,
      observation: null,
      advisories,
      eventFile: relativeDisplayPath(eventFile, home),
      reference: entry.reference,
    };
  }

  const recorded = await appendObservation({
    entryRoot: entry.absolutePath,
    relativePath: entry.relativePath,
    lineage: entry.lineage,
    now,
    kind: "sync",
    changeClass,
    note: syncNote(previousObservation, vcs, advisories),
    advisories,
    previousObservation,
    vcs,
  });
  const updatedLineage = updateLineageForObservation(entry.lineage, recorded.observation);
  await writeLineage(entry.absolutePath, updatedLineage);
  await writeSourceCard(entry.absolutePath, updatedLineage, recorded.observation);
  const comparison = await compareCheckoutObservations(
    home,
    entry,
    checkout,
    previousObservation,
    recorded.observation,
  );
  const eventFile = await appendEvent(
    home,
    {
      event: "source.synced",
      source: entry.alias,
      path: entry.relativePath,
      change_class: changeClass,
      previous_observation: previousObservation?.observation_id ?? null,
      observation: recorded.observationFile,
      advisories,
    },
    now,
  );

  return {
    root: home,
    alias: entry.alias,
    path: entry.relativePath,
    changeClass,
    observationFile: `${entry.relativePath}/${recorded.observationFile}`,
    observation: recorded.observation,
    advisories,
    eventFile: relativeDisplayPath(eventFile, home),
    ...(comparison ? { comparison } : {}),
    reference: entry.reference,
  };
}

function syncNote(
  previous: SourceObservation | null,
  vcs: SourceVcsMetadata | undefined,
  advisories: readonly string[],
): string {
  const position = vcs ? `${vcs.ref} ${vcs.commit.slice(0, 12)}` : null;
  const moved = previous?.vcs?.commit && vcs && previous.vcs.commit !== vcs.commit;
  const base = position ? `${moved ? "moved to" : "observed at"} ${position}` : "observed content";
  return advisories.length > 0 ? `${base}; ${advisories.join("; ")}` : base;
}

/** File-level comparison between two Git observations, straight from Git. */
async function compareCheckoutObservations(
  root: string,
  entry: SourceEntry,
  checkout: string,
  previous: SourceObservation | null,
  current: SourceObservation,
): Promise<SourceDiffResult | undefined> {
  const from = previous?.vcs?.commit;
  const to = current.vcs?.commit;
  if (!from || !to) return undefined;
  const changes = await changedPathsBetween(checkout, from, to);
  if (!changes) return undefined;
  return {
    root,
    alias: entry.alias,
    from: previous?.observation_id ?? null,
    to: current.observation_id,
    added: changes.added,
    removed: changes.removed,
    changed: changes.changed,
  };
}

export async function captureSource(options: SourceCaptureOptions): Promise<SourceCaptureResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withResolvedSourceHome(root, options, (entry) => captureSourceUnlocked(options, entry));
}

/**
 * Preserve a Source's current bytes: the explicit tier, available at any time
 * and for any content mode. This is the only routine path that hashes a tree,
 * because a capture that cannot prove what it holds is not a capture.
 */
async function captureSourceUnlocked(
  options: SourceCaptureOptions,
  entry: SourceEntry,
): Promise<SourceCaptureResult> {
  const home = entry.homeRoot;
  const now = options.now ?? new Date();
  const contentRoot = contentRootFor(entry);
  if (!(await exists(contentRoot))) {
    throw new FrameworkNotFoundError(
      `source '${entry.alias}' has no content to capture at ${contentRelativeFor(entry)}`,
    );
  }
  const previousObservation = await loadObservation(
    entry.absolutePath,
    entry.lineage.latest_observation,
  );
  const previousCapture = await latestCaptureManifest(entry);
  const vcs = await collectGitMetadata(contentRoot, previousObservation?.vcs);
  const id = await nextObservationId(entry.absolutePath, now, "capture");
  const capture = await materializeCapture(entry.absolutePath, id, contentRoot, nowIso(now));
  const changeClass = await classifyCaptureChange(entry, previousCapture, capture);

  const recorded = await appendObservation({
    entryRoot: entry.absolutePath,
    relativePath: entry.relativePath,
    lineage: entry.lineage,
    now,
    kind: "capture",
    changeClass,
    note:
      options.note ??
      `captured ${capture.file_count} files from ${sourceContentDir(entry.lineage.content_mode)}/`,
    advisories: vcs?.dirty ? [CHECKOUT_ADVISORY_LOCAL_MODIFICATIONS] : [],
    previousObservation,
    vcs,
    capture,
    id,
  });
  const updatedLineage = updateLineageForObservation(entry.lineage, recorded.observation);
  await writeLineage(entry.absolutePath, updatedLineage);
  await writeSourceCard(entry.absolutePath, updatedLineage, recorded.observation);
  const eventFile = await appendEvent(
    home,
    {
      event: "source.captured",
      source: entry.alias,
      path: entry.relativePath,
      observation: recorded.observationFile,
      capture: capture.path,
      file_count: capture.file_count,
      byte_count: capture.byte_count,
    },
    now,
  );

  return {
    root: home,
    alias: entry.alias,
    path: entry.relativePath,
    observationFile: `${entry.relativePath}/${recorded.observationFile}`,
    observation: recorded.observation,
    capture,
    capturePath: `${entry.relativePath}/${capture.path}`,
    manifestFile: `${entry.relativePath}/${capture.manifest}`,
    eventFile: relativeDisplayPath(eventFile, home),
    reference: entry.reference,
  };
}

function countManifestDifferences(previous: SourceManifest, current: SourceManifest): number {
  const diff = compareManifests(previous, current);
  return diff.added.length + diff.removed.length + diff.changed.length;
}

/**
 * Grade a capture against the previous one. Both manifests already exist, so
 * this is a comparison of records rather than another pass over the bytes.
 */
async function classifyCaptureChange(
  entry: SourceEntry,
  previous: SourceManifest | null,
  capture: SourceCapture,
): Promise<SourceChangeClass> {
  if (!previous) return "normal";
  if (previous.fingerprint.value === capture.value) return "same";
  const current = await readManifest(path.join(entry.absolutePath, capture.manifest));
  return classFromRatio(
    countManifestDifferences(previous, current),
    Math.max(previous.files.length, current.files.length),
  );
}

/** Most recent capture manifest for a source, or null when nothing was captured. */
async function latestCaptureManifest(entry: SourceEntry): Promise<SourceManifest | null> {
  const captures = await listCaptureIds(entry.absolutePath);
  const latest = captures.at(-1);
  if (!latest) return null;
  const file = path.join(entry.absolutePath, captureManifestPath(latest));
  return (await exists(file)) ? readManifest(file) : null;
}

async function listCaptureIds(entryRoot: string): Promise<string[]> {
  const dir = path.join(entryRoot, CAPTURES_DIR);
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function importSourceContent(
  options: SourceImportOptions,
): Promise<SourceImportResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withResolvedSourceHome(root, options, (entry) =>
    importSourceContentUnlocked(options, entry),
  );
}

/**
 * Replace a copied Source's content from a local directory or archive.
 *
 * The bytes that are about to go are captured first, so an import adds a record
 * instead of destroying one — the append-only half of the old frozen rules,
 * kept, without the "never update this" half.
 */
async function importSourceContentUnlocked(
  options: SourceImportOptions,
  entry: SourceEntry,
): Promise<SourceImportResult> {
  const home = entry.homeRoot;
  const now = options.now ?? new Date();
  if (entry.lineage.content_mode !== "copy") {
    throw new FrameworkError(
      withSemanticModel(
        `source '${entry.alias}' is checkout-backed, so its content is not replaced by import`,
        "sourceCopyContentOnly",
      ),
    );
  }
  const from = path.resolve(options.from);
  if (!(await exists(from))) {
    throw new FrameworkNotFoundError(`import source not found: ${from}`);
  }

  const contentRoot = contentRootFor(entry);
  const preserved = (await exists(contentRoot))
    ? await captureSourceUnlocked(
        {
          root: home,
          alias: entry.alias,
          note: "content preserved before import",
          now,
        },
        entry,
      )
    : null;
  const previousManifest = preserved
    ? await readManifest(path.join(entry.absolutePath, preserved.capture.manifest))
    : null;

  await rm(contentRoot, { recursive: true, force: true });
  await copyContentInto(from, contentRoot);
  await materializeMaterials(contentRoot, path.join(entry.absolutePath, MATERIALS_DIR));

  const currentManifest = await collectManifest(
    contentRoot,
    nowIso(now),
    sourceContentDir(entry.lineage.content_mode),
  );
  const changeClass = previousManifest
    ? previousManifest.fingerprint.value === currentManifest.fingerprint.value
      ? "same"
      : classFromRatio(
          countManifestDifferences(previousManifest, currentManifest),
          Math.max(previousManifest.files.length, currentManifest.files.length),
        )
    : "normal";

  const latestObservation = await loadObservation(
    entry.absolutePath,
    preserved
      ? observationPath(preserved.observation.observation_id)
      : entry.lineage.latest_observation,
  );
  const recorded = await appendObservation({
    entryRoot: entry.absolutePath,
    relativePath: entry.relativePath,
    lineage: entry.lineage,
    now,
    kind: "import",
    changeClass,
    note: options.note ?? `content replaced from ${from}`,
    advisories: [],
    previousObservation: latestObservation,
  });
  const updatedLineage = updateLineageForObservation(
    { ...entry.lineage, source_uri: from },
    recorded.observation,
  );
  await writeLineage(entry.absolutePath, updatedLineage);
  await writeSourceCard(entry.absolutePath, updatedLineage, recorded.observation);
  const eventFile = await appendEvent(
    home,
    {
      event: "source.imported",
      source: entry.alias,
      path: entry.relativePath,
      from,
      change_class: changeClass,
      observation: recorded.observationFile,
      preserved_capture: preserved?.capture.path ?? null,
    },
    now,
  );

  return {
    root: home,
    alias: entry.alias,
    path: entry.relativePath,
    contentPath: contentRelativeFor(entry),
    observationFile: `${entry.relativePath}/${recorded.observationFile}`,
    observation: recorded.observation,
    preservedCapture: preserved?.capture ?? null,
    changeClass,
    eventFile: relativeDisplayPath(eventFile, home),
    reference: entry.reference,
  };
}

export async function switchSource(options: SourceSwitchOptions): Promise<SourceSwitchResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withResolvedSourceHome(root, options, (entry) => switchSourceUnlocked(options, entry));
}

async function switchSourceUnlocked(
  options: SourceSwitchOptions,
  entry: SourceEntry,
): Promise<SourceSwitchResult> {
  const home = entry.homeRoot;
  const now = options.now ?? new Date();
  assertCheckoutBacked(entry, "switch");
  const checkout = path.join(entry.absolutePath, CHECKOUT_DIR);
  if (!(await exists(path.join(checkout, ".git")))) {
    throw new FrameworkError(
      withSemanticModel(
        `source '${entry.alias}' has no Git checkout to switch`,
        "sourceNotCheckoutBacked",
      ),
    );
  }
  // No gate here on purpose: `git checkout` refuses a move that would overwrite
  // uncommitted work, and that refusal is the byte protection this needs.
  await checkoutGitRef(checkout, options.target);
  const vcs = await collectGitMetadata(checkout);
  if (!vcs) {
    throw new FrameworkError(`source '${entry.alias}' does not have readable Git metadata`);
  }
  const updatedLineage: SourceLineage = {
    ...entry.lineage,
    checkout: {
      path: CHECKOUT_DIR,
      ref: vcs.ref,
      commit: vcs.commit,
      dirty: vcs.dirty,
    },
  };
  await writeLineage(entry.absolutePath, updatedLineage);
  const eventFile = await appendEvent(
    home,
    {
      event: "source.switched",
      source: entry.alias,
      path: entry.relativePath,
      target: options.target,
      ref: vcs.ref,
      commit: vcs.commit,
      dirty: vcs.dirty,
    },
    now,
  );
  const sync = options.sync
    ? await syncSourceUnlocked(
        { root: home, alias: entry.alias, now },
        {
          ...entry,
          lineage: updatedLineage,
        },
      )
    : undefined;
  return {
    root: home,
    alias: entry.alias,
    path: entry.relativePath,
    target: options.target,
    vcs,
    eventFile: relativeDisplayPath(eventFile, home),
    ...(sync ? { sync } : {}),
    reference: entry.reference,
  };
}

export async function getSourceStatus(options: {
  readonly root: string;
  readonly alias?: string;
  /** Clone-registry file to consult for a broken reference's current location. */
  readonly registryFile?: string;
}): Promise<SourceStatusResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const listings = options.alias
    ? [{ kind: "entry", entry: await sourceEntryForAlias(root, options.alias) } as const]
    : await listSourceEntryListings(root, options.registryFile);
  const sources: SourceStatusEntry[] = [];
  const broken: BrokenSourceReference[] = [];
  for (const listing of listings) {
    if (listing.kind === "broken") {
      broken.push(listing.broken);
      continue;
    }
    const entry = listing.entry;
    const latest = await loadObservation(entry.absolutePath, entry.lineage.latest_observation);
    sources.push({
      alias: entry.alias,
      path: entry.relativePath,
      absolutePath: entry.absolutePath,
      name: entry.lineage.lineage_name,
      kind: entry.lineage.source_kind,
      uri: entry.lineage.source_uri,
      contentMode: entry.lineage.content_mode,
      latestObservation: latest?.observation_id ?? null,
      latestChangeClass: latest?.change_class ?? null,
      latestAdvisories: latest?.advisories ?? [],
      captures: (await listCaptureIds(entry.absolutePath)).length,
      relation: entry.reference ? "ref" : "owned",
      reference: entry.reference,
      ...(latest?.vcs ? { vcs: latest.vcs } : {}),
      ...(entry.lineage.content_mode === "checkout" && entry.lineage.checkout
        ? { checkout: entry.lineage.checkout }
        : {}),
    });
  }
  return { root, sources, broken };
}

export async function getSourceLog(options: {
  readonly root: string;
  readonly alias: string;
}): Promise<SourceLogResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entry = await sourceEntryForAlias(root, options.alias);
  const observationsDir = path.join(entry.absolutePath, OBSERVATIONS_DIR);
  const entries = await readdir(observationsDir, { withFileTypes: true });
  const observations: SourceLogEntry[] = [];
  for (const file of entries) {
    if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
    const relative = `${OBSERVATIONS_DIR}/${file.name}`;
    observations.push({
      observation: await readSourceObservationFile(path.join(observationsDir, file.name)),
      path: relative,
    });
  }
  observations.sort((a, b) => a.observation.observed_on.localeCompare(b.observation.observed_on));
  return {
    root: entry.homeRoot,
    alias: entry.alias,
    path: entry.relativePath,
    entries: observations,
    reference: entry.reference,
  };
}

function normalizeObservationSelector(selector: string): string {
  const normalized = selector.replace(/\\/g, "/");
  if (normalized.endsWith(".yaml")) return normalized;
  if (normalized.startsWith(`${OBSERVATIONS_DIR}/`)) return `${normalized}.yaml`;
  return `${OBSERVATIONS_DIR}/${normalized}.yaml`;
}

async function resolveSourceObservationEntry(
  root: string,
  alias: string,
  observationSelector?: string,
): Promise<SourceEntry & { readonly observation: SourceObservation }> {
  const entry = await sourceEntryForAlias(root, alias);
  const observationRef = observationSelector
    ? normalizeObservationSelector(observationSelector)
    : entry.lineage.latest_observation;
  if (!observationRef) {
    throw new FrameworkNotFoundError(`source '${entry.alias}' has no observations`);
  }
  const observation = await loadObservation(entry.absolutePath, observationRef);
  if (!observation) {
    throw new FrameworkNotFoundError(`source observation not found: ${observationRef}`);
  }
  return { ...entry, observation };
}

export async function resolveSourceObservation(
  options: SourceObservationResolveOptions,
): Promise<SourceObservationResolution> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entry = await resolveSourceObservationEntry(root, options.alias, options.observation);
  const observationFile = observationPath(entry.observation.observation_id);
  const capture = entry.observation.capture;
  return {
    root: entry.homeRoot,
    alias: entry.alias,
    sourcePath: entry.relativePath,
    observationFile: `${entry.relativePath}/${observationFile}`,
    observation: entry.observation,
    contentMode: entry.lineage.content_mode,
    contentPath: capture ? `${entry.relativePath}/${capture.path}` : contentRelativeFor(entry),
    materialsPath: `${entry.relativePath}/${MATERIALS_DIR}`,
    capturePath: capture ? `${entry.relativePath}/${capture.path}` : null,
    reference: entry.reference,
  };
}

/**
 * List the files an observation stands for, computing the hash only now.
 *
 * A capture answers from its stored manifest. Anything else is read from the
 * source's current content, which is what a tier-1 pin means for a non-Git
 * source: hashed once, when a decision asks for it.
 */
export async function readSourceContentListing(
  options: SourceObservationResolveOptions,
): Promise<SourceContentListing> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entry = await resolveSourceObservationEntry(root, options.alias, options.observation);
  const capture = entry.observation.capture;
  if (capture) {
    const manifestFile = path.join(entry.absolutePath, capture.manifest);
    if (!(await exists(manifestFile))) {
      throw new FrameworkNotFoundError(
        withSemanticModel(
          `source capture manifest is missing: ${entry.relativePath}/${capture.manifest}`,
          "sourceCaptureMissing",
        ),
      );
    }
    const manifest = await readManifest(manifestFile);
    return {
      alias: entry.alias,
      observationId: entry.observation.observation_id,
      origin: "capture",
      relativeRoot: `${entry.relativePath}/${capture.path}`,
      fingerprint: manifest.fingerprint,
      files: manifest.files,
    };
  }

  const contentRoot = contentRootFor(entry);
  if (!(await exists(contentRoot))) {
    throw new FrameworkNotFoundError(
      `source '${entry.alias}' has no content at ${contentRelativeFor(entry)}`,
    );
  }
  const manifest = await collectManifest(
    contentRoot,
    nowIso(),
    sourceContentDir(entry.lineage.content_mode),
  );
  return {
    alias: entry.alias,
    observationId: entry.observation.observation_id,
    origin: "content",
    relativeRoot: contentRelativeFor(entry),
    fingerprint: manifest.fingerprint,
    files: manifest.files,
  };
}

/**
 * The two most recent points at which a copied source's bytes were described.
 *
 * A capture describes them exactly. The current content describes them now, at
 * the cost of hashing, which is why it is only reached for when the newest
 * record is not itself a capture. Everything in between is a cheap append entry
 * that never claimed to know the bytes, so there is nothing there to compare.
 */
async function describeCopiedBytes(
  root: string,
  entry: SourceEntry,
  latest: SourceObservation,
  since: string | null,
): Promise<{
  readonly from: { id: string; manifest: SourceManifest } | null;
  readonly to: { id: string; manifest: SourceManifest } | null;
}> {
  const ordered = (await getSourceLog({ root, alias: entry.alias })).entries.map(
    (logEntry) => logEntry.observation,
  );
  const captures: { id: string; manifest: SourceManifest }[] = [];
  for (const observation of ordered) {
    const manifest = await loadCaptureManifest(entry.absolutePath, observation);
    if (manifest) captures.push({ id: observation.observation_id, manifest });
  }

  if (since) {
    const pinned = captures.find((capture) => `${OBSERVATIONS_DIR}/${capture.id}.yaml` === since);
    const to =
      (await loadCaptureManifest(entry.absolutePath, latest)) ??
      (await currentContentDescription(entry));
    return {
      from: pinned ?? null,
      to: to ? { id: latest.observation_id, manifest: to } : null,
    };
  }

  const latestCapture = captures.at(-1);
  if (latestCapture?.id === latest.observation_id) {
    return { from: captures.at(-2) ?? null, to: latestCapture };
  }
  const current = await currentContentDescription(entry);
  return {
    from: latestCapture ?? null,
    to: current ? { id: latest.observation_id, manifest: current } : null,
  };
}

async function currentContentDescription(entry: SourceEntry): Promise<SourceManifest | null> {
  const contentRoot = contentRootFor(entry);
  if (!(await exists(contentRoot))) return null;
  return collectManifest(contentRoot, nowIso(), sourceContentDir(entry.lineage.content_mode));
}

/**
 * What changed between two observations.
 *
 * For a checkout-backed source that is a Git diff between the recorded commits.
 * For copied content it compares byte descriptions: the captures that preserved
 * them, and the content as it stands when the newest record is not a capture.
 */
export async function diffSource(options: SourceDiffOptions): Promise<SourceDiffResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entry = await sourceEntryForAlias(root, options.alias);
  const empty: SourceDiffResult = {
    root: entry.homeRoot,
    alias: entry.alias,
    from: null,
    to: null,
    added: [],
    removed: [],
    changed: [],
    reference: entry.reference,
  };
  const latest = await loadObservation(entry.absolutePath, entry.lineage.latest_observation);
  if (!latest) return empty;

  const previousRef = options.since
    ? normalizeObservationSelector(options.since)
    : latest.previous_observation;
  const previous = await loadObservation(entry.absolutePath, previousRef);

  if (entry.lineage.content_mode === "checkout") {
    const comparison = await compareCheckoutObservations(
      entry.homeRoot,
      entry,
      path.join(entry.absolutePath, CHECKOUT_DIR),
      previous,
      latest,
    );
    return comparison
      ? { ...comparison, reference: entry.reference }
      : { ...empty, from: previous?.observation_id ?? null, to: latest.observation_id };
  }

  const described = await describeCopiedBytes(
    root,
    entry,
    latest,
    options.since ? previousRef : null,
  );
  if (!described.to) {
    return { ...empty, from: described.from?.id ?? null, to: latest.observation_id };
  }
  const diff = compareManifests(described.from?.manifest ?? null, described.to.manifest);
  return {
    ...diff,
    root: entry.homeRoot,
    alias: entry.alias,
    from: described.from?.id ?? null,
    to: described.to.id,
    reference: entry.reference,
  };
}

export async function collectSourceHealthRows(
  root: string,
  options: { readonly includeAdvisories?: boolean } = {},
): Promise<CheckRow[]> {
  await preflightSourceWorkspace(path.resolve(root));
  const rows: CheckRow[] = [];
  const listings = await listSourceEntryListings(root);
  for (const listing of listings) {
    // A broken reference is a structure finding and nothing more: `check` names
    // it and stops there. It does not scan neighbouring directories, guess at a
    // new location, or rewrite the shell.
    if (listing.kind === "broken") {
      rows.push({
        path: `${listing.broken.shellPath}/${SOURCE_REFERENCE_FILE}`,
        status: "error",
        message: brokenReferenceMessage(listing.broken),
      });
      continue;
    }
    const source = listing.entry;
    // For a reference the finding is in another workspace, so the row addresses
    // the shell this workspace owns and the message names where the material is.
    const rowPath = (relative: string): string =>
      source.reference
        ? `${source.reference.shellPath}/${SOURCE_REFERENCE_FILE}`
        : `${source.relativePath}/${relative}`;
    const inHome = source.reference
      ? ` (in its home ${source.reference.homeRoot}, at ${source.relativePath})`
      : "";
    const latest = await loadObservation(source.absolutePath, source.lineage.latest_observation);
    if (!source.lineage.latest_observation) {
      rows.push({
        path: rowPath("source.yaml"),
        status: "error",
        message: `source '${source.alias}' has no latest observation${inHome}`,
      });
      continue;
    }
    if (!latest) {
      rows.push({
        path: rowPath("source.yaml"),
        status: "error",
        message: `source '${source.alias}' points to missing latest observation${inHome}`,
      });
      continue;
    }
    const contentDir = sourceContentDir(source.lineage.content_mode);
    if (!(await exists(path.join(source.absolutePath, contentDir)))) {
      rows.push({
        path: rowPath(contentDir),
        status: "error",
        message: `source '${source.alias}' has no readable content at ${contentDir}/${inHome}`,
      });
    }
    // A capture is the one record that promises specific bytes, so both halves
    // of it have to still be there.
    for (const id of await listCaptureIds(source.absolutePath)) {
      for (const relative of [captureManifestPath(id), capturePath(id)]) {
        if (await exists(path.join(source.absolutePath, relative))) continue;
        rows.push({
          path: rowPath(relative),
          status: "error",
          message: withSemanticModel(
            `source capture '${id}' is missing ${relative.endsWith(".json") ? "its integrity manifest" : "its captured bytes"}${inHome}`,
            "sourceCaptureMissing",
          ),
        });
      }
    }
    if (options.includeAdvisories) {
      for (const advisory of latest.advisories) {
        rows.push({
          path: rowPath(source.lineage.latest_observation),
          status: "warning",
          message: `source '${source.alias}' latest observation: ${advisory}`,
        });
      }
    }
  }
  return rows;
}
