import path from "node:path";

import {
  type DonorSourceMapping,
  donorLocatorMatchesPath,
  listDonorSourceMappings,
} from "./donors/index.js";
import {
  type SourceChangeClass,
  type SourceKind,
  type SourceStatusEntry,
  getSourceStatus,
} from "./sources.js";
import {
  countCommitsBetween,
  diffPathsBetween,
  fetchRemoteHead,
  readCheckoutLocalSignals,
} from "./sources/git.js";

/**
 * What a source's managed checkout shows relative to what Assay recorded.
 *
 * - `unchanged`: the checkout is where the latest observation says it is.
 * - `local-modified`: uncommitted edits nobody recorded.
 * - `local-drift`: the checkout is on a commit no observation recorded.
 * - `upstream-ahead`: the remote moved past the recorded commit.
 * - `not-checked`: no cheap signal exists (no Git checkout, or no recorded
 *   commit to compare against).
 */
export type UpstreamSignal =
  | "unchanged"
  | "local-modified"
  | "local-drift"
  | "upstream-ahead"
  | "not-checked";

export interface UpstreamImpact {
  /** Donor mappings whose source locator the changed paths touch. */
  readonly mappings: number;
  readonly adoptions: readonly string[];
}

export interface UpstreamSourceState {
  readonly alias: string;
  readonly path: string;
  readonly kind: SourceKind;
  readonly signal: UpstreamSignal;
  /** One line saying what this source shows, ready to print. */
  readonly summary: string;
  readonly recordedCommit: string | null;
  readonly headCommit: string | null;
  /** Commits the checkout has that the recorded observation does not. */
  readonly localCommitsAhead: number | null;
  readonly dirtyFiles: number;
  /** Commits the remote has that the recorded commit does not; null when unchecked. */
  readonly upstreamCommits: number | null;
  /** Why the remote comparison did not happen or could not complete. */
  readonly upstreamNote: string | null;
  /** Files the comparison found changed, when the paths could be listed. */
  readonly changedFiles: number;
  readonly impact: UpstreamImpact | null;
}

export interface UpstreamStatus {
  /** True when this run was allowed to touch the network. */
  readonly fetched: boolean;
  readonly total: number;
  readonly changedSources: number;
  readonly sources: readonly UpstreamSourceState[];
  /** Concrete command that resolves the most actionable finding, if any. */
  readonly nextCommand: string | null;
}

export interface CollectUpstreamStatusOptions {
  readonly root: string;
  /** Compare against the remote too. Off by default: `status` stays local. */
  readonly fetch?: boolean;
}

/**
 * Answer "did anything upstream move, and does it reach anything we adopted?"
 * for every living source, cheaply enough to run on every `assay status`.
 *
 * Three layers, split by cost:
 *
 * - L1 compares the checkout's HEAD and working tree against the commit the
 *   latest observation recorded. Local reads only, always on. This is also the
 *   only place a managed checkout that was edited by hand becomes visible:
 *   `sync` guards against it, but sync is the command nobody runs.
 * - L2 fetches and compares the remote tip. Only with `fetch`, never implicit,
 *   and a failure annotates the source instead of failing the command.
 * - L3 intersects the changed paths with the source locators of the
 *   workspace's donor adoptions, turning "the source moved" into "it reaches N
 *   places you adopted".
 *
 * Non-Git checkouts report "not checked (no cheap signal)" rather than hashing
 * their trees: full fingerprint comparison stays in `sync`, where the cost is
 * already being paid.
 */
export async function collectUpstreamStatus(
  options: CollectUpstreamStatusOptions,
): Promise<UpstreamStatus> {
  const root = path.resolve(options.root);
  const fetch = options.fetch === true;
  const { sources } = await getSourceStatus({ root });
  if (sources.length === 0) {
    return { fetched: fetch, total: 0, changedSources: 0, sources: [], nextCommand: null };
  }

  const donorMappings = await listDonorSourceMappings(root);
  const states = await Promise.all(
    sources.map((source) => inspectSource(root, source, donorMappings, fetch)),
  );

  const changedSources = states.filter((state) => isChanged(state)).length;
  // Only an upstream move has a command that fixes it, and only while the
  // checkout is otherwise clean: `source sync` refuses a checkout holding
  // unrecorded work, so naming it there would send the reader into an error.
  // `upstream-ahead` is exactly that state.
  const ahead = states.find((state) => state.signal === "upstream-ahead");
  return {
    fetched: fetch,
    total: states.length,
    changedSources,
    sources: states,
    nextCommand: ahead ? `assay source sync ${ahead.alias}` : null,
  };
}

function isChanged(state: UpstreamSourceState): boolean {
  return state.signal !== "unchanged" && state.signal !== "not-checked";
}

async function inspectSource(
  root: string,
  source: SourceStatusEntry,
  donorMappings: readonly DonorSourceMapping[],
  fetch: boolean,
): Promise<UpstreamSourceState> {
  const checkout = path.join(root, source.path, "checkout");
  const recordedCommit = source.checkout?.commit ?? source.vcs?.commit ?? null;
  const signals = await readCheckoutLocalSignals(checkout);

  if (!signals) {
    return baseState(source, {
      signal: "not-checked",
      summary: "not checked (no cheap signal)",
      recordedCommit,
    });
  }
  if (!recordedCommit) {
    return baseState(source, {
      signal: "not-checked",
      summary: "not checked (no recorded commit to compare)",
      recordedCommit,
      headCommit: signals.head,
    });
  }

  const changedPaths = new Set<string>(signals.dirtyPaths);
  const localDrift = signals.head !== recordedCommit;
  const localCommitsAhead = localDrift
    ? await countCommitsBetween(checkout, recordedCommit, signals.head)
    : 0;
  if (localDrift) {
    for (const changed of (await diffPathsBetween(checkout, recordedCommit, signals.head)) ?? []) {
      changedPaths.add(changed);
    }
  }

  let upstreamCommits: number | null = null;
  let upstreamNote: string | null = null;
  if (fetch) {
    const remote = await fetchRemoteHead(checkout);
    if (remote.commit === null) {
      upstreamNote = remote.reason ?? "upstream could not be read";
    } else if (remote.commit === recordedCommit) {
      upstreamCommits = 0;
    } else {
      upstreamCommits = await countCommitsBetween(checkout, recordedCommit, remote.commit);
      if (upstreamCommits === null) {
        // A shallow clone cannot count the range; the differing tip is still
        // proof the remote moved.
        upstreamCommits = 1;
      }
      for (const changed of (await diffPathsBetween(checkout, recordedCommit, remote.commit)) ??
        []) {
        changedPaths.add(changed);
      }
    }
  }

  const impact = impactFor(source.alias, [...changedPaths], donorMappings);
  const dirtyFiles = signals.dirtyPaths.length;
  const signal: UpstreamSignal =
    dirtyFiles > 0
      ? "local-modified"
      : localDrift
        ? "local-drift"
        : (upstreamCommits ?? 0) > 0
          ? "upstream-ahead"
          : "unchanged";

  return {
    alias: source.alias,
    path: source.path,
    kind: source.kind,
    signal,
    summary: summarize({
      dirtyFiles,
      localDrift,
      localCommitsAhead,
      upstreamCommits,
      upstreamNote,
      fetch,
    }),
    recordedCommit,
    headCommit: signals.head,
    localCommitsAhead,
    dirtyFiles,
    upstreamCommits,
    upstreamNote,
    changedFiles: changedPaths.size,
    impact,
  };
}

function baseState(
  source: SourceStatusEntry,
  overrides: {
    readonly signal: UpstreamSignal;
    readonly summary: string;
    readonly recordedCommit: string | null;
    readonly headCommit?: string | null;
  },
): UpstreamSourceState {
  return {
    alias: source.alias,
    path: source.path,
    kind: source.kind,
    signal: overrides.signal,
    summary: overrides.summary,
    recordedCommit: overrides.recordedCommit,
    headCommit: overrides.headCommit ?? null,
    localCommitsAhead: null,
    dirtyFiles: 0,
    upstreamCommits: null,
    upstreamNote: null,
    changedFiles: 0,
    impact: null,
  };
}

function impactFor(
  alias: string,
  changedPaths: readonly string[],
  donorMappings: readonly DonorSourceMapping[],
): UpstreamImpact | null {
  const forAlias = donorMappings.filter((mapping) => mapping.sourceAlias === alias);
  if (forAlias.length === 0) {
    return null;
  }
  const hit = forAlias.filter((mapping) =>
    changedPaths.some((changed) => donorLocatorMatchesPath(mapping.locator, changed)),
  );
  return {
    mappings: hit.length,
    adoptions: [...new Set(hit.map((mapping) => mapping.adoptionId))].sort(),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarize(input: {
  readonly dirtyFiles: number;
  readonly localDrift: boolean;
  readonly localCommitsAhead: number | null;
  readonly upstreamCommits: number | null;
  readonly upstreamNote: string | null;
  readonly fetch: boolean;
}): string {
  const local: string[] = [];
  if (input.dirtyFiles > 0) {
    local.push(`local checkout modified (${plural(input.dirtyFiles, "uncommitted file")})`);
  }
  if (input.localDrift) {
    local.push(
      input.localCommitsAhead && input.localCommitsAhead > 0
        ? `local checkout is ${plural(input.localCommitsAhead, "commit")} past the recorded observation`
        : "local checkout HEAD differs from the recorded observation",
    );
  }

  const upstream: string[] = [];
  if (input.upstreamNote) {
    upstream.push(`upstream not checked this run (${input.upstreamNote})`);
  } else if ((input.upstreamCommits ?? 0) > 0) {
    upstream.push(`${plural(input.upstreamCommits ?? 0, "new upstream commit")}`);
  }

  if (local.length === 0 && upstream.length === 0) {
    return "no change";
  }
  const parts = [...upstream, ...local];
  if (local.length > 0) {
    parts.push("not recorded — preserve or discard it before the next sync");
  }
  return parts.join("; ");
}
