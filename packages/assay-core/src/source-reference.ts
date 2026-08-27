import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { type CloneRegistryEntry, findClonesByAlias, recordSourceClone } from "./clone-registry.js";
import {
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
  WorkspaceCutoverRequiredError,
} from "./errors.js";
import { appendEvent } from "./events.js";
import { resolveWorkspaceLayout, workspaceRelativePath } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { withSemanticModel } from "./semantics.js";
import { toPosixPath } from "./serialization.js";
import { withWorkspaceMutationCoordination } from "./tasks/task-storage.js";

/**
 * Source references: one Source, one home, reachable from any workspace.
 *
 * A workspace that needs material somebody else already studied writes a shell
 * under its own `sources/<alias>/` naming the workspace that owns it and the
 * alias it has there. Nothing else. The shell duplicates no URI, no commit, no
 * observation, because a second copy of those is a second authority, and the
 * whole point is that there is one.
 *
 * The relationship is live and one hop deep. `link` follows a chain of shells
 * to the workspace that actually holds `source.yaml` and records that one, so
 * runtime never walks a graph. Reads show the relation rather than hiding it;
 * writes go through to the home and say so. Deleting is the one asymmetry:
 * `unlink` forgets a local name and never reaches the shared material.
 */

export const SOURCE_REFERENCE_SCHEMA = "assay.source-reference/v1";
export const SOURCE_REFERENCE_FILE = "source.ref.yaml";
export const SOURCE_LINEAGE_FILE = "source.yaml";
/** A user-maintained entry point every reference can see; read, never written. */
export const SOURCE_BRIEF_FILE = "brief.md";

/**
 * Directories only a Source home has. A shell holding one is not a thin
 * pointer any more, and quietly resolving it elsewhere would leave real bytes
 * stranded under a name that says they live somewhere else.
 */
const HOME_ONLY_DIRECTORIES = ["checkout", "content", "observations", "captures"] as const;

/** Depth `link` will follow before calling the arrangement a loop. */
const MAX_REFERENCE_HOPS = 8;

export interface SourceReferenceRecord {
  readonly schema: typeof SOURCE_REFERENCE_SCHEMA;
  /** Target workspace root; relative to the consumer root, or absolute. */
  readonly workspace: string;
  /** Alias the Source has in that workspace. */
  readonly source: string;
}

/** A reference shell as it sits in the consumer workspace, before resolution. */
export interface SourceReferenceShell {
  readonly alias: string;
  readonly consumerRoot: string;
  /** Consumer-relative path of the shell directory. */
  readonly shellPath: string;
  readonly absolutePath: string;
  readonly record: SourceReferenceRecord;
  /** `../../shared-research#qiskit`, as read output prints it. */
  readonly display: string;
}

/** Where a reference actually resolves, once the target workspace was read. */
export interface SourceReferenceHome {
  readonly workspaceRoot: string;
  readonly alias: string;
  /** Home-relative sources directory, from the home's own layout. */
  readonly sourcesRelative: string;
  readonly entryRoot: string;
  /** Home-relative `brief.md` when the home keeps one. */
  readonly brief: string | null;
}

/** What read and write output carries so a reference is never mistaken for owned. */
export interface SourceEntryReference {
  readonly consumerRoot: string;
  readonly shellPath: string;
  /** `workspace:` exactly as the shell records it. */
  readonly workspaceRecorded: string;
  readonly homeRoot: string;
  readonly homeAlias: string;
  readonly display: string;
  readonly brief: string | null;
}

export interface BrokenSourceReference {
  readonly alias: string;
  readonly shellPath: string;
  readonly display: string;
  /** One line saying what could not be reached, ready to print. */
  readonly reason: string;
  readonly workspaceRecorded: string;
  readonly homeAlias: string;
  /** Where the registry currently says this Source is, when it verified. */
  readonly suggestions: readonly string[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function invalidReference(file: string, message: string, cause?: unknown): FrameworkError {
  return new FrameworkError(`${message}: ${file}`, {
    code: "IO_ERROR",
    ...(cause === undefined ? {} : { cause }),
  });
}

export function sourceReferenceDisplay(record: SourceReferenceRecord): string {
  return `${toPosixPath(record.workspace)}#${record.source}`;
}

export async function readSourceReferenceRecord(file: string): Promise<SourceReferenceRecord> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw invalidReference(file, "source reference is not valid YAML", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidReference(file, "source reference is not a mapping");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SOURCE_REFERENCE_SCHEMA) {
    throw invalidReference(file, `source reference schema must be ${SOURCE_REFERENCE_SCHEMA}`);
  }
  // A reference that carried its own branch, revision, or pin would be a second
  // place the Source's state is declared, which is exactly what one home means
  // there cannot be.
  for (const field of ["pin", "branch", "revision", "ref", "observation", "source_uri"]) {
    if (Object.hasOwn(record, field)) {
      throw invalidReference(
        file,
        `source reference must not declare '${field}'; a reference names a home, and the home holds the state`,
      );
    }
  }
  if (typeof record.workspace !== "string" || record.workspace.trim() === "") {
    throw invalidReference(file, "source reference needs a 'workspace' path");
  }
  if (typeof record.source !== "string" || record.source.trim() === "") {
    throw invalidReference(file, "source reference needs a 'source' alias");
  }
  return {
    schema: SOURCE_REFERENCE_SCHEMA,
    workspace: record.workspace.trim(),
    source: record.source.trim(),
  };
}

/**
 * Refuse a shell that also holds material.
 *
 * Both files present, or a `checkout/` beside the pointer, means two answers to
 * where this Source lives. `check` reports it and every command on the alias
 * fails, rather than one of the two answers being picked silently.
 */
async function assertThinShell(entryRoot: string, shellPath: string): Promise<void> {
  if (await exists(path.join(entryRoot, SOURCE_LINEAGE_FILE))) {
    throw new FrameworkError(
      `source '${shellPath}' holds both ${SOURCE_LINEAGE_FILE} and ${SOURCE_REFERENCE_FILE}; a Source is either owned here or referenced, not both`,
      { code: "IO_ERROR" },
    );
  }
  for (const directory of HOME_ONLY_DIRECTORIES) {
    if (await exists(path.join(entryRoot, directory))) {
      throw new FrameworkError(
        `source reference '${shellPath}' also holds ${directory}/; a reference is a pointer, so its material belongs in the home workspace`,
        { code: "IO_ERROR" },
      );
    }
  }
}

/** Read the shell at `sources/<alias>/`, or null when there is no shell there. */
export async function readSourceReferenceShell(input: {
  readonly consumerRoot: string;
  readonly sourcesRelative: string;
  readonly alias: string;
}): Promise<SourceReferenceShell | null> {
  const shellPath = `${input.sourcesRelative}/${input.alias}`;
  const entryRoot = path.join(input.consumerRoot, input.sourcesRelative, input.alias);
  const file = path.join(entryRoot, SOURCE_REFERENCE_FILE);
  if (!(await exists(file))) return null;
  await assertThinShell(entryRoot, shellPath);
  const record = await readSourceReferenceRecord(file);
  return {
    alias: input.alias,
    consumerRoot: input.consumerRoot,
    shellPath,
    absolutePath: entryRoot,
    record,
    display: sourceReferenceDisplay(record),
  };
}

function resolveRecordedWorkspace(consumerRoot: string, recorded: string): string {
  // `path.resolve` covers both halves of the contract at once: a relative path
  // is taken against the consumer root, and an absolute one — including a bare
  // Windows drive path — is used as written.
  return path.normalize(path.resolve(consumerRoot, recorded));
}

interface ResolvedTargetWorkspace {
  readonly root: string;
  readonly sourcesRelative: string;
}

type TargetWorkspaceRead =
  | { readonly ok: true; readonly value: ResolvedTargetWorkspace }
  | { readonly ok: false; readonly reason: string };

/** Read a target workspace far enough to locate its sources area. */
async function readTargetWorkspace(root: string): Promise<TargetWorkspaceRead> {
  let info: Stats;
  try {
    info = await lstat(root);
  } catch {
    return { ok: false, reason: `target workspace is not there: ${root}` };
  }
  if (!info.isDirectory()) {
    return { ok: false, reason: `target workspace is not a directory: ${root}` };
  }
  try {
    const manifest = await loadManifest(root);
    const layout = resolveWorkspaceLayout(manifest);
    if (!manifest || !layout) {
      return { ok: false, reason: `target is not an Assay workspace: ${root}` };
    }
    return { ok: true, value: { root, sourcesRelative: workspaceRelativePath(layout, "sources") } };
  } catch (error) {
    if (error instanceof WorkspaceCutoverRequiredError) {
      return {
        ok: false,
        reason: `target workspace ${root} is on an older format; run \`assay update\` there first`,
      };
    }
    return {
      ok: false,
      reason: `target workspace could not be read: ${root} (${error instanceof Error ? error.message : "unknown error"})`,
    };
  }
}

export type SourceReferenceResolution =
  | { readonly ok: true; readonly home: SourceReferenceHome }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve one hop.
 *
 * The target has to be an owned Source: a shell pointing at another shell is
 * refused here and flattened by `link` instead, so no command ever walks a
 * chain it could get lost in.
 */
export async function resolveSourceReference(
  shell: SourceReferenceShell,
): Promise<SourceReferenceResolution> {
  const targetRoot = resolveRecordedWorkspace(shell.consumerRoot, shell.record.workspace);
  const workspace = await readTargetWorkspace(targetRoot);
  if (!workspace.ok) return { ok: false, reason: workspace.reason };
  const alias = slugify(shell.record.source);
  const entryRoot = path.join(workspace.value.root, workspace.value.sourcesRelative, alias);
  if (await exists(path.join(entryRoot, SOURCE_LINEAGE_FILE))) {
    const briefFile = path.join(entryRoot, SOURCE_BRIEF_FILE);
    return {
      ok: true,
      home: {
        workspaceRoot: workspace.value.root,
        alias,
        sourcesRelative: workspace.value.sourcesRelative,
        entryRoot,
        brief: (await exists(briefFile))
          ? `${workspace.value.sourcesRelative}/${alias}/${SOURCE_BRIEF_FILE}`
          : null,
      },
    };
  }
  if (await exists(path.join(entryRoot, SOURCE_REFERENCE_FILE))) {
    return {
      ok: false,
      reason: `'${alias}' in ${workspace.value.root} is itself a reference; re-run \`assay source link\` so this shell records the workspace that owns it`,
    };
  }
  return { ok: false, reason: `no source '${alias}' in ${workspace.value.root}` };
}

export function referenceForHome(
  shell: SourceReferenceShell,
  home: SourceReferenceHome,
): SourceEntryReference {
  return {
    consumerRoot: shell.consumerRoot,
    shellPath: shell.shellPath,
    workspaceRecorded: shell.record.workspace,
    homeRoot: home.workspaceRoot,
    homeAlias: home.alias,
    display: shell.display,
    brief: home.brief,
  };
}

/**
 * Where the registry currently says a Source with this alias lives.
 *
 * Attached to a broken reference's error and to `source list`, this eats most of
 * the "move the home, relink by hand" cost the design accepted — without ever
 * rebinding anything. The suggestion is a path to type, not an action taken.
 */
export async function relinkSuggestions(input: {
  readonly consumerRoot: string;
  readonly localAlias: string;
  readonly homeAlias: string;
  readonly registryFile?: string;
}): Promise<string[]> {
  let candidates: CloneRegistryEntry[];
  try {
    candidates = await findClonesByAlias(
      input.homeAlias,
      input.registryFile === undefined ? {} : { registryFile: input.registryFile },
    );
  } catch {
    return [];
  }
  return candidates.map(
    (candidate) =>
      `assay source link ${candidate.workspace} ${candidate.alias} --alias ${input.localAlias}`,
  );
}

export function brokenReferenceMessage(broken: BrokenSourceReference): string {
  const lines = [
    `source '${broken.alias}' is a broken reference to ${broken.display}: ${broken.reason}`,
  ];
  if (broken.suggestions.length > 0) {
    lines.push(`The clone registry currently lists it at: ${broken.suggestions.join(" | ")}`);
  }
  return withSemanticModel(lines.join(". "), "sourceReferenceBroken");
}

export async function describeBrokenReference(input: {
  readonly shell: SourceReferenceShell;
  readonly reason: string;
  readonly registryFile?: string;
}): Promise<BrokenSourceReference> {
  return {
    alias: input.shell.alias,
    shellPath: input.shell.shellPath,
    display: input.shell.display,
    reason: input.reason,
    workspaceRecorded: input.shell.record.workspace,
    homeAlias: input.shell.record.source,
    suggestions: await relinkSuggestions({
      consumerRoot: input.shell.consumerRoot,
      localAlias: input.shell.alias,
      homeAlias: slugify(input.shell.record.source),
      ...(input.registryFile === undefined ? {} : { registryFile: input.registryFile }),
    }),
  };
}

/** Path to record in a shell: relative when both sides share a root, else absolute. */
function recordedWorkspacePath(consumerRoot: string, homeRoot: string): string {
  const relative = path.relative(consumerRoot, homeRoot);
  if (relative === "" || path.isAbsolute(relative)) {
    return toPosixPath(homeRoot);
  }
  return toPosixPath(relative);
}

interface FlattenedChain {
  readonly root: string;
  readonly alias: string;
  readonly sourcesRelative: string;
  readonly entryRoot: string;
  readonly hops: number;
}

/**
 * Follow shells to the workspace that owns the Source.
 *
 * This runs once, at link time, and is why the runtime model is one hop: A → B
 * → C is written down as A → C. A loop is named rather than followed.
 */
async function flattenReferenceChain(
  startRoot: string,
  startAlias: string,
): Promise<FlattenedChain> {
  const visited = new Set<string>();
  let root = path.normalize(path.resolve(startRoot));
  let alias = slugify(startAlias);
  for (let hop = 0; hop < MAX_REFERENCE_HOPS; hop += 1) {
    const key = `${process.platform === "win32" ? root.toLowerCase() : root}#${alias}`;
    if (visited.has(key)) {
      throw new FrameworkError(
        `source reference chain loops back to ${alias} in ${root}; one of the shells has to point at a workspace that owns the Source`,
      );
    }
    visited.add(key);
    const workspace = await readTargetWorkspace(root);
    if (!workspace.ok) {
      throw new FrameworkNotFoundError(workspace.reason);
    }
    const entryRoot = path.join(workspace.value.root, workspace.value.sourcesRelative, alias);
    if (await exists(path.join(entryRoot, SOURCE_LINEAGE_FILE))) {
      return {
        root: workspace.value.root,
        alias,
        sourcesRelative: workspace.value.sourcesRelative,
        entryRoot,
        hops: hop,
      };
    }
    const referenceFile = path.join(entryRoot, SOURCE_REFERENCE_FILE);
    if (!(await exists(referenceFile))) {
      throw new FrameworkNotFoundError(`no source '${alias}' in ${workspace.value.root}`);
    }
    await assertThinShell(entryRoot, `${workspace.value.sourcesRelative}/${alias}`);
    const record = await readSourceReferenceRecord(referenceFile);
    root = resolveRecordedWorkspace(workspace.value.root, record.workspace);
    alias = slugify(record.source);
  }
  throw new FrameworkError(
    `source reference chain from ${startAlias} is more than ${MAX_REFERENCE_HOPS} hops deep`,
  );
}

/** Every shell in a workspace, with whatever it resolves to right now. */
export async function listSourceReferenceShells(input: {
  readonly root: string;
  readonly sourcesRelative: string;
}): Promise<SourceReferenceShell[]> {
  const sourcesRoot = path.join(input.root, input.sourcesRelative);
  if (!(await exists(sourcesRoot))) return [];
  const shells: SourceReferenceShell[] = [];
  for (const entry of await readdir(sourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const shell = await readSourceReferenceShell({
      consumerRoot: input.root,
      sourcesRelative: input.sourcesRelative,
      alias: entry.name,
    });
    if (shell) shells.push(shell);
  }
  return shells.sort((a, b) => a.alias.localeCompare(b.alias));
}

export interface SourceLinkOptions {
  readonly root: string;
  /** Target workspace root. Omitted, the clone registry is consulted instead. */
  readonly workspace?: string;
  readonly source: string;
  readonly alias?: string;
  readonly now?: Date;
  readonly registryFile?: string;
}

export interface SourceLinkResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  readonly referenceFile: string;
  readonly home: {
    readonly workspace: string;
    readonly workspaceRecorded: string;
    readonly alias: string;
    readonly path: string;
  };
  /** Home-relative `brief.md`, or null when the home keeps none. */
  readonly brief: string | null;
  /** Set when the requested target was itself a reference and got flattened. */
  readonly flattenedHops: number;
  /** Local alias already pointing at this home; the link was not created again. */
  readonly alreadyLinkedAs: string | null;
  readonly created: boolean;
  readonly eventFile: string | null;
  readonly notices: readonly string[];
}

async function consumerSourcesRelative(root: string): Promise<string> {
  const manifest = await loadManifest(root);
  const layout = resolveWorkspaceLayout(manifest);
  if (!manifest || !layout) {
    throw new FrameworkNotFoundError(`No Assay workspace at ${root}.`);
  }
  return workspaceRelativePath(layout, "sources");
}

/**
 * Resolve a bare `source link <alias>` through the registry.
 *
 * One verified candidate links directly; several are listed with their exact
 * paths and the command stops. Guessing between two homes is the one thing a
 * hint must not do.
 */
async function workspaceFromRegistry(
  alias: string,
  options: SourceLinkOptions,
): Promise<{ readonly workspace: string; readonly notice: string }> {
  const candidates = await findClonesByAlias(
    alias,
    options.registryFile === undefined ? {} : { registryFile: options.registryFile },
  );
  if (candidates.length === 0) {
    throw new FrameworkNotFoundError(
      `no workspace given and the clone registry knows no home for '${alias}'; pass the target workspace: assay source link <target-workspace> ${alias}`,
    );
  }
  const first = candidates[0];
  if (candidates.length > 1 || !first) {
    throw new FrameworkError(
      [
        `the clone registry knows ${candidates.length} homes for '${alias}'; name the one you mean:`,
        ...candidates.map((candidate) => `  assay source link ${candidate.workspace} ${alias}`),
      ].join("\n"),
    );
  }
  return {
    workspace: first.workspace,
    notice: `Registry: resolved '${alias}' to ${first.workspace}`,
  };
}

export async function linkSource(options: SourceLinkOptions): Promise<SourceLinkResult> {
  const root = path.resolve(options.root);
  const sourcesRelative = await consumerSourcesRelative(root);
  return withWorkspaceMutationCoordination(root, () =>
    linkSourceUnlocked(options, root, sourcesRelative),
  );
}

async function linkSourceUnlocked(
  options: SourceLinkOptions,
  root: string,
  sourcesRelative: string,
): Promise<SourceLinkResult> {
  const now = options.now ?? new Date();
  const notices: string[] = [];
  const requestedAlias = slugify(options.source);
  let workspaceArgument = options.workspace;
  if (workspaceArgument === undefined) {
    const resolved = await workspaceFromRegistry(requestedAlias, options);
    workspaceArgument = resolved.workspace;
    notices.push(resolved.notice);
  }

  const chain = await flattenReferenceChain(
    resolveRecordedWorkspace(root, workspaceArgument),
    requestedAlias,
  );
  if (chain.hops > 0) {
    notices.push(
      `Flattened: the target was itself a reference; this shell records the workspace that owns '${chain.alias}'.`,
    );
  }
  if (samePathValue(chain.root, root)) {
    throw new FrameworkError(
      `'${chain.alias}' is owned by this workspace; use it directly instead of linking to it`,
    );
  }

  const localAlias = slugify(options.alias ?? chain.alias);
  const shellPath = `${sourcesRelative}/${localAlias}`;
  const entryRoot = path.join(root, sourcesRelative, localAlias);
  const referenceRecorded = recordedWorkspacePath(root, chain.root);
  const briefFile = path.join(chain.entryRoot, SOURCE_BRIEF_FILE);
  const brief = (await exists(briefFile))
    ? `${chain.sourcesRelative}/${chain.alias}/${SOURCE_BRIEF_FILE}`
    : null;
  const home = {
    workspace: chain.root,
    workspaceRecorded: referenceRecorded,
    alias: chain.alias,
    path: chain.entryRoot,
  };

  // Linking something already linked is a notice, not a failure: the workspace
  // is in the state the command asked for. An explicit `--alias` is the
  // exception — a second local name for one home is a legitimate thing to want,
  // and asking for it by name is how you say so — so that case reports the
  // existing link and still creates the new name.
  const existingShells = await listSourceReferenceShells({ root, sourcesRelative });
  for (const shell of existingShells) {
    const resolution = await resolveSourceReference(shell);
    if (!resolution.ok) continue;
    if (
      !(
        samePathValue(resolution.home.workspaceRoot, chain.root) &&
        resolution.home.alias === chain.alias
      )
    ) {
      continue;
    }
    if (shell.alias !== localAlias && options.alias !== undefined) {
      notices.push(
        `Also linked as '${shell.alias}' -> ${shell.display}; both names reach the same Source home.`,
      );
      continue;
    }
    notices.push(
      shell.alias === localAlias
        ? `Already linked: '${shell.alias}' already points at ${shell.display}.`
        : `Already linked as '${shell.alias}' -> ${shell.display}; nothing was created.`,
    );
    return {
      root,
      alias: shell.alias,
      path: shell.shellPath,
      referenceFile: `${shell.shellPath}/${SOURCE_REFERENCE_FILE}`,
      home,
      brief,
      flattenedHops: chain.hops,
      alreadyLinkedAs: shell.alias,
      created: false,
      eventFile: null,
      notices,
    };
  }

  if (await exists(entryRoot)) {
    throw new FrameworkAlreadyExistsError(
      `sources/${localAlias} already exists in this workspace: ${shellPath}. Pass --alias to link the same Source under another local name.`,
    );
  }

  const record: SourceReferenceRecord = {
    schema: SOURCE_REFERENCE_SCHEMA,
    workspace: referenceRecorded,
    source: chain.alias,
  };
  await mkdir(entryRoot, { recursive: true });
  await writeFile(path.join(entryRoot, SOURCE_REFERENCE_FILE), stringifyYaml(record), "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "source.linked",
      source: localAlias,
      path: shellPath,
      home_workspace: chain.root,
      home_source: chain.alias,
      workspace_recorded: referenceRecorded,
      flattened_hops: chain.hops,
    },
    now,
  );
  // The home is what the registry indexes, and a link is proof someone reached
  // for it; recording it here is how a later `source add` of the same material
  // can be talked out of a second clone.
  await recordSourceClone({
    workspace: chain.root,
    alias: chain.alias,
    origin: await homeOriginUri(chain.entryRoot),
    now,
    ...(options.registryFile === undefined ? {} : { registryFile: options.registryFile }),
  });

  return {
    root,
    alias: localAlias,
    path: shellPath,
    referenceFile: `${shellPath}/${SOURCE_REFERENCE_FILE}`,
    home,
    brief,
    flattenedHops: chain.hops,
    alreadyLinkedAs: null,
    created: true,
    eventFile: relativeDisplayPath(eventFile, root),
    notices,
  };
}

/** The home's own `source_uri`, read straight off its lineage file for the cache. */
async function homeOriginUri(entryRoot: string): Promise<string> {
  try {
    const parsed = parseYaml(await readFile(path.join(entryRoot, SOURCE_LINEAGE_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const uri = (parsed as Record<string, unknown>).source_uri;
      if (typeof uri === "string") return uri;
    }
  } catch {
    // The cache does without it.
  }
  return "";
}

function samePathValue(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface SourceUnlinkOptions {
  readonly root: string;
  readonly alias: string;
  readonly now?: Date;
}

export interface SourceUnlinkResult {
  readonly root: string;
  readonly alias: string;
  readonly path: string;
  /** What the shell pointed at, so the output can say what was forgotten. */
  readonly display: string;
  /** Where the shell said the home was; named even when it is not there. */
  readonly homeWorkspace: string;
  /** False when the recorded home could not be found, so nothing was touched. */
  readonly homeReachable: boolean;
  readonly homeAlias: string;
  readonly eventFile: string;
}

export async function unlinkSource(options: SourceUnlinkOptions): Promise<SourceUnlinkResult> {
  const root = path.resolve(options.root);
  const sourcesRelative = await consumerSourcesRelative(root);
  return withWorkspaceMutationCoordination(root, () =>
    unlinkSourceUnlocked(options, root, sourcesRelative),
  );
}

/**
 * Forget a local name.
 *
 * The one operation that must not follow the reference. It removes the pointer
 * file and the directory it was alone in — never a recursive delete, so even a
 * shell that somehow acquired content cannot be destroyed from here — and the
 * shared material is not touched, read, or locked.
 */
async function unlinkSourceUnlocked(
  options: SourceUnlinkOptions,
  root: string,
  sourcesRelative: string,
): Promise<SourceUnlinkResult> {
  const now = options.now ?? new Date();
  const alias = slugify(options.alias);
  const shellPath = `${sourcesRelative}/${alias}`;
  const entryRoot = path.join(root, sourcesRelative, alias);
  const referenceFile = path.join(entryRoot, SOURCE_REFERENCE_FILE);
  if (!(await exists(referenceFile))) {
    if (await exists(path.join(entryRoot, SOURCE_LINEAGE_FILE))) {
      throw new FrameworkError(
        withSemanticModel(
          `source '${alias}' is owned by this workspace, so there is no reference to unlink`,
          "sourceOwnedHere",
        ),
      );
    }
    throw new FrameworkNotFoundError(`no source reference found: ${shellPath}`);
  }

  const record = await readSourceReferenceRecord(referenceFile);
  const display = sourceReferenceDisplay(record);
  const homeRoot = resolveRecordedWorkspace(root, record.workspace);
  await rm(referenceFile, { force: false });
  const remaining = await readdir(entryRoot);
  // rmdir, not a recursive rm: a shell that somehow holds anything else keeps
  // its directory rather than being cleared out from the consumer side.
  if (remaining.length === 0) {
    await rmdir(entryRoot);
  }

  const eventFile = await appendEvent(
    root,
    {
      event: "source.unlinked",
      source: alias,
      path: shellPath,
      home_workspace: homeRoot,
      home_source: record.source,
      remaining_files: remaining.length,
    },
    now,
  );
  return {
    root,
    alias,
    path: shellPath,
    display,
    homeWorkspace: homeRoot,
    homeReachable: await exists(homeRoot),
    homeAlias: record.source,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export interface SourceHomeResult {
  readonly root: string;
  readonly alias: string;
  readonly relation: "owned" | "ref";
  /** Workspace that owns the Source; the current one for an owned Source. */
  readonly homeWorkspace: string;
  readonly homeAlias: string;
  /** Absolute path of the Source directory in its home. */
  readonly homePath: string;
  readonly workspaceRecorded: string | null;
  readonly display: string | null;
  readonly brief: string | null;
}

/** Where a local alias actually resolves, without reading the Source itself. */
export async function resolveSourceHome(options: {
  readonly root: string;
  readonly alias: string;
  readonly registryFile?: string;
}): Promise<SourceHomeResult> {
  const root = path.resolve(options.root);
  const sourcesRelative = await consumerSourcesRelative(root);
  const alias = slugify(options.alias);
  const entryRoot = path.join(root, sourcesRelative, alias);
  if (await exists(path.join(entryRoot, SOURCE_LINEAGE_FILE))) {
    const briefFile = path.join(entryRoot, SOURCE_BRIEF_FILE);
    return {
      root,
      alias,
      relation: "owned",
      homeWorkspace: root,
      homeAlias: alias,
      homePath: entryRoot,
      workspaceRecorded: null,
      display: null,
      brief: (await exists(briefFile)) ? `${sourcesRelative}/${alias}/${SOURCE_BRIEF_FILE}` : null,
    };
  }
  const shell = await readSourceReferenceShell({ consumerRoot: root, sourcesRelative, alias });
  if (!shell) {
    throw new FrameworkNotFoundError(`source not found: ${alias}`);
  }
  const resolution = await resolveSourceReference(shell);
  if (!resolution.ok) {
    throw new FrameworkNotFoundError(
      brokenReferenceMessage(
        await describeBrokenReference({
          shell,
          reason: resolution.reason,
          ...(options.registryFile === undefined ? {} : { registryFile: options.registryFile }),
        }),
      ),
    );
  }
  return {
    root,
    alias,
    relation: "ref",
    homeWorkspace: resolution.home.workspaceRoot,
    homeAlias: resolution.home.alias,
    homePath: resolution.home.entryRoot,
    workspaceRecorded: shell.record.workspace,
    display: shell.display,
    brief: resolution.home.brief,
  };
}
