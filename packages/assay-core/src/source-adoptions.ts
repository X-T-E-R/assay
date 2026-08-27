/**
 * Public Source adoption surface.
 *
 * A Source adoption is one mapping: this material, from that source, landed
 * here. Records use Source-owned schema names and live under
 * `.assay/source-adoptions`. Product callers reach that store only through this
 * workspace-aware surface.
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
export type SourceAdoptionMatch = codec.SourceAdoptionMatch;
export type SourceAdoptionPathLocator = codec.SourceAdoptionPathLocator;
export type SourceAdoptionPin = codec.SourceAdoptionPin;
export type SourceAdoptionRecord = codec.SourceAdoptionRecord;
export type SourceAdoptionSourceRef = codec.SourceAdoptionSourceRef;
export type SourceAdoptionTargetRef = codec.SourceAdoptionTargetRef;
export type SourceAdoptionTakeResult = codec.TakeSourceAdoptionMaterialResult;
export type SourceAdoptionListResult = codec.SourceAdoptionListResult;
export type SourceAdoptionResult = codec.SourceAdoptionResult;
export type SourceAdoptionRemoveResult = codec.RemoveSourceAdoptionResult;
export type SourceAdoptionSummary = codec.SourceAdoptionSummary;
export type SourceAdoptionSourceMapping = codec.SourceAdoptionSourceMapping;

export const sourceAdoptionRecordSchema = codec.sourceAdoptionRecordSchema;
export const SOURCE_ADOPTION_SCHEMA = codec.SOURCE_ADOPTION_SCHEMA;

export function sourceAdoptionLocatorMatchesPath(
  locator: SourceAdoptionPathLocator,
  filePath: string,
): boolean {
  return codec.sourceAdoptionLocatorMatchesPath(locator, filePath);
}

export async function takeSourceAdoptionMaterial(options: codec.TakeSourceAdoptionMaterialOptions) {
  const root = await preflight(options.root);
  return withWorkspaceMutationCoordination(root, () =>
    codec.takeSourceAdoptionMaterial({ ...options, root }),
  );
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

export async function removeSourceAdoption(options: {
  readonly root: string;
  readonly adoptionId: string;
  readonly now?: Date;
}) {
  const root = await preflight(options.root);
  return withWorkspaceMutationCoordination(root, () =>
    codec.removeSourceAdoption({ ...options, root }),
  );
}

export async function listSourceAdoptionSourceMappings(root: string) {
  const resolved = await preflight(root);
  return codec.listSourceAdoptionSourceMappings(resolved);
}

export async function getSourceAdoptionSummary(root: string) {
  const resolved = await preflight(root);
  return codec.getSourceAdoptionSummary(resolved);
}

export async function collectSourceAdoptionIntegrityRows(root: string) {
  const resolved = await preflight(root);
  return codec.collectSourceAdoptionIntegrityRows(resolved);
}
