import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { appendEvent } from "../events.js";
import { relativeDisplayPath } from "../paths.js";
import type { CheckRow } from "../results.js";
import { stringifySortedJson } from "../serialization.js";
import { resolveSourceObservation } from "../sources.js";
import { nowIso } from "../time.js";
import {
  SOURCE_ADOPTION_DECISION_SCHEMA,
  SOURCE_ADOPTION_DEFINITION_SCHEMA,
  SOURCE_ADOPTION_EVIDENCE_SCHEMA,
  SOURCE_ADOPTION_INSPECTION_SCHEMA,
  SOURCE_ADOPTION_STATE_SCHEMA,
  type SourceAdoptionAcceptedBaseline,
  type SourceAdoptionDecision,
  type SourceAdoptionDecisionOutcome,
  type SourceAdoptionDefinition,
  type SourceAdoptionDiagnostic,
  type SourceAdoptionEvidence,
  type SourceAdoptionEvidenceInput,
  type SourceAdoptionInspection,
  type SourceAdoptionLocatorSnapshot,
  type SourceAdoptionMappingInspection,
  type SourceAdoptionPathLocator,
  type SourceAdoptionPolicyEvaluation,
  type SourceAdoptionState,
  sourceAdoptionDecisionSchema,
  sourceAdoptionDefinitionSchema,
  sourceAdoptionEvidenceInputSchema,
  sourceAdoptionEvidenceSchema,
  sourceAdoptionInspectionSchema,
  sourceAdoptionRelativePathSchema,
  sourceAdoptionStateSchema,
} from "./schemas.js";
import {
  sameLocatorSnapshot,
  sameTargetSnapshot,
  snapshotSourceAdoptionSource,
  snapshotSourceAdoptionTarget,
} from "./snapshots.js";
import {
  SourceAdoptionRecordFileError,
  adoptionRoot,
  assertNewAdoptionState,
  assertSourceAdoptionId,
  collectSourceAdoptionRecordIssues,
  decisionFile,
  definitionFile,
  evidenceFile,
  inspectionFile,
  listSourceAdoptionEvidence,
  listSourceAdoptionInspections,
  listSourceAdoptionStateIds,
  listSourceAdoptionDecisions as listStoredDecisions,
  parseSourceAdoptionValue,
  readSourceAdoptionDecision,
  readSourceAdoptionDefinition,
  readSourceAdoptionInspection,
  readSourceAdoptionState,
  readSourceAdoptionStateFromDirectory,
  readStructuredFile,
  sourceAdoptionWorkspaceRoot,
  stateFile,
  withAdoptionLock,
  writeAtomicJson,
  writeImmutableJson,
} from "./storage.js";

export * from "./schemas.js";
export { sourceAdoptionLocatorMatchesPath, snapshotManifestLocator } from "./snapshots.js";
export {
  type SourceAdoptionLockStatus,
  SourceAdoptionRecordFileError,
  collectSourceAdoptionRecordIssues,
  inspectAdoptionLock,
  releaseAdoptionLock,
} from "./storage.js";

function recordDigest(value: unknown): string {
  return createHash("sha256").update(stringifySortedJson(value), "utf8").digest("hex");
}

function recordId(prefix: string, value: unknown): string {
  return `${prefix}-${recordDigest(value).slice(0, 24)}`;
}

function uniqueIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new FrameworkError(`duplicate ${label} identifier: ${value}`, {
        code: "INVALID_SOURCE_ADOPTION",
      });
    }
    seen.add(value);
  }
}

function normalizeDefinition(value: unknown): SourceAdoptionDefinition {
  const parsed = parseSourceAdoptionValue(
    sourceAdoptionDefinitionSchema,
    value,
    "Source adoption definition",
  );
  const normalized = {
    ...parsed,
    targets: [...parsed.targets].sort((a, b) => a.id.localeCompare(b.id)),
    mappings: [...parsed.mappings]
      .map((mapping) => ({ ...mapping, evidence: [...mapping.evidence].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...parsed.evidence].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return sourceAdoptionDefinitionSchema.parse(normalized);
}

async function validateDefinition(
  root: string,
  definition: SourceAdoptionDefinition,
): Promise<void> {
  uniqueIds(
    definition.targets.map((target) => target.id),
    "target",
  );
  uniqueIds(
    definition.mappings.map((mapping) => mapping.id),
    "mapping",
  );
  uniqueIds(
    definition.evidence.map((requirement) => requirement.id),
    "evidence",
  );

  const targetIds = new Set(definition.targets.map((target) => target.id));
  const requirementIds = new Set(definition.evidence.map((requirement) => requirement.id));
  for (const target of definition.targets) {
    if (!definition.mappings.some((mapping) => mapping.target.target_id === target.id)) {
      throw new FrameworkError(`Source adoption target '${target.id}' has no mappings`, {
        code: "INVALID_SOURCE_ADOPTION",
      });
    }
  }
  for (const mapping of definition.mappings) {
    if (!targetIds.has(mapping.target.target_id)) {
      throw new FrameworkError(
        `mapping '${mapping.id}' references unknown target '${mapping.target.target_id}'`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    for (const requirement of mapping.evidence) {
      if (!requirementIds.has(requirement)) {
        throw new FrameworkError(
          `mapping '${mapping.id}' references unknown evidence '${requirement}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
    }
  }

  for (const target of definition.targets) {
    const source = await snapshotSourceAdoptionSource(
      root,
      definition,
      target.id,
      definition.source.observation,
    );
    for (const [mappingId, snapshot] of Object.entries(source.locators)) {
      if (snapshot.state !== "present") {
        throw new FrameworkError(
          `source locator for mapping '${mappingId}' does not resolve in observation '${definition.source.observation}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
    }
    // The registry record must exist. The target path and locators may remain
    // unresolved while the relationship is still a draft.
    await snapshotSourceAdoptionTarget(root, definition, target.id);
  }
}

async function appendSourceAdoptionEventBestEffort(
  root: string,
  event: Record<string, unknown>,
  now: Date,
): Promise<string | null> {
  try {
    return relativeDisplayPath(await appendEvent(root, event, now), root);
  } catch {
    return null;
  }
}

export interface RegisterSourceAdoptionOptions {
  readonly root: string;
  readonly definition: unknown;
  readonly now?: Date;
}

export interface RegisterSourceAdoptionFileOptions {
  readonly root: string;
  readonly file: string;
  readonly now?: Date;
}

export interface SourceAdoptionDefinitionResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly definitionDigest: string;
  readonly definition: SourceAdoptionDefinition;
  readonly state: SourceAdoptionState;
  readonly eventFile: string | null;
}

export async function registerSourceAdoption(
  options: RegisterSourceAdoptionOptions,
): Promise<SourceAdoptionDefinitionResult> {
  const root = path.resolve(options.root);
  const definition = normalizeDefinition(options.definition);
  const now = options.now ?? new Date();
  await validateDefinition(root, definition);
  const digest = recordDigest(definition);

  return withAdoptionLock(root, definition.id, async (directory) => {
    await assertNewAdoptionState(directory, definition.id);
    const state = sourceAdoptionStateSchema.parse({
      schema: SOURCE_ADOPTION_STATE_SCHEMA,
      adoption_id: definition.id,
      current_definition: digest,
      generation: 0,
      targets: Object.fromEntries(
        definition.targets.map((target) => [target.id, { baseline: null }]),
      ),
      decisions: [],
      updated_at: nowIso(now),
    });

    await writeImmutableJson(definitionFile(directory, digest), definition);
    await writeAtomicJson(stateFile(directory), state);
    const eventFile = await appendSourceAdoptionEventBestEffort(
      root,
      {
        event: "source.adoption.registered",
        adoption: definition.id,
        definition_digest: digest,
        targets: definition.targets.map((target) => target.id),
      },
      now,
    );
    return {
      root,
      adoptionId: definition.id,
      definitionDigest: digest,
      definition,
      state,
      eventFile,
    };
  });
}

export async function registerSourceAdoptionFromFile(
  options: RegisterSourceAdoptionFileOptions,
): Promise<SourceAdoptionDefinitionResult> {
  return registerSourceAdoption({
    root: options.root,
    definition: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface UpdateSourceAdoptionOptions extends RegisterSourceAdoptionOptions {
  readonly adoptionId: string;
}

export async function updateSourceAdoption(
  options: UpdateSourceAdoptionOptions,
): Promise<SourceAdoptionDefinitionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const definition = normalizeDefinition(options.definition);
  const now = options.now ?? new Date();
  if (definition.id !== adoptionId) {
    throw new FrameworkError(
      `definition id '${definition.id}' does not match adoption '${adoptionId}'`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }
  await validateDefinition(root, definition);
  const digest = recordDigest(definition);

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readSourceAdoptionStateFromDirectory(directory, adoptionId);
    const previous = await readSourceAdoptionDefinition(root, adoptionId, state.current_definition);
    if (previous.definition.source.alias !== definition.source.alias) {
      throw new FrameworkError(
        "a Source adoption cannot change source lineage; register a new adoption instead",
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    const targets = { ...state.targets };
    for (const target of definition.targets) {
      targets[target.id] ??= { baseline: null };
    }
    const nextState = sourceAdoptionStateSchema.parse({
      ...state,
      current_definition: digest,
      generation: state.generation + 1,
      targets,
      updated_at: nowIso(now),
    });
    await writeImmutableJson(definitionFile(directory, digest), definition);
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendSourceAdoptionEventBestEffort(
      root,
      {
        event: "source.adoption.definition.updated",
        adoption: adoptionId,
        previous_definition: state.current_definition,
        definition_digest: digest,
      },
      now,
    );
    return {
      root,
      adoptionId,
      definitionDigest: digest,
      definition,
      state: nextState,
      eventFile,
    };
  });
}

export async function updateSourceAdoptionFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly file: string;
  readonly now?: Date;
}): Promise<SourceAdoptionDefinitionResult> {
  return updateSourceAdoption({
    root: options.root,
    adoptionId: options.adoptionId,
    definition: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export const SOURCE_ADOPTION_TAKE_MODES_CODEC = ["adapt", "copy"] as const;
export type SourceAdoptionTakeMode = (typeof SOURCE_ADOPTION_TAKE_MODES_CODEC)[number];

export interface TakeSourceAdoptionMaterialOptions {
  readonly root: string;
  /** Living source alias the material came from. */
  readonly sourceAlias: string;
  /** Path inside that source's observation. */
  readonly sourcePath: string;
  /** Registered system the material landed in. */
  readonly targetSystem: string;
  /** Path inside that system. */
  readonly targetPath: string;
  readonly mode?: SourceAdoptionTakeMode;
  /** Locator shape; inferred from the observation when omitted. */
  readonly match?: "exact" | "prefix";
  /** Source observation id or path; defaults to the latest. */
  readonly observation?: string;
  /** Adoption id; derived from alias, system, and source path when omitted. */
  readonly adoptionId?: string;
  readonly title?: string;
  readonly now?: Date;
}

export interface TakeSourceAdoptionMaterialResult extends SourceAdoptionDefinitionResult {
  readonly targetId: string;
  readonly mappingId: string;
  readonly match: "exact" | "prefix";
  readonly observation: string;
}

/** Identifier fragment accepted by `sourceAdoptionIdSchema`, derived from free text. */
function sourceAdoptionSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : `x${slug}`;
}

/**
 * Validate one endpoint of a take before it becomes a definition. Doing it
 * here rather than leaving it to definition validation is what lets the error
 * name the argument the caller typed — an absolute or drive-prefixed path is
 * the likely mistake, and "Source adoption definition failed validation" would
 * not say which half of the command produced it.
 */
function normalizeTakePath(value: string, label: string): string {
  const parsed = sourceAdoptionRelativePathSchema.safeParse(value);
  if (!parsed.success) {
    throw new FrameworkError(
      `${label} must be a contained relative path (no leading '/', drive letter, or '..'): ${value}`,
      { code: "INVALID_SOURCE_ADOPTION" },
    );
  }
  return parsed.data;
}

/**
 * Locator shape for a source path, read off the observation that is being
 * adopted: a path that names one recorded file is `exact`, a path that has
 * recorded files beneath it is `prefix`. Without this, taking a directory
 * would fail validation with "source locator does not resolve" even though the
 * directory is right there in the observation.
 */
async function inferSourceMatch(
  root: string,
  manifestFile: string,
  sourcePath: string,
): Promise<"exact" | "prefix"> {
  let files: readonly { readonly path?: unknown }[] = [];
  try {
    const parsed = JSON.parse(await readFile(path.resolve(root, manifestFile), "utf8")) as {
      readonly files?: readonly { readonly path?: unknown }[];
    };
    files = parsed.files ?? [];
  } catch {
    return "exact";
  }
  const paths = files.map((file) => (typeof file.path === "string" ? file.path : ""));
  if (paths.includes(sourcePath)) {
    return "exact";
  }
  return paths.some((candidate) => candidate.startsWith(`${sourcePath}/`)) ? "prefix" : "exact";
}

/**
 * Register a single-source, single-target adoption from its two endpoints.
 *
 * `source adoption register --file` asks for a definition document before the adoption
 * can be recorded, which puts a preparation step in front of the one thing the
 * user is trying to say: "I took that from there and put it here." This
 * synthesizes the same definition — same schema, same validation, same
 * records — so the common case is one command. `--file` remains for multi-
 * target, multi-mapping, or evidence-bearing adoptions.
 */
export async function takeSourceAdoptionMaterial(
  options: TakeSourceAdoptionMaterialOptions,
): Promise<TakeSourceAdoptionMaterialResult> {
  const root = path.resolve(options.root);
  const sourcePath = normalizeTakePath(options.sourcePath, "source path");
  const targetPath = normalizeTakePath(options.targetPath, "target path");
  const mode = options.mode ?? "adapt";

  const resolved = await resolveSourceObservation({
    root,
    alias: options.sourceAlias,
    ...(options.observation === undefined ? {} : { observation: options.observation }),
  });
  const match = options.match ?? (await inferSourceMatch(root, resolved.manifestFile, sourcePath));

  const targetId = sourceAdoptionSlug(options.targetSystem);
  const mappingId = sourceAdoptionSlug(sourcePath);
  const adoptionId = (
    options.adoptionId ?? `${sourceAdoptionSlug(resolved.alias)}-${targetId}-${mappingId}`
  ).slice(0, 128);

  const definition = {
    schema: SOURCE_ADOPTION_DEFINITION_SCHEMA,
    id: adoptionId,
    ...(options.title === undefined ? {} : { title: options.title }),
    source: { alias: resolved.alias, observation: resolved.observation.observation_id },
    targets: [{ id: targetId, system: options.targetSystem, adapter: "local-system/v1" }],
    mappings: [
      {
        id: mappingId,
        kind: "artifact",
        mode,
        source: { path: sourcePath, match },
        target: { target_id: targetId, path: targetPath, match },
        evidence: [],
      },
    ],
    evidence: [],
  };

  const registered = await registerSourceAdoption({
    root,
    definition,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    ...registered,
    targetId,
    mappingId,
    match,
    observation: resolved.observation.observation_id,
  };
}

export interface SourceAdoptionSourceMapping {
  readonly adoptionId: string;
  readonly mappingId: string;
  readonly sourceAlias: string;
  readonly locator: SourceAdoptionPathLocator;
}

/**
 * Every declared source locator across the workspace's Source adoptions.
 *
 * `assay status` intersects these with the paths an upstream change touched,
 * so "the source moved" is reported together with "it reaches N adopted
 * places". A damaged adoption is skipped rather than fatal: `check` is where
 * record integrity is reported, and status must not stop answering because one
 * adoption is unreadable.
 */
export async function listSourceAdoptionSourceMappings(
  root: string,
): Promise<readonly SourceAdoptionSourceMapping[]> {
  const resolvedRoot = path.resolve(root);
  const mappings: SourceAdoptionSourceMapping[] = [];
  for (const adoptionId of await listSourceAdoptionStateIds(resolvedRoot)) {
    try {
      const state = await readSourceAdoptionState(resolvedRoot, adoptionId);
      const { definition } = await readSourceAdoptionDefinition(
        resolvedRoot,
        adoptionId,
        state.current_definition,
      );
      for (const mapping of definition.mappings) {
        mappings.push({
          adoptionId,
          mappingId: mapping.id,
          sourceAlias: definition.source.alias,
          locator: mapping.source,
        });
      }
    } catch {
      // unreadable adoption; `check` reports the damaged record
    }
  }
  return mappings;
}

function sourceChange(
  baseline: SourceAdoptionLocatorSnapshot | null,
  candidate: SourceAdoptionLocatorSnapshot,
): SourceAdoptionMappingInspection["source"]["change"] {
  if (!baseline) return "activation";
  if (sameLocatorSnapshot(baseline, candidate)) return "no-direct-change";
  return candidate.state === "missing" ? "missing" : "direct-change";
}

function targetChange(
  baseline: SourceAdoptionLocatorSnapshot | null,
  candidate: SourceAdoptionLocatorSnapshot,
): SourceAdoptionMappingInspection["target"]["change"] {
  if (!baseline) {
    if (candidate.state === "missing") return "missing";
    if (candidate.state === "unresolvable") return "unresolvable";
    return "activation";
  }
  if (sameLocatorSnapshot(baseline, candidate)) return "unchanged";
  if (candidate.state === "missing") return "missing";
  if (candidate.state === "unresolvable") return "unresolvable";
  return "drifted";
}

function mappingFacts(
  source: SourceAdoptionMappingInspection["source"]["change"],
  target: SourceAdoptionMappingInspection["target"]["change"],
): SourceAdoptionMappingInspection["facts"] {
  const facts: SourceAdoptionMappingInspection["facts"][number][] = [];
  if (source === "activation" || target === "activation") facts.push("activation");
  if (source === "direct-change") facts.push("source-direct-change");
  if (source === "missing") facts.push("source-missing");
  if (target === "drifted") facts.push("target-drift");
  if (target === "missing") facts.push("target-missing");
  if (target === "unresolvable") facts.push("target-unresolvable");
  if (source === "direct-change" && target === "drifted") facts.push("both-changed");
  return facts;
}

function diagnosticsForMapping(
  mappingId: string,
  source: SourceAdoptionMappingInspection["source"]["change"],
  target: SourceAdoptionMappingInspection["target"]["change"],
): SourceAdoptionDiagnostic[] {
  const diagnostics: SourceAdoptionDiagnostic[] = [];
  if (source === "direct-change") {
    diagnostics.push({
      code: "source-adoption.source.direct_change",
      severity: "info",
      mapping_id: mappingId,
      message: "declared source material changed directly",
    });
  } else if (source === "missing") {
    diagnostics.push({
      code: "source-adoption.source.locator_missing",
      severity: "warning",
      mapping_id: mappingId,
      message: "declared source locator no longer resolves",
    });
  }
  if (target === "drifted") {
    diagnostics.push({
      code: "source-adoption.target.drift",
      severity: "info",
      mapping_id: mappingId,
      message: "declared target material differs from its accepted baseline",
    });
  } else if (target === "missing") {
    diagnostics.push({
      code: "source-adoption.target.locator_missing",
      severity: "warning",
      mapping_id: mappingId,
      message: "declared target locator does not currently resolve",
    });
  } else if (target === "unresolvable") {
    diagnostics.push({
      code: "source-adoption.target.locator_unresolvable",
      severity: "error",
      mapping_id: mappingId,
      message: "declared target locator cannot be inspected safely",
    });
  }
  return diagnostics;
}

async function buildSourceAdoptionInspection(input: {
  readonly root: string;
  readonly state: SourceAdoptionState;
  readonly definition: SourceAdoptionDefinition;
  readonly definitionDigest: string;
  readonly targetId: string;
  readonly observation?: string;
  readonly now: Date;
}): Promise<SourceAdoptionInspection> {
  const target = input.definition.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) {
    throw new FrameworkNotFoundError(
      `target '${input.targetId}' is not active in Source adoption '${input.definition.id}'`,
    );
  }
  const targetState = input.state.targets[input.targetId] ?? { baseline: null };
  const source = await snapshotSourceAdoptionSource(
    input.root,
    input.definition,
    input.targetId,
    input.observation,
  );
  const targetSnapshot = await snapshotSourceAdoptionTarget(
    input.root,
    input.definition,
    input.targetId,
  );
  const mappings: SourceAdoptionMappingInspection[] = [];
  const diagnostics: SourceAdoptionDiagnostic[] = [];

  for (const mapping of input.definition.mappings.filter(
    (candidate) => candidate.target.target_id === input.targetId,
  )) {
    const candidateSource = source.locators[mapping.id];
    const candidateTarget = targetSnapshot.locators[mapping.id];
    if (!candidateSource || !candidateTarget) {
      throw new FrameworkError(`snapshot missing mapping '${mapping.id}'`, {
        code: "INVALID_SOURCE_ADOPTION",
      });
    }
    const baselineSource = targetState.baseline?.source.locators[mapping.id] ?? null;
    const baselineTarget = targetState.baseline?.target.locators[mapping.id] ?? null;
    const sourceDelta = sourceChange(baselineSource, candidateSource);
    const targetDelta = targetChange(baselineTarget, candidateTarget);
    mappings.push({
      id: mapping.id,
      source: {
        baseline: baselineSource,
        candidate: candidateSource,
        change: sourceDelta,
      },
      target: {
        baseline: baselineTarget,
        candidate: candidateTarget,
        change: targetDelta,
      },
      facts: mappingFacts(sourceDelta, targetDelta),
      evidence: [...mapping.evidence],
    });
    diagnostics.push(...diagnosticsForMapping(mapping.id, sourceDelta, targetDelta));
  }

  if (targetSnapshot.working_tree === "dirty") {
    diagnostics.push({
      code: "source-adoption.target.working_tree_dirty",
      severity: "info",
      message: "target Git working tree is dirty; mapped artifact fingerprints remain inspectable",
    });
  }

  const activeEvidenceIds = new Set(mappings.flatMap((mapping) => mapping.evidence));
  const requirements = input.definition.evidence.filter((requirement) =>
    activeEvidenceIds.has(requirement.id),
  );
  const createdAt = nowIso(input.now);
  const content = {
    schema: SOURCE_ADOPTION_INSPECTION_SCHEMA,
    adoption_id: input.definition.id,
    definition_digest: input.definitionDigest,
    target_id: input.targetId,
    baseline_decision_id: targetState.baseline?.decision_id ?? null,
    source,
    target: targetSnapshot,
    mappings,
    required_evidence: requirements
      .filter((requirement) => requirement.policy === "required")
      .map((requirement) => requirement.id)
      .sort(),
    advisory_evidence: requirements
      .filter((requirement) => requirement.policy === "advisory")
      .map((requirement) => requirement.id)
      .sort(),
    diagnostics: diagnostics.sort(
      (a, b) =>
        a.code.localeCompare(b.code) || (a.mapping_id ?? "").localeCompare(b.mapping_id ?? ""),
    ),
    created_at: createdAt,
  };
  return sourceAdoptionInspectionSchema.parse({
    ...content,
    id: recordId("inspection", content),
  });
}

export interface InspectSourceAdoptionOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId: string;
  readonly observation?: string;
  readonly now?: Date;
  readonly persist?: boolean;
}

export interface InspectSourceAdoptionResult {
  readonly root: string;
  readonly inspection: SourceAdoptionInspection;
  readonly path: string | null;
  readonly created: boolean;
}

export async function inspectSourceAdoption(
  options: InspectSourceAdoptionOptions,
): Promise<InspectSourceAdoptionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const state = await readSourceAdoptionState(root, adoptionId);
  const { definition, digest } = await readSourceAdoptionDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  const inspection = await buildSourceAdoptionInspection({
    root,
    state,
    definition,
    definitionDigest: digest,
    targetId: assertSourceAdoptionId(options.targetId),
    ...(options.observation === undefined ? {} : { observation: options.observation }),
    now: options.now ?? new Date(),
  });
  if (options.persist === false) {
    return { root, inspection, path: null, created: false };
  }
  const directory = await adoptionRoot(root, adoptionId);
  const file = inspectionFile(directory, inspection.id);
  const created = await writeImmutableJson(file, inspection);
  return {
    root,
    inspection,
    path: relativeDisplayPath(file, root),
    created,
  };
}

export interface RecordSourceAdoptionEvidenceOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
  readonly evidence: unknown;
  readonly now?: Date;
}

export interface RecordSourceAdoptionEvidenceResult {
  readonly root: string;
  readonly evidence: SourceAdoptionEvidence;
  readonly path: string;
  readonly created: boolean;
}

export async function recordSourceAdoptionEvidence(
  options: RecordSourceAdoptionEvidenceOptions,
): Promise<RecordSourceAdoptionEvidenceResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const inspection = await readSourceAdoptionInspection(root, adoptionId, options.inspectionId);
  const input = parseSourceAdoptionValue(
    sourceAdoptionEvidenceInputSchema,
    options.evidence,
    "Source adoption evidence input",
  );
  const recordedAt = nowIso(options.now ?? new Date());
  const content = {
    schema: SOURCE_ADOPTION_EVIDENCE_SCHEMA,
    adoption_id: adoptionId,
    definition_digest: inspection.definition_digest,
    target_id: inspection.target_id,
    inspection_id: inspection.id,
    source_observation: inspection.source.observation_id,
    target_fingerprint: inspection.target.fingerprint,
    check_id: input.check_id,
    result: input.result,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    artifacts: input.artifacts,
    recorded_at: recordedAt,
  };
  const evidence = sourceAdoptionEvidenceSchema.parse({
    ...content,
    id: recordId("evidence", content),
  });
  const directory = await adoptionRoot(root, adoptionId);
  const file = evidenceFile(directory, evidence.id);
  const created = await writeImmutableJson(file, evidence);
  return { root, evidence, path: relativeDisplayPath(file, root), created };
}

export async function recordSourceAdoptionEvidenceFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
  readonly file: string;
  readonly now?: Date;
}): Promise<RecordSourceAdoptionEvidenceResult> {
  return recordSourceAdoptionEvidence({
    root: options.root,
    adoptionId: options.adoptionId,
    inspectionId: options.inspectionId,
    evidence: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function evaluatePolicy(
  inspection: SourceAdoptionInspection,
  evidence: readonly SourceAdoptionEvidence[],
): SourceAdoptionPolicyEvaluation {
  const latest = new Map<string, SourceAdoptionEvidence>();
  for (const item of evidence) {
    latest.set(item.check_id, item);
  }
  const requiredMissing = inspection.required_evidence.filter(
    (id) => latest.get(id)?.result !== "passed",
  );
  const advisoryMissing = inspection.advisory_evidence.filter((id) => !latest.has(id));
  const failed = [...latest.values()]
    .filter((item) => item.result !== "passed")
    .map((item) => item.check_id);
  return {
    required_missing: [...new Set(requiredMissing)].sort(),
    advisory_missing: [...new Set(advisoryMissing)].sort(),
    failed: [...new Set(failed)].sort(),
  };
}

export interface VerifySourceAdoptionInspectionResult {
  readonly root: string;
  readonly inspection: SourceAdoptionInspection;
  readonly current: boolean;
  readonly ok: boolean;
  readonly policy: SourceAdoptionPolicyEvaluation;
  readonly evidence: readonly SourceAdoptionEvidence[];
  readonly diagnostics: readonly SourceAdoptionDiagnostic[];
}

async function verifyInspectionWithState(
  root: string,
  state: SourceAdoptionState,
  inspection: SourceAdoptionInspection,
): Promise<VerifySourceAdoptionInspectionResult> {
  const diagnostics: SourceAdoptionDiagnostic[] = [];
  const { definition } = await readSourceAdoptionDefinition(
    root,
    inspection.adoption_id,
    inspection.definition_digest,
  );
  const currentTargetState = state.targets[inspection.target_id] ?? { baseline: null };
  let current =
    state.current_definition === inspection.definition_digest &&
    (currentTargetState.baseline?.decision_id ?? null) === inspection.baseline_decision_id;

  const source = await snapshotSourceAdoptionSource(
    root,
    definition,
    inspection.target_id,
    inspection.source.observation_id,
  );
  if (
    source.manifest_fingerprint !== inspection.source.manifest_fingerprint ||
    Object.entries(source.locators).some(
      ([mappingId, snapshot]) =>
        !sameLocatorSnapshot(inspection.source.locators[mappingId], snapshot),
    )
  ) {
    current = false;
    diagnostics.push({
      code: "source-adoption.inspection.source_stale",
      severity: "error",
      message: "source observation no longer matches the recorded inspection",
    });
  }
  const target = await snapshotSourceAdoptionTarget(root, definition, inspection.target_id);
  if (!sameTargetSnapshot(target, inspection.target)) {
    current = false;
    diagnostics.push({
      code: "source-adoption.inspection.target_stale",
      severity: "warning",
      message: "mapped target material changed after the inspection",
    });
  }
  if (state.current_definition !== inspection.definition_digest) {
    diagnostics.push({
      code: "source-adoption.inspection.definition_stale",
      severity: "warning",
      message: "the Source adoption definition changed after the inspection",
    });
  }
  if ((currentTargetState.baseline?.decision_id ?? null) !== inspection.baseline_decision_id) {
    diagnostics.push({
      code: "source-adoption.inspection.baseline_stale",
      severity: "warning",
      message: "the target baseline changed after the inspection",
    });
  }

  const evidence = await listSourceAdoptionEvidence(root, inspection.adoption_id, inspection.id);
  const policy = evaluatePolicy(inspection, evidence);
  return {
    root,
    inspection,
    current,
    ok: current && policy.required_missing.length === 0,
    policy,
    evidence,
    diagnostics,
  };
}

export async function verifySourceAdoptionInspection(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
}): Promise<VerifySourceAdoptionInspectionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const state = await readSourceAdoptionState(root, adoptionId);
  const inspection = await readSourceAdoptionInspection(root, adoptionId, options.inspectionId);
  return verifyInspectionWithState(root, state, inspection);
}

export interface DecideSourceAdoptionOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId: string;
  readonly outcome: Exclude<SourceAdoptionDecisionOutcome, "rollback">;
  readonly inspectionId?: string;
  readonly observation?: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface SourceAdoptionDecisionResult {
  readonly root: string;
  readonly decision: SourceAdoptionDecision;
  readonly state: SourceAdoptionState;
  readonly path: string;
  readonly inspectionPath: string;
  readonly eventFile: string | null;
}

export async function decideSourceAdoption(
  options: DecideSourceAdoptionOptions,
): Promise<SourceAdoptionDecisionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const targetId = assertSourceAdoptionId(options.targetId);
  const now = options.now ?? new Date();

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readSourceAdoptionStateFromDirectory(directory, adoptionId);
    let inspection: SourceAdoptionInspection;
    if (options.inspectionId) {
      inspection = await readSourceAdoptionInspection(root, adoptionId, options.inspectionId);
      if (inspection.target_id !== targetId) {
        throw new FrameworkError(
          `inspection '${inspection.id}' belongs to target '${inspection.target_id}', not '${targetId}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
    } else {
      const { definition, digest } = await readSourceAdoptionDefinition(
        root,
        adoptionId,
        state.current_definition,
      );
      inspection = await buildSourceAdoptionInspection({
        root,
        state,
        definition,
        definitionDigest: digest,
        targetId,
        ...(options.observation === undefined ? {} : { observation: options.observation }),
        now,
      });
      await writeImmutableJson(inspectionFile(directory, inspection.id), inspection);
    }

    const verification = await verifyInspectionWithState(root, state, inspection);
    if (options.outcome === "accept") {
      if (!verification.current) {
        throw new FrameworkError(
          "Source adoption inspection is stale; inspect the current source and target before accepting",
          { code: "SOURCE_ADOPTION_STALE", details: verification.diagnostics },
        );
      }
      const unresolvable = inspection.mappings.filter(
        (mapping) => mapping.target.candidate.state === "unresolvable",
      );
      if (unresolvable.length > 0) {
        throw new FrameworkError(
          `cannot bind an accepted baseline for unresolvable target mapping(s): ${unresolvable.map((mapping) => mapping.id).join(", ")}`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
      if (verification.policy.required_missing.length > 0) {
        throw new FrameworkError(
          `required Source adoption evidence has not passed: ${verification.policy.required_missing.join(", ")}`,
          {
            code: "SOURCE_ADOPTION_POLICY_BLOCKED",
            details: verification.policy,
          },
        );
      }
    }

    const decidedAt = nowIso(now);
    const targetState = state.targets[targetId] ?? { baseline: null };
    const evidenceIds = verification.evidence.map((evidence) => evidence.id).sort();
    const seed = {
      adoption_id: adoptionId,
      definition_digest: inspection.definition_digest,
      target_id: targetId,
      inspection_id: inspection.id,
      outcome: options.outcome,
      reason: options.reason ?? null,
      evidence_ids: evidenceIds,
      policy: verification.policy,
      baseline_before: targetState.baseline?.decision_id ?? null,
      state_generation: state.generation,
      decided_at: decidedAt,
    };
    const decisionId = recordId("decision", seed);
    const baselineAfter: SourceAdoptionAcceptedBaseline | null =
      options.outcome === "accept"
        ? {
            decision_id: decisionId,
            definition_digest: inspection.definition_digest,
            source: inspection.source,
            target: inspection.target,
            accepted_at: decidedAt,
          }
        : null;
    const decision = sourceAdoptionDecisionSchema.parse({
      schema: SOURCE_ADOPTION_DECISION_SCHEMA,
      id: decisionId,
      ...seed,
      baseline_after: baselineAfter,
      restored_from_decision: null,
    });
    await writeImmutableJson(decisionFile(directory, decision.id), decision);

    const targets = { ...state.targets };
    targets[targetId] = {
      baseline: baselineAfter ?? targetState.baseline,
    };
    const nextState = sourceAdoptionStateSchema.parse({
      ...state,
      generation: state.generation + 1,
      targets,
      decisions: [...state.decisions, decision.id],
      updated_at: decidedAt,
    });
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendSourceAdoptionEventBestEffort(
      root,
      {
        event: `source.adoption.${options.outcome}`,
        adoption: adoptionId,
        target: targetId,
        inspection: inspection.id,
        decision: decision.id,
      },
      now,
    );
    return {
      root,
      decision,
      state: nextState,
      path: relativeDisplayPath(decisionFile(directory, decision.id), root),
      inspectionPath: relativeDisplayPath(inspectionFile(directory, inspection.id), root),
      eventFile,
    };
  });
}

export async function recordSourceAdoptionRollback(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly decisionId: string;
  readonly reason?: string;
  readonly now?: Date;
}): Promise<SourceAdoptionDecisionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const restoredFrom = assertSourceAdoptionId(options.decisionId);
  const now = options.now ?? new Date();

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readSourceAdoptionStateFromDirectory(directory, adoptionId);
    if (!state.decisions.includes(restoredFrom)) {
      throw new FrameworkNotFoundError(
        `committed Source adoption decision not found: ${restoredFrom}`,
      );
    }
    const historical = await readSourceAdoptionDecision(root, adoptionId, restoredFrom);
    if (!historical.baseline_after) {
      throw new FrameworkError(
        `decision '${restoredFrom}' does not identify an accepted baseline`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    const { definition } = await readSourceAdoptionDefinition(
      root,
      adoptionId,
      historical.baseline_after.definition_digest,
    );
    const currentTarget = await snapshotSourceAdoptionTarget(
      root,
      definition,
      historical.target_id,
    );
    if (!sameTargetSnapshot(currentTarget, historical.baseline_after.target)) {
      throw new FrameworkError(
        "target mapped artifacts do not match the historical baseline; restore them outside Assay before recording rollback",
        { code: "SOURCE_ADOPTION_STALE" },
      );
    }

    const inspection = await buildSourceAdoptionInspection({
      root,
      state,
      definition,
      definitionDigest: historical.baseline_after.definition_digest,
      targetId: historical.target_id,
      observation: historical.baseline_after.source.observation_id,
      now,
    });
    await writeImmutableJson(inspectionFile(directory, inspection.id), inspection);
    const decidedAt = nowIso(now);
    const targetState = state.targets[historical.target_id] ?? { baseline: null };
    const seed = {
      adoption_id: adoptionId,
      definition_digest: historical.baseline_after.definition_digest,
      target_id: historical.target_id,
      inspection_id: inspection.id,
      outcome: "rollback" as const,
      reason: options.reason ?? null,
      evidence_ids: [],
      policy: {
        required_missing: [],
        advisory_missing: [],
        failed: [],
      },
      baseline_before: targetState.baseline?.decision_id ?? null,
      restored_from_decision: restoredFrom,
      state_generation: state.generation,
      decided_at: decidedAt,
    };
    const decisionId = recordId("decision", seed);
    const baselineAfter: SourceAdoptionAcceptedBaseline = {
      decision_id: decisionId,
      definition_digest: historical.baseline_after.definition_digest,
      source: historical.baseline_after.source,
      target: currentTarget,
      accepted_at: decidedAt,
    };
    const decision = sourceAdoptionDecisionSchema.parse({
      schema: SOURCE_ADOPTION_DECISION_SCHEMA,
      id: decisionId,
      ...seed,
      baseline_after: baselineAfter,
    });
    await writeImmutableJson(decisionFile(directory, decision.id), decision);
    const targets = { ...state.targets };
    targets[historical.target_id] = { baseline: baselineAfter };
    const nextState = sourceAdoptionStateSchema.parse({
      ...state,
      generation: state.generation + 1,
      targets,
      decisions: [...state.decisions, decision.id],
      updated_at: decidedAt,
    });
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendSourceAdoptionEventBestEffort(
      root,
      {
        event: "source.adoption.rollback.recorded",
        adoption: adoptionId,
        target: historical.target_id,
        restored_from: restoredFrom,
        decision: decision.id,
      },
      now,
    );
    return {
      root,
      decision,
      state: nextState,
      path: relativeDisplayPath(decisionFile(directory, decision.id), root),
      inspectionPath: relativeDisplayPath(inspectionFile(directory, inspection.id), root),
      eventFile,
    };
  });
}

export interface SourceAdoptionListEntry {
  readonly id: string;
  readonly title: string | null;
  readonly definitionDigest: string;
  readonly sourceAlias: string;
  readonly targets: readonly {
    readonly id: string;
    readonly system: string;
    readonly baselineDecision: string | null;
  }[];
}

export interface SourceAdoptionListResult {
  readonly root: string;
  readonly adoptions: readonly SourceAdoptionListEntry[];
}

export async function listSourceAdoptions(options: {
  readonly root: string;
}): Promise<SourceAdoptionListResult> {
  const root = path.resolve(options.root);
  const entries: SourceAdoptionListEntry[] = [];
  for (const adoptionId of await listSourceAdoptionStateIds(root)) {
    const state = await readSourceAdoptionState(root, adoptionId);
    const { definition } = await readSourceAdoptionDefinition(
      root,
      adoptionId,
      state.current_definition,
    );
    entries.push({
      id: adoptionId,
      title: definition.title ?? null,
      definitionDigest: state.current_definition,
      sourceAlias: definition.source.alias,
      targets: definition.targets.map((target) => ({
        id: target.id,
        system: target.system,
        baselineDecision: state.targets[target.id]?.baseline?.decision_id ?? null,
      })),
    });
  }
  return { root, adoptions: entries };
}

export interface SourceAdoptionResult {
  readonly root: string;
  readonly definition: SourceAdoptionDefinition;
  readonly definitionDigest: string;
  readonly state: SourceAdoptionState;
}

export async function getSourceAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
}): Promise<SourceAdoptionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const state = await readSourceAdoptionState(root, adoptionId);
  const { definition, digest } = await readSourceAdoptionDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  return { root, definition, definitionDigest: digest, state };
}

export interface SourceAdoptionTargetStatus {
  readonly id: string;
  readonly system: string;
  readonly baselineDecision: string | null;
  readonly inspection: SourceAdoptionInspection;
}

export interface SourceAdoptionStatusResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly definitionDigest: string;
  readonly targets: readonly SourceAdoptionTargetStatus[];
}

export async function getSourceAdoptionStatus(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}): Promise<SourceAdoptionStatusResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  const state = await readSourceAdoptionState(root, adoptionId);
  const { definition, digest } = await readSourceAdoptionDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  const targets = options.targetId
    ? definition.targets.filter(
        (target) => target.id === assertSourceAdoptionId(options.targetId as string),
      )
    : definition.targets;
  if (targets.length === 0) {
    throw new FrameworkNotFoundError(
      `target '${options.targetId}' is not active in Source adoption '${adoptionId}'`,
    );
  }
  const result = [];
  for (const target of targets) {
    result.push({
      id: target.id,
      system: target.system,
      baselineDecision: state.targets[target.id]?.baseline?.decision_id ?? null,
      inspection: await buildSourceAdoptionInspection({
        root,
        state,
        definition,
        definitionDigest: digest,
        targetId: target.id,
        now: new Date(),
      }),
    });
  }
  return { root, adoptionId, definitionDigest: digest, targets: result };
}

export interface SourceAdoptionHistoryResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly decisions: readonly SourceAdoptionDecision[];
}

export async function getSourceAdoptionHistory(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}): Promise<SourceAdoptionHistoryResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertSourceAdoptionId(options.adoptionId);
  return {
    root,
    adoptionId,
    decisions: await listStoredDecisions(root, adoptionId, options.targetId),
  };
}

export interface SourceAdoptionSummary {
  readonly adoptions: number;
  readonly targets: number;
  readonly acceptedTargets: number;
  readonly draftTargets: number;
}

export async function getSourceAdoptionSummary(
  root: string,
): Promise<SourceAdoptionSummary | null> {
  const ids = await listSourceAdoptionStateIds(path.resolve(root));
  if (ids.length === 0) return null;
  let targets = 0;
  let acceptedTargets = 0;
  for (const adoptionId of ids) {
    const state = await readSourceAdoptionState(root, adoptionId);
    const { definition } = await readSourceAdoptionDefinition(
      root,
      adoptionId,
      state.current_definition,
    );
    targets += definition.targets.length;
    acceptedTargets += definition.targets.filter(
      (target) => state.targets[target.id]?.baseline != null,
    ).length;
  }
  return {
    adoptions: ids.length,
    targets,
    acceptedTargets,
    draftTargets: targets - acceptedTargets,
  };
}

async function assertSourceAdoptionStateHistoryIntegrity(
  root: string,
  adoptionId: string,
  state: SourceAdoptionState,
  evidence: readonly SourceAdoptionEvidence[],
): Promise<void> {
  const { definition } = await readSourceAdoptionDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  for (const target of definition.targets) {
    if (!state.targets[target.id]) {
      throw new FrameworkError(`Source adoption state is missing active target '${target.id}'`, {
        code: "INVALID_SOURCE_ADOPTION",
      });
    }
  }

  const uniqueDecisionIds = new Set(state.decisions);
  if (uniqueDecisionIds.size !== state.decisions.length) {
    throw new FrameworkError("Source adoption state contains duplicate committed decision ids", {
      code: "INVALID_SOURCE_ADOPTION",
    });
  }
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  const baselineByTarget = new Map(
    Object.keys(state.targets).map((targetId) => [targetId, null as string | null]),
  );
  let previousGeneration = -1;

  for (const decisionId of state.decisions) {
    const decision = await readSourceAdoptionDecision(root, adoptionId, decisionId);
    if (!state.targets[decision.target_id]) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' references unknown state target '${decision.target_id}'`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    if (
      decision.state_generation <= previousGeneration ||
      decision.state_generation >= state.generation
    ) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' has inconsistent state generation ${decision.state_generation}`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    previousGeneration = decision.state_generation;

    const expectedBefore = baselineByTarget.get(decision.target_id) ?? null;
    if (decision.baseline_before !== expectedBefore) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' baseline_before does not match committed history`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }

    await readSourceAdoptionDefinition(root, adoptionId, decision.definition_digest);
    const inspection = await readSourceAdoptionInspection(root, adoptionId, decision.inspection_id);
    if (
      inspection.definition_digest !== decision.definition_digest ||
      inspection.target_id !== decision.target_id
    ) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' does not match inspection '${inspection.id}'`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }

    if (new Set(decision.evidence_ids).size !== decision.evidence_ids.length) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' contains duplicate evidence ids`,
        {
          code: "INVALID_SOURCE_ADOPTION",
        },
      );
    }
    for (const evidenceId of decision.evidence_ids) {
      const record = evidenceById.get(evidenceId);
      if (!record) {
        throw new FrameworkError(
          `Source adoption decision '${decision.id}' references missing evidence '${evidenceId}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
      if (record.inspection_id !== inspection.id) {
        throw new FrameworkError(
          `Source adoption decision '${decision.id}' references evidence '${evidenceId}' from another inspection`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
    }

    const advancesBaseline = decision.outcome === "accept" || decision.outcome === "rollback";
    if (advancesBaseline !== (decision.baseline_after !== null)) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' has an invalid baseline_after for outcome '${decision.outcome}'`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    if ((decision.outcome === "rollback") !== (decision.restored_from_decision !== null)) {
      throw new FrameworkError(
        `Source adoption decision '${decision.id}' has an invalid rollback reference`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }

    if (decision.baseline_after) {
      const baseline = decision.baseline_after;
      if (
        baseline.decision_id !== decision.id ||
        baseline.definition_digest !== decision.definition_digest ||
        baseline.accepted_at !== decision.decided_at ||
        recordDigest(baseline.source) !== recordDigest(inspection.source) ||
        recordDigest(baseline.target) !== recordDigest(inspection.target)
      ) {
        throw new FrameworkError(
          `Source adoption decision '${decision.id}' baseline_after does not match its inspection`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
      baselineByTarget.set(decision.target_id, decision.id);
    }
  }

  for (const [targetId, targetState] of Object.entries(state.targets)) {
    const expectedDecisionId = baselineByTarget.get(targetId) ?? null;
    const actualDecisionId = targetState.baseline?.decision_id ?? null;
    if (actualDecisionId !== expectedDecisionId) {
      throw new FrameworkError(
        `Source adoption state baseline for target '${targetId}' does not match committed history`,
        { code: "INVALID_SOURCE_ADOPTION" },
      );
    }
    if (targetState.baseline) {
      const decision = await readSourceAdoptionDecision(
        root,
        adoptionId,
        targetState.baseline.decision_id,
      );
      if (
        !decision.baseline_after ||
        recordDigest(targetState.baseline) !== recordDigest(decision.baseline_after)
      ) {
        throw new FrameworkError(
          `Source adoption state baseline for target '${targetId}' does not match decision '${decision.id}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
    }
  }
}

export async function collectSourceAdoptionIntegrityRows(root: string): Promise<CheckRow[]> {
  const resolvedRoot = path.resolve(root);
  const sourceAdoptionRoot = await sourceAdoptionWorkspaceRoot(resolvedRoot);
  try {
    await stat(sourceAdoptionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: CheckRow[] = [];
  for (const adoptionId of await listSourceAdoptionStateIds(resolvedRoot)) {
    const directory = await adoptionRoot(resolvedRoot, adoptionId);
    try {
      const state = await readSourceAdoptionStateFromDirectory(directory, adoptionId);
      if (state.adoption_id !== adoptionId) {
        throw new FrameworkError(
          `state adoption id '${state.adoption_id}' does not match directory '${adoptionId}'`,
          { code: "INVALID_SOURCE_ADOPTION" },
        );
      }
      await listSourceAdoptionInspections(resolvedRoot, adoptionId);
      const evidence = await listSourceAdoptionEvidence(resolvedRoot, adoptionId);
      await assertSourceAdoptionStateHistoryIntegrity(resolvedRoot, adoptionId, state, evidence);
      rows.push({
        path: relativeDisplayPath(stateFile(directory), resolvedRoot),
        status: "ok",
        message: "Source adoption state and committed records are valid",
      });
    } catch (error) {
      rows.push({
        // Anchor the row to the file that actually failed. A damaged
        // inspection or evidence record must not be reported against
        // state.json, which is usually intact and is not what an operator
        // needs to look at.
        path: relativeDisplayPath(
          error instanceof SourceAdoptionRecordFileError ? error.file : stateFile(directory),
          resolvedRoot,
        ),
        status: "error",
        message: error instanceof Error ? error.message : "Source adoption state failed validation",
      });
    }

    // Records nothing references cannot invalidate committed history, so they
    // no longer abort the adoption — but they are still reported, against the
    // file that is actually damaged. Leaving them silent is how an interrupted
    // write or a tampered draft record becomes an unexplained failure later.
    for (const issue of await collectSourceAdoptionRecordIssues(resolvedRoot, adoptionId)) {
      rows.push({
        path: relativeDisplayPath(issue.file, resolvedRoot),
        status: "error",
        message: `${issue.message}. This record is not referenced by state.json, so committed history is unaffected; re-run the command that produced it or delete the file.`,
      });
    }
  }
  return rows;
}
