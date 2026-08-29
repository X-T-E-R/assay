import path from "node:path";

import {
  type CheckRow,
  type FrameworkStatusResult,
  checkFramework,
  getFrameworkStatus,
  initFramework,
  loadManifest,
} from "absorb-anything-core";
import { checkOwnWork, getOwnWorkStatus, initOwnWork } from "own-work";

import { ASSAY_ENVELOPE_DIR, ASSAY_VERSION } from "./constants.js";
import {
  ASSAY_DETAIL_COMMAND,
  ASSAY_TOPICS,
  type AssayDigestEntry,
  assaySemanticDigest,
} from "./semantics.js";

export interface InitAssayOptions {
  readonly target: string;
  readonly name?: string;
  /** Overlay keeps every work folder inside the envelope; standalone is default. */
  readonly overlay?: boolean;
  readonly git?: boolean;
  readonly agents?: boolean;
  readonly template?: string;
}

export interface InitAssayResult {
  readonly root: string;
  readonly mode: "overlay" | "standalone";
  readonly envelope: string;
  readonly project: string;
  readonly template: string | null;
  readonly createdEnvelope: boolean;
  readonly createdRegistry: boolean;
  readonly system: string | null;
}

/**
 * Create or complete one suite workspace. An existing envelope is reused and
 * filled in, never replaced: a workspace may already hold one half's work.
 */
export async function initAssay(options: InitAssayOptions): Promise<InitAssayResult> {
  const root = path.resolve(options.target);
  const standalone = options.overlay !== true;
  const existing = await loadManifest(root);
  let template: string | null = null;
  if (!existing) {
    const created = await initFramework({
      target: root,
      ...(options.name ? { name: options.name } : {}),
      standalone,
      envelope: ASSAY_ENVELOPE_DIR,
      git: options.git ?? false,
      ...(options.agents === undefined ? {} : { agents: options.agents }),
      ...(options.template === undefined ? {} : { template: options.template }),
    });
    template = created.template;
  }
  const build = await initOwnWork({
    target: root,
    ...(options.name ? { name: options.name } : {}),
    standalone,
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  });
  const status = await getFrameworkStatus({ root });
  return {
    root,
    mode: build.mode,
    envelope: status.envelope ?? ASSAY_ENVELOPE_DIR,
    project: status.project ?? options.name ?? path.basename(root),
    template,
    createdEnvelope: existing === null,
    createdRegistry: build.createdRegistry,
    system: build.system ?? null,
  };
}

export interface AssayCheckResult {
  readonly root: string;
  readonly ok: boolean;
  readonly rows: readonly CheckRow[];
}

function rowKey(row: CheckRow): string {
  return [row.status, row.path.replaceAll("\\", "/"), row.message ?? ""].join("\u0000");
}

/**
 * The full common check plus each half's own records. Both halves validate the
 * shared envelope, so identical rows are reported once; either half failing
 * fails the suite.
 */
export async function checkAssay(options: {
  readonly root: string;
  readonly includeAdvisories?: boolean;
}): Promise<AssayCheckResult> {
  const root = path.resolve(options.root);
  const study = await checkFramework({
    root,
    includeAdvisories: options.includeAdvisories ?? false,
  });
  const build = await checkOwnWork({ root });
  const rows: CheckRow[] = [];
  const seen = new Set<string>();
  for (const row of [...study.rows, ...build.rows]) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return { root, ok: study.ok && build.ok, rows };
}

export interface AssayStatusResult {
  readonly common: FrameworkStatusResult;
  readonly study: {
    readonly sources: number;
    readonly brokenReferences: number;
    readonly knowledgeEntries: number;
  };
  readonly build: {
    readonly tasks: number;
    readonly roadmaps: number;
    readonly specs: number;
    readonly systems: number;
    readonly primarySystem: string | null;
  };
}

/** One payload: the shared workspace, the study summary, and the build counts. */
export async function getAssayStatus(options: {
  readonly root: string;
}): Promise<AssayStatusResult> {
  const build = await getOwnWorkStatus({ root: path.resolve(options.root) });
  return {
    common: build.common,
    study: {
      sources: build.common.sources?.total ?? 0,
      brokenReferences: build.common.sources?.brokenReferences ?? 0,
      knowledgeEntries: build.common.knowledgeEntries ?? 0,
    },
    build: {
      tasks: build.tasks,
      roadmaps: build.roadmaps,
      specs: build.specs,
      systems: build.systems,
      primarySystem: build.primarySystem,
    },
  };
}

export interface AssayPrimeResult {
  readonly root: string;
  readonly version: string;
  readonly semantics: readonly AssayDigestEntry[];
  readonly topics: readonly string[];
  readonly detailsCommand: string;
  readonly workspace: {
    readonly envelope: string;
    readonly project: string | null;
    readonly installedVersion: string | null;
    readonly sources: number;
    readonly knowledgeEntries: number;
    readonly tasks: number;
    readonly roadmaps: number;
    readonly specs: number;
    readonly systems: number;
    readonly primarySystem: string | null;
  } | null;
}

export async function primeAssay(options: {
  readonly root: string;
}): Promise<AssayPrimeResult> {
  const root = path.resolve(options.root);
  const status = await getAssayStatus({ root });
  const base = {
    root,
    version: ASSAY_VERSION,
    semantics: assaySemanticDigest(),
    topics: ASSAY_TOPICS,
    detailsCommand: ASSAY_DETAIL_COMMAND,
  };
  if (!status.common.hasManifest) return { ...base, workspace: null };
  return {
    ...base,
    workspace: {
      envelope: status.common.envelope ?? ASSAY_ENVELOPE_DIR,
      project: status.common.project ?? null,
      installedVersion: status.common.installedVersion ?? null,
      sources: status.study.sources,
      knowledgeEntries: status.study.knowledgeEntries,
      tasks: status.build.tasks,
      roadmaps: status.build.roadmaps,
      specs: status.build.specs,
      systems: status.build.systems,
      primarySystem: status.build.primarySystem,
    },
  };
}
