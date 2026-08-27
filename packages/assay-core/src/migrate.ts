import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { CURRENT_VERSION, MANAGED_DIR, MANIFEST_FILE, MIGRATABLE_VERSION } from "./constants.js";
import { FrameworkError, WorkspaceCutoverRequiredError } from "./errors.js";
import { stringifySortedJson } from "./serialization.js";
import { SOURCE_ADOPTION_SCHEMA, sourceAdoptionRecordSchema } from "./source-adoption/schemas.js";

/**
 * In-place migration from the previous release's on-disk shape.
 *
 * Assay is fail-closed about envelopes: a workspace written by an older version
 * is never loaded or half-understood. That rule stays. What this module adds is
 * one narrow door — the version immediately before this one can be rewritten
 * into the current shape by `assay update`, so a break in the record format does
 * not mean losing the record.
 *
 * The migration is a list of named steps. Each step reads and writes plain files
 * without going through the loaders, because the loaders refuse the old
 * envelope by design. Adding a step is how a later slice migrates a different
 * record kind: append it to {@link MIGRATION_STEPS} and it participates in the
 * same analysis, the same report, and the same one-shot application.
 */

export interface WorkspaceMigrationStep {
  readonly id: string;
  /** One line, in the imperative: what this step will do to the workspace. */
  readonly summary: string;
  /**
   * Rewrite the records this step owns. Returns one line per record touched,
   * for the update report; an empty array means the step had nothing to do.
   */
  readonly run: (context: WorkspaceMigrationContext) => Promise<string[]>;
}

export interface WorkspaceMigrationContext {
  readonly root: string;
  /** Workspace-relative sources directory, read from the raw manifest layout. */
  readonly sourcesRelative: string;
  readonly now: Date;
}

export interface WorkspaceMigrationAnalysis {
  readonly root: string;
  readonly required: boolean;
  readonly from: string;
  readonly to: string;
  readonly steps: readonly WorkspaceMigrationStep[];
}

export interface WorkspaceMigrationResult {
  readonly root: string;
  readonly from: string;
  readonly to: string;
  /** What each step actually changed, in the order the steps ran. */
  readonly changes: readonly string[];
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

async function readRawManifest(root: string): Promise<Record<string, unknown> | null> {
  const file = path.join(root, MANIFEST_FILE);
  if (!(await exists(file))) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    throw new FrameworkError(`workspace manifest is not valid JSON: ${file}`, { cause: error });
  }
}

function rawLayout(manifest: Record<string, unknown>): Record<string, unknown> | null {
  const layout = manifest.layout;
  return layout && typeof layout === "object" && !Array.isArray(layout)
    ? (layout as Record<string, unknown>)
    : null;
}

function rawSourcesRelative(manifest: Record<string, unknown>): string {
  const layout = rawLayout(manifest);
  const paths =
    layout?.paths && typeof layout.paths === "object" && !Array.isArray(layout.paths)
      ? (layout.paths as Record<string, unknown>)
      : null;
  const sources = paths?.sources;
  return typeof sources === "string" && sources.length > 0 ? sources : "sources";
}

function envelopeTuple(manifest: Record<string, unknown>): string {
  const layout = rawLayout(manifest);
  const version =
    typeof manifest.framework_version === "string" ? manifest.framework_version : "unknown";
  const schema = typeof manifest.__schema === "number" ? manifest.__schema : "unknown";
  const layoutVersion = typeof layout?.version === "number" ? layout.version : "unknown";
  return `${version}+s${schema}+l${layoutVersion}`;
}

/**
 * Whether this workspace needs — and can have — an in-place migration.
 *
 * A workspace already on the current version needs nothing. One on the previous
 * version is migratable. Anything else is refused here rather than in the middle
 * of a rewrite.
 */
export async function analyzeWorkspaceMigration(root: string): Promise<WorkspaceMigrationAnalysis> {
  const resolved = path.resolve(root);
  const manifest = await readRawManifest(resolved);
  const notRequired: WorkspaceMigrationAnalysis = {
    root: resolved,
    required: false,
    from: CURRENT_VERSION,
    to: CURRENT_VERSION,
    steps: [],
  };
  if (!manifest) return notRequired;
  const version = manifest.framework_version;
  if (version === CURRENT_VERSION) return notRequired;
  if (version !== MIGRATABLE_VERSION) {
    throw new WorkspaceCutoverRequiredError(envelopeTuple(manifest));
  }
  return {
    root: resolved,
    required: true,
    from: MIGRATABLE_VERSION,
    to: CURRENT_VERSION,
    steps: MIGRATION_STEPS,
  };
}

/**
 * Run every migration step, then stamp the new version.
 *
 * The version is written last on purpose: if a step fails, the workspace still
 * reads as the old version and the migration can be run again once the cause is
 * fixed, rather than being stranded halfway.
 */
export async function applyWorkspaceMigration(options: {
  readonly root: string;
  readonly now?: Date;
}): Promise<WorkspaceMigrationResult> {
  const analysis = await analyzeWorkspaceMigration(options.root);
  if (!analysis.required) {
    return { root: analysis.root, from: analysis.from, to: analysis.to, changes: [] };
  }
  const manifest = await readRawManifest(analysis.root);
  if (!manifest) {
    throw new FrameworkError(`workspace manifest disappeared during migration: ${analysis.root}`);
  }
  const context: WorkspaceMigrationContext = {
    root: analysis.root,
    sourcesRelative: rawSourcesRelative(manifest),
    now: options.now ?? new Date(),
  };
  const changes: string[] = [];
  for (const step of analysis.steps) {
    changes.push(...(await step.run(context)));
  }
  await writeFile(
    path.join(analysis.root, MANIFEST_FILE),
    stringifySortedJson({ ...manifest, framework_version: CURRENT_VERSION }),
    "utf8",
  );
  changes.push(`${MANIFEST_FILE}: framework_version ${analysis.from} -> ${analysis.to}`);
  return { root: analysis.root, from: analysis.from, to: analysis.to, changes };
}

/** Retired 0.13 lineage fields, and what replaces them. */
const RETIRED_LINEAGE = ["mode", "default_capture_mode"] as const;

interface LegacyObservation {
  readonly record: Record<string, unknown>;
  readonly id: string;
  readonly file: string;
}

async function readYamlRecord(file: string): Promise<Record<string, unknown>> {
  const parsed = parseYaml(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrameworkError(`source record is not a mapping: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

async function writeYamlRecord(file: string, record: Record<string, unknown>): Promise<void> {
  await writeFile(file, stringifyYaml(record), "utf8");
}

/** Drop keys rather than null them out, so the rewritten YAML has no ghost fields. */
function withoutFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));
}

async function legacyObservations(entryRoot: string): Promise<LegacyObservation[]> {
  const dir = path.join(entryRoot, "observations");
  if (!(await exists(dir))) return [];
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const records: LegacyObservation[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    records.push({ record: await readYamlRecord(file), id: name.replace(/\.yaml$/, ""), file });
  }
  return records;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn one 0.13 observation into a 0.14 ledger entry.
 *
 * An `archive` observation already preserved bytes, so it becomes exactly what
 * it always was: a capture, with its fingerprint carried into the capture block.
 * A `checkout` observation becomes a cheap append record; its tree hash has no
 * field to live in any more, so it is written into the note rather than dropped.
 */
function migrateObservationRecord(observation: LegacyObservation): Record<string, unknown> {
  const record = observation.record;
  const fingerprint =
    record.fingerprint &&
    typeof record.fingerprint === "object" &&
    !Array.isArray(record.fingerprint)
      ? (record.fingerprint as Record<string, unknown>)
      : null;
  const capturePath = asString(record.capture_path);
  const previous = asString(record.previous_observation);
  const treeHash = asString(fingerprint?.value);

  const notes: string[] = [];
  const captureMode = asString(record.capture_mode) ?? "checkout";
  if (capturePath) {
    notes.push(`captured content, migrated from ${MIGRATABLE_VERSION}`);
  } else {
    const vcs =
      record.vcs && typeof record.vcs === "object" && !Array.isArray(record.vcs)
        ? (record.vcs as Record<string, unknown>)
        : null;
    const commit = asString(vcs?.commit);
    notes.push(
      commit
        ? `observed at ${asString(vcs?.ref) ?? "HEAD"} ${commit.slice(0, 12)}`
        : "observed content",
    );
    if (treeHash) {
      notes.push(`${MIGRATABLE_VERSION} tree hash sha256-tree-v1:${treeHash}`);
    }
  }
  notes.push(`migrated from ${MIGRATABLE_VERSION} ${captureMode} observation`);

  const migrated: Record<string, unknown> = {
    observation_id: record.observation_id ?? observation.id,
    observed_on: record.observed_on,
    lineage_id: record.lineage_id,
    source_path: record.source_path,
    previous_observation: previous,
    kind: previous ? (capturePath ? "capture" : "sync") : "add",
    change_class: record.change_class ?? "normal",
    note: notes.join("; "),
    advisories: [],
  };
  if (record.vcs !== undefined) migrated.vcs = record.vcs;
  if (capturePath && treeHash && fingerprint) {
    migrated.capture = {
      path: capturePath,
      manifest: `captures/${observation.id}/manifest.json`,
      algorithm: "sha256-tree-v1",
      value: treeHash,
      file_count: fingerprint.file_count ?? 0,
      byte_count: fingerprint.byte_count ?? 0,
    };
  }
  return migrated;
}

/**
 * Give a migrated capture its own integrity manifest.
 *
 * 0.13 kept every manifest in `manifests/`, one per observation, whether or not
 * bytes were preserved. 0.14 keeps a manifest only where there are captured
 * bytes to prove, next to them. The old file stays where it is; this copies it
 * into place and rewrites its root to the capture's own path.
 */
async function installCaptureManifest(
  entryRoot: string,
  observationId: string,
  legacyManifest: string | null,
  capturePath: string,
): Promise<boolean> {
  if (!legacyManifest) return false;
  const source = path.join(entryRoot, legacyManifest);
  if (!(await exists(source))) return false;
  const target = path.join(entryRoot, "captures", observationId, "manifest.json");
  if (await exists(target)) return false;
  const parsed = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, stringifySortedJson({ ...parsed, root: capturePath }), "utf8");
  return true;
}

/**
 * Materialize `content/` for a source that has no upstream to follow.
 *
 * A 0.13 frozen source read its bytes from wherever it was added from, or from
 * its newest capture. 0.14 says copied content lives in the source, so the bytes
 * are brought inside. The order of preference is what the workspace can vouch
 * for: a non-Git `checkout/` this source already held, then its newest capture,
 * then the original path if it is still there.
 */
type CopiedContentOrigin = "checkout" | "capture" | "origin" | "empty";

async function materializeCopiedContent(
  entryRoot: string,
  sourceUri: string | null,
  legacyCheckout: string | null,
  newestCapture: string | null,
): Promise<CopiedContentOrigin> {
  const content = path.join(entryRoot, "content");
  if (legacyCheckout) {
    await rename(path.join(entryRoot, legacyCheckout), content);
    return "checkout";
  }
  await mkdir(content, { recursive: true });
  if (newestCapture) {
    const from = path.join(entryRoot, newestCapture);
    if (await exists(from)) {
      await cp(from, content, { recursive: true });
      return "capture";
    }
  }
  if (sourceUri && !sourceUri.includes("://") && (await exists(sourceUri))) {
    const info = await stat(sourceUri);
    if (info.isDirectory()) {
      await cp(sourceUri, content, { recursive: true });
      return "origin";
    }
    await cp(sourceUri, path.join(content, path.basename(sourceUri)));
    return "origin";
  }
  return "empty";
}

const COPIED_CONTENT_SOURCE: Record<CopiedContentOrigin, string> = {
  checkout: "filled from the bytes the source already held",
  capture: "filled from newest capture",
  origin: "filled from original source path",
  empty: "created empty; neither a capture nor the original path was available",
};

/**
 * `living|frozen` + `checkout|archive` collapse into one content mode.
 *
 * The flag is not translated so much as replaced by the truth on disk: a source
 * whose `checkout/` is a real Git working tree stays checkout-backed, and
 * anything else is bytes that were copied once, which is what `copy` names. 0.13
 * also let a plain directory be "living" with a copy-refresh; that arrangement
 * has no successor, so those become copied content and keep their bytes.
 */
const sourceContentModeStep: WorkspaceMigrationStep = {
  id: "sources-content-mode",
  summary: "rewrite source records: living|frozen modes become checkout|copy content",
  run: async (context) => {
    const sourcesRoot = path.join(context.root, context.sourcesRelative);
    if (!(await exists(sourcesRoot))) return [];
    const changes: string[] = [];
    for (const entry of (await readdir(sourcesRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const entryRoot = path.join(sourcesRoot, entry.name);
      const lineageFile = path.join(entryRoot, "source.yaml");
      if (!(await exists(lineageFile))) continue;
      const lineage = await readYamlRecord(lineageFile);
      if (typeof lineage.content_mode === "string") continue;

      const legacyMode = asString(lineage.mode) ?? "living";
      const legacyCapture = asString(lineage.default_capture_mode) ?? "checkout";
      const hasCheckout = await exists(path.join(entryRoot, "checkout"));
      const isGitCheckout = hasCheckout && (await exists(path.join(entryRoot, "checkout", ".git")));
      const contentMode: "checkout" | "copy" = isGitCheckout ? "checkout" : "copy";
      const relativeEntry = `${context.sourcesRelative}/${entry.name}`;

      const observations = await legacyObservations(entryRoot);
      let newestCapture: string | null = null;
      for (const observation of observations) {
        const migrated = migrateObservationRecord(observation);
        const capture = migrated.capture as { readonly path?: string } | undefined;
        if (capture?.path) {
          newestCapture = capture.path;
          await installCaptureManifest(
            entryRoot,
            observation.id,
            asString(observation.record.manifest),
            capture.path,
          );
        }
        await writeYamlRecord(observation.file, migrated);
      }
      if (observations.length > 0) {
        changes.push(
          `${relativeEntry}/observations: ${observations.length} entries rewritten as append records`,
        );
      }

      const retired =
        contentMode === "copy" ? [...RETIRED_LINEAGE, "checkout"] : [...RETIRED_LINEAGE];
      const nextLineage: Record<string, unknown> = {
        ...withoutFields(lineage, retired),
        content_mode: contentMode,
      };
      await writeYamlRecord(lineageFile, nextLineage);
      changes.push(
        `${relativeEntry}/source.yaml: ${legacyMode}/${legacyCapture} -> content_mode ${contentMode}`,
      );

      if (contentMode === "copy" && !(await exists(path.join(entryRoot, "content")))) {
        const origin = await materializeCopiedContent(
          entryRoot,
          asString(lineage.source_uri),
          hasCheckout ? "checkout" : null,
          newestCapture,
        );
        changes.push(`${relativeEntry}/content: ${COPIED_CONTENT_SOURCE[origin]}`);
      }
    }
    return changes;
  },
};

async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(file))) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    throw new FrameworkError(`Source adoption record is not valid JSON: ${file}`, { cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function countJsonFiles(directory: string): Promise<number> {
  if (!(await exists(directory))) return 0;
  return (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
}

/** A 0.13 mapping, paired with the target definition it points at. */
interface LegacyMapping {
  readonly id: string;
  readonly mode: string;
  readonly sourcePath: string;
  readonly sourceMatch: string;
  readonly targetId: string;
  readonly targetSystem: string;
  readonly targetPath: string;
  readonly targetMatch: string;
}

function legacyMappings(definition: Record<string, unknown>): LegacyMapping[] {
  const targets = new Map<string, string>();
  for (const entry of asArray(definition.targets)) {
    const target = asRecord(entry);
    const id = asString(target?.id);
    const system = asString(target?.system);
    if (id && system) targets.set(id, system);
  }
  const mappings: LegacyMapping[] = [];
  for (const entry of asArray(definition.mappings)) {
    const mapping = asRecord(entry);
    const id = asString(mapping?.id);
    const source = asRecord(mapping?.source);
    const target = asRecord(mapping?.target);
    const targetId = asString(target?.target_id);
    const sourcePath = asString(source?.path);
    const targetPath = asString(target?.path);
    if (!id || !targetId || !sourcePath || !targetPath) continue;
    const system = targets.get(targetId);
    if (!system) continue;
    mappings.push({
      id,
      mode: asString(mapping?.mode) ?? "adapt",
      sourcePath,
      sourceMatch: asString(source?.match) ?? "exact",
      targetId,
      targetSystem: system,
      targetPath,
      targetMatch: asString(target?.match) ?? "exact",
    });
  }
  return mappings;
}

/**
 * The tier-1 pin a 0.13 record can still vouch for.
 *
 * An accepted baseline snapshotted the source it was accepted against, so a
 * decided adoption carries a real identity: the commit when there was one, and
 * the tree hash otherwise. 0.13 never recorded the origin the commit came from,
 * so that stays null rather than being guessed. A draft adoption has no snapshot
 * and migrates without a pin, which is what it always was.
 */
function baselinePin(
  baseline: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const source = asRecord(baseline?.source);
  if (!source) return undefined;
  const commit = asString(source.vcs_commit);
  if (commit) return { kind: "git-commit", commit, origin: null };
  const fingerprint = asString(source.manifest_fingerprint);
  if (fingerprint) {
    return { kind: "content-hash", algorithm: "sha256-tree-v1", value: fingerprint };
  }
  return undefined;
}

/** The last committed decision for one target: outcome plus reason, nothing else. */
async function lastDecisionSummary(
  entryRoot: string,
  decisionIds: readonly string[],
  targetId: string,
): Promise<string | null> {
  for (const decisionId of [...decisionIds].reverse()) {
    const decision = await readJsonRecord(path.join(entryRoot, "decisions", `${decisionId}.json`));
    if (!decision || asString(decision.target_id) !== targetId) continue;
    const outcome = asString(decision.outcome);
    if (!outcome) continue;
    const reason = asString(decision.reason);
    return `last ${MIGRATABLE_VERSION} decision: ${outcome}${reason ? ` — ${reason}` : ""}`;
  }
  return null;
}

function adoptionSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : `x${slug}`;
}

/**
 * A free record id, derived from the old adoption and its mapping.
 *
 * A single-mapping adoption keeps its own id, which is what `take` derived in
 * the first place, so the common case migrates to the same name it had. Anything
 * else is disambiguated by mapping, and a collision takes a numeric suffix
 * rather than overwriting a record that is already there.
 */
async function freeAdoptionRecordFile(
  storeRoot: string,
  preferred: string,
): Promise<{ readonly id: string; readonly file: string }> {
  for (let index = 0; index < 100; index += 1) {
    const id = adoptionSlug((index === 0 ? preferred : `${preferred}-${index}`).slice(0, 128));
    const file = path.join(storeRoot, `${id}.json`);
    if (!(await exists(file))) return { id, file };
  }
  throw new FrameworkError(`could not find a free Source adoption record name for ${preferred}`);
}

/**
 * The 12-command adoption workflow collapses into one record per mapping.
 *
 * A 0.13 adoption was a definition plus a target-keyed state, with inspections,
 * evidence, decisions, and rollbacks accumulating beside it. 0.14 keeps only what
 * the record was for: this material, from that source, landed here. Each mapping
 * becomes its own record; the last decision survives as a sentence in the note,
 * because that is the part someone re-reads; the workflow chain does not, because
 * nothing reads it.
 *
 * The retired per-adoption directory is left exactly where it is. Nothing loads
 * it any more, and deleting a user's records during a migration is not this
 * step's call to make.
 */
const sourceAdoptionCollapseStep: WorkspaceMigrationStep = {
  id: "source-adoptions-collapse",
  summary: "collapse adoption records to one mapping each; drop the inspection/decision workflow",
  run: async (context) => {
    const storeRoot = path.join(context.root, MANAGED_DIR, "source-adoptions");
    if (!(await exists(storeRoot))) return [];
    const changes: string[] = [];
    for (const entry of (await readdir(storeRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const entryRoot = path.join(storeRoot, entry.name);
      const state = await readJsonRecord(path.join(entryRoot, "state.json"));
      if (!state) continue;
      const digest = asString(state.current_definition);
      const definition = digest
        ? await readJsonRecord(path.join(entryRoot, "definitions", `${digest}.json`))
        : null;
      if (!definition) {
        changes.push(
          `${MANAGED_DIR}/source-adoptions/${entry.name}: left in place; its current definition could not be read`,
        );
        continue;
      }

      const mappings = legacyMappings(definition);
      if (mappings.length === 0) {
        changes.push(
          `${MANAGED_DIR}/source-adoptions/${entry.name}: left in place; it declares no readable mapping`,
        );
        continue;
      }
      const sourceRef = asRecord(definition.source);
      const alias = asString(sourceRef?.alias);
      const observation = asString(sourceRef?.observation);
      if (!alias || !observation) {
        changes.push(
          `${MANAGED_DIR}/source-adoptions/${entry.name}: left in place; it names no source observation`,
        );
        continue;
      }
      const title = asString(definition.title);
      const stateTargets = asRecord(state.targets) ?? {};
      const decisionIds = asArray(state.decisions).filter(
        (value): value is string => typeof value === "string",
      );
      const recordedOn = asString(state.updated_at) ?? context.now.toISOString();

      const written: string[] = [];
      const refused: string[] = [];
      for (const mapping of mappings) {
        const preferred =
          mappings.length === 1 ? entry.name : `${entry.name}-${adoptionSlug(mapping.id)}`;
        const { id, file } = await freeAdoptionRecordFile(storeRoot, preferred);
        const baseline = asRecord(asRecord(stateTargets[mapping.targetId])?.baseline);
        const pin = baselinePin(baseline);
        const note = [
          title,
          await lastDecisionSummary(entryRoot, decisionIds, mapping.targetId),
          `migrated from ${MIGRATABLE_VERSION} adoption ${entry.name} mapping ${mapping.id}`,
        ]
          .filter((line): line is string => Boolean(line))
          .join("; ");
        // Validate before writing: a 0.13 field this step misread must not
        // become a record that only `assay check` finds out about.
        const candidate = sourceAdoptionRecordSchema.safeParse({
          schema: SOURCE_ADOPTION_SCHEMA,
          id,
          mode: mapping.mode === "copy" ? "copy" : "adapt",
          source: {
            alias,
            observation,
            path: mapping.sourcePath,
            match: mapping.sourceMatch === "prefix" ? "prefix" : "exact",
            ...(pin === undefined ? {} : { pin }),
          },
          target: {
            system: mapping.targetSystem,
            path: mapping.targetPath,
            match: mapping.targetMatch === "prefix" ? "prefix" : "exact",
          },
          note,
          recorded_on: recordedOn,
        });
        if (!candidate.success) {
          refused.push(mapping.id);
          continue;
        }
        await writeFile(file, stringifySortedJson(candidate.data), "utf8");
        written.push(id);
      }

      const dropped = [
        `${await countJsonFiles(path.join(entryRoot, "inspections"))} inspections`,
        `${await countJsonFiles(path.join(entryRoot, "evidence"))} evidence records`,
        `${decisionIds.length} decisions`,
      ].join(", ");
      changes.push(
        `${MANAGED_DIR}/source-adoptions/${entry.name}: ${mappings.length} mapping(s) -> ${written.length > 0 ? written.join(", ") : "nothing"}; dropped ${dropped}; retired directory left on disk`,
      );
      if (refused.length > 0) {
        changes.push(
          `${MANAGED_DIR}/source-adoptions/${entry.name}: could not rewrite mapping(s) ${refused.join(", ")}; the old directory still holds them`,
        );
      }
    }
    return changes;
  },
};

/**
 * Ordered migration steps. A later slice adds its record kind here; the update
 * command needs no change to run it.
 */
export const MIGRATION_STEPS: readonly WorkspaceMigrationStep[] = [
  sourceContentModeStep,
  sourceAdoptionCollapseStep,
];
