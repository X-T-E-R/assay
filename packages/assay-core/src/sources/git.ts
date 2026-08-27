import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import { FrameworkError } from "../errors.js";
import { toPosixPath } from "../serialization.js";
import type { SourceLineage, SourceVcsMetadata } from "../sources.js";

export type SourceSyncGitTarget =
  | { readonly kind: "branch"; readonly value: string }
  | { readonly kind: "ref"; readonly value: string };

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

/**
 * Reject a caller-supplied value before it reaches a `git` argument list.
 *
 * Git parses any argument that starts with `-` as an option, so a ref, branch,
 * or remote URI such as `--upload-pack=<command>` would run that command even
 * though the surrounding invocation fails. Values are also rejected when they
 * are empty or carry NUL/newline characters, which cannot appear in a Git ref
 * or remote and only show up in crafted input.
 *
 * The call sites additionally pass `--end-of-options` / `--` so an option-like
 * value can never be reinterpreted, but validation is what makes the refusal
 * explicit and testable.
 */
export function assertGitArgumentValue(label: string, value: string): void {
  if (value === "") {
    throw new FrameworkError(`${label} must not be empty`, { code: "IO_ERROR" });
  }
  if (value.startsWith("-")) {
    throw new FrameworkError(
      `${label} must not start with '-' (git would parse '${value}' as an option): ${value}`,
      { code: "IO_ERROR" },
    );
  }
  if (/[\0\r\n]/.test(value)) {
    throw new FrameworkError(`${label} must not contain control characters: ${value}`, {
      code: "IO_ERROR",
    });
  }
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

export function assertManagedCheckout(entryRoot: string, checkout: string): void {
  const relative = toPosixPath(path.relative(path.resolve(entryRoot), path.resolve(checkout)));
  if (relative !== "checkout") {
    throw new FrameworkError(`refusing to mutate unmanaged checkout path: ${checkout}`, {
      code: "IO_ERROR",
    });
  }
}

export async function isGitCheckout(checkout: string): Promise<boolean> {
  return exists(path.join(checkout, ".git"));
}

/**
 * Files Git currently tracks in a checkout, as the denominator for grading how
 * much of a source moved. Null when the count cannot be read; callers grade
 * conservatively rather than inventing a ratio.
 */
export async function countTrackedFiles(checkout: string): Promise<number | null> {
  if (!(await isGitCheckout(checkout))) {
    return null;
  }
  const listed = await tryGit(checkout, ["ls-files"]);
  if (listed.exitCode !== 0) {
    return null;
  }
  return listed.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

export interface CheckoutPathChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * Added, removed, and modified paths between two commits, straight from Git.
 *
 * This is the diff a Source needs, and Git already has it: no tree hashing, no
 * stored manifest, and it works for any two commits the checkout still holds.
 * Null means the comparison could not be made (unknown commit, shallow clone),
 * never "nothing changed".
 */
export async function changedPathsBetween(
  checkout: string,
  from: string,
  to: string,
): Promise<CheckoutPathChanges | null> {
  try {
    assertGitArgumentValue("diff base", from);
    assertGitArgumentValue("diff target", to);
  } catch {
    return null;
  }
  const result = await tryGit(checkout, [
    "diff",
    "--name-status",
    "--end-of-options",
    from,
    to,
    "--",
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [status, ...rest] = line.split("\t");
    const target = unquoteGitPath((rest.at(-1) ?? "").trim());
    if (target === "" || status === undefined) continue;
    if (status.startsWith("A")) added.push(target);
    else if (status.startsWith("D")) removed.push(target);
    else changed.push(target);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/**
 * Paths named by `git status --porcelain` output. Rename entries carry
 * `old -> new`; the new path is the one that exists on disk. Git quotes paths
 * that contain unusual characters, so a quoted value is unquoted before use.
 */
function porcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const raw = line.length > 3 ? line.slice(3) : line.trim();
    const arrow = raw.indexOf(" -> ");
    const value = (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim();
    paths.push(unquoteGitPath(value));
  }
  return paths;
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
    return value;
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

/**
 * Cheap local facts about a managed checkout: where its HEAD is and whether
 * anything in it is uncommitted. This is the zero-network half of upstream
 * drift detection, so it runs on every `assay status` and must stay to a
 * couple of local `git` calls — no fetch, no tree hashing.
 *
 * Returns null when the path is not a Git checkout, which is the signal
 * callers use to report "not checked" instead of inventing a comparison.
 */
export interface CheckoutLocalSignals {
  readonly head: string;
  readonly branch: string | null;
  readonly dirtyPaths: readonly string[];
}

export async function readCheckoutLocalSignals(
  checkout: string,
): Promise<CheckoutLocalSignals | null> {
  if (!(await isGitCheckout(checkout))) {
    return null;
  }
  const head = await resolveCommit(checkout, "HEAD");
  if (head === null) {
    return null;
  }
  const status = await tryGit(checkout, ["status", "--porcelain"]);
  return {
    head,
    branch: await currentCheckoutBranch(checkout),
    dirtyPaths: status.exitCode === 0 ? porcelainPaths(status.stdout) : [],
  };
}

/**
 * Repository-relative paths that differ between two commits, or null when the
 * comparison cannot be made (an unknown commit, a shallow clone that lacks the
 * older object). Null means "unknown", never "nothing changed".
 */
export async function diffPathsBetween(
  checkout: string,
  from: string,
  to: string,
): Promise<string[] | null> {
  try {
    assertGitArgumentValue("diff base", from);
    assertGitArgumentValue("diff target", to);
  } catch {
    return null;
  }
  const result = await tryGit(checkout, [
    "diff",
    "--name-only",
    "--end-of-options",
    from,
    to,
    "--",
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(unquoteGitPath);
}

/** Number of commits `to` has that `from` does not, or null when unknown. */
export async function countCommitsBetween(
  checkout: string,
  from: string,
  to: string,
): Promise<number | null> {
  try {
    assertGitArgumentValue("range base", from);
    assertGitArgumentValue("range target", to);
  } catch {
    return null;
  }
  const result = await tryGit(checkout, [
    "rev-list",
    "--count",
    "--end-of-options",
    `${from}..${to}`,
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

export interface RemoteHeadResult {
  readonly commit: string | null;
  readonly ref: string | null;
  /** Why the remote could not be read this run; null on success. */
  readonly reason: string | null;
}

/** Milliseconds a status-time fetch may take before it is treated as a failure. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetch and report the remote tip for a managed checkout's current branch.
 *
 * Everything about this call is non-interactive and bounded: credential
 * prompts are disabled and the fetch is given a timeout, because it runs from
 * `assay status --fetch` where a hung network call would be worse than an
 * unanswered question. Every failure is returned as a reason string; callers
 * annotate the source and carry on rather than failing the command.
 */
export async function fetchRemoteHead(checkout: string): Promise<RemoteHeadResult> {
  if (!(await isGitCheckout(checkout))) {
    return { commit: null, ref: null, reason: "not a Git checkout" };
  }
  const remote = await gitRemoteOrigin(checkout);
  if (!remote) {
    return { commit: null, ref: null, reason: "no 'origin' remote configured" };
  }

  const fetched = await execa("git", ["fetch", "--prune", "--quiet", "origin"], {
    cwd: checkout,
    reject: false,
    timeout: FETCH_TIMEOUT_MS,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
      GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    },
  });
  if ((fetched.exitCode ?? 1) !== 0) {
    return {
      commit: null,
      ref: null,
      reason: `git fetch failed: ${firstLine(fetched.stderr || fetched.stdout) || "no output"}`,
    };
  }

  const branch = await currentCheckoutBranch(checkout);
  const candidates = branch
    ? [`refs/remotes/origin/${branch}`, "refs/remotes/origin/HEAD"]
    : ["refs/remotes/origin/HEAD"];
  for (const candidate of candidates) {
    const commit = await resolveCommit(checkout, candidate);
    if (commit) {
      return { commit, ref: candidate, reason: null };
    }
  }
  return { commit: null, ref: null, reason: "no matching remote branch to compare" };
}

/**
 * Commit a ref points at, or null when it does not resolve.
 *
 * `rev-parse` does not accept `--end-of-options` — it echoes the marker back as
 * an unrecognized argument — so an option-like ref is rejected up front
 * instead, and the output is required to be a bare object name. Returning
 * anything else would put a junk revision into a later `diff` or `rev-list`,
 * where it fails silently and reads as "nothing changed".
 */
async function resolveCommit(checkout: string, ref: string): Promise<string | null> {
  try {
    assertGitArgumentValue("git ref", ref);
  } catch {
    return null;
  }
  const resolved = await tryGit(checkout, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const value = resolved.stdout.trim();
  return resolved.exitCode === 0 && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, 160);
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

export async function syncTargetForCheckout(
  options: { readonly branch?: string; readonly ref?: string },
  checkout: string,
  lineage: SourceLineage,
): Promise<SourceSyncGitTarget | null> {
  if (options.ref) {
    assertGitArgumentValue("source ref", options.ref);
    return { kind: "ref", value: options.ref };
  }
  if (options.branch) {
    assertGitArgumentValue("source branch", options.branch);
    return { kind: "branch", value: options.branch };
  }

  const checkoutBranch = await currentCheckoutBranch(checkout);
  if (checkoutBranch) {
    return { kind: "branch", value: checkoutBranch };
  }

  if (lineage.checkout?.ref && lineage.checkout.ref !== "HEAD") {
    assertGitArgumentValue("recorded checkout ref", lineage.checkout.ref);
    return { kind: "branch", value: lineage.checkout.ref };
  }

  return null;
}

async function gitRemoteOrigin(checkout: string): Promise<string | null> {
  const remote = await tryGit(checkout, ["config", "--get", "remote.origin.url"]);
  return remote.exitCode === 0 && remote.stdout.trim() !== "" ? remote.stdout.trim() : null;
}

export async function checkoutGitRef(checkout: string, ref: string): Promise<void> {
  assertGitArgumentValue("checkout ref", ref);
  // `--end-of-options` keeps a ref that resembles an option
  // (`--upload-pack=<command>`) from being parsed as one. Branch resolution is
  // unchanged: git still prefers a matching branch over a pathspec.
  const checkedOut = await tryGit(checkout, ["checkout", "--end-of-options", ref]);
  if (checkedOut.exitCode === 0) {
    return;
  }

  const fetched = await tryGit(checkout, ["fetch", "origin", "--end-of-options", ref]);
  if (fetched.exitCode === 0) {
    await runGit(checkout, ["checkout", "--end-of-options", "FETCH_HEAD"], "git checkout");
    return;
  }

  throw new FrameworkError(
    `git checkout failed: ${gitCommandOutput(checkedOut)}; git fetch failed: ${gitCommandOutput(fetched)}`,
    { code: "IO_ERROR" },
  );
}

export async function cloneGitSource(
  source: string,
  checkout: string,
  target: SourceSyncGitTarget | null,
  shallow: boolean,
): Promise<void> {
  assertGitArgumentValue("source uri", source);
  await mkdir(path.dirname(checkout), { recursive: true });
  const args = ["clone"];
  if (shallow) {
    args.push("--depth", "1");
  }
  if (target?.kind === "branch") {
    assertGitArgumentValue("source branch", target.value);
    args.push("--branch", target.value);
  }
  // `--` bounds the positional repository/directory pair, so a source URI that
  // resembles an option cannot become one.
  args.push("--", source, checkout);
  await runGit(path.dirname(checkout), args, "git clone");

  if (target?.kind === "ref") {
    await checkoutGitRef(checkout, target.value);
  }
}

/**
 * Advisory strings a checkout update can produce. They are recorded on the
 * observation; none of them stops the command.
 */
export const CHECKOUT_ADVISORY_LOCAL_MODIFICATIONS = "observed with local modifications";
export const CHECKOUT_ADVISORY_NOT_FAST_FORWARD =
  "upstream moved but this checkout could not fast-forward; local state kept";

export interface ManagedCheckoutUpdate {
  /** What the update noticed, in the order a reader wants it. */
  readonly advisories: readonly string[];
  /** True when the working tree was actually moved. */
  readonly moved: boolean;
}

export interface UpdateManagedCheckoutOptions {
  readonly entryRoot: string;
  readonly sourceUri: string;
  /** Where the caller asked to be; null follows the checkout's own branch. */
  readonly target: SourceSyncGitTarget | null;
  /** True when the user named the branch or ref on this run. */
  readonly requested: boolean;
}

/**
 * Bring a managed Git checkout up to date without ever discarding bytes.
 *
 * Assay used to refuse a dirty checkout and then `reset --hard` a clean one.
 * Both halves were wrong for a single-user evidence workbench: editing two
 * lines of upstream to see what breaks is the normal way to read it, and a
 * refusal only trains everyone to work around the tool. So this fetches (a
 * read), and moves the working tree only through operations Git itself guards:
 * `merge --ff-only` and `checkout`, both of which stop rather than overwrite.
 * What could not be done becomes an advisory the observation records.
 *
 * Byte-loss protection therefore lives where it already worked — in Git — and
 * Assay's job is to say what it saw.
 */
export async function updateManagedCheckout(
  options: UpdateManagedCheckoutOptions,
): Promise<ManagedCheckoutUpdate> {
  const checkout = path.join(options.entryRoot, "checkout");
  assertManagedCheckout(options.entryRoot, checkout);
  if (!(await isGitCheckout(checkout))) {
    return { advisories: [], moved: false };
  }

  const advisories: string[] = [];
  await alignCheckoutOrigin(checkout, options.sourceUri);
  const dirty = await checkoutIsDirty(checkout);
  if (dirty) {
    advisories.push(CHECKOUT_ADVISORY_LOCAL_MODIFICATIONS);
  }

  const fetchNote = await fetchForTarget(checkout, options.target);
  if (fetchNote) {
    advisories.push(fetchNote);
  }

  // An explicit `--branch`/`--ref` is a request to be somewhere else, so Git's
  // own refusal is the answer the user needs to see. Following the checkout's
  // current branch is routine, so a blocked update is recorded instead.
  if (options.requested && options.target) {
    if (options.target.kind === "ref") {
      await checkoutGitRef(checkout, options.target.value);
    } else {
      await checkoutTrackingBranch(checkout, options.target.value);
    }
  }

  const branch = await currentCheckoutBranch(checkout);
  if (!branch) {
    return { advisories, moved: false };
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  if ((await resolveCommit(checkout, remoteRef)) === null) {
    return { advisories, moved: false };
  }
  const before = await resolveCommit(checkout, "HEAD");
  const merged = await tryGit(checkout, ["merge", "--ff-only", "--end-of-options", remoteRef]);
  if (merged.exitCode !== 0) {
    if ((await resolveCommit(checkout, remoteRef)) !== before) {
      advisories.push(CHECKOUT_ADVISORY_NOT_FAST_FORWARD);
    }
    return { advisories, moved: false };
  }
  return { advisories, moved: (await resolveCommit(checkout, "HEAD")) !== before };
}

async function alignCheckoutOrigin(checkout: string, sourceUri: string): Promise<void> {
  if (sourceUri === "") return;
  assertGitArgumentValue("source uri", sourceUri);
  const remote = await gitRemoteOrigin(checkout);
  if (remote === sourceUri) return;
  await runGit(
    checkout,
    remote
      ? ["remote", "set-url", "origin", "--end-of-options", sourceUri]
      : ["remote", "add", "origin", "--end-of-options", sourceUri],
    remote ? "git remote set-url" : "git remote add",
  );
}

async function checkoutIsDirty(checkout: string): Promise<boolean> {
  const status = await tryGit(checkout, ["status", "--porcelain"]);
  return status.exitCode === 0 && status.stdout.trim() !== "";
}

/** Fetch for the requested target, returning an advisory when it could not run. */
async function fetchForTarget(
  checkout: string,
  target: SourceSyncGitTarget | null,
): Promise<string | null> {
  if (!(await gitRemoteOrigin(checkout))) {
    return "upstream not checked (no 'origin' remote configured)";
  }
  const args =
    target?.kind === "branch"
      ? [
          "fetch",
          "--prune",
          "origin",
          "--end-of-options",
          `+refs/heads/${target.value}:refs/remotes/origin/${target.value}`,
        ]
      : ["fetch", "--prune", "origin"];
  if (target?.kind === "branch") {
    assertGitArgumentValue("source branch", target.value);
  }
  const fetched = await tryGit(checkout, args);
  return fetched.exitCode === 0
    ? null
    : `upstream not checked (git fetch failed: ${firstLine(gitCommandOutput(fetched))})`;
}

/**
 * Put the checkout on `branch`, creating it from `origin/<branch>` when it does
 * not exist locally. `git checkout` refuses when the move would overwrite
 * uncommitted work, and that refusal is the protection this path relies on.
 */
async function checkoutTrackingBranch(checkout: string, branch: string): Promise<void> {
  assertGitArgumentValue("source branch", branch);
  if ((await currentCheckoutBranch(checkout)) === branch) {
    return;
  }
  const local = await tryGit(checkout, ["checkout", "--end-of-options", branch]);
  if (local.exitCode === 0) {
    return;
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  if ((await resolveCommit(checkout, remoteRef)) === null) {
    throw new FrameworkError(`git checkout failed: ${gitCommandOutput(local)}`, {
      code: "IO_ERROR",
    });
  }
  await runGit(checkout, ["checkout", "-b", branch, "--end-of-options", remoteRef], "git checkout");
}

/** Clone a Git source into the managed checkout path when it is not there yet. */
export async function ensureGitCheckout(
  entryRoot: string,
  sourceUri: string,
  target: SourceSyncGitTarget | null,
  shallow: boolean,
): Promise<boolean> {
  const checkout = path.join(entryRoot, "checkout");
  assertManagedCheckout(entryRoot, checkout);
  if (await isGitCheckout(checkout)) {
    return false;
  }
  await rm(checkout, { recursive: true, force: true });
  await cloneGitSource(sourceUri, checkout, target, shallow);
  return true;
}

export async function collectGitMetadata(
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
