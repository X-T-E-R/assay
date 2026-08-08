/**
 * Public Source adoption surface.
 *
 * Operational records use Source-owned schema names and live under
 * `.assay/source-adoptions`. Product callers reach that store only through
 * this workspace-aware surface.
 */
import path from "node:path";

import { FrameworkNotFoundError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import * as codec from "./source-adoption/index.js";
import { withWorkspaceMutationCoordination } from "./tasks/task-storage.js";

async function preflight(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const manifest = await loadManifest(resolved);
  if (!manifest) throw new FrameworkNotFoundError(`No Assay manifest found: ${resolved}`);
  return resolved;
}

export const SOURCE_ADOPTION_TAKE_MODES = codec.SOURCE_ADOPTION_TAKE_MODES_CODEC;
export type SourceAdoptionTakeMode = codec.SourceAdoptionTakeMode;
export type SourceAdoptionDecisionOutcome = codec.SourceAdoptionDecisionOutcome;
export type SourceAdoptionDefinition = codec.SourceAdoptionDefinition;
export type SourceAdoptionPathLocator = codec.SourceAdoptionPathLocator;
export type SourceAdoptionInspection = codec.SourceAdoptionInspection;
export type SourceAdoptionDecision = codec.SourceAdoptionDecision;
export type SourceAdoptionState = codec.SourceAdoptionState;
export type SourceAdoptionEvidence = codec.SourceAdoptionEvidence;
export type SourceAdoptionDefinitionResult = codec.SourceAdoptionDefinitionResult;
export type SourceAdoptionTakeResult = codec.TakeSourceAdoptionMaterialResult;
export type SourceAdoptionInspectionResult = codec.InspectSourceAdoptionResult;
export type SourceAdoptionEvidenceResult = codec.RecordSourceAdoptionEvidenceResult;
export type SourceAdoptionVerificationResult = codec.VerifySourceAdoptionInspectionResult;
export type SourceAdoptionDecisionResult = codec.SourceAdoptionDecisionResult;
export type SourceAdoptionListResult = codec.SourceAdoptionListResult;
export type SourceAdoptionResult = codec.SourceAdoptionResult;
export type SourceAdoptionStatusResult = codec.SourceAdoptionStatusResult;
export type SourceAdoptionHistoryResult = codec.SourceAdoptionHistoryResult;
export type SourceAdoptionSummary = codec.SourceAdoptionSummary;
export type SourceAdoptionSourceMapping = codec.SourceAdoptionSourceMapping;

export const sourceAdoptionDefinitionSchema = codec.sourceAdoptionDefinitionSchema;
export function sourceAdoptionLocatorMatchesPath(
  locator: SourceAdoptionPathLocator,
  filePath: string,
): boolean {
  return codec.sourceAdoptionLocatorMatchesPath(locator, filePath);
}

export async function registerSourceAdoption(options: codec.RegisterSourceAdoptionOptions) {
  const root = await preflight(options.root);
  return codec.registerSourceAdoption({ ...options, root });
}

export async function registerSourceAdoptionFromFile(
  options: codec.RegisterSourceAdoptionFileOptions,
) {
  const root = await preflight(options.root);
  return codec.registerSourceAdoptionFromFile({ ...options, root });
}

export async function updateSourceAdoption(options: codec.UpdateSourceAdoptionOptions) {
  const root = await preflight(options.root);
  return codec.updateSourceAdoption({ ...options, root });
}

export async function updateSourceAdoptionFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly file: string;
  readonly now?: Date;
}) {
  const root = await preflight(options.root);
  return codec.updateSourceAdoptionFromFile({ ...options, root });
}

export async function takeSourceAdoptionMaterial(options: codec.TakeSourceAdoptionMaterialOptions) {
  const root = await preflight(options.root);
  return codec.takeSourceAdoptionMaterial({ ...options, root });
}

export async function listSourceAdoptionSourceMappings(root: string) {
  const resolved = await preflight(root);
  return codec.listSourceAdoptionSourceMappings(resolved);
}

export async function inspectSourceAdoption(options: codec.InspectSourceAdoptionOptions) {
  const root = await preflight(options.root);
  if (options.persist === false) return codec.inspectSourceAdoption({ ...options, root });
  return withWorkspaceMutationCoordination(root, () =>
    codec.inspectSourceAdoption({ ...options, root }),
  );
}

export async function recordSourceAdoptionEvidenceFromFile(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
  readonly file: string;
  readonly now?: Date;
}) {
  const root = await preflight(options.root);
  return withWorkspaceMutationCoordination(root, () =>
    codec.recordSourceAdoptionEvidenceFromFile({ ...options, root }),
  );
}

export async function recordSourceAdoptionEvidence(
  options: codec.RecordSourceAdoptionEvidenceOptions,
) {
  const root = await preflight(options.root);
  return withWorkspaceMutationCoordination(root, () =>
    codec.recordSourceAdoptionEvidence({ ...options, root }),
  );
}

export async function verifySourceAdoptionInspection(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly inspectionId: string;
}) {
  const root = await preflight(options.root);
  return codec.verifySourceAdoptionInspection({ ...options, root });
}

export async function decideSourceAdoption(options: codec.DecideSourceAdoptionOptions) {
  const root = await preflight(options.root);
  return codec.decideSourceAdoption({ ...options, root });
}

export async function recordSourceAdoptionRollback(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly decisionId: string;
  readonly reason?: string;
  readonly now?: Date;
}) {
  const root = await preflight(options.root);
  return codec.recordSourceAdoptionRollback({ ...options, root });
}

export async function listSourceAdoptions(options: { readonly root: string }) {
  const root = await preflight(options.root);
  return codec.listSourceAdoptions({ root });
}

export async function getSourceAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
}) {
  const root = await preflight(options.root);
  return codec.getSourceAdoption({ ...options, root });
}

export async function getSourceAdoptionStatus(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}) {
  const root = await preflight(options.root);
  return codec.getSourceAdoptionStatus({ ...options, root });
}

export async function getSourceAdoptionHistory(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly targetId?: string;
}) {
  const root = await preflight(options.root);
  return codec.getSourceAdoptionHistory({ ...options, root });
}

export async function getSourceAdoptionSummary(root: string) {
  const resolved = await preflight(root);
  return codec.getSourceAdoptionSummary(resolved);
}

export async function collectSourceAdoptionIntegrityRows(root: string) {
  const resolved = await preflight(root);
  return codec.collectSourceAdoptionIntegrityRows(resolved);
}
