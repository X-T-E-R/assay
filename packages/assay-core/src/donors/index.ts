import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { appendEvent } from "../events.js";
import { relativeDisplayPath } from "../paths.js";
import type { CheckRow } from "../results.js";
import { stringifySortedJson } from "../serialization.js";
import { nowIso } from "../time.js";
import {
  DONOR_DECISION_SCHEMA,
  DONOR_EVIDENCE_SCHEMA,
  DONOR_INSPECTION_SCHEMA,
  DONOR_STATE_SCHEMA,
  type DonorAcceptedBaseline,
  type DonorAdoptionDefinition,
  type DonorDecision,
  type DonorDecisionOutcome,
  type DonorDiagnostic,
  type DonorEvidence,
  type DonorEvidenceInput,
  type DonorInspection,
  type DonorLocatorSnapshot,
  type DonorMappingInspection,
  type DonorPolicyEvaluation,
  type DonorState,
  donorAdoptionDefinitionSchema,
  donorDecisionSchema,
  donorEvidenceInputSchema,
  donorEvidenceSchema,
  donorInspectionSchema,
  donorStateSchema,
} from "./schemas.js";
import {
  sameLocatorSnapshot,
  sameTargetSnapshot,
  snapshotDonorSource,
  snapshotDonorTarget,
} from "./snapshots.js";
import {
  DonorRecordFileError,
  adoptionRoot,
  assertDonorId,
  assertNewAdoptionState,
  collectDonorRecordIssues,
  decisionFile,
  definitionFile,
  donorWorkspaceRoot,
  evidenceFile,
  inspectionFile,
  listDonorEvidence,
  listDonorInspections,
  listDonorStateIds,
  listDonorDecisions as listStoredDecisions,
  parseDonorValue,
  readDonorDecision,
  readDonorDefinition,
  readDonorInspection,
  readDonorState,
  readDonorStateFromDirectory,
  readStructuredFile,
  stateFile,
  withAdoptionLock,
  writeAtomicJson,
  writeImmutableJson,
} from "./storage.js";

export * from "./schemas.js";
export { snapshotManifestLocator } from "./snapshots.js";
export {
  type DonorLockStatus,
  DonorRecordFileError,
  collectDonorRecordIssues,
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
        code: "INVALID_DONOR",
      });
    }
    seen.add(value);
  }
}

function normalizeDefinition(value: unknown): DonorAdoptionDefinition {
  const parsed = parseDonorValue(donorAdoptionDefinitionSchema, value, "donor adoption definition");
  const normalized = {
    ...parsed,
    targets: [...parsed.targets].sort((a, b) => a.id.localeCompare(b.id)),
    mappings: [...parsed.mappings]
      .map((mapping) => ({ ...mapping, evidence: [...mapping.evidence].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...parsed.evidence].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return donorAdoptionDefinitionSchema.parse(normalized);
}

async function validateDefinition(
  root: string,
  definition: DonorAdoptionDefinition,
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
      throw new FrameworkError(`donor target '${target.id}' has no mappings`, {
        code: "INVALID_DONOR",
      });
    }
  }
  for (const mapping of definition.mappings) {
    if (!targetIds.has(mapping.target.target_id)) {
      throw new FrameworkError(
        `mapping '${mapping.id}' references unknown target '${mapping.target.target_id}'`,
        { code: "INVALID_DONOR" },
      );
    }
    for (const requirement of mapping.evidence) {
      if (!requirementIds.has(requirement)) {
        throw new FrameworkError(
          `mapping '${mapping.id}' references unknown evidence '${requirement}'`,
          { code: "INVALID_DONOR" },
        );
      }
    }
  }

  for (const target of definition.targets) {
    const source = await snapshotDonorSource(
      root,
      definition,
      target.id,
      definition.source.observation,
    );
    for (const [mappingId, snapshot] of Object.entries(source.locators)) {
      if (snapshot.state !== "present") {
        throw new FrameworkError(
          `source locator for mapping '${mappingId}' does not resolve in observation '${definition.source.observation}'`,
          { code: "INVALID_DONOR" },
        );
      }
    }
    // The registry record must exist. The target path and locators may remain
    // unresolved while the relationship is still a draft.
    await snapshotDonorTarget(root, definition, target.id);
  }
}

async function appendDonorEventBestEffort(
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

export interface RegisterDonorAdoptionOptions {
  readonly root: string;
  readonly definition: unknown;
  readonly now?: Date;
}

export interface RegisterDonorAdoptionFileOptions {
  readonly root: string;
  readonly file: string;
  readonly now?: Date;
}

export interface DonorDefinitionResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly definitionDigest: string;
  readonly definition: DonorAdoptionDefinition;
  readonly state: DonorState;
  readonly eventFile: string | null;
}

export async function registerDonorAdoption(
  options: RegisterDonorAdoptionOptions,
): Promise<DonorDefinitionResult> {
  const root = path.resolve(options.root);
  const definition = normalizeDefinition(options.definition);
  const now = options.now ?? new Date();
  await validateDefinition(root, definition);
  const digest = recordDigest(definition);

  return withAdoptionLock(root, definition.id, async (directory) => {
    await assertNewAdoptionState(directory, definition.id);
    const state = donorStateSchema.parse({
      schema: DONOR_STATE_SCHEMA,
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
    const eventFile = await appendDonorEventBestEffort(
      root,
      {
        event: "donor.registered",
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

export async function registerDonorAdoptionFromFile(
  options: RegisterDonorAdoptionFileOptions,
): Promise<DonorDefinitionResult> {
  return registerDonorAdoption({
    root: options.root,
    definition: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface UpdateDonorAdoptionOptions extends RegisterDonorAdoptionOptions {
  readonly adoptionId: string;
}

export async function updateDonorAdoption(
  options: UpdateDonorAdoptionOptions,
): Promise<DonorDefinitionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const definition = normalizeDefinition(options.definition);
  const now = options.now ?? new Date();
  if (definition.id !== adoptionId) {
    throw new FrameworkError(
      `definition id '${definition.id}' does not match adoption '${adoptionId}'`,
      { code: "INVALID_DONOR" },
    );
  }
  await validateDefinition(root, definition);
  const digest = recordDigest(definition);

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readDonorStateFromDirectory(directory, adoptionId);
    const previous = await readDonorDefinition(root, adoptionId, state.current_definition);
    if (previous.definition.source.alias !== definition.source.alias) {
      throw new FrameworkError(
        "a donor adoption cannot change source lineage; register a new adoption instead",
        { code: "INVALID_DONOR" },
      );
    }
    const targets = { ...state.targets };
    for (const target of definition.targets) {
      targets[target.id] ??= { baseline: null };
    }
    const nextState = donorStateSchema.parse({
      ...state,
      current_definition: digest,
      generation: state.generation + 1,
      targets,
      updated_at: nowIso(now),
    });
    await writeImmutableJson(definitionFile(directory, digest), definition);
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendDonorEventBestEffort(
      root,
      {
        event: "donor.definition.updated",
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

export async function updateDonorAdoptionFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly file: string;
  readonly now?: Date;
}): Promise<DonorDefinitionResult> {
  return updateDonorAdoption({
    root: options.root,
    adoptionId: options.adoptionId,
    definition: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function sourceChange(
  baseline: DonorLocatorSnapshot | null,
  candidate: DonorLocatorSnapshot,
): DonorMappingInspection["source"]["change"] {
  if (!baseline) return "activation";
  if (sameLocatorSnapshot(baseline, candidate)) return "no-direct-change";
  return candidate.state === "missing" ? "missing" : "direct-change";
}

function targetChange(
  baseline: DonorLocatorSnapshot | null,
  candidate: DonorLocatorSnapshot,
): DonorMappingInspection["target"]["change"] {
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
  source: DonorMappingInspection["source"]["change"],
  target: DonorMappingInspection["target"]["change"],
): DonorMappingInspection["facts"] {
  const facts: DonorMappingInspection["facts"][number][] = [];
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
  source: DonorMappingInspection["source"]["change"],
  target: DonorMappingInspection["target"]["change"],
): DonorDiagnostic[] {
  const diagnostics: DonorDiagnostic[] = [];
  if (source === "direct-change") {
    diagnostics.push({
      code: "donor.source.direct_change",
      severity: "info",
      mapping_id: mappingId,
      message: "declared source material changed directly",
    });
  } else if (source === "missing") {
    diagnostics.push({
      code: "donor.source.locator_missing",
      severity: "warning",
      mapping_id: mappingId,
      message: "declared source locator no longer resolves",
    });
  }
  if (target === "drifted") {
    diagnostics.push({
      code: "donor.target.drift",
      severity: "info",
      mapping_id: mappingId,
      message: "declared target material differs from its accepted baseline",
    });
  } else if (target === "missing") {
    diagnostics.push({
      code: "donor.target.locator_missing",
      severity: "warning",
      mapping_id: mappingId,
      message: "declared target locator does not currently resolve",
    });
  } else if (target === "unresolvable") {
    diagnostics.push({
      code: "donor.target.locator_unresolvable",
      severity: "error",
      mapping_id: mappingId,
      message: "declared target locator cannot be inspected safely",
    });
  }
  return diagnostics;
}

async function buildDonorInspection(input: {
  readonly root: string;
  readonly state: DonorState;
  readonly definition: DonorAdoptionDefinition;
  readonly definitionDigest: string;
  readonly targetId: string;
  readonly observation?: string;
  readonly now: Date;
}): Promise<DonorInspection> {
  const target = input.definition.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) {
    throw new FrameworkNotFoundError(
      `target '${input.targetId}' is not active in donor adoption '${input.definition.id}'`,
    );
  }
  const targetState = input.state.targets[input.targetId] ?? { baseline: null };
  const source = await snapshotDonorSource(
    input.root,
    input.definition,
    input.targetId,
    input.observation,
  );
  const targetSnapshot = await snapshotDonorTarget(input.root, input.definition, input.targetId);
  const mappings: DonorMappingInspection[] = [];
  const diagnostics: DonorDiagnostic[] = [];

  for (const mapping of input.definition.mappings.filter(
    (candidate) => candidate.target.target_id === input.targetId,
  )) {
    const candidateSource = source.locators[mapping.id];
    const candidateTarget = targetSnapshot.locators[mapping.id];
    if (!candidateSource || !candidateTarget) {
      throw new FrameworkError(`snapshot missing mapping '${mapping.id}'`, {
        code: "INVALID_DONOR",
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
      code: "donor.target.working_tree_dirty",
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
    schema: DONOR_INSPECTION_SCHEMA,
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
  return donorInspectionSchema.parse({
    ...content,
    id: recordId("inspection", content),
  });
}

export interface InspectDonorAdoptionOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId: string;
  readonly observation?: string;
  readonly now?: Date;
  readonly persist?: boolean;
}

export interface InspectDonorAdoptionResult {
  readonly root: string;
  readonly inspection: DonorInspection;
  readonly path: string | null;
  readonly created: boolean;
}

export async function inspectDonorAdoption(
  options: InspectDonorAdoptionOptions,
): Promise<InspectDonorAdoptionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const state = await readDonorState(root, adoptionId);
  const { definition, digest } = await readDonorDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  const inspection = await buildDonorInspection({
    root,
    state,
    definition,
    definitionDigest: digest,
    targetId: assertDonorId(options.targetId),
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

export interface RecordDonorEvidenceOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
  readonly evidence: unknown;
  readonly now?: Date;
}

export interface RecordDonorEvidenceResult {
  readonly root: string;
  readonly evidence: DonorEvidence;
  readonly path: string;
  readonly created: boolean;
}

export async function recordDonorEvidence(
  options: RecordDonorEvidenceOptions,
): Promise<RecordDonorEvidenceResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const inspection = await readDonorInspection(root, adoptionId, options.inspectionId);
  const input = parseDonorValue(donorEvidenceInputSchema, options.evidence, "donor evidence input");
  const recordedAt = nowIso(options.now ?? new Date());
  const content = {
    schema: DONOR_EVIDENCE_SCHEMA,
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
  const evidence = donorEvidenceSchema.parse({
    ...content,
    id: recordId("evidence", content),
  });
  const directory = await adoptionRoot(root, adoptionId);
  const file = evidenceFile(directory, evidence.id);
  const created = await writeImmutableJson(file, evidence);
  return { root, evidence, path: relativeDisplayPath(file, root), created };
}

export async function recordDonorEvidenceFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
  readonly file: string;
  readonly now?: Date;
}): Promise<RecordDonorEvidenceResult> {
  return recordDonorEvidence({
    root: options.root,
    adoptionId: options.adoptionId,
    inspectionId: options.inspectionId,
    evidence: await readStructuredFile(path.resolve(options.file)),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function evaluatePolicy(
  inspection: DonorInspection,
  evidence: readonly DonorEvidence[],
): DonorPolicyEvaluation {
  const latest = new Map<string, DonorEvidence>();
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

export interface VerifyDonorInspectionResult {
  readonly root: string;
  readonly inspection: DonorInspection;
  readonly current: boolean;
  readonly ok: boolean;
  readonly policy: DonorPolicyEvaluation;
  readonly evidence: readonly DonorEvidence[];
  readonly diagnostics: readonly DonorDiagnostic[];
}

async function verifyInspectionWithState(
  root: string,
  state: DonorState,
  inspection: DonorInspection,
): Promise<VerifyDonorInspectionResult> {
  const diagnostics: DonorDiagnostic[] = [];
  const { definition } = await readDonorDefinition(
    root,
    inspection.adoption_id,
    inspection.definition_digest,
  );
  const currentTargetState = state.targets[inspection.target_id] ?? { baseline: null };
  let current =
    state.current_definition === inspection.definition_digest &&
    (currentTargetState.baseline?.decision_id ?? null) === inspection.baseline_decision_id;

  const source = await snapshotDonorSource(
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
      code: "donor.inspection.source_stale",
      severity: "error",
      message: "source observation no longer matches the recorded inspection",
    });
  }
  const target = await snapshotDonorTarget(root, definition, inspection.target_id);
  if (!sameTargetSnapshot(target, inspection.target)) {
    current = false;
    diagnostics.push({
      code: "donor.inspection.target_stale",
      severity: "warning",
      message: "mapped target material changed after the inspection",
    });
  }
  if (state.current_definition !== inspection.definition_digest) {
    diagnostics.push({
      code: "donor.inspection.definition_stale",
      severity: "warning",
      message: "the donor definition changed after the inspection",
    });
  }
  if ((currentTargetState.baseline?.decision_id ?? null) !== inspection.baseline_decision_id) {
    diagnostics.push({
      code: "donor.inspection.baseline_stale",
      severity: "warning",
      message: "the target baseline changed after the inspection",
    });
  }

  const evidence = await listDonorEvidence(root, inspection.adoption_id, inspection.id);
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

export async function verifyDonorInspection(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
}): Promise<VerifyDonorInspectionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const state = await readDonorState(root, adoptionId);
  const inspection = await readDonorInspection(root, adoptionId, options.inspectionId);
  return verifyInspectionWithState(root, state, inspection);
}

export interface DecideDonorAdoptionOptions {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId: string;
  readonly outcome: Exclude<DonorDecisionOutcome, "rollback">;
  readonly inspectionId?: string;
  readonly observation?: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface DonorDecisionResult {
  readonly root: string;
  readonly decision: DonorDecision;
  readonly state: DonorState;
  readonly path: string;
  readonly inspectionPath: string;
  readonly eventFile: string | null;
}

export async function decideDonorAdoption(
  options: DecideDonorAdoptionOptions,
): Promise<DonorDecisionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const targetId = assertDonorId(options.targetId);
  const now = options.now ?? new Date();

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readDonorStateFromDirectory(directory, adoptionId);
    let inspection: DonorInspection;
    if (options.inspectionId) {
      inspection = await readDonorInspection(root, adoptionId, options.inspectionId);
      if (inspection.target_id !== targetId) {
        throw new FrameworkError(
          `inspection '${inspection.id}' belongs to target '${inspection.target_id}', not '${targetId}'`,
          { code: "INVALID_DONOR" },
        );
      }
    } else {
      const { definition, digest } = await readDonorDefinition(
        root,
        adoptionId,
        state.current_definition,
      );
      inspection = await buildDonorInspection({
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
          "donor inspection is stale; inspect the current source and target before accepting",
          { code: "DONOR_STALE", details: verification.diagnostics },
        );
      }
      const unresolvable = inspection.mappings.filter(
        (mapping) => mapping.target.candidate.state === "unresolvable",
      );
      if (unresolvable.length > 0) {
        throw new FrameworkError(
          `cannot bind an accepted baseline for unresolvable target mapping(s): ${unresolvable.map((mapping) => mapping.id).join(", ")}`,
          { code: "INVALID_DONOR" },
        );
      }
      if (verification.policy.required_missing.length > 0) {
        throw new FrameworkError(
          `required donor evidence has not passed: ${verification.policy.required_missing.join(", ")}`,
          {
            code: "DONOR_POLICY_BLOCKED",
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
    const baselineAfter: DonorAcceptedBaseline | null =
      options.outcome === "accept"
        ? {
            decision_id: decisionId,
            definition_digest: inspection.definition_digest,
            source: inspection.source,
            target: inspection.target,
            accepted_at: decidedAt,
          }
        : null;
    const decision = donorDecisionSchema.parse({
      schema: DONOR_DECISION_SCHEMA,
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
    const nextState = donorStateSchema.parse({
      ...state,
      generation: state.generation + 1,
      targets,
      decisions: [...state.decisions, decision.id],
      updated_at: decidedAt,
    });
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendDonorEventBestEffort(
      root,
      {
        event: `donor.${options.outcome}`,
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

export async function recordDonorRollback(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly decisionId: string;
  readonly reason?: string;
  readonly now?: Date;
}): Promise<DonorDecisionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const restoredFrom = assertDonorId(options.decisionId);
  const now = options.now ?? new Date();

  return withAdoptionLock(root, adoptionId, async (directory) => {
    const state = await readDonorStateFromDirectory(directory, adoptionId);
    if (!state.decisions.includes(restoredFrom)) {
      throw new FrameworkNotFoundError(`committed donor decision not found: ${restoredFrom}`);
    }
    const historical = await readDonorDecision(root, adoptionId, restoredFrom);
    if (!historical.baseline_after) {
      throw new FrameworkError(
        `decision '${restoredFrom}' does not identify an accepted baseline`,
        { code: "INVALID_DONOR" },
      );
    }
    const { definition } = await readDonorDefinition(
      root,
      adoptionId,
      historical.baseline_after.definition_digest,
    );
    const currentTarget = await snapshotDonorTarget(root, definition, historical.target_id);
    if (!sameTargetSnapshot(currentTarget, historical.baseline_after.target)) {
      throw new FrameworkError(
        "target mapped artifacts do not match the historical baseline; restore them outside Assay before recording rollback",
        { code: "DONOR_STALE" },
      );
    }

    const inspection = await buildDonorInspection({
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
    const baselineAfter: DonorAcceptedBaseline = {
      decision_id: decisionId,
      definition_digest: historical.baseline_after.definition_digest,
      source: historical.baseline_after.source,
      target: currentTarget,
      accepted_at: decidedAt,
    };
    const decision = donorDecisionSchema.parse({
      schema: DONOR_DECISION_SCHEMA,
      id: decisionId,
      ...seed,
      baseline_after: baselineAfter,
    });
    await writeImmutableJson(decisionFile(directory, decision.id), decision);
    const targets = { ...state.targets };
    targets[historical.target_id] = { baseline: baselineAfter };
    const nextState = donorStateSchema.parse({
      ...state,
      generation: state.generation + 1,
      targets,
      decisions: [...state.decisions, decision.id],
      updated_at: decidedAt,
    });
    await writeAtomicJson(stateFile(directory), nextState);
    const eventFile = await appendDonorEventBestEffort(
      root,
      {
        event: "donor.rollback.recorded",
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

export interface DonorAdoptionListEntry {
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

export interface DonorAdoptionListResult {
  readonly root: string;
  readonly adoptions: readonly DonorAdoptionListEntry[];
}

export async function listDonorAdoptions(options: {
  readonly root: string;
}): Promise<DonorAdoptionListResult> {
  const root = path.resolve(options.root);
  const entries: DonorAdoptionListEntry[] = [];
  for (const adoptionId of await listDonorStateIds(root)) {
    const state = await readDonorState(root, adoptionId);
    const { definition } = await readDonorDefinition(root, adoptionId, state.current_definition);
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

export interface DonorAdoptionResult {
  readonly root: string;
  readonly definition: DonorAdoptionDefinition;
  readonly definitionDigest: string;
  readonly state: DonorState;
}

export async function getDonorAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
}): Promise<DonorAdoptionResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const state = await readDonorState(root, adoptionId);
  const { definition, digest } = await readDonorDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  return { root, definition, definitionDigest: digest, state };
}

export interface DonorTargetStatus {
  readonly id: string;
  readonly system: string;
  readonly baselineDecision: string | null;
  readonly inspection: DonorInspection;
}

export interface DonorStatusResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly definitionDigest: string;
  readonly targets: readonly DonorTargetStatus[];
}

export async function getDonorStatus(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}): Promise<DonorStatusResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  const state = await readDonorState(root, adoptionId);
  const { definition, digest } = await readDonorDefinition(
    root,
    adoptionId,
    state.current_definition,
  );
  const targets = options.targetId
    ? definition.targets.filter((target) => target.id === assertDonorId(options.targetId as string))
    : definition.targets;
  if (targets.length === 0) {
    throw new FrameworkNotFoundError(
      `target '${options.targetId}' is not active in donor adoption '${adoptionId}'`,
    );
  }
  const result = [];
  for (const target of targets) {
    result.push({
      id: target.id,
      system: target.system,
      baselineDecision: state.targets[target.id]?.baseline?.decision_id ?? null,
      inspection: await buildDonorInspection({
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

export interface DonorHistoryResult {
  readonly root: string;
  readonly adoptionId: string;
  readonly decisions: readonly DonorDecision[];
}

export async function getDonorHistory(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}): Promise<DonorHistoryResult> {
  const root = path.resolve(options.root);
  const adoptionId = assertDonorId(options.adoptionId);
  return {
    root,
    adoptionId,
    decisions: await listStoredDecisions(root, adoptionId, options.targetId),
  };
}

export interface DonorSummary {
  readonly adoptions: number;
  readonly targets: number;
  readonly acceptedTargets: number;
  readonly draftTargets: number;
}

export async function getDonorSummary(root: string): Promise<DonorSummary | null> {
  const ids = await listDonorStateIds(path.resolve(root));
  if (ids.length === 0) return null;
  let targets = 0;
  let acceptedTargets = 0;
  for (const adoptionId of ids) {
    const state = await readDonorState(root, adoptionId);
    const { definition } = await readDonorDefinition(root, adoptionId, state.current_definition);
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

async function assertDonorStateHistoryIntegrity(
  root: string,
  adoptionId: string,
  state: DonorState,
  evidence: readonly DonorEvidence[],
): Promise<void> {
  const { definition } = await readDonorDefinition(root, adoptionId, state.current_definition);
  for (const target of definition.targets) {
    if (!state.targets[target.id]) {
      throw new FrameworkError(`donor state is missing active target '${target.id}'`, {
        code: "INVALID_DONOR",
      });
    }
  }

  const uniqueDecisionIds = new Set(state.decisions);
  if (uniqueDecisionIds.size !== state.decisions.length) {
    throw new FrameworkError("donor state contains duplicate committed decision ids", {
      code: "INVALID_DONOR",
    });
  }
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  const baselineByTarget = new Map(
    Object.keys(state.targets).map((targetId) => [targetId, null as string | null]),
  );
  let previousGeneration = -1;

  for (const decisionId of state.decisions) {
    const decision = await readDonorDecision(root, adoptionId, decisionId);
    if (!state.targets[decision.target_id]) {
      throw new FrameworkError(
        `donor decision '${decision.id}' references unknown state target '${decision.target_id}'`,
        { code: "INVALID_DONOR" },
      );
    }
    if (
      decision.state_generation <= previousGeneration ||
      decision.state_generation >= state.generation
    ) {
      throw new FrameworkError(
        `donor decision '${decision.id}' has inconsistent state generation ${decision.state_generation}`,
        { code: "INVALID_DONOR" },
      );
    }
    previousGeneration = decision.state_generation;

    const expectedBefore = baselineByTarget.get(decision.target_id) ?? null;
    if (decision.baseline_before !== expectedBefore) {
      throw new FrameworkError(
        `donor decision '${decision.id}' baseline_before does not match committed history`,
        { code: "INVALID_DONOR" },
      );
    }

    await readDonorDefinition(root, adoptionId, decision.definition_digest);
    const inspection = await readDonorInspection(root, adoptionId, decision.inspection_id);
    if (
      inspection.definition_digest !== decision.definition_digest ||
      inspection.target_id !== decision.target_id
    ) {
      throw new FrameworkError(
        `donor decision '${decision.id}' does not match inspection '${inspection.id}'`,
        { code: "INVALID_DONOR" },
      );
    }

    if (new Set(decision.evidence_ids).size !== decision.evidence_ids.length) {
      throw new FrameworkError(`donor decision '${decision.id}' contains duplicate evidence ids`, {
        code: "INVALID_DONOR",
      });
    }
    for (const evidenceId of decision.evidence_ids) {
      const record = evidenceById.get(evidenceId);
      if (!record) {
        throw new FrameworkError(
          `donor decision '${decision.id}' references missing evidence '${evidenceId}'`,
          { code: "INVALID_DONOR" },
        );
      }
      if (record.inspection_id !== inspection.id) {
        throw new FrameworkError(
          `donor decision '${decision.id}' references evidence '${evidenceId}' from another inspection`,
          { code: "INVALID_DONOR" },
        );
      }
    }

    const advancesBaseline = decision.outcome === "accept" || decision.outcome === "rollback";
    if (advancesBaseline !== (decision.baseline_after !== null)) {
      throw new FrameworkError(
        `donor decision '${decision.id}' has an invalid baseline_after for outcome '${decision.outcome}'`,
        { code: "INVALID_DONOR" },
      );
    }
    if ((decision.outcome === "rollback") !== (decision.restored_from_decision !== null)) {
      throw new FrameworkError(
        `donor decision '${decision.id}' has an invalid rollback reference`,
        { code: "INVALID_DONOR" },
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
          `donor decision '${decision.id}' baseline_after does not match its inspection`,
          { code: "INVALID_DONOR" },
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
        `donor state baseline for target '${targetId}' does not match committed history`,
        { code: "INVALID_DONOR" },
      );
    }
    if (targetState.baseline) {
      const decision = await readDonorDecision(root, adoptionId, targetState.baseline.decision_id);
      if (
        !decision.baseline_after ||
        recordDigest(targetState.baseline) !== recordDigest(decision.baseline_after)
      ) {
        throw new FrameworkError(
          `donor state baseline for target '${targetId}' does not match decision '${decision.id}'`,
          { code: "INVALID_DONOR" },
        );
      }
    }
  }
}

export async function collectDonorIntegrityRows(root: string): Promise<CheckRow[]> {
  const resolvedRoot = path.resolve(root);
  const donorRoot = await donorWorkspaceRoot(resolvedRoot);
  try {
    await stat(donorRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: CheckRow[] = [];
  for (const adoptionId of await listDonorStateIds(resolvedRoot)) {
    const directory = await adoptionRoot(resolvedRoot, adoptionId);
    try {
      const state = await readDonorStateFromDirectory(directory, adoptionId);
      if (state.adoption_id !== adoptionId) {
        throw new FrameworkError(
          `state adoption id '${state.adoption_id}' does not match directory '${adoptionId}'`,
          { code: "INVALID_DONOR" },
        );
      }
      await listDonorInspections(resolvedRoot, adoptionId);
      const evidence = await listDonorEvidence(resolvedRoot, adoptionId);
      await assertDonorStateHistoryIntegrity(resolvedRoot, adoptionId, state, evidence);
      rows.push({
        path: relativeDisplayPath(stateFile(directory), resolvedRoot),
        status: "ok",
        message: "donor state and committed records are valid",
      });
    } catch (error) {
      rows.push({
        // Anchor the row to the file that actually failed. A damaged
        // inspection or evidence record must not be reported against
        // state.json, which is usually intact and is not what an operator
        // needs to look at.
        path: relativeDisplayPath(
          error instanceof DonorRecordFileError ? error.file : stateFile(directory),
          resolvedRoot,
        ),
        status: "error",
        message: error instanceof Error ? error.message : "donor state failed validation",
      });
    }

    // Records nothing references cannot invalidate committed history, so they
    // no longer abort the adoption — but they are still reported, against the
    // file that is actually damaged. Leaving them silent is how an interrupted
    // write or a tampered draft record becomes an unexplained failure later.
    for (const issue of await collectDonorRecordIssues(resolvedRoot, adoptionId)) {
      rows.push({
        path: relativeDisplayPath(issue.file, resolvedRoot),
        status: "error",
        message: `${issue.message}. This record is not referenced by state.json, so committed history is unaffected; re-run the command that produced it or delete the file.`,
      });
    }
  }
  return rows;
}
