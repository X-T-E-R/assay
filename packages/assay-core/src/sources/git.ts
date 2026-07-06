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

export async function checkoutGitRef(checkout: string, ref: string): Promise<void> {
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

export async function cloneGitSource(
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

export async function refreshLocalGitCheckout(
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

export async function refreshRemoteGitCheckout(
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
