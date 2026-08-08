import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { MANAGED_DIR } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { resolveWorkspaceLayout, workspacePath, workspaceRelativePath } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { loadArchetype } from "./profile.js";
import type { CheckRow } from "./results.js";
import type { FrameworkManifest } from "./schemas/index.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";
import {
  assertGitCheckoutSafeForRefresh,
  assertManagedCheckout,
  checkoutGitRef,
  cloneGitSource,
  collectGitMetadata,
  isGitCheckout,
  refreshLocalGitCheckout,
  refreshRemoteGitCheckout,
  syncTargetForCheckout,
} from "./sources/git.js";
import { withWorkspaceMutationCoordination } from "./tasks/task-storage.js";
import { nowIso } from "./time.js";

export const SOURCE_MODES = ["living", "frozen"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export const SOURCE_CAPTURE_MODES = ["checkout", "archive"] as const;
export type SourceCaptureMode = (typeof SOURCE_CAPTURE_MODES)[number];

export const SOURCE_CHANGE_CLASSES = ["same", "patch", "normal", "major", "replacement"] as const;
export type SourceChangeClass = (typeof SOURCE_CHANGE_CLASSES)[number];

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
  readonly mode: SourceMode;
  readonly default_capture_mode: SourceCaptureMode;
  readonly checkout?: {
    readonly path: "checkout";
    readonly ref: string | null;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
}

export interface SourceObservation {
  readonly observation_id: string;
  readonly observed_on: string;
  readonly lineage_id: string;
  readonly source_path: string;
  readonly previous_observation: string | null;
  readonly change_class: SourceChangeClass;
  readonly capture_mode: SourceCaptureMode;
  readonly vcs?: SourceVcsMetadata;
  readonly fingerprint: SourceFingerprint;
  readonly manifest: string;
  readonly materials_path: string;
  readonly checkout_path?: string;
  readonly capture_path?: string;
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
  readonly capture?: SourceCaptureMode;
  readonly mode?: SourceMode;
  readonly now?: Date;
}

export interface SourceAddResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly sourceFile: string;
  readonly observationFile: string;
  readonly manifestFile: string;
  readonly checkoutPath: string | null;
  readonly materialsPath: string;
  readonly observation: SourceObservation;
  readonly eventFile: string;
}

export interface SourceSyncOptions {
  readonly root: string;
  readonly alias?: string;
  readonly branch?: string;
  readonly ref?: string;
  readonly changeClass?: SourceChangeClass;
  readonly now?: Date;
}

export interface SourceSyncResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly changeClass: SourceChangeClass;
  readonly observationFile: string | null;
  readonly manifestFile: string | null;
  readonly observation: SourceObservation | null;
  readonly eventFile: string;
  readonly comparison?: SourceDiffResult;
}

export interface SourceSwitchOptions {
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
}

export interface SourceStatusEntry {
  readonly alias: string;
  readonly path: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly uri: string;
  readonly mode: SourceMode;
  readonly captureMode: SourceCaptureMode;
  readonly latestObservation: string | null;
  readonly latestChangeClass: SourceChangeClass | null;
  readonly vcs?: SourceVcsMetadata;
  readonly checkout?: SourceLineage["checkout"];
}

export interface SourceStatusResult {
  readonly root: string;
  readonly sources: readonly SourceStatusEntry[];
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
}

export interface SourceObservationResolveOptions {
  readonly root: string;
  readonly alias: string;
  readonly observation?: string;
}

export interface SourceObservationResolution {
  readonly root: string;
  readonly alias: string;
  readonly sourcePath: string;
  readonly observationFile: string;
  readonly observation: SourceObservation;
  readonly manifestFile: string;
  readonly materialsPath: string;
  readonly checkoutPath: string | null;
}

interface SourceEntry {
  readonly alias: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly lineage: SourceLineage;
}

interface MaterializedObservation {
  readonly observation: SourceObservation;
  readonly manifest: SourceManifest;
  readonly observationFile: string;
  readonly manifestFile: string;
}

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
  const manifest = requireManifestPresent(await loadManifest(root), root);
  try {
    await loadArchetype(manifest.project.archetype, { root });
  } catch (error) {
    // Workspaces whose historical archetype no longer resolves intentionally
    // degrade to the layout's base structure. Still propagate parse failures,
    // especially RETIRED_ARCHETYPE_PATH, before any Source semantic access.
    const message = error instanceof Error ? error.message : "";
    const unresolved =
      message.startsWith("archetype not found:") ||
      (message.startsWith("archetype '") && message.includes(" was removed in Assay "));
    if (!unresolved) throw error;
  }
  return manifest;
}

function sourcesRootForManifest(root: string, manifest: FrameworkManifest): string {
  return workspacePath(root, layoutForManifest(manifest), "sources");
}

function sourcesRelativeForManifest(manifest: FrameworkManifest): string {
  return workspaceRelativePath(layoutForManifest(manifest), "sources");
}

function assertCaptureMode(value: SourceCaptureMode): void {
  if (!SOURCE_CAPTURE_MODES.includes(value)) {
    throw new FrameworkError(`capture mode must be one of: ${SOURCE_CAPTURE_MODES.join(", ")}`);
  }
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
  const normalized = slugify(alias ?? displaySourceName(source));
  if (normalized === "frozen") {
    throw new FrameworkError("source alias 'frozen' is reserved by the Source namespace");
  }
  return normalized;
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

async function readSourceLineageFile(file: string): Promise<SourceLineage> {
  const value = await readYamlFile<Record<string, unknown>>(file);
  for (const field of ["status", "relation"] as const) {
    if (Object.hasOwn(value, field)) {
      throw new FrameworkError(`source lineage contains retired field '${field}': ${file}`, {
        code: "IO_ERROR",
      });
    }
  }
  if (typeof value.mode !== "string" || !SOURCE_MODES.includes(value.mode as SourceMode)) {
    throw new FrameworkError(
      `source lineage mode must be one of: ${SOURCE_MODES.join(", ")}: ${file}`,
      {
        code: "IO_ERROR",
      },
    );
  }
  if (
    typeof value.default_capture_mode !== "string" ||
    !SOURCE_CAPTURE_MODES.includes(value.default_capture_mode as SourceCaptureMode)
  ) {
    throw new FrameworkError(
      `source lineage capture mode must be one of: ${SOURCE_CAPTURE_MODES.join(", ")}: ${file}`,
      { code: "IO_ERROR" },
    );
  }
  return value as unknown as SourceLineage;
}

async function readSourceObservationFile(file: string): Promise<SourceObservation> {
  const value = await readYamlFile<Record<string, unknown>>(file);
  for (const field of [
    "analysis_status",
    "analysis_path",
    "analysis_exit",
    "analysis_closed_on",
  ] as const) {
    if (Object.hasOwn(value, field)) {
      throw new FrameworkError(`source observation contains retired field '${field}': ${file}`, {
        code: "IO_ERROR",
      });
    }
  }
  if (
    typeof value.capture_mode !== "string" ||
    !SOURCE_CAPTURE_MODES.includes(value.capture_mode as SourceCaptureMode)
  ) {
    throw new FrameworkError(
      `source observation capture mode must be one of: ${SOURCE_CAPTURE_MODES.join(", ")}: ${file}`,
      { code: "IO_ERROR" },
    );
  }
  return value as unknown as SourceObservation;
}

async function writeYamlFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(value), "utf8");
}

// Source-entry ledger directories live directly under sources/<alias>/.
const OBSERVATIONS_DIR = "observations";
const MANIFESTS_DIR = "manifests";
const CAPTURES_DIR = "captures";

function observationPath(observationId: string): string {
  return `${OBSERVATIONS_DIR}/${observationId}.yaml`;
}

function manifestPath(observationId: string): string {
  return `${MANIFESTS_DIR}/${observationId}.json`;
}

function isGitMetadata(value: SourceVcsMetadata | undefined): value is SourceVcsMetadata {
  return value !== undefined && value.type === "git" && value.commit.length > 0;
}

async function collectManifest(sourceRoot: string, generatedOn: string): Promise<SourceManifest> {
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
    root: sourceRoot,
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

async function materializeArchiveCapture(
  entryRoot: string,
  observationId: string,
  captureRoot: string,
): Promise<string> {
  const relativePath = `${CAPTURES_DIR}/${observationId}/source`;
  const destination = path.join(entryRoot, relativePath);
  await cp(captureRoot, destination, {
    recursive: true,
    filter: (_source, dest) => shouldCopySource(destination, dest),
  });
  return relativePath;
}

async function prepareSourceRoots(
  entryRoot: string,
  source: string,
  captureMode: SourceCaptureMode,
  branch: string | undefined,
): Promise<{
  readonly captureRoot: string;
  readonly checkoutPath: string | null;
  readonly sourceKind: SourceKind;
}> {
  const checkout = path.join(entryRoot, "checkout");
  const sourceExists = await exists(source);
  const sourceKind: SourceKind = sourceExists
    ? (await exists(path.join(source, ".git")))
      ? "git"
      : "directory"
    : looksLikeGitUri(source)
      ? "git"
      : "unknown";

  if (!sourceExists && sourceKind !== "git") {
    throw new FrameworkNotFoundError(`source not found: ${source}`);
  }

  if (captureMode === "checkout") {
    if (sourceKind === "git") {
      await cloneGitSource(
        source,
        checkout,
        branch ? { kind: "branch", value: branch } : null,
        !sourceExists,
      );
    } else {
      await cp(source, checkout, {
        recursive: true,
        filter: (_source, dest) => shouldCopyCheckout(checkout, dest),
      });
    }
    return { captureRoot: checkout, checkoutPath: "checkout", sourceKind };
  }

  if (sourceExists) {
    return { captureRoot: source, checkoutPath: null, sourceKind };
  }

  throw new FrameworkError(`capture mode '${captureMode}' requires a local source in this version`);
}

async function updateCheckoutFromSource(entryRoot: string, sourceUri: string): Promise<string> {
  const checkout = path.join(entryRoot, "checkout");
  assertManagedCheckout(entryRoot, checkout);
  if (!(await exists(sourceUri))) {
    return checkout;
  }

  await rm(checkout, { recursive: true, force: true });
  await cp(sourceUri, checkout, {
    recursive: true,
    filter: (_source, dest) => shouldCopyCheckout(checkout, dest),
  });
  return checkout;
}

async function refreshCheckoutBeforeObservation(
  entry: SourceEntry,
  options: Pick<SourceSyncOptions, "branch" | "ref">,
  captureMode: SourceCaptureMode,
  previousObservation: SourceObservation | null,
): Promise<string> {
  const checkout = path.join(entry.absolutePath, "checkout");
  if (captureMode !== "checkout") {
    return (await exists(entry.lineage.source_uri)) ? entry.lineage.source_uri : checkout;
  }

  if (await isGitCheckout(checkout)) {
    await assertGitCheckoutSafeForRefresh(
      checkout,
      entry.lineage.checkout?.commit ?? previousObservation?.vcs?.commit ?? null,
    );
  } else if ((await exists(checkout)) && previousObservation) {
    // The guard exists to stop a refresh from discarding local work Assay never
    // recorded. It needs a recorded fingerprint to compare against: when the
    // latest observation has none, drift cannot be proven either way, so the
    // refresh proceeds and records a complete observation instead of failing.
    const recordedFingerprint = previousObservation.fingerprint?.value;
    if (recordedFingerprint) {
      const checkoutManifest = await collectManifest(checkout, nowIso());
      if (checkoutManifest.fingerprint.value !== recordedFingerprint) {
        throw new FrameworkError(
          `managed source checkout has unrecorded changes; preserve or remove them before refresh: ${checkout}`,
          { code: "IO_ERROR" },
        );
      }
    }
  }

  const sourceExists = await exists(entry.lineage.source_uri);
  const sourceIsGit = sourceExists && (await exists(path.join(entry.lineage.source_uri, ".git")));
  const target = await syncTargetForCheckout(options, checkout, entry.lineage);

  if (sourceExists && (entry.lineage.source_kind === "git" || sourceIsGit)) {
    return refreshLocalGitCheckout(entry.absolutePath, entry.lineage.source_uri, target);
  }

  if (sourceExists) {
    return updateCheckoutFromSource(entry.absolutePath, entry.lineage.source_uri);
  }

  if (await isGitCheckout(checkout)) {
    await refreshRemoteGitCheckout(entry.absolutePath, checkout, target);
  }
  return checkout;
}

async function ensureSourceScaffold(entryRoot: string): Promise<void> {
  await mkdir(path.join(entryRoot, "materials"), { recursive: true });
  await mkdir(path.join(entryRoot, OBSERVATIONS_DIR), { recursive: true });
  await mkdir(path.join(entryRoot, MANIFESTS_DIR), { recursive: true });
  await mkdir(path.join(entryRoot, CAPTURES_DIR), { recursive: true });
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

function observationSuffix(
  vcs: SourceVcsMetadata | undefined,
  fingerprint: SourceFingerprint,
): string {
  return isGitMetadata(vcs) ? vcs.commit : fingerprint.value;
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

function classifyChange(
  previousObservation: SourceObservation | null,
  previousManifest: SourceManifest | null,
  currentManifest: SourceManifest,
  currentVcs: SourceVcsMetadata | undefined,
  forced?: SourceChangeClass,
): SourceChangeClass {
  if (forced) {
    assertChangeClass(forced);
    return forced;
  }

  if (!previousObservation || !previousManifest) {
    return "normal";
  }

  if (isGitMetadata(previousObservation.vcs) && isGitMetadata(currentVcs)) {
    if (
      previousObservation.vcs.commit === currentVcs.commit &&
      previousObservation.vcs.dirty === currentVcs.dirty
    ) {
      return "same";
    }
    if (
      previousObservation.vcs.remote &&
      currentVcs.remote &&
      previousObservation.vcs.remote !== currentVcs.remote
    ) {
      return "replacement";
    }
    if (currentVcs.common_ancestor_with_previous === false) {
      return "replacement";
    }
  } else if (
    previousObservation.fingerprint?.value !== undefined &&
    previousObservation.fingerprint.value === currentManifest.fingerprint.value
  ) {
    return "same";
  }
  // A previous observation without a recorded fingerprint cannot prove "same".
  // Classification falls through to the manifest diff below, which always
  // yields a real class so the repairing observation is written.

  const diff = compareManifests(previousManifest, currentManifest);
  const changedCount = diff.added.length + diff.removed.length + diff.changed.length;
  const denominator = Math.max(previousManifest.files.length, currentManifest.files.length, 1);
  const ratio = changedCount / denominator;
  if (ratio <= 0.05) return "patch";
  if (ratio <= 0.4) return "normal";
  return "major";
}

async function recordObservation(input: {
  readonly root: string;
  readonly entryRoot: string;
  readonly relativePath: string;
  readonly lineage: SourceLineage;
  readonly now: Date;
  readonly captureMode: SourceCaptureMode;
  readonly captureRoot: string;
  readonly previousObservation: SourceObservation | null;
  readonly previousManifest: SourceManifest | null;
  readonly changeClass?: SourceChangeClass;
}): Promise<MaterializedObservation & { readonly changeClass: SourceChangeClass }> {
  const observedOn = nowIso(input.now);
  const previousVcs = input.previousObservation?.vcs;
  const vcs = await collectGitMetadata(input.captureRoot, previousVcs);
  const manifest = await collectManifest(input.captureRoot, observedOn);
  const changeClass = classifyChange(
    input.previousObservation,
    input.previousManifest,
    manifest,
    vcs,
    input.changeClass,
  );
  const id = await nextObservationId(
    input.entryRoot,
    input.now,
    observationSuffix(vcs, manifest.fingerprint),
  );

  const observation: SourceObservation = {
    observation_id: id,
    observed_on: observedOn,
    lineage_id: input.lineage.lineage_id,
    source_path: input.relativePath,
    previous_observation: input.previousObservation
      ? observationPath(input.previousObservation.observation_id)
      : null,
    change_class: changeClass,
    capture_mode: input.captureMode,
    ...(vcs ? { vcs } : {}),
    fingerprint: manifest.fingerprint,
    manifest: manifestPath(id),
    materials_path: "materials",
    ...(input.captureMode === "checkout" ? { checkout_path: "checkout" } : {}),
    ...(input.captureMode === "archive" ? { capture_path: `${CAPTURES_DIR}/${id}/source` } : {}),
  };

  const obsFile = path.join(input.entryRoot, observationPath(id));
  const manifestFile = path.join(input.entryRoot, manifestPath(id));
  if (input.captureMode === "archive") {
    await materializeArchiveCapture(input.entryRoot, id, input.captureRoot);
  }
  await writeYamlFile(obsFile, observation);
  await writeManifest(manifestFile, manifest);

  return {
    observation,
    manifest,
    observationFile: observationPath(id),
    manifestFile: manifestPath(id),
    changeClass,
  };
}

function updateLineageForObservation(
  lineage: SourceLineage,
  observation: SourceObservation,
): SourceLineage {
  return {
    ...lineage,
    latest_observation: observationPath(observation.observation_id),
    ...(observation.capture_mode === "checkout" && observation.vcs
      ? {
          checkout: {
            path: "checkout",
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
  const lines = [
    `# ${lineage.lineage_name}`,
    "",
    `- Source kind: ${lineage.source_kind}`,
    `- Source URI: ${lineage.source_uri}`,
    `- Latest observation: ${lineage.latest_observation ?? observationPath(observation.observation_id)}`,
    `- Capture mode: ${lineage.default_capture_mode}`,
    `- Change class: ${observation.change_class}`,
    "",
    "## Entrypoints",
    "",
    "- `source.yaml`: durable lineage identity",
    "- `checkout/`: current materialized source when capture mode is `checkout`",
    "- `materials/`: selected extracts and supporting files",
    `- Source mode: ${lineage.mode}`,
    "- `observations/`, `manifests/`, `captures/`: source observation ledger",
    "",
  ];
  await writeFile(path.join(entryRoot, "README.md"), lines.join("\n"), "utf8");
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
    const entryRoot = path.join(sourcesRoot, normalized);
    const sourceFile = path.join(entryRoot, "source.yaml");
    if (!(await exists(sourceFile))) {
      throw new FrameworkNotFoundError(`source not found: ${normalized}`);
    }
    return {
      alias: normalized,
      relativePath: `${sourcesRelative}/${normalized}`,
      absolutePath: entryRoot,
      lineage: await readSourceLineageFile(sourceFile),
    };
  }

  const entries = await listSourceEntries(root);
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

async function listSourceEntries(root: string): Promise<SourceEntry[]> {
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const sourcesRoot = sourcesRootForManifest(root, manifest);
  const sourcesRelative = sourcesRelativeForManifest(manifest);
  if (!(await exists(sourcesRoot))) return [];
  const entries = await readdir(sourcesRoot, { withFileTypes: true });
  const sources: SourceEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "frozen") continue;
    const entryRoot = path.join(sourcesRoot, entry.name);
    const sourceFile = path.join(entryRoot, "source.yaml");
    if (!(await exists(sourceFile))) continue;
    sources.push({
      alias: entry.name,
      relativePath: `${sourcesRelative}/${entry.name}`,
      absolutePath: entryRoot,
      lineage: await readSourceLineageFile(sourceFile),
    });
  }
  return sources.sort((a, b) => a.alias.localeCompare(b.alias));
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

async function loadObservationManifest(
  entryRoot: string,
  observation: SourceObservation | null,
): Promise<SourceManifest | null> {
  if (!observation) return null;
  const file = path.join(entryRoot, observation.manifest);
  return (await exists(file)) ? readManifest(file) : null;
}

async function writeLineage(entryRoot: string, lineage: SourceLineage): Promise<void> {
  await writeYamlFile(path.join(entryRoot, "source.yaml"), lineage);
}

async function materializeMaterials(captureRoot: string, materialsDir: string): Promise<number> {
  await mkdir(materialsDir, { recursive: true });
  await writeStructure(captureRoot, path.join(materialsDir, "structure.md"));
  return materializeSelectedFiles(captureRoot, materialsDir);
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
  const mode = options.mode ?? "living";
  if (!SOURCE_MODES.includes(mode)) {
    throw new FrameworkError(`source mode must be one of: ${SOURCE_MODES.join(", ")}`);
  }
  if (mode === "frozen" && options.capture !== undefined && options.capture !== "archive") {
    throw new FrameworkError("frozen sources require archive capture");
  }
  const captureMode = mode === "frozen" ? "archive" : (options.capture ?? "checkout");
  assertCaptureMode(captureMode);

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

  await ensureSourceScaffold(entryRoot);
  const { captureRoot, checkoutPath, sourceKind } = await prepareSourceRoots(
    entryRoot,
    source,
    captureMode,
    options.branch,
  );
  const selectedFiles = await materializeMaterials(captureRoot, path.join(entryRoot, "materials"));
  const createdOn = nowIso(now);
  const lineage: SourceLineage = {
    lineage_id: alias,
    lineage_name: options.alias ?? displaySourceName(options.source),
    source_kind: sourceKind,
    source_uri: source,
    created_on: createdOn,
    latest_observation: null,
    mode,
    default_capture_mode: captureMode,
  };

  const recorded = await recordObservation({
    root,
    entryRoot,
    relativePath,
    lineage,
    now,
    captureMode,
    captureRoot,
    previousObservation: null,
    previousManifest: null,
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
      mode,
      capture_mode: captureMode,
      observation: recorded.observationFile,
      manifest: recorded.manifestFile,
      materials_selected_files: selectedFiles,
    },
    now,
  );

  return {
    root,
    alias,
    path: relativePath,
    sourceFile: `${relativePath}/source.yaml`,
    observationFile: `${relativePath}/${recorded.observationFile}`,
    manifestFile: `${relativePath}/${recorded.manifestFile}`,
    checkoutPath: checkoutPath ? `${relativePath}/${checkoutPath}` : null,
    materialsPath: `${relativePath}/materials`,
    observation: recorded.observation,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function syncSource(options: SourceSyncOptions): Promise<SourceSyncResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withWorkspaceMutationCoordination(root, () => syncSourceUnlocked({ ...options, root }));
}

async function syncSourceUnlocked(options: SourceSyncOptions): Promise<SourceSyncResult> {
  const root = path.resolve(options.root);
  requireManifestPresent(await loadManifest(root), root);
  const now = options.now ?? new Date();
  if (options.changeClass) assertChangeClass(options.changeClass);
  const entry = await sourceEntryForAlias(root, options.alias);
  if (entry.lineage.mode === "frozen") {
    throw new FrameworkError(`source '${entry.alias}' is frozen and cannot be synced`);
  }
  const previousObservation = await loadObservation(
    entry.absolutePath,
    entry.lineage.latest_observation,
  );
  const previousManifest = await loadObservationManifest(entry.absolutePath, previousObservation);
  const captureMode = entry.lineage.default_capture_mode;

  const captureRoot = await refreshCheckoutBeforeObservation(
    entry,
    options,
    captureMode,
    previousObservation,
  );

  await materializeMaterials(captureRoot, path.join(entry.absolutePath, "materials"));
  const recorded = await recordObservation({
    root,
    entryRoot: entry.absolutePath,
    relativePath: entry.relativePath,
    lineage: entry.lineage,
    now,
    captureMode,
    captureRoot,
    previousObservation,
    previousManifest,
    ...(options.changeClass ? { changeClass: options.changeClass } : {}),
  });

  if (recorded.changeClass === "same") {
    await rm(path.join(entry.absolutePath, recorded.observationFile), { force: true });
    await rm(path.join(entry.absolutePath, recorded.manifestFile), { force: true });
    const eventFile = await appendEvent(
      root,
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
      root,
      alias: entry.alias,
      path: entry.relativePath,
      changeClass: "same",
      observationFile: null,
      manifestFile: null,
      observation: null,
      eventFile: relativeDisplayPath(eventFile, root),
    };
  }

  const updatedLineage = updateLineageForObservation(entry.lineage, recorded.observation);
  await writeLineage(entry.absolutePath, updatedLineage);
  await writeSourceCard(entry.absolutePath, updatedLineage, recorded.observation);
  const comparison = compareManifests(previousManifest, recorded.manifest);
  const comparisonResult: SourceDiffResult = {
    ...comparison,
    root,
    alias: entry.alias,
    from: previousObservation?.observation_id ?? null,
    to: recorded.observation.observation_id,
  };
  const eventFile = await appendEvent(
    root,
    {
      event: "source.synced",
      source: entry.alias,
      path: entry.relativePath,
      change_class: recorded.changeClass,
      previous_observation: previousObservation?.observation_id ?? null,
      observation: recorded.observationFile,
      manifest: recorded.manifestFile,
    },
    now,
  );

  return {
    root,
    alias: entry.alias,
    path: entry.relativePath,
    changeClass: recorded.changeClass,
    observationFile: `${entry.relativePath}/${recorded.observationFile}`,
    manifestFile: `${entry.relativePath}/${recorded.manifestFile}`,
    observation: recorded.observation,
    eventFile: relativeDisplayPath(eventFile, root),
    comparison: comparisonResult,
  };
}

export async function switchSource(options: SourceSwitchOptions): Promise<SourceSwitchResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  return withWorkspaceMutationCoordination(root, () => switchSourceUnlocked({ ...options, root }));
}

async function switchSourceUnlocked(options: SourceSwitchOptions): Promise<SourceSwitchResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const now = options.now ?? new Date();
  const entry = await sourceEntryForAlias(root, options.alias);
  if (entry.lineage.mode === "frozen") {
    throw new FrameworkError(`source '${entry.alias}' is frozen and cannot be switched`);
  }
  const checkout = path.join(entry.absolutePath, "checkout");
  if (!(await exists(path.join(checkout, ".git")))) {
    throw new FrameworkError(`source '${entry.alias}' does not have a Git checkout`);
  }
  const latestObservation = await loadObservation(
    entry.absolutePath,
    entry.lineage.latest_observation,
  );
  await assertGitCheckoutSafeForRefresh(
    checkout,
    entry.lineage.checkout?.commit ?? latestObservation?.vcs?.commit ?? null,
  );
  await checkoutGitRef(checkout, options.target);
  const vcs = await collectGitMetadata(checkout);
  if (!vcs) {
    throw new FrameworkError(`source '${entry.alias}' does not have readable Git metadata`);
  }
  const updatedLineage: SourceLineage = {
    ...entry.lineage,
    checkout: {
      path: "checkout",
      ref: vcs.ref,
      commit: vcs.commit,
      dirty: vcs.dirty,
    },
  };
  await writeLineage(entry.absolutePath, updatedLineage);
  const eventFile = await appendEvent(
    root,
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
    ? await syncSourceUnlocked({ root, alias: entry.alias, now })
    : undefined;
  return {
    root,
    alias: entry.alias,
    path: entry.relativePath,
    target: options.target,
    vcs,
    eventFile: relativeDisplayPath(eventFile, root),
    ...(sync ? { sync } : {}),
  };
}

export async function getSourceStatus(options: {
  readonly root: string;
  readonly alias?: string;
}): Promise<SourceStatusResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entries = options.alias
    ? [await sourceEntryForAlias(root, options.alias)]
    : await listSourceEntries(root);
  const sources: SourceStatusEntry[] = [];
  for (const entry of entries) {
    const latest = await loadObservation(entry.absolutePath, entry.lineage.latest_observation);
    sources.push({
      alias: entry.alias,
      path: entry.relativePath,
      name: entry.lineage.lineage_name,
      kind: entry.lineage.source_kind,
      uri: entry.lineage.source_uri,
      mode: entry.lineage.mode,
      captureMode: entry.lineage.default_capture_mode,
      latestObservation: latest?.observation_id ?? null,
      latestChangeClass: latest?.change_class ?? null,
      ...(latest?.vcs ? { vcs: latest.vcs } : {}),
      ...(entry.lineage.default_capture_mode === "checkout" && entry.lineage.checkout
        ? { checkout: entry.lineage.checkout }
        : {}),
    });
  }
  return { root, sources };
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
  return { root, alias: entry.alias, path: entry.relativePath, entries: observations };
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
  return {
    root,
    alias: entry.alias,
    sourcePath: entry.relativePath,
    observationFile: `${entry.relativePath}/${observationFile}`,
    observation: entry.observation,
    manifestFile: `${entry.relativePath}/${entry.observation.manifest}`,
    materialsPath: `${entry.relativePath}/${entry.observation.materials_path}`,
    checkoutPath: entry.observation.checkout_path
      ? `${entry.relativePath}/${entry.observation.checkout_path}`
      : null,
  };
}

export async function diffSource(options: SourceDiffOptions): Promise<SourceDiffResult> {
  const root = path.resolve(options.root);
  await preflightSourceWorkspace(root);
  const entry = await sourceEntryForAlias(root, options.alias);
  const latest = await loadObservation(entry.absolutePath, entry.lineage.latest_observation);
  const latestManifest = await loadObservationManifest(entry.absolutePath, latest);
  if (!latest || !latestManifest) {
    return { root, alias: entry.alias, from: null, to: null, added: [], removed: [], changed: [] };
  }

  const previousRef = options.since
    ? normalizeObservationSelector(options.since)
    : latest.previous_observation;
  const previous = await loadObservation(entry.absolutePath, previousRef);
  const previousManifest = await loadObservationManifest(entry.absolutePath, previous);
  const diff = compareManifests(previousManifest, latestManifest);
  return {
    ...diff,
    root,
    alias: entry.alias,
    from: previous?.observation_id ?? null,
    to: latest.observation_id,
  };
}

export async function collectSourceHealthRows(
  root: string,
  options: { readonly includeAdvisories?: boolean } = {},
): Promise<CheckRow[]> {
  await preflightSourceWorkspace(path.resolve(root));
  const rows: CheckRow[] = [];
  const sources = await listSourceEntries(root);
  for (const source of sources) {
    const latest = await loadObservation(source.absolutePath, source.lineage.latest_observation);
    if (!source.lineage.latest_observation) {
      rows.push({
        path: `${source.relativePath}/source.yaml`,
        status: "error",
        message: `source '${source.alias}' has no latest observation`,
      });
      continue;
    }
    if (!latest) {
      rows.push({
        path: `${source.relativePath}/source.yaml`,
        status: "error",
        message: `source '${source.alias}' points to missing latest observation`,
      });
      continue;
    }
    if (!latest.fingerprint?.value) {
      rows.push({
        path: `${source.relativePath}/${source.lineage.latest_observation}`,
        status: "error",
        message: `source observation '${latest.observation_id}' has no fingerprint`,
      });
    }
    const manifestFile = path.join(source.absolutePath, latest.manifest);
    if (!(await exists(manifestFile))) {
      rows.push({
        path: `${source.relativePath}/${latest.manifest}`,
        status: "error",
        message: `source observation '${latest.observation_id}' has no capture manifest`,
      });
    }
  }
  return rows;
}
