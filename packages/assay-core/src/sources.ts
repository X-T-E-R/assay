import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { MANAGED_DIR } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { resolveWorkspaceLayout, workspacePath, workspaceRelativePath } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import type { CheckRow } from "./results.js";
import type { FrameworkManifest } from "./schemas/index.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";
import { nowIso } from "./time.js";

export const SOURCE_CAPTURE_MODES = ["checkout", "archive"] as const;
export type SourceCaptureMode = (typeof SOURCE_CAPTURE_MODES)[number];

export const SOURCE_CHANGE_CLASSES = ["same", "patch", "normal", "major", "replacement"] as const;
export type SourceChangeClass = (typeof SOURCE_CHANGE_CLASSES)[number];

export type SourceKind = "git" | "directory" | "archive" | "url" | "unknown";
export type SourceAnalysisStatus = "none" | "open" | "closed" | "suggested";

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
  readonly status: "active" | "replaced" | "archived";
  readonly default_capture_mode: SourceCaptureMode;
  readonly checkout?: {
    readonly path: "checkout";
    readonly ref: string | null;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
  readonly relation?: {
    readonly kind: "replaces" | "forks" | "supersedes";
    readonly source: string;
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
  readonly analysis_status: SourceAnalysisStatus;
  readonly vcs?: SourceVcsMetadata;
  readonly fingerprint: SourceFingerprint;
  readonly manifest: string;
  readonly materials_path: string;
  readonly checkout_path?: string;
  readonly capture_path?: string;
  readonly analysis_path?: string;
  readonly analysis_exit?: string;
  readonly analysis_closed_on?: string;
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
  readonly status: SourceLineage["status"];
  readonly captureMode: SourceCaptureMode;
  readonly latestObservation: string | null;
  readonly latestChangeClass: SourceChangeClass | null;
  readonly analysisStatus: SourceAnalysisStatus | null;
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
  readonly diffFile: string | null;
}

export interface SourceObservationCloseOptions extends SourceObservationResolveOptions {
  readonly analysisPath: string;
  readonly analysisExit: string;
  readonly now?: Date;
}

interface SourceEntry {
  readonly alias: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly lineage: SourceLineage;
}

type SourceSyncGitTarget =
  | { readonly kind: "branch"; readonly value: string }
  | { readonly kind: "ref"; readonly value: string };

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

function referencesRootForManifest(root: string, manifest: FrameworkManifest): string {
  return workspacePath(root, layoutForManifest(manifest), "references");
}

function referencesRelativeForManifest(manifest: FrameworkManifest): string {
  return workspaceRelativePath(layoutForManifest(manifest), "references");
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
    throw new FrameworkError("source alias 'frozen' is reserved for legacy full captures");
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

async function writeYamlFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(value), "utf8");
}

// Source-entry ledger directories live directly under references/<alias>/.
// Layout v3 nested these under references/<alias>/.assay/, but once the
// workspace state dir became .assay (v4) that nesting produced confusing
// paths like .assay/references/foo/.assay/observations/. The ledger is now
// flat; LEGACY_SOURCE_LEDGER is read only as a migration fallback.
const OBSERVATIONS_DIR = "observations";
const MANIFESTS_DIR = "manifests";
const CAPTURES_DIR = "captures";
const COMPARISONS_DIR = "comparisons";
const LEGACY_SOURCE_LEDGER = ".assay";

function observationPath(observationId: string): string {
  return `${OBSERVATIONS_DIR}/${observationId}.yaml`;
}

function legacyObservationPath(observationId: string): string {
  return `${LEGACY_SOURCE_LEDGER}/${OBSERVATIONS_DIR}/${observationId}.yaml`;
}

function manifestPath(observationId: string): string {
  return `${MANIFESTS_DIR}/${observationId}.json`;
}

function legacyManifestPath(observationId: string): string {
  return `${LEGACY_SOURCE_LEDGER}/${MANIFESTS_DIR}/${observationId}.json`;
}

function analysisStatusForChange(
  changeClass: SourceChangeClass,
  firstObservation: boolean,
): SourceAnalysisStatus {
  if (changeClass === "same") return "none";
  if (firstObservation) return "open";
  return changeClass === "major" || changeClass === "replacement" ? "open" : "suggested";
}

function isGitMetadata(value: SourceVcsMetadata | undefined): value is SourceVcsMetadata {
  return value !== undefined && value.type === "git" && value.commit.length > 0;
}

function gitCommandOutput(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`;
}

async function tryGit(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const result = await execa("git", [...args], { cwd, reject: false });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

async function runGit(cwd: string, args: readonly string[], failureLabel: string): Promise<string> {
  const result = await tryGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new FrameworkError(`${failureLabel} failed: ${gitCommandOutput(result)}`, {
      code: "IO_ERROR",
    });
  }
  return result.stdout.trim();
}

function assertManagedCheckout(entryRoot: string, checkout: string): void {
  const relative = toPosixPath(path.relative(path.resolve(entryRoot), path.resolve(checkout)));
  if (relative !== "checkout") {
    throw new FrameworkError(`refusing to mutate unmanaged checkout path: ${checkout}`, {
      code: "IO_ERROR",
    });
  }
}

async function isGitCheckout(checkout: string): Promise<boolean> {
  return exists(path.join(checkout, ".git"));
}

async function currentCheckoutBranch(checkout: string): Promise<string | null> {
  if (!(await isGitCheckout(checkout))) {
    return null;
  }
  const branch = await tryGit(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.exitCode !== 0) {
    return null;
  }
  const value = branch.stdout.trim();
  return value && value !== "HEAD" ? value : null;
}

async function syncTargetForCheckout(
  options: Pick<SourceSyncOptions, "branch" | "ref">,
  checkout: string,
  lineage: SourceLineage,
): Promise<SourceSyncGitTarget | null> {
  if (options.ref) {
    return { kind: "ref", value: options.ref };
  }
  if (options.branch) {
    return { kind: "branch", value: options.branch };
  }

  const checkoutBranch = await currentCheckoutBranch(checkout);
  if (checkoutBranch) {
    return { kind: "branch", value: checkoutBranch };
  }

  if (lineage.checkout?.ref && lineage.checkout.ref !== "HEAD") {
    return { kind: "branch", value: lineage.checkout.ref };
  }

  return null;
}

async function gitRemoteOrigin(checkout: string): Promise<string | null> {
  const remote = await tryGit(checkout, ["config", "--get", "remote.origin.url"]);
  return remote.exitCode === 0 && remote.stdout.trim() !== "" ? remote.stdout.trim() : null;
}

async function resetManagedGitCheckout(checkout: string, target?: string): Promise<void> {
  await runGit(checkout, target ? ["reset", "--hard", target] : ["reset", "--hard"], "git reset");
  await runGit(checkout, ["clean", "-fd"], "git clean");
}

async function checkoutGitRef(checkout: string, ref: string): Promise<void> {
  const checkedOut = await tryGit(checkout, ["checkout", ref]);
  if (checkedOut.exitCode === 0) {
    return;
  }

  const fetched = await tryGit(checkout, ["fetch", "origin", ref]);
  if (fetched.exitCode === 0) {
    await runGit(checkout, ["checkout", "FETCH_HEAD"], "git checkout");
    return;
  }

  throw new FrameworkError(
    `git checkout failed: ${gitCommandOutput(checkedOut)}; git fetch failed: ${gitCommandOutput(fetched)}`,
    { code: "IO_ERROR" },
  );
}

async function cloneGitSource(
  source: string,
  checkout: string,
  target: SourceSyncGitTarget | null,
  shallow: boolean,
): Promise<void> {
  await mkdir(path.dirname(checkout), { recursive: true });
  const args = ["clone"];
  if (shallow) {
    args.push("--depth", "1");
  }
  if (target?.kind === "branch") {
    args.push("--branch", target.value);
  }
  args.push(source, checkout);
  await runGit(path.dirname(checkout), args, "git clone");

  if (target?.kind === "ref") {
    await checkoutGitRef(checkout, target.value);
  }
  await resetManagedGitCheckout(checkout);
}

async function refreshLocalGitCheckout(
  entryRoot: string,
  sourceUri: string,
  target: SourceSyncGitTarget | null,
): Promise<string> {
  const checkout = path.join(entryRoot, "checkout");
  assertManagedCheckout(entryRoot, checkout);
  if (await isGitCheckout(checkout)) {
    const remote = await gitRemoteOrigin(checkout);
    if (remote) {
      await runGit(checkout, ["remote", "set-url", "origin", sourceUri], "git remote set-url");
    } else {
      await runGit(checkout, ["remote", "add", "origin", sourceUri], "git remote add");
    }
    await refreshRemoteGitCheckout(entryRoot, checkout, target);
    return checkout;
  }
  await rm(checkout, { recursive: true, force: true });
  await cloneGitSource(sourceUri, checkout, target, false);
  return checkout;
}

async function refreshRemoteGitCheckout(
  entryRoot: string,
  checkout: string,
  target: SourceSyncGitTarget | null,
): Promise<void> {
  assertManagedCheckout(entryRoot, checkout);
  if (!(await isGitCheckout(checkout))) {
    return;
  }

  const remote = await gitRemoteOrigin(checkout);
  if (!remote) {
    if (target) {
      await runGit(checkout, ["checkout", target.value], "git checkout");
      await resetManagedGitCheckout(checkout);
    }
    return;
  }

  await resetManagedGitCheckout(checkout);

  if (target?.kind === "branch") {
    const remoteRef = `refs/remotes/origin/${target.value}`;
    await runGit(
      checkout,
      ["fetch", "--prune", "origin", `+refs/heads/${target.value}:${remoteRef}`],
      "git fetch",
    );
    await runGit(checkout, ["checkout", "-B", target.value, remoteRef], "git checkout");
    await resetManagedGitCheckout(checkout, remoteRef);
    return;
  }

  if (target?.kind === "ref") {
    await runGit(checkout, ["fetch", "--prune", "origin"], "git fetch");
    await checkoutGitRef(checkout, target.value);
    await resetManagedGitCheckout(checkout);
    return;
  }

  await runGit(checkout, ["fetch", "--prune", "origin"], "git fetch");
  const branch = await currentCheckoutBranch(checkout);
  if (branch) {
    const remoteRef = `refs/remotes/origin/${branch}`;
    await runGit(checkout, ["checkout", "-B", branch, remoteRef], "git checkout");
    await resetManagedGitCheckout(checkout, remoteRef);
    return;
  }
  await resetManagedGitCheckout(checkout);
}

async function collectGitMetadata(
  cwd: string,
  previous?: SourceVcsMetadata,
): Promise<SourceVcsMetadata | undefined> {
  const inside = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    reject: false,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return undefined;
  }

  const remote = await execa("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    reject: false,
  });
  const ref = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, reject: false });
  const commit = await execa("git", ["rev-parse", "HEAD"], { cwd, reject: false });
  const dirty = await execa("git", ["status", "--porcelain"], { cwd, reject: false });
  const commitDate = await execa("git", ["show", "-s", "--format=%cI", "HEAD"], {
    cwd,
    reject: false,
  });

  if (commit.exitCode !== 0) {
    return undefined;
  }

  let commonAncestor: boolean | undefined;
  if (previous?.commit) {
    const mergeBase = await execa("git", ["merge-base", "--is-ancestor", previous.commit, "HEAD"], {
      cwd,
      reject: false,
    });
    commonAncestor = mergeBase.exitCode === 0;
  }

  return {
    type: "git",
    remote: remote.exitCode === 0 && remote.stdout.trim() !== "" ? remote.stdout.trim() : null,
    ref: ref.exitCode === 0 ? ref.stdout.trim() : "HEAD",
    commit: commit.stdout.trim(),
    dirty: dirty.stdout.trim().length > 0,
    commit_date:
      commitDate.exitCode === 0 && commitDate.stdout.trim() !== ""
        ? commitDate.stdout.trim()
        : null,
    ...(commonAncestor === undefined ? {} : { common_ancestor_with_previous: commonAncestor }),
  };
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
): Promise<string> {
  const checkout = path.join(entry.absolutePath, "checkout");
  if (captureMode !== "checkout") {
    return (await exists(entry.lineage.source_uri)) ? entry.lineage.source_uri : checkout;
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
  await mkdir(path.join(entryRoot, COMPARISONS_DIR), { recursive: true });
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
  } else if (previousObservation.fingerprint.value === currentManifest.fingerprint.value) {
    return "same";
  }

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

  const firstObservation = input.previousObservation === null;
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
    analysis_status: analysisStatusForChange(changeClass, firstObservation),
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
    ...(observation.vcs
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
    "- `observations/`, `manifests/`, `comparisons/`, `captures/`: source observation ledger",
    "",
  ];
  await writeFile(path.join(entryRoot, "README.md"), lines.join("\n"), "utf8");
}

async function appendHistory(
  entryRoot: string,
  event: "add" | "sync" | "switch" | "noop",
  observation: SourceObservation | null,
  note: string,
  now: Date,
): Promise<void> {
  const file = path.join(entryRoot, "history.md");
  if (!(await exists(file))) {
    await writeFile(file, "# Source History\n\n", "utf8");
  }
  const obs = observation ? ` (${observation.observation_id}, ${observation.change_class})` : "";
  const line = `- ${nowIso(now)} — ${event}${obs}: ${note}\n`;
  await writeFile(file, `${await readFile(file, "utf8")}${line}`, "utf8");
}

async function sourceEntryForAlias(root: string, alias?: string): Promise<SourceEntry> {
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const referencesRoot = referencesRootForManifest(root, manifest);
  const referencesRelative = referencesRelativeForManifest(manifest);
  if (!(await exists(referencesRoot))) {
    throw new FrameworkNotFoundError(`no references directory found: ${referencesRelative}`);
  }

  if (alias) {
    const normalized = slugify(alias);
    const entryRoot = path.join(referencesRoot, normalized);
    const sourceFile = path.join(entryRoot, "source.yaml");
    if (!(await exists(sourceFile))) {
      throw new FrameworkNotFoundError(`source not found: ${normalized}`);
    }
    return {
      alias: normalized,
      relativePath: `${referencesRelative}/${normalized}`,
      absolutePath: entryRoot,
      lineage: await readYamlFile<SourceLineage>(sourceFile),
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
  const referencesRoot = referencesRootForManifest(root, manifest);
  const referencesRelative = referencesRelativeForManifest(manifest);
  if (!(await exists(referencesRoot))) return [];
  const entries = await readdir(referencesRoot, { withFileTypes: true });
  const sources: SourceEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "frozen") continue;
    const entryRoot = path.join(referencesRoot, entry.name);
    const sourceFile = path.join(entryRoot, "source.yaml");
    if (!(await exists(sourceFile))) continue;
    sources.push({
      alias: entry.name,
      relativePath: `${referencesRelative}/${entry.name}`,
      absolutePath: entryRoot,
      lineage: await readYamlFile<SourceLineage>(sourceFile),
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
  // Resolve three selector shapes: a full path (flat or legacy), or a bare
  // observation id. Bare ids and flat paths prefer the v4 flat layout; legacy
  // .assay/observations/ paths are read as-is for migration compatibility.
  let file: string;
  if (normalized.endsWith(".yaml")) {
    file = path.join(entryRoot, normalized);
  } else {
    file = path.join(entryRoot, OBSERVATIONS_DIR, `${normalized}.yaml`);
    if (!(await exists(file))) {
      file = path.join(entryRoot, legacyObservationPath(normalized));
    }
  }
  if (!(await exists(file))) return null;
  return readYamlFile<SourceObservation>(file);
}

async function loadObservationManifest(
  entryRoot: string,
  observation: SourceObservation | null,
): Promise<SourceManifest | null> {
  if (!observation) return null;
  const file = path.join(entryRoot, observation.manifest);
  if (await exists(file)) {
    return readManifest(file);
  }
  // Migration fallback: v3 stored manifests under .assay/manifests/. If the
  // manifest path points at the flat layout but the file is missing, try the
  // legacy location derived from the observation id.
  const legacyFile = path.join(entryRoot, legacyManifestPath(observation.observation_id));
  if (await exists(legacyFile)) {
    return readManifest(legacyFile);
  }
  return null;
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
  const manifest = requireManifestPresent(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const captureMode = options.capture ?? "checkout";
  assertCaptureMode(captureMode);

  const source =
    looksLikeGitUri(options.source) && !(await exists(options.source))
      ? options.source
      : path.resolve(options.source);
  const alias = aliasForSource(options.source, options.alias);
  const relativePath = `${referencesRelativeForManifest(manifest)}/${alias}`;
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
    status: "active",
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
  await appendHistory(entryRoot, "add", recorded.observation, `added from ${source}`, now);

  const eventFile = await appendEvent(
    root,
    {
      event: "source.added",
      source: alias,
      path: relativePath,
      source_uri: source,
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
  requireManifestPresent(await loadManifest(root), root);
  const now = options.now ?? new Date();
  if (options.changeClass) assertChangeClass(options.changeClass);
  const entry = await sourceEntryForAlias(root, options.alias);
  const previousObservation = await loadObservation(
    entry.absolutePath,
    entry.lineage.latest_observation,
  );
  const previousManifest = await loadObservationManifest(entry.absolutePath, previousObservation);
  const captureMode = entry.lineage.default_capture_mode;

  const captureRoot = await refreshCheckoutBeforeObservation(entry, options, captureMode);

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
    await appendHistory(
      entry.absolutePath,
      "noop",
      null,
      "same source state; no new observation",
      now,
    );
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
  await appendHistory(
    entry.absolutePath,
    "sync",
    recorded.observation,
    `synced ${entry.lineage.source_uri}`,
    now,
  );
  const comparison = compareManifests(previousManifest, recorded.manifest);
  const comparisonResult: SourceDiffResult = {
    ...comparison,
    root,
    alias: entry.alias,
    from: previousObservation?.observation_id ?? null,
    to: recorded.observation.observation_id,
  };
  await writeFile(
    path.join(
      entry.absolutePath,
      COMPARISONS_DIR,
      `${previousObservation?.observation_id ?? "none"}--${recorded.observation.observation_id}.md`,
    ),
    formatDiffMarkdown(comparisonResult),
    "utf8",
  );
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
  requireManifestPresent(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const entry = await sourceEntryForAlias(root, options.alias);
  const checkout = path.join(entry.absolutePath, "checkout");
  if (!(await exists(path.join(checkout, ".git")))) {
    throw new FrameworkError(`source '${entry.alias}' does not have a Git checkout`);
  }
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
  await appendHistory(
    entry.absolutePath,
    "switch",
    null,
    `checked out ${options.target} (${vcs.commit.slice(0, 12)})`,
    now,
  );
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
  const sync = options.sync ? await syncSource({ root, alias: entry.alias, now }) : undefined;
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
  requireManifestPresent(await loadManifest(root), root);
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
      status: entry.lineage.status,
      captureMode: entry.lineage.default_capture_mode,
      latestObservation: latest?.observation_id ?? null,
      latestChangeClass: latest?.change_class ?? null,
      analysisStatus: latest?.analysis_status ?? null,
      ...(latest?.vcs ? { vcs: latest.vcs } : {}),
      ...(entry.lineage.checkout ? { checkout: entry.lineage.checkout } : {}),
    });
  }
  return { root, sources };
}

export async function getSourceLog(options: {
  readonly root: string;
  readonly alias: string;
}): Promise<SourceLogResult> {
  const root = path.resolve(options.root);
  requireManifestPresent(await loadManifest(root), root);
  const entry = await sourceEntryForAlias(root, options.alias);
  const flatDir = path.join(entry.absolutePath, OBSERVATIONS_DIR);
  const legacyDir = path.join(entry.absolutePath, LEGACY_SOURCE_LEDGER, OBSERVATIONS_DIR);
  const observationsDir = (await exists(flatDir)) ? flatDir : legacyDir;
  const entries = await readdir(observationsDir, { withFileTypes: true });
  const observations: SourceLogEntry[] = [];
  for (const file of entries) {
    if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
    const relative = `${OBSERVATIONS_DIR}/${file.name}`;
    observations.push({
      observation: await readYamlFile<SourceObservation>(path.join(observationsDir, file.name)),
      path: relative,
    });
  }
  observations.sort((a, b) => a.observation.observed_on.localeCompare(b.observation.observed_on));
  return { root, alias: entry.alias, path: entry.relativePath, entries: observations };
}

function normalizeObservationSelector(selector: string): string {
  const normalized = selector.replace(/\\/g, "/");
  if (normalized.endsWith(".yaml")) return normalized;
  // Accept both flat (observations/<id>) and legacy (.assay/observations/<id>)
  // selectors; readers resolve both against the source entry root.
  if (normalized.startsWith(`${OBSERVATIONS_DIR}/`)) return `${normalized}.yaml`;
  if (normalized.startsWith(`${LEGACY_SOURCE_LEDGER}/${OBSERVATIONS_DIR}/`)) {
    return `${normalized}.yaml`;
  }
  return `${OBSERVATIONS_DIR}/${normalized}.yaml`;
}

function observationIdFromPath(observationRef: string | null): string | null {
  if (!observationRef) return null;
  return path.basename(observationRef.replace(/\\/g, "/"), ".yaml");
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
  requireManifestPresent(await loadManifest(root), root);
  const entry = await resolveSourceObservationEntry(root, options.alias, options.observation);
  const observationFile = observationPath(entry.observation.observation_id);
  const previousId = observationIdFromPath(entry.observation.previous_observation);
  const diffName = previousId ? `${previousId}--${entry.observation.observation_id}.md` : null;
  let diffExists: string | null = null;
  if (diffName) {
    const flat = `${COMPARISONS_DIR}/${diffName}`;
    const legacy = `${LEGACY_SOURCE_LEDGER}/${COMPARISONS_DIR}/${diffName}`;
    if (await exists(path.join(entry.absolutePath, flat))) {
      diffExists = flat;
    } else if (await exists(path.join(entry.absolutePath, legacy))) {
      diffExists = legacy;
    }
  }

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
    diffFile: diffExists ? `${entry.relativePath}/${diffExists}` : null,
  };
}

export async function closeSourceObservationAnalysis(
  options: SourceObservationCloseOptions,
): Promise<SourceObservationResolution> {
  const root = path.resolve(options.root);
  requireManifestPresent(await loadManifest(root), root);
  const entry = await resolveSourceObservationEntry(root, options.alias, options.observation);
  const updated: SourceObservation = {
    ...entry.observation,
    analysis_status: "closed",
    analysis_path: options.analysisPath.replace(/\\/g, "/"),
    analysis_exit: options.analysisExit,
    analysis_closed_on: nowIso(options.now ?? new Date()),
  };
  await writeYamlFile(
    path.join(entry.absolutePath, observationPath(updated.observation_id)),
    updated,
  );
  return resolveSourceObservation({
    root,
    alias: entry.alias,
    observation: updated.observation_id,
  });
}

export async function diffSource(options: SourceDiffOptions): Promise<SourceDiffResult> {
  const root = path.resolve(options.root);
  requireManifestPresent(await loadManifest(root), root);
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

function formatDiffMarkdown(diff: SourceDiffResult): string {
  return [
    `# Source Diff: ${diff.alias}`,
    "",
    `- From: ${diff.from ?? "none"}`,
    `- To: ${diff.to ?? "none"}`,
    "",
    "## Added",
    "",
    ...(diff.added.length > 0 ? diff.added.map((file) => `- ${file}`) : ["(none)"]),
    "",
    "## Removed",
    "",
    ...(diff.removed.length > 0 ? diff.removed.map((file) => `- ${file}`) : ["(none)"]),
    "",
    "## Changed",
    "",
    ...(diff.changed.length > 0 ? diff.changed.map((file) => `- ${file}`) : ["(none)"]),
    "",
  ].join("\n");
}

export async function collectSourceHealthRows(root: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const sources = await listSourceEntries(root);
  for (const source of sources) {
    const latest = await loadObservation(source.absolutePath, source.lineage.latest_observation);
    if (!source.lineage.latest_observation) {
      rows.push({
        path: `${source.relativePath}/source.yaml`,
        status: "warning",
        message: `source '${source.alias}' has no latest observation`,
      });
      continue;
    }
    if (!latest) {
      rows.push({
        path: `${source.relativePath}/source.yaml`,
        status: "warning",
        message: `source '${source.alias}' points to missing latest observation`,
      });
      continue;
    }
    if (!latest.fingerprint?.value) {
      rows.push({
        path: `${source.relativePath}/${source.lineage.latest_observation}`,
        status: "warning",
        message: `source observation '${latest.observation_id}' has no fingerprint`,
      });
    }
    const manifestFile = path.join(source.absolutePath, latest.manifest);
    if (!(await exists(manifestFile))) {
      rows.push({
        path: `${source.relativePath}/${latest.manifest}`,
        status: "warning",
        message: `source observation '${latest.observation_id}' has no capture manifest`,
      });
    }
    if (latest.change_class === "major" && latest.analysis_status !== "closed") {
      rows.push({
        path: `${source.relativePath}/${source.lineage.latest_observation}`,
        status: "warning",
        message: `major source change '${latest.observation_id}' needs revalidation analysis`,
      });
    }
  }
  return rows;
}
