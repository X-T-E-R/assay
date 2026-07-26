import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";

import { defaultAdrIndex, loadAdrIndex, saveAdrIndex } from "./adrs.js";
import {
  ASSAY_AGENTS_FILE,
  ASSAY_AGENTS_MALFORMED_REASON,
  type AssayAgentsBlockResult,
  applyAssayAgentsBlock,
  describeAssayAgentsBlockAction,
  planAssayAgentsBlock,
} from "./agents.js";
import {
  ADRS_FILE,
  LEGACY_MANAGED_DIR,
  MANAGED_DIR,
  MANIFEST_FILE,
  SYSTEMS_REGISTRY_FILE,
} from "./constants.js";
import { collectDonorIntegrityRows, getDonorSummary } from "./donors/index.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { fileHash } from "./hashing.js";
import {
  type WorkspaceArea,
  defaultStandaloneLayout,
  intentRootPath,
  resolveWorkspaceLayout,
  workspacePath,
  workspaceRelativePath,
  workspaceSubpath,
  workspaceTemplateRelativePath,
  workspaceWorkRelativePath,
} from "./layout.js";
import {
  defaultManifest,
  loadManifest,
  projectFromManifest,
  recordTemplate,
  saveManifest,
} from "./manifest.js";
import { relativeDisplayPath, resolveContainedPath, slugify } from "./paths.js";
import {
  type Archetype,
  type CapabilityModule,
  SUPPORTED_CAPABILITY_MODULES,
  archetypeHasCapability,
  capabilityDirectories,
  declaredCapabilities,
  dirsForArchetype,
  effectiveCapabilities,
  isCapabilityModule,
  loadArchetype,
  readInstalledArchetype,
  requireCapability,
  requireCapabilityModule,
} from "./profile.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "./results.js";
import type {
  AdrIndex,
  AdrRecord,
  FrameworkManifest,
  ProjectArchetype,
  ProjectMode,
  WorkspaceLayout,
} from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";
import {
  closeSourceObservationAnalysis,
  collectSourceHealthRows,
  getSourceStatus,
  resolveSourceObservation,
} from "./sources.js";
import { loadSystemsRegistry, resolveRegistryPath } from "./systems-registry.js";
import { archetypeTemplates, capabilityTemplates, mergeTemplateFiles } from "./templates.js";
import { nowIso } from "./time.js";
import {
  type SourceAdrSuggestion,
  type UpstreamStatus,
  adrSuggestionsForSources,
  collectUpstreamStatus,
} from "./upstream.js";
import { archetypeZones } from "./zones.js";

const GENERATED_REFERENCE_DIRS = new Set([
  ".venv",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".next",
]);

/**
 * Runtime template set for a workspace, resolved through its layout.
 *
 * Overlay workspaces keep every Assay-managed file under `.assay/`, so the
 * archetype's root-relative template paths are translated before `update` uses
 * them. Without the layout, `assay update` would create `README.md`,
 * `.gitignore`, `analyses/`, and `knowledge/` in an attached product
 * repository — the files `attach` deliberately leaves alone.
 *
 * Capability modules contribute their own templates, so files scaffolded by
 * `assay capability add` stay under update management instead of drifting
 * outside it. Callers that hold a manifest pass its `capabilities` list;
 * without it only the archetype's own modules contribute.
 */
export async function desiredRuntimeTemplates(
  project: string,
  archetype: ProjectArchetype,
  mode: ProjectMode,
  options: {
    readonly root?: string;
    readonly layout?: WorkspaceLayout;
    readonly capabilities?: readonly string[];
  } = {},
) {
  const archetypeDefinition = await loadArchetype(archetype, options);
  const capabilities = effectiveCapabilities(archetypeDefinition, options.capabilities);
  return mergeTemplateFiles(
    archetypeTemplates(project, mode, archetypeDefinition, options.layout),
    capabilityTemplates(project, mode, archetypeDefinition, capabilities, options.layout),
  );
}

export interface InitFrameworkOptions {
  readonly target: string;
  readonly name?: string;
  readonly git?: boolean;
  readonly force?: boolean;
  readonly createNew?: boolean;
  readonly agents?: boolean;
  /** Project archetype name. Built-ins and local/user YAML archetypes are resolved by the core loader. */
  readonly archetype?: ProjectArchetype;
}

export interface InitFrameworkResult {
  readonly root: string;
  readonly project: string;
  readonly archetype: ProjectArchetype;
  readonly mode: ProjectMode;
  readonly report: OperationReport;
}

/** How a capability module became available to a workspace. */
export type CapabilitySource = "archetype" | "added";

export interface AddCapabilityOptions {
  readonly root: string;
  /** Capability module name; validated against the supported set. */
  readonly module: string;
  readonly now?: Date;
}

export interface AddCapabilityResult {
  readonly root: string;
  readonly module: CapabilityModule;
  /** True when the workspace already had the module; nothing was written. */
  readonly alreadyEnabled: boolean;
  readonly source: CapabilitySource;
  readonly capabilities: readonly CapabilityModule[];
  readonly report: OperationReport;
  readonly eventFile?: string;
}

export interface CapabilityStatus {
  readonly module: string;
  readonly enabled: boolean;
  readonly source: CapabilitySource | null;
  /** False for a manifest entry this build cannot scaffold or gate. */
  readonly supported: boolean;
}

export interface ListCapabilitiesOptions {
  readonly root: string;
}

export interface ListCapabilitiesResult {
  readonly root: string;
  readonly project: string;
  readonly archetype: ProjectArchetype;
  readonly capabilities: readonly CapabilityStatus[];
}

export interface CheckFrameworkOptions {
  readonly root: string;
  /** Include non-blocking workflow and content reminders in addition to integrity checks. */
  readonly includeAdvisories?: boolean;
}

export interface CheckFrameworkResult {
  readonly root: string;
  readonly ok: boolean;
  readonly rows: CheckRow[];
  readonly manifest?: {
    readonly schema: number;
    readonly frameworkVersion: string;
    readonly format: string;
    readonly archetype: ProjectArchetype;
    readonly mode: ProjectMode;
    readonly managedFiles: number;
  };
  readonly systems?: {
    readonly primary: string | null;
    readonly total: number;
    readonly openIterations: number;
  };
}

export interface FrameworkZoneCount {
  readonly path: string;
  readonly files: number;
  /** What belongs in this zone; empty when the archetype does not declare it. */
  readonly purpose: string;
}

export interface FrameworkStatusSystem {
  readonly name: string;
  readonly status: string;
  readonly vcs: string;
  readonly version: string;
  readonly supersedes: readonly string[];
}

export interface FrameworkStatusLivingSources {
  readonly total: number;
  readonly openObservations: number;
  readonly suggestedAnalyses: number;
  readonly closedObservations: number;
  readonly majorRevalidations: number;
}

export interface FrameworkStatusDonors {
  readonly adoptions: number;
  readonly targets: number;
  readonly acceptedTargets: number;
  readonly draftTargets: number;
}

export interface GetFrameworkStatusOptions {
  readonly root: string;
  /**
   * Also compare each Git-backed source against its remote. Off by default:
   * `status` is a local-first command, and a failed fetch annotates the source
   * instead of failing the command.
   */
  readonly fetch?: boolean;
}

export interface FrameworkStatusResult {
  readonly root: string;
  readonly hasManifest: boolean;
  readonly installedVersion?: string;
  readonly layoutVersion?: number;
  readonly manifestFormat?: string;
  readonly project?: string;
  readonly archetype?: ProjectArchetype;
  /** The archetype's one-line description; omitted when it declares none. */
  readonly archetypeDescription?: string;
  /**
   * Why the installed archetype could not be resolved, when it could not be.
   * Zones fall back to the layout's work areas in that case, and this line is
   * what says so instead of leaving the shorter list unexplained.
   */
  readonly archetypeNotice?: string;
  readonly mode?: ProjectMode;
  readonly managedFiles: number;
  readonly zones: FrameworkZoneCount[];
  readonly systems?: readonly FrameworkStatusSystem[];
  readonly livingSources?: FrameworkStatusLivingSources;
  /** Drift of each living source's checkout; omitted when there are none. */
  readonly upstream?: UpstreamStatus;
  /** Sources whose latest change grade suggests recording a decision. */
  readonly adrSuggestions?: readonly SourceAdrSuggestion[];
  readonly donors?: FrameworkStatusDonors;
  readonly openIterations?: number;
  readonly knowledgeEntries?: number;
  /** Records in a workspace-root `runs.jsonl`; omitted when there is no file. */
  readonly runRecords?: number;
}

export interface AddReferenceOptions {
  readonly root: string;
  readonly source: string;
  readonly name: string;
  readonly now?: Date;
}

export interface AddReferenceResult {
  readonly root: string;
  readonly source: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface AbsorbReferenceOptions {
  readonly root: string;
  readonly source: string;
  readonly name?: string;
  readonly outlet?: AbsorptionOutlet;
  readonly now?: Date;
}

export interface AbsorbReferenceResult {
  readonly root: string;
  readonly source: string;
  readonly referencePath: string;
  readonly analysisPath: string;
  readonly eventFile: string;
}

export const ABSORPTION_OUTLETS = ["problem", "intake"] as const;
export type AbsorptionOutlet = (typeof ABSORPTION_OUTLETS)[number];

export interface CreateAnalysisOptions {
  readonly root: string;
  readonly title: string;
  /** Path of a frozen reference this analysis is bound to (relative to root). */
  readonly forReference?: string;
  /** Living source alias this analysis is bound to. */
  readonly forSource?: string;
  /** Observation id/path for a living source analysis. Defaults to latest. */
  readonly observation?: string;
  readonly now?: Date;
}

export interface CreateAnalysisResult {
  readonly root: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface StartIterationOptions {
  readonly root: string;
  readonly title: string;
  readonly now?: Date;
}

export interface StartIterationResult {
  readonly root: string;
  readonly path: string;
  readonly planPath: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface CaptureEventOptions {
  readonly root: string;
  readonly kind: string;
  readonly text: string;
  readonly now?: Date;
}

export interface CaptureEventResult {
  readonly root: string;
  readonly eventFile: string;
}

export type IterationResult = "applied" | "rejected" | "retest";

export interface CloseIterationOptions {
  readonly root: string;
  readonly selector: string;
  readonly result: IterationResult;
  readonly note?: string;
  readonly now?: Date;
}

export interface CloseIterationResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

export type AnalysisExit = "adopt" | "reject" | "experiment" | "adr";

export interface CloseAnalysisOptions {
  readonly root: string;
  readonly path: string;
  readonly exit: AnalysisExit;
  readonly note?: string;
  /** @deprecated Analysis close no longer applies mechanical content gates. */
  readonly allowEmpty?: boolean;
  readonly now?: Date;
}

export interface CloseAnalysisResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

export type KnowledgeType = "decision" | "pattern" | "guide" | "troubleshooting";

// Map each knowledge type to its directory name. Most types pluralize by
// appending "s", but "troubleshooting" is already the directory name used by
// the templates and constants (knowledge/troubleshooting/). Appending "s"
// here would create a parallel "knowledge/troubleshootings/" directory and
// split entries from their README — the bug this map exists to prevent.
const KNOWLEDGE_TYPE_DIRS: Record<KnowledgeType, string> = {
  decision: "decisions",
  pattern: "patterns",
  guide: "guides",
  troubleshooting: "troubleshooting",
};

export interface AddKnowledgeOptions {
  readonly root: string;
  readonly type: KnowledgeType;
  readonly title: string;
  readonly fromAnalysis?: string;
  readonly fromIteration?: string;
  readonly now?: Date;
}

export interface AddKnowledgeResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureDir(target: string, root: string, report: OperationReport): Promise<void> {
  const display = relativeDisplayPath(target, root);
  if (await exists(target)) {
    report.existing_dirs.push(display);
    return;
  }

  await mkdir(target, { recursive: true });
  report.created_dirs.push(display);
}

function dateStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function monthStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function requireManifest(manifest: FrameworkManifest | null, root: string): FrameworkManifest {
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}.`,
    );
  }
  return manifest;
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  if (!(await exists(root))) {
    return count;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(child);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function layoutForManifest(manifest: FrameworkManifest | null): WorkspaceLayout {
  return resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
}

function isWorkspaceArea(value: string): value is WorkspaceArea {
  return (
    value === "manifest" ||
    value === "events" ||
    value === "backups" ||
    value === "systemsRegistry" ||
    value === "adrsIndex" ||
    value === "references" ||
    value === "analyses" ||
    value === "iterations" ||
    value === "knowledge" ||
    value === "systemsContracts"
  );
}

function layoutDirectoryPath(layout: WorkspaceLayout, directory: string): string {
  return isWorkspaceArea(directory)
    ? workspaceRelativePath(layout, directory)
    : workspaceWorkRelativePath(layout, directory);
}

/** Workspace-root-relative directories owned by the given capability modules. */
function capabilityDirs(capabilities: readonly CapabilityModule[]): string[] {
  return capabilityDirectories(capabilities).map((directory) => directory.path);
}

/**
 * Capability modules a workspace actually has, for reporting paths that only
 * exist when a module is enabled. Falls back to the manifest's own list when
 * the archetype cannot be loaded, so a broken archetype hides structure rather
 * than failing the caller.
 */
async function enabledCapabilities(
  root: string,
  manifest: FrameworkManifest | null,
): Promise<CapabilityModule[]> {
  if (!manifest) {
    return [];
  }
  try {
    const archetypeDefinition = await loadArchetype(manifest.project.archetype, { root });
    return effectiveCapabilities(archetypeDefinition, manifest.project.capabilities);
  } catch {
    return declaredCapabilities(manifest);
  }
}

/**
 * Knowledge subdirectory names the workspace's archetype declares (both the
 * `dirs` and mode-specific lists), e.g. `knowledge/playbooks`. A custom
 * archetype owns these names, so `check` must not report them as drift.
 */
async function archetypeKnowledgeDirs(root: string): Promise<string[]> {
  try {
    const installedArchetype = await readInstalledArchetype(root);
    const archetypeDefinition = await loadArchetype(installedArchetype ?? "study", { root });
    const mode = await readFrameworkMode(root);
    const names: string[] = [];
    for (const directory of dirsForArchetype(archetypeDefinition, mode)) {
      const segments = directory.split("/");
      if (segments[0] === "knowledge" && segments[1]) {
        names.push(segments[1]);
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function countKnowledgeEntries(root: string, layout: WorkspaceLayout): Promise<number> {
  const knowledgeRoot = path.join(root, workspaceRelativePath(layout, "knowledge"));
  if (!(await exists(knowledgeRoot))) return 0;
  const files: string[] = [];
  await collectMarkdownFiles(knowledgeRoot, files);
  return files.filter((file) => {
    const basename = path.basename(file);
    return basename !== "README.md" && basename !== "ADR-TEMPLATE.md";
  }).length;
}

/**
 * An iteration counts as open when its plan header declares `Status: open`.
 * Reading and writing use the same header anchor, so `status` and
 * `iteration close` cannot disagree about which line holds the state.
 */
async function countOpenIterations(root: string, layout: WorkspaceLayout): Promise<number> {
  const iterationsDir = path.join(root, workspaceRelativePath(layout, "iterations"));
  if (!(await exists(iterationsDir))) {
    return 0;
  }

  let count = 0;
  const entries = await readdir(iterationsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const planPath = path.join(iterationsDir, entry.name, "plan.md");
    if (!(await exists(planPath))) continue;
    try {
      const content = await readFile(planPath, "utf8");
      if (readHeaderField(content, "Status")?.toLowerCase() === "open") {
        count += 1;
      }
    } catch {
      // skip unreadable plans
    }
  }
  return count;
}

const REQUIRED_ADR_FRONTMATTER_FIELDS = [
  "adr",
  "title",
  "status",
  "date",
  "supersedes",
  "superseded_by",
  "related_analysis",
  "related_iteration",
] as const;

function missingAdrFrontmatterFields(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return [...REQUIRED_ADR_FRONTMATTER_FIELDS];
  }
  const frontmatter = match[1];
  return REQUIRED_ADR_FRONTMATTER_FIELDS.filter((field) => {
    const pattern = new RegExp(`^${field}:`, "m");
    return !pattern.test(frontmatter);
  });
}

function recordAdrChainErrors(rows: CheckRow[], index: AdrIndex): void {
  for (const adr of Object.values(index.adrs)) {
    for (const oldId of adr.supersedes) {
      const oldAdr = index.adrs[oldId];
      if (!oldAdr) {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR '${adr.id}' supersedes missing ADR '${oldId}'`,
        });
        continue;
      }
      if (oldAdr.superseded_by !== adr.id) {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR supersedes link is not bidirectional: '${adr.id}' -> '${oldId}'`,
        });
      }
      if (oldAdr.status !== "superseded") {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR '${oldId}' is superseded by '${adr.id}' but status is '${oldAdr.status}'`,
        });
      }
    }

    if (!adr.superseded_by) {
      continue;
    }
    const replacement = index.adrs[adr.superseded_by];
    if (!replacement) {
      rows.push({
        path: ADRS_FILE,
        status: "error",
        message: `ADR '${adr.id}' points to missing superseded_by '${adr.superseded_by}'`,
      });
      continue;
    }
    if (!replacement.supersedes.includes(adr.id)) {
      rows.push({
        path: ADRS_FILE,
        status: "error",
        message: `ADR superseded_by link is not bidirectional: '${adr.id}' -> '${replacement.id}'`,
      });
    }
  }
}

function recordAdrCycleErrors(rows: CheckRow[], index: AdrIndex): void {
  const reported = new Set<string>();
  for (const start of Object.keys(index.adrs)) {
    const seen = new Set<string>();
    const order: string[] = [];
    let current: string | null = start;

    while (current) {
      if (seen.has(current)) {
        const cycleStart = order.indexOf(current);
        const cycle = [...order.slice(cycleStart), current].join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          rows.push({
            path: ADRS_FILE,
            status: "error",
            message: `ADR supersede chain has a cycle: ${cycle}`,
          });
        }
        break;
      }
      seen.add(current);
      order.push(current);
      const record: AdrRecord | undefined = index.adrs[current];
      if (!record?.superseded_by || !index.adrs[record.superseded_by]) {
        break;
      }
      current = record.superseded_by;
    }
  }
}

async function writeTemplateFile(
  root: string,
  templatePath: string,
  content: string,
  report: OperationReport,
  options: { readonly force: boolean; readonly createNew: boolean; readonly executable: boolean },
): Promise<"written" | "skipped" | "new-copy"> {
  const absolutePath = path.join(root, templatePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  if ((await exists(absolutePath)) && !options.force) {
    if (options.createNew) {
      const newPath = `${absolutePath}.new`;
      await writeFile(newPath, content, "utf8");
      report.new_copies.push(relativeDisplayPath(newPath, root));
      return "new-copy";
    }

    report.skipped_files.push(templatePath);
    return "skipped";
  }

  const existed = await exists(absolutePath);
  await writeFile(absolutePath, content, "utf8");
  if (options.executable) {
    const mode = (await stat(absolutePath)).mode;
    await chmod(absolutePath, mode | 0o755);
  }

  (existed ? report.updated_files : report.created_files).push(templatePath);
  return "written";
}

async function scaffoldAdrIndex(root: string, report: OperationReport): Promise<void> {
  const file = path.join(root, ADRS_FILE);
  if (await exists(file)) {
    report.skipped_files.push(ADRS_FILE);
    return;
  }
  await saveAdrIndex(root, defaultAdrIndex());
  report.created_files.push(ADRS_FILE);
}

/**
 * State a capability module needs beyond its template set. The ADR index is
 * generated JSON rather than a template, so it is written here instead of
 * through {@link MODULE_SCAFFOLDS}.
 */
async function scaffoldCapabilityState(
  root: string,
  capability: CapabilityModule,
  report: OperationReport,
): Promise<void> {
  if (capability === "adr") {
    await scaffoldAdrIndex(root, report);
  }
}

function recordAssayAgentsResult(report: OperationReport, result: AssayAgentsBlockResult): void {
  if (result.action === "skip") {
    if (result.reason === ASSAY_AGENTS_MALFORMED_REASON) {
      report.notes.push(describeAssayAgentsBlockAction(result));
    }
    return;
  }

  if (!result.changed || result.dryRun) {
    return;
  }

  if (result.action === "create") {
    report.created_files.push(result.path);
  } else if (result.action === "append" || result.action === "replace") {
    report.updated_files.push(result.path);
  }
}

export async function initFramework(options: InitFrameworkOptions): Promise<InitFrameworkResult> {
  const root = path.resolve(options.target);
  const project = options.name ?? path.basename(root);
  const report = createEmptyReport();

  const archetype = options.archetype ?? "study";
  const archetypeDefinition = await loadArchetype(archetype, { root });
  const mode = archetypeDefinition.mode;

  await ensureDir(root, root, report);

  let manifest = (await loadManifest(root)) ?? defaultManifest(project, { archetype, mode });
  manifest.project.archetype = archetype;
  manifest.project.mode = mode;

  // `init` always writes a standalone workspace, so archetype and capability
  // paths need no layout translation here.
  const capabilities = effectiveCapabilities(archetypeDefinition, manifest.project.capabilities);
  const directories = new Set([
    ...dirsForArchetype(archetypeDefinition, mode),
    ...capabilityDirs(capabilities),
  ]);
  for (const directory of directories) {
    await ensureDir(path.join(root, directory), root, report);
  }

  for (const template of mergeTemplateFiles(
    archetypeTemplates(project, mode, archetypeDefinition),
    capabilityTemplates(project, mode, archetypeDefinition, capabilities),
  )) {
    const result = await writeTemplateFile(root, template.path, template.content, report, {
      force: options.force ?? false,
      createNew: options.createNew ?? false,
      executable: template.executable,
    });
    if (result === "written") {
      recordTemplate(manifest, template);
    }
  }
  for (const capability of capabilities) {
    await scaffoldCapabilityState(root, capability, report);
  }

  const manifestExisted = await exists(path.join(root, MANIFEST_FILE));
  manifest = await saveManifest(root, manifest);
  (manifestExisted ? report.updated_files : report.created_files).push(MANIFEST_FILE);

  recordAssayAgentsResult(
    report,
    await applyAssayAgentsBlock({
      root,
      mode: options.agents === false ? "skip" : "install",
    }),
  );

  await appendEvent(root, {
    archetype,
    event: "framework.initialized",
    mode,
    project,
    version: manifest.framework_version,
  });

  if (options.git && !(await exists(path.join(root, ".git")))) {
    const result = await execa("git", ["init"], { cwd: root, reject: false });
    if (result.exitCode === 0) {
      report.notes.push("initialized root git repository");
    } else {
      report.notes.push(`git init failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  return { root, project, archetype, mode, report };
}

/**
 * Enable a capability module in an existing workspace.
 *
 * Enablement is decoupled from the init-time archetype choice: the module's
 * directories and templates are scaffolded through the workspace layout, its
 * state files are created, the manifest records the module, and a
 * `capability.added` event is written. Every step is idempotent, and a module
 * the workspace already has returns without writing anything, so re-running
 * the command is a no-op rather than an error.
 */
export async function addCapability(options: AddCapabilityOptions): Promise<AddCapabilityResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const module = requireCapabilityModule(options.module);
  const archetypeDefinition = await loadArchetype(manifest.project.archetype, { root });
  const layout = layoutForManifest(manifest);
  const report = createEmptyReport();
  const now = options.now ?? new Date();

  const alreadyDeclared = declaredCapabilities(manifest).includes(module);
  if (archetypeHasCapability(archetypeDefinition, module) || alreadyDeclared) {
    return {
      root,
      module,
      alreadyEnabled: true,
      source: alreadyDeclared ? "added" : "archetype",
      capabilities: effectiveCapabilities(archetypeDefinition, manifest.project.capabilities),
      report,
    };
  }

  // Archetype template paths are workspace-root-relative literals. An overlay
  // workspace keeps everything under `.assay/`, so both directories and
  // templates are translated before any write; otherwise `capability add`
  // would scaffold into an attached product repository's root.
  for (const directory of capabilityDirs([module])) {
    const relativePath = workspaceTemplateRelativePath(layout, directory);
    await ensureDir(path.join(root, relativePath), root, report);
  }

  const project = projectFromManifest(manifest, root);
  for (const template of capabilityTemplates(
    project,
    manifest.project.mode,
    archetypeDefinition,
    [module],
    layout,
  )) {
    const result = await writeTemplateFile(root, template.path, template.content, report, {
      force: false,
      createNew: false,
      executable: template.executable,
    });
    if (result === "written") {
      recordTemplate(manifest, template);
    }
  }
  await scaffoldCapabilityState(root, module, report);

  manifest.project.capabilities = [
    ...new Set([...(manifest.project.capabilities ?? []), module]),
  ].sort();
  const saved = await saveManifest(root, manifest);
  const eventFile = await appendEvent(
    root,
    {
      event: "capability.added",
      module,
      archetype: saved.project.archetype,
      capabilities: saved.project.capabilities ?? [],
    },
    now,
  );

  return {
    root,
    module,
    alreadyEnabled: false,
    source: "added",
    capabilities: effectiveCapabilities(archetypeDefinition, saved.project.capabilities),
    report,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

/**
 * Report every capability module and how this workspace obtained it: provided
 * by the archetype, added after init, or not enabled. Manifest entries this
 * build does not implement are listed as unsupported instead of being dropped.
 */
export async function listCapabilities(
  options: ListCapabilitiesOptions,
): Promise<ListCapabilitiesResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const archetypeDefinition = await loadArchetype(manifest.project.archetype, { root });
  const declared = new Set(manifest.project.capabilities ?? []);

  const capabilities: CapabilityStatus[] = SUPPORTED_CAPABILITY_MODULES.map((module) => {
    const fromArchetype = archetypeHasCapability(archetypeDefinition, module);
    const added = declared.has(module);
    return {
      module,
      enabled: fromArchetype || added,
      source: fromArchetype ? "archetype" : added ? "added" : null,
      supported: true,
    };
  });
  for (const module of declared) {
    if (!isCapabilityModule(module)) {
      capabilities.push({ module, enabled: false, source: "added", supported: false });
    }
  }

  return {
    root,
    project: manifest.project.name,
    archetype: manifest.project.archetype,
    capabilities,
  };
}

export async function checkFramework(
  options: CheckFrameworkOptions,
): Promise<CheckFrameworkResult> {
  const root = path.resolve(options.root);
  const includeAdvisories = options.includeAdvisories ?? false;

  // Resolve the workspace layout up front so checks point at the right paths
  // for both standalone (work folders at root) and overlay (work folders
  // under .assay/). If the manifest cannot be read, fall back to standalone.
  let manifestForLayout: FrameworkManifest | null = null;
  try {
    manifestForLayout = await loadManifest(root);
  } catch {
    // invalid manifest is reported below; use standalone fallback for paths
  }
  const layout = layoutForManifest(manifestForLayout);

  // Base structure check targets: always-required runtime files plus the
  // archetype-declared primary directories. systems/ and knowledge/ resolve
  // through the layout: standalone keeps them at root, overlay keeps them
  // under .assay/.
  const checkTargets: Array<readonly [string, string]> = [
    [`${MANAGED_DIR} directory`, MANAGED_DIR],
    [`${MANAGED_DIR}/VERSION`, `${MANAGED_DIR}/VERSION`],
    [`${MANAGED_DIR}/manifest.json`, `${MANAGED_DIR}/manifest.json`],
    ["systems directory", workspaceRelativePath(layout, "systemsContracts")],
    ["knowledge directory", workspaceRelativePath(layout, "knowledge")],
  ];

  // If a workspace declares its archetype, augment checks with that archetype's
  // top-level dirs (intake/, problem/, references/, analyses/, iterations/,
  // benchmarks/, attempts/...). Default to a permissive check when the
  // manifest/archetype cannot be read.
  const archetypeDegradations: CheckRow[] = [];
  try {
    const installedArchetype = await readInstalledArchetype(root);
    const archetypeDefinition = await loadArchetype(installedArchetype ?? "study", { root });
    const mode = await readFrameworkMode(root);
    const topLevels = new Set<string>();
    for (const d of dirsForArchetype(archetypeDefinition, mode)) {
      const top = d.split("/")[0];
      if (top && !top.startsWith(".") && top !== "systems" && top !== "knowledge") {
        topLevels.add(top);
      }
    }
    for (const dir of topLevels) {
      checkTargets.push([`${dir} directory`, layoutDirectoryPath(layout, dir)]);
    }
  } catch (error) {
    // The archetype is what tells check which directories this workspace is
    // supposed to have. Falling back to the base set silently made a workspace
    // whose archetype no longer resolves look fully checked, so say so.
    archetypeDegradations.push({
      path: MANIFEST_FILE,
      status: "warning",
      message: describeArchetypeDegradation(error),
    });
  }

  // Directories owned by capability modules the workspace added after init.
  // `capability add` scaffolds them, so a missing one is real drift. Modules
  // the archetype itself declares are left to the archetype's own directory
  // coverage: an overlay workspace may legitimately never have scaffolded
  // them, and reporting those as missing would be a false failure.
  const existingTargets = new Set(checkTargets.map(([, target]) => target));
  for (const capability of declaredCapabilities(manifestForLayout)) {
    for (const directory of capabilityDirs([capability])) {
      const target = workspaceTemplateRelativePath(layout, directory);
      if (!existingTargets.has(target)) {
        existingTargets.add(target);
        checkTargets.push([`${directory} directory`, target]);
      }
    }
  }
  const rows: CheckRow[] = [...archetypeDegradations];

  for (const [label, target] of checkTargets) {
    rows.push({
      path: target,
      status: (await exists(path.join(root, target))) ? "ok" : "missing",
      message: label,
    });
  }

  let manifest: FrameworkManifest | null = null;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    rows.push({
      path: MANIFEST_FILE,
      status: "error",
      message: error instanceof Error ? error.message : "manifest failed validation",
    });
  }

  if (manifest) {
    rows.push({
      path: MANIFEST_FILE,
      status: "ok",
      message: `manifest schema ${manifest.__schema}; archetype ${manifest.project.archetype}; mode ${manifest.project.mode}`,
    });

    // Semantic check 1: managed file existence + hash consistency
    for (const [filePath, record] of Object.entries(manifest.managed_files)) {
      const absolutePath = path.join(root, filePath);
      if (!(await exists(absolutePath))) {
        rows.push({
          path: filePath,
          status: "error",
          message: `managed file missing (template: ${record.template_id})`,
        });
        continue;
      }
      try {
        const currentHash = await fileHash(absolutePath);
        if (currentHash !== record.hash) {
          rows.push({
            path: filePath,
            status: "warning",
            message: "modified by user (hash differs from manifest)",
          });
        }
      } catch {
        rows.push({
          path: filePath,
          status: "warning",
          message: "could not read file for hash check",
        });
      }
    }
  } else if (!rows.some((row) => row.path === MANIFEST_FILE && row.status === "error")) {
    rows.push({ path: MANIFEST_FILE, status: "missing", message: "readable manifest" });
  }

  // Semantic check 2: systems registry consistency
  let primaryName: string | null = null;
  let systemCount = 0;
  let openIterations = 0;
  try {
    const registry = await loadSystemsRegistry(root);
    if (registry) {
      primaryName = registry.primary;
      systemCount = Object.keys(registry.systems).length;

      // Check primary uniqueness
      const primaries = Object.values(registry.systems).filter((s) => s.status === "primary");
      if (primaries.length === 0 && registry.primary !== null) {
        rows.push({
          path: SYSTEMS_REGISTRY_FILE,
          status: "error",
          message: `registry primary is '${registry.primary}' but no system has status: primary`,
        });
      } else if (primaries.length > 1) {
        rows.push({
          path: SYSTEMS_REGISTRY_FILE,
          status: "error",
          message: `expected exactly one primary system, found ${primaries.length}: ${primaries.map((s) => s.name).join(", ")}`,
        });
      }

      // Check each active/primary system exists on disk. Registry paths are
      // workspace-relative for systems inside the workspace and absolute for
      // systems outside it, so they are resolved rather than joined.
      for (const system of Object.values(registry.systems)) {
        if (system.status === "archived") {
          if (system.archive_path) {
            const archivePath = resolveRegistryPath(root, system.archive_path);
            if (!(await exists(archivePath))) {
              rows.push({
                path: system.archive_path,
                status: "error",
                message: `archived system '${system.name}' has no archive on disk`,
              });
            }
          } else {
            rows.push({
              path: SYSTEMS_REGISTRY_FILE,
              status: "error",
              message: `archived system '${system.name}' records no archive_path`,
            });
          }
          continue;
        }
        const systemPath = resolveRegistryPath(root, system.path);
        if (!(await exists(systemPath))) {
          rows.push({
            path: system.path,
            status: "error",
            message: `registered system '${system.name}' missing on disk`,
          });
        }
        if (system.contract_file) {
          const contractPath = resolveRegistryPath(root, system.contract_file);
          if (!(await exists(contractPath))) {
            rows.push({
              path: system.contract_file,
              status: "warning",
              message: `contract file missing for system '${system.name}'`,
            });
          }
        }
        if (system.vcs === "independent-git") {
          if (!(await exists(path.join(systemPath, ".git")))) {
            rows.push({
              path: system.path,
              status: "warning",
              message: `system '${system.name}' declared independent-git but no .git found`,
            });
          }
        }
      }
    }
  } catch (error) {
    rows.push({
      path: SYSTEMS_REGISTRY_FILE,
      status: "error",
      message: error instanceof Error ? error.message : "systems registry error",
    });
  }

  // Semantic check 3: open iterations
  try {
    openIterations = await countOpenIterations(root, layout);
    if (includeAdvisories && openIterations > 0) {
      rows.push({
        path: `${workspaceRelativePath(layout, "iterations")}/`,
        status: "warning",
        message: `${openIterations} iteration(s) not closed (Status: open)`,
      });
    }
  } catch {
    // iterations directory may not exist; skip
  }

  // Semantic check 4: ADR index and supersede chain consistency
  try {
    const adrIndex = await loadAdrIndex(root);
    if (adrIndex) {
      for (const adr of Object.values(adrIndex.adrs)) {
        const adrPath = path.join(root, adr.path);
        if (!(await exists(adrPath))) {
          rows.push({
            path: adr.path,
            status: "error",
            message: `indexed ADR '${adr.id}' missing on disk`,
          });
          continue;
        }
        try {
          const content = await readFile(adrPath, "utf8");
          const missingFields = missingAdrFrontmatterFields(content);
          if (missingFields.length > 0) {
            rows.push({
              path: adr.path,
              status: "warning",
              message: `ADR frontmatter missing: ${missingFields.join(", ")}`,
            });
          }
        } catch {
          rows.push({
            path: adr.path,
            status: "warning",
            message: `could not read ADR '${adr.id}' for frontmatter check`,
          });
        }
      }
      recordAdrChainErrors(rows, adrIndex);
      recordAdrCycleErrors(rows, adrIndex);
    }
  } catch (error) {
    rows.push({
      path: ADRS_FILE,
      status: "error",
      message: error instanceof Error ? error.message : "ADR index error",
    });
  }

  // Semantic check 5: knowledge directory-name consistency
  // The framework owns the base knowledge subdirectory names (decisions,
  // patterns, guides, troubleshooting). A legacy bug appended "s" to every
  // knowledge type, producing a parallel "knowledge/troubleshootings/"
  // directory that split troubleshooting entries from their README. Flag any
  // knowledge subdirectory that is neither a base name nor declared by the
  // workspace's archetype, so real drift is visible while a custom archetype's
  // own knowledge folders stay clean.
  try {
    const knowledgeRoot = workspacePath(root, layout, "knowledge");
    if (await exists(knowledgeRoot)) {
      const expectedKnowledgeDirs = new Set([
        "decisions",
        "patterns",
        "guides",
        "troubleshooting",
        "templates",
        "evaluations",
        ...(await archetypeKnowledgeDirs(root)),
      ]);
      const entries = await readdir(knowledgeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!expectedKnowledgeDirs.has(entry.name)) {
          rows.push({
            path: workspaceSubpath(layout, "knowledge", entry.name),
            status: "warning",
            message: `unexpected knowledge subdirectory '${entry.name}' (expected one of: ${[...expectedKnowledgeDirs].join(", ")}). A legacy bug created 'troubleshootings'; move entries into 'knowledge/troubleshooting/'.`,
          });
        }
      }
    }
  } catch {
    // knowledge dir may not exist; skip
  }

  // Advisory check 1: frozen references with no case file.
  //
  // This replaces the old `analyzed` gate, which was true nowhere and blocked
  // nothing. The real gap it hid is a frozen directory with no
  // `reference.yaml`: v3-era freezes carry no provenance at all, so nothing
  // downstream can say where the material came from or when it was captured.
  if (includeAdvisories) {
    try {
      const frozenRoot = path.join(workspacePath(root, layout, "references"), "frozen");
      if (await exists(frozenRoot)) {
        for (const ref of await collectFrozenReferences(root, frozenRoot)) {
          if (await exists(path.join(root, ref.relativePath, "reference.yaml"))) continue;
          rows.push({
            path: ref.relativePath,
            status: "warning",
            message: `frozen reference '${ref.name}' has no reference.yaml, so its provenance is not recorded. Write one with \`assay reference backfill ${ref.relativePath}\`.`,
          });
        }
      }
    } catch {
      // references/frozen may not exist; skip
    }
  }

  // Advisory check 2: empty draft analyses.
  if (includeAdvisories) {
    try {
      const analysesRoot = workspacePath(root, layout, "analyses");
      if (await exists(analysesRoot)) {
        const emptyDrafts = await findEmptyDraftAnalyses(root, analysesRoot);
        for (const draft of emptyDrafts) {
          rows.push({
            path: draft.relativePath,
            status: "warning",
            message: `analysis '${draft.relativePath}' is still a draft with empty 'Key observations'`,
          });
        }
      }
    } catch {
      // analyses dir may not exist; skip
    }
  }

  // Advisory check 3: adoption archives that still contain staged material.
  if (includeAdvisories) {
    try {
      const oldRoot = path.join(root, ".old");
      if (await exists(oldRoot)) {
        const entries = await readdir(oldRoot, { withFileTypes: true });
        const stamps = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        if (stamps.length > 0) {
          rows.push({
            path: ".old",
            status: "warning",
            message: `adoption archive .old/ still contains ${stamps.length} stamp(s): ${stamps.join(", ")}. Move archived artifacts into the new structure or confirm cleanup.`,
          });
        }
      }
    } catch {
      // .old may not exist; skip
    }
  }

  // Advisory check 4: pending queue entries.
  if (includeAdvisories) {
    try {
      const queueCandidates = [
        path.join(root, MANAGED_DIR, "queue.json"),
        path.join(root, LEGACY_MANAGED_DIR, "queue.json"),
      ];
      for (const queuePath of queueCandidates) {
        if (!(await exists(queuePath))) continue;
        const raw = await readFile(queuePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const pending = countPendingQueueEntries(parsed);
        if (pending > 0) {
          rows.push({
            path: relativeDisplayPath(queuePath, root),
            status: "warning",
            message: `queue has ${pending} pending entry/entries. Process or prune them when useful.`,
          });
        }
      }
    } catch {
      // queue may be missing or unreadable; skip
    }
  }

  // Advisory check 5: intent captured into an unversioned private overlay.
  // A private overlay keeps `.assay/` out of the product repository and gives
  // it no history of its own, and intent captures are the least regenerable
  // records Assay holds: nothing else can reconstruct what was originally
  // asked for. Recommending `private-git` is a workspace-setup suggestion,
  // never a failure.
  if (includeAdvisories && layout.mode === "overlay" && layout.privacy === "private") {
    try {
      if ((await enabledCapabilities(root, manifestForLayout)).includes("intent")) {
        rows.push({
          path: intentRootPath(layout),
          status: "warning",
          message:
            "intent is enabled in a private overlay, so captures live in the one directory that has no version history. Re-attach with `--privacy private-git`, or initialize a Git repository inside .assay/, so captured intent can be recovered.",
        });
      }
    } catch {
      // capability state is reported elsewhere; skip the advisory
    }
  }

  // Advisory check 6: superseded systems no chain points at. `system promote`
  // demotes the previous primary without writing a supersedes link, so an
  // unreferenced superseded system is unreachable from the current primary and
  // its intent captures drop out of `intent list --include-lineage`.
  if (includeAdvisories) {
    try {
      const registry = await loadSystemsRegistry(root);
      if (registry) {
        const referenced = new Set(
          Object.values(registry.systems).flatMap((system) => system.supersedes),
        );
        for (const system of Object.values(registry.systems)) {
          if (system.status === "superseded" && !referenced.has(system.name)) {
            rows.push({
              path: SYSTEMS_REGISTRY_FILE,
              status: "warning",
              message: `system '${system.name}' is superseded but no system records it in a supersedes chain, so its lineage cannot be followed. Record the replacement with \`assay system update <replacement> --supersedes ${system.name}\`.`,
            });
          }
        }
      }
    } catch {
      // registry problems are reported by the structural registry check
    }
  }

  // Advisory check 7: placement. `check` has always validated that declared
  // directories exist; these three report the opposite — content sitting where
  // the archetype never said it should. They are advisories on purpose:
  // writing straight into a directory instead of going through a command is
  // normal usage, and the goal is to make misplacement visible and fixable
  // rather than to fail the workspace over it.
  if (includeAdvisories) {
    rows.push(...(await collectPlacementAdvisories(root, layout, manifestForLayout)));
  }

  // Advisory check 8: the AGENTS.md managed block no longer matches the
  // archetype. The block is generated, so an archetype whose directories or
  // description changed leaves stale layout guidance in the one channel that
  // reaches an agent before it does anything.
  if (includeAdvisories) {
    try {
      const agentsPlan = await planAssayAgentsBlock({ root, mode: "refresh-existing" });
      if (agentsPlan.changed && agentsPlan.action === "replace") {
        rows.push({
          path: ASSAY_AGENTS_FILE,
          status: "warning",
          message:
            "Assay managed block in AGENTS.md does not match the current archetype. Run `assay update --agents` to refresh the workspace layout table.",
        });
      }
    } catch {
      // AGENTS.md problems are reported by update; never fail check over them
    }
  }

  // Semantic check 6: living source observation integrity. Major-change
  // revalidation is an opt-in advisory; missing referenced records remain
  // visible in the default structural check.
  // New-style external sources live at references/<source>/ with source.yaml
  // plus an observation ledger under .assay/.
  try {
    rows.push(...(await collectSourceHealthRows(root, { includeAdvisories })));
  } catch (error) {
    rows.push({
      path: workspaceRelativePath(layout, "references"),
      status: "error",
      message:
        error instanceof Error ? error.message : "source observation state failed validation",
    });
  }

  // Semantic check 7: donor persistence integrity. Ordinary source/target
  // changes and advisory evidence intentionally stay out of global check.
  try {
    rows.push(...(await collectDonorIntegrityRows(root)));
  } catch (error) {
    rows.push({
      path: `${MANAGED_DIR}/donors`,
      status: "error",
      message: error instanceof Error ? error.message : "donor state failed validation",
    });
  }

  return {
    root,
    ok: rows.every((row) => row.status === "ok" || row.status === "warning"),
    rows,
    ...(manifest
      ? {
          manifest: {
            schema: manifest.__schema,
            frameworkVersion: manifest.framework_version,
            format: `schema ${manifest.__schema}; archetype ${manifest.project.archetype}; mode ${manifest.project.mode}`,
            archetype: manifest.project.archetype,
            mode: manifest.project.mode,
            managedFiles: Object.keys(manifest.managed_files).length,
          },
        }
      : {}),
    ...(systemCount > 0 || primaryName !== null || openIterations > 0
      ? { systems: { primary: primaryName, total: systemCount, openIterations } }
      : {}),
  };
}

/**
 * Directories under a work root that belong to Assay's own machinery rather
 * than to an archetype. In an overlay workspace the work root and the state
 * root are the same directory, so these sit next to the work folders and must
 * not be reported as stray placement.
 */
const NON_ZONE_WORK_ROOT_ENTRIES = new Set(["donors", "archetypes", "node_modules"]);

/**
 * Name of the work-root entry a workspace-root-relative path sits under, or
 * null when the path lies outside the work root.
 */
function workRootEntryName(layout: WorkspaceLayout, rootRelativePath: string): string | null {
  const normalized = rootRelativePath.replace(/\\/g, "/");
  if (layout.work_root === ".") {
    return normalized.split("/")[0] ?? null;
  }
  const prefix = `${layout.work_root.replace(/\\/g, "/")}/`;
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  return normalized.slice(prefix.length).split("/")[0] ?? null;
}

/**
 * Placement advisories: content that exists where the archetype never declared
 * a home for it. Every row is a warning, never an error.
 */
async function collectPlacementAdvisories(
  root: string,
  layout: WorkspaceLayout,
  manifest: FrameworkManifest | null,
): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  rows.push(...(await collectUndeclaredDirectoryRows(root, layout, manifest)));
  rows.push(...(await collectStatuslessAnalysisRows(root, layout)));
  return rows;
}

/**
 * Top-level directories in the workspace's work root that neither the
 * archetype nor the layout accounts for. This is the Loreal case: material
 * piling up somewhere the workspace has no semantics for.
 */
async function collectUndeclaredDirectoryRows(
  root: string,
  layout: WorkspaceLayout,
  manifest: FrameworkManifest | null,
): Promise<CheckRow[]> {
  if (!manifest) {
    return [];
  }
  let archetype: Archetype;
  try {
    archetype = await loadArchetype(manifest.project.archetype, { root });
  } catch {
    return [];
  }

  const capabilities = effectiveCapabilities(archetype, manifest.project.capabilities);
  const declared = new Set<string>(NON_ZONE_WORK_ROOT_ENTRIES);
  for (const directory of [
    ...dirsForArchetype(archetype, manifest.project.mode),
    ...capabilityDirs(capabilities),
  ]) {
    const name = workRootEntryName(layout, workspaceTemplateRelativePath(layout, directory));
    if (name) {
      declared.add(name);
    }
  }
  // Work areas and state files the layout itself owns. In an overlay these are
  // children of the work root, so they are compared by the same rule.
  for (const declaredPath of Object.values(layout.paths)) {
    const name = workRootEntryName(layout, declaredPath);
    if (name) {
      declared.add(name);
    }
  }

  const workRootPath = path.join(root, layout.work_root);
  let names: string[];
  try {
    const entries = await readdir(workRootPath, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  const rows: CheckRow[] = [];
  for (const name of names) {
    if (name.startsWith(".") || declared.has(name)) continue;
    rows.push({
      path: workspaceWorkRelativePath(layout, name),
      status: "warning",
      message: `directory '${name}/' is not declared by archetype ${archetype.name}. Move its contents into a declared directory (\`assay status\` lists them) or add it to the archetype.`,
    });
  }
  return rows;
}

/**
 * Analysis files written straight into `analyses/references/` without the
 * `Status:` header every analysis carries. These are hand-written notes that
 * never entered the analysis lifecycle, so nothing can tell whether they are
 * open or closed.
 */
async function collectStatuslessAnalysisRows(
  root: string,
  layout: WorkspaceLayout,
): Promise<CheckRow[]> {
  const referencesRoot = path.join(workspacePath(root, layout, "analyses"), "references");
  if (!(await exists(referencesRoot))) {
    return [];
  }
  const files: string[] = [];
  try {
    await collectMarkdownFiles(referencesRoot, files);
  } catch {
    return [];
  }
  const rows: CheckRow[] = [];
  for (const file of files) {
    if (path.basename(file) === "README.md") continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (readHeaderField(content, "Status") !== null) continue;
    rows.push({
      path: relativeDisplayPath(file, root),
      status: "warning",
      message:
        "analysis file has no `Status:` header, so it is outside the analysis lifecycle. Add `- Status: draft` or create it with `assay analysis new`.",
    });
  }
  return rows;
}

interface FrozenReference {
  readonly name: string;
  readonly relativePath: string;
}

/**
 * Collect frozen reference directories under references/frozen/<month>/<name>.
 * Each leaf directory (the <name> level) is one reference. Returns its name and
 * path relative to the framework root.
 */
async function collectFrozenReferences(
  root: string,
  frozenRoot: string,
): Promise<FrozenReference[]> {
  const references: FrozenReference[] = [];

  const months = await readdir(frozenRoot, { withFileTypes: true });
  for (const month of months) {
    if (!month.isDirectory()) continue;
    const monthPath = path.join(frozenRoot, month.name);
    const names = await readdir(monthPath, { withFileTypes: true });
    for (const name of names) {
      if (!name.isDirectory()) continue;
      const absolute = path.join(monthPath, name.name);
      const relativePath = relativeDisplayPath(absolute, root);
      references.push({ name: name.name, relativePath });
    }
  }
  return references;
}

async function collectMarkdownFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(child, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(child);
    }
  }
}

interface EmptyDraft {
  readonly relativePath: string;
}

/**
 * Find analysis markdown files that are still drafts (Status: draft) and whose
 * "Key observations" section has no real content. "Empty" means the section
 * heading is immediately followed by another heading or end-of-file, with only
 * blank lines between.
 */
async function findEmptyDraftAnalyses(root: string, analysesRoot: string): Promise<EmptyDraft[]> {
  const files: string[] = [];
  await collectMarkdownFiles(analysesRoot, files);
  const empty: EmptyDraft[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (!/- Status:\s*draft\b/i.test(content)) continue;
      if (!hasEmptyKeyObservations(content)) continue;
      empty.push({ relativePath: relativeDisplayPath(file, root) });
    } catch {
      // skip unreadable
    }
  }
  return empty;
}

/**
 * True when the "## Key observations" (or similar) section body is empty.
 * Section body is the text between the heading and the next ## heading or EOF;
 * it counts as empty if it contains no non-whitespace, non-list-marker lines.
 */
function hasEmptyKeyObservations(content: string): boolean {
  return !sectionHasHumanContent(content, "Key observations");
}

function sectionBody(content: string, heading: string): string | null {
  const section = findSection(content, heading);
  return section === null ? null : content.slice(section.bodyStart, section.bodyEnd);
}

/**
 * Escape a literal fragment so it can be embedded in a RegExp source.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MarkdownSection {
  /** Index just after the heading line, where the section body starts. */
  readonly bodyStart: number;
  /** Index of the next `##` heading, or end of document. */
  readonly bodyEnd: number;
}

/**
 * Locate a `## <heading>` section. The heading must occupy a whole line, so a
 * sentence that merely mentions `## Result` inside another section cannot be
 * mistaken for the section itself.
 */
function findSection(content: string, heading: string): MarkdownSection | null {
  const pattern = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*$`, "im");
  const match = content.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const headingStart = match.index;
  let bodyStart = headingStart + match[0].length;
  if (content.startsWith("\r\n", bodyStart)) {
    bodyStart += 2;
  } else if (content.startsWith("\n", bodyStart)) {
    bodyStart += 1;
  }
  const after = content.slice(bodyStart);
  const next = after.match(/^##[ \t]/m);
  const bodyEnd = next?.index === undefined ? content.length : bodyStart + next.index;
  return { bodyStart, bodyEnd };
}

/**
 * Length of a document's header block: everything before the first `##`
 * section heading. Workspace state lines (`- Status:`, `- Source alias:`,
 * `- Freeze path:`, ...) are written into this block, so reads and rewrites
 * anchor here instead of matching the first lookalike line in the body. A note
 * such as `- Blocker: Status: open (waiting on upstream)` inside a section can
 * then neither absorb a rewrite nor be mistaken for the real state.
 */
function headerBlockLength(content: string): number {
  const match = content.match(/^##[ \t]/m);
  return match?.index === undefined ? content.length : match.index;
}

function headerFieldPattern(field: string): RegExp {
  return new RegExp(`^[ \\t]{0,3}(?:[-*][ \\t]+)?${escapeRegExp(field)}:[ \\t]*(.*)$`, "im");
}

/** Value of a header metadata field, or null when the header does not set it. */
function readHeaderField(content: string, field: string): string | null {
  const header = content.slice(0, headerBlockLength(content));
  const match = header.match(headerFieldPattern(field));
  return match?.[1] === undefined ? null : match[1].trim();
}

/** First whitespace-delimited token of a header field, for path/id fields. */
function readHeaderToken(content: string, field: string): string | null {
  const value = readHeaderField(content, field);
  if (value === null) return null;
  const token = value.split(/\s+/)[0];
  return token === undefined || token === "" ? null : token;
}

function insertHeaderLine(header: string, line: string): string {
  const body = header.replace(/\s+$/, "");
  if (body === "") {
    return `${line}\n\n${header}`;
  }
  const trailing = header.slice(body.length);
  return `${body}\n${line}${trailing === "" ? "\n" : trailing}`;
}

/**
 * Append a line to the end of a `## <heading>` section, creating the section at
 * the end of the document when it is absent.
 */
function appendToSection(content: string, heading: string, line: string): string {
  const section = findSection(content, heading);
  if (section === null) {
    const separator = content.endsWith("\n") ? "" : "\n";
    return `${content}${separator}\n## ${heading}\n\n${line}\n`;
  }
  const body = content.slice(section.bodyStart, section.bodyEnd);
  const trimmedBody = body.replace(/\s+$/, "");
  const newBody = trimmedBody === "" ? `\n${line}\n\n` : `${trimmedBody}\n${line}\n\n`;
  return `${content.slice(0, section.bodyStart)}${newBody}${content.slice(section.bodyEnd)}`;
}

/**
 * Tick the `- [ ] <label>` checkbox inside a specific section. Returns null when
 * the section has no such checkbox, so callers can refuse instead of reporting a
 * close that changed nothing. Only the section body is searched, so a
 * lookalike checkbox in `## Key observations` is never ticked in its place.
 */
function checkSectionCheckbox(content: string, heading: string, label: string): string | null {
  const section = findSection(content, heading);
  if (section === null) {
    return null;
  }
  const body = content.slice(section.bodyStart, section.bodyEnd);
  const pattern = new RegExp(
    `^([ \\t]*[-*][ \\t]+)\\[[ xX]?\\]([ \\t]+${escapeRegExp(label)})\\b`,
    "im",
  );
  const match = body.match(pattern);
  if (!match) {
    return null;
  }
  const updatedBody = body.replace(pattern, (_full, marker: string, suffix: string) => {
    return `${marker}[x]${suffix}`;
  });
  return `${content.slice(0, section.bodyStart)}${updatedBody}${content.slice(section.bodyEnd)}`;
}

/**
 * Write a header metadata field and verify the result. The field is rewritten
 * in place when the header already declares it and inserted at the end of the
 * header block otherwise, so the document always records the new state; a
 * rewrite that did not take effect raises instead of reporting success.
 */
function setHeaderField(content: string, field: string, value: string, label: string): string {
  const headerLength = headerBlockLength(content);
  const header = content.slice(0, headerLength);
  const rest = content.slice(headerLength);
  const pattern = headerFieldPattern(field);
  const updatedHeader = pattern.test(header)
    ? header.replace(pattern, (line) => {
        const marker = line.match(/^[ \t]{0,3}(?:[-*][ \t]+)?/)?.[0] ?? "";
        return `${marker}${field}: ${value}`;
      })
    : insertHeaderLine(header, `- ${field}: ${value}`);
  const updated = `${updatedHeader}${rest}`;
  if (readHeaderField(updated, field) !== value) {
    throw new FrameworkError(`${label}: could not record '${field}: ${value}'`, {
      code: "IO_ERROR",
    });
  }
  return updated;
}

function sectionHasHumanContent(content: string, heading: string): boolean {
  const body = sectionBody(content, heading);
  if (body === null) return false;
  // Non-empty if there is any line with visible content that is not a bare
  // list marker or checkbox placeholder.
  return body.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    if (/^[-*]\s*(\[[ xX]\])?\s*$/.test(trimmed)) return false; // empty list item
    if (/^- \[[ xX]\]\s+(adopt|reject|experiment|ADR)$/i.test(trimmed)) return false;
    return true;
  });
}

/**
 * Count entries in a parsed queue.json that are still "pending". Accepts both
 * an array of entry objects and an object with an "entries" array. Each entry
 * is counted if it has a status field equal to "pending".
 */
function countPendingQueueEntries(parsed: unknown): number {
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === "object" && "entries" in parsed) {
    const maybeEntries = (parsed as Record<string, unknown>).entries;
    if (Array.isArray(maybeEntries)) entries = maybeEntries;
  }
  return entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const status = (entry as Record<string, unknown>).status;
    return status === "pending";
  }).length;
}

/**
 * Work areas every layout defines, with the purpose to show when one of them
 * holds content the archetype never declared. A workspace whose archetype
 * predates a directory still has real work in it — study workspaces created
 * before `iteration` became a capability module are the concrete case — and
 * status must not hide that.
 */
const WORK_AREA_ZONE_PURPOSES: ReadonlyArray<readonly [WorkspaceArea, string]> = [
  ["references", "External systems captured as evidence"],
  ["analyses", "Conversion layer from references to decisions"],
  ["iterations", "Controlled changes to your own systems, one folder each"],
  ["knowledge", "Accepted, reusable knowledge"],
  ["systemsContracts", "Registered systems and local implementations"],
];

async function readArchetypeForStatus(
  root: string,
  manifest: FrameworkManifest | null,
): Promise<{ readonly archetype: Archetype | null; readonly degradation?: string }> {
  if (!manifest) {
    return { archetype: null };
  }
  try {
    return { archetype: await loadArchetype(manifest.project.archetype, { root }) };
  } catch (error) {
    // An unresolvable archetype degrades to work-area zones rather than
    // failing, but the degradation is stated: the zone list is otherwise
    // indistinguishable from a workspace that simply has little in it.
    return { archetype: null, degradation: describeArchetypeDegradation(error) };
  }
}

/**
 * One line explaining that the archetype could not be resolved and what the
 * command did instead. Shared by `status` and `check` so both name the same
 * cause, which for a removed or renamed archetype is the actionable part.
 */
function describeArchetypeDegradation(error: unknown): string {
  const reason = error instanceof Error ? error.message : "archetype could not be loaded";
  return `${reason} — reporting base structure only`;
}

/**
 * Zones for `assay status`: every zone the archetype declares, plus any layout
 * work area that exists on disk and no declared zone already covers. Paths are
 * resolved through the layout, so an overlay workspace reports the `.assay/`
 * locations it actually uses.
 */
async function resolveStatusZones(
  root: string,
  layout: WorkspaceLayout,
  archetype: Archetype | null,
  mode: ProjectMode,
  capabilities: readonly CapabilityModule[],
): Promise<FrameworkZoneCount[]> {
  const declared = archetype ? archetypeZones(archetype, mode, capabilities) : [];
  const resolved = new Map<string, string>();
  for (const zone of declared) {
    const zonePath = workspaceTemplateRelativePath(layout, zone.path);
    if (!resolved.has(zonePath)) {
      resolved.set(zonePath, zone.purpose);
    }
  }

  for (const [area, purpose] of WORK_AREA_ZONE_PURPOSES) {
    const areaPath = workspaceRelativePath(layout, area);
    const covered = [...resolved.keys()].some(
      (zonePath) => zonePath === areaPath || zonePath.startsWith(`${areaPath}/`),
    );
    if (covered || !(await exists(path.join(root, areaPath)))) {
      continue;
    }
    resolved.set(areaPath, purpose);
  }

  return Promise.all(
    [...resolved].map(async ([zonePath, purpose]) => ({
      path: zonePath,
      files: await countFiles(path.join(root, zonePath)),
      purpose,
    })),
  );
}

/**
 * Count records in a workspace-root `runs.jsonl`. Assay does not create the
 * file and no command writes to it; external harnesses append one JSON object
 * per line. Counting it keeps those records visible without asking anyone to
 * run a command they would have to remember.
 */
async function countRunRecords(root: string, layout: WorkspaceLayout): Promise<number | undefined> {
  const runsPath = path.join(root, workspaceWorkRelativePath(layout, "runs.jsonl"));
  let size: number;
  try {
    const stats = await stat(runsPath);
    if (!stats.isFile()) {
      return undefined;
    }
    size = stats.size;
  } catch {
    return undefined;
  }
  if (size === 0) {
    return 0;
  }
  if (size > MAX_RUN_LOG_BYTES) {
    return undefined;
  }
  try {
    const content = await readFile(runsPath, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

/** Guard against reading an unbounded append-only log into memory for a count. */
const MAX_RUN_LOG_BYTES = 16 * 1024 * 1024;

export async function getFrameworkStatus(
  options: GetFrameworkStatusOptions,
): Promise<FrameworkStatusResult> {
  const root = path.resolve(options.root);
  const manifest = await loadManifest(root);
  const layout = layoutForManifest(manifest);
  // Zones come from the installed archetype plus the modules the workspace has
  // actually enabled, so a solve workspace stops being told about study's
  // directories and an intent-less workspace gains no permanently empty rows.
  const capabilities = await enabledCapabilities(root, manifest);
  const { archetype: archetypeDefinition, degradation: archetypeNotice } =
    await readArchetypeForStatus(root, manifest);
  const zones = await resolveStatusZones(
    root,
    layout,
    archetypeDefinition,
    manifest?.project.mode ?? archetypeDefinition?.mode ?? "learning",
    capabilities,
  );

  // Systems section from registry
  let systems: readonly FrameworkStatusSystem[] | undefined;
  let openIterations: number | undefined;
  try {
    const registry = await loadSystemsRegistry(root);
    if (registry) {
      systems = Object.values(registry.systems)
        .sort((a, b) => {
          const order: Record<string, number> = {
            primary: 0,
            active: 1,
            superseded: 2,
            archived: 3,
          };
          return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name);
        })
        .map((s) => ({
          name: s.name,
          status: s.status,
          vcs: s.vcs,
          version: s.version,
          supersedes: s.supersedes,
        }));
    }
  } catch {
    // registry missing or invalid; status omits systems section
  }

  try {
    openIterations = await countOpenIterations(root, layout);
  } catch {
    // iterations dir may not exist
  }

  let livingSources: FrameworkStatusLivingSources | undefined;
  let adrSuggestions: readonly SourceAdrSuggestion[] | undefined;
  try {
    const status = await getSourceStatus({ root });
    const sources = status.sources;
    livingSources = {
      total: sources.length,
      openObservations: sources.filter((source) => source.analysisStatus === "open").length,
      suggestedAnalyses: sources.filter((source) => source.analysisStatus === "suggested").length,
      closedObservations: sources.filter((source) => source.analysisStatus === "closed").length,
      majorRevalidations: sources.filter(
        (source) => source.latestChangeClass === "major" && source.analysisStatus !== "closed",
      ).length,
    };
    const suggestions = adrSuggestionsForSources(sources);
    adrSuggestions = suggestions.length > 0 ? suggestions : undefined;
  } catch {
    // sources may not exist or may be mid-migration; status omits the summary
  }

  // Upstream drift is the answer users would otherwise have to go and fetch
  // with a command nobody runs. It is computed here, in the command they do
  // run, and it never fails status: a broken checkout or an unreachable remote
  // annotates its own line.
  let upstream: UpstreamStatus | undefined;
  try {
    const collected = await collectUpstreamStatus({ root, fetch: options.fetch === true });
    upstream = collected.total > 0 ? collected : undefined;
  } catch {
    // source ledger problems are reported by check; status stays usable
  }

  let donors: FrameworkStatusDonors | undefined;
  try {
    donors = (await getDonorSummary(root)) ?? undefined;
  } catch {
    // donor state may be absent or mid-repair; check reports structural errors
  }

  const knowledgeCount = await countKnowledgeEntries(root, layout);
  const runRecords = await countRunRecords(root, layout);

  if (!manifest) {
    return {
      root,
      hasManifest: false,
      managedFiles: 0,
      zones,
      ...(systems ? { systems } : {}),
      ...(livingSources ? { livingSources } : {}),
      ...(upstream ? { upstream } : {}),
      ...(adrSuggestions ? { adrSuggestions } : {}),
      ...(donors ? { donors } : {}),
      ...(openIterations !== undefined ? { openIterations } : {}),
      knowledgeEntries: knowledgeCount,
      ...(runRecords !== undefined ? { runRecords } : {}),
    };
  }

  return {
    root,
    hasManifest: true,
    installedVersion: manifest.framework_version,
    layoutVersion: manifest.layout_version,
    manifestFormat: `schema ${manifest.__schema}; archetype ${manifest.project.archetype}; mode ${manifest.project.mode}`,
    project: manifest.project.name,
    archetype: manifest.project.archetype,
    ...(archetypeDefinition && archetypeDefinition.description !== ""
      ? { archetypeDescription: archetypeDefinition.description }
      : {}),
    ...(archetypeNotice ? { archetypeNotice } : {}),
    mode: manifest.project.mode,
    managedFiles: Object.keys(manifest.managed_files).length,
    zones,
    ...(systems ? { systems } : {}),
    ...(livingSources ? { livingSources } : {}),
    ...(upstream ? { upstream } : {}),
    ...(adrSuggestions ? { adrSuggestions } : {}),
    ...(donors ? { donors } : {}),
    ...(openIterations !== undefined ? { openIterations } : {}),
    knowledgeEntries: knowledgeCount,
    ...(runRecords !== undefined ? { runRecords } : {}),
  };
}

function shouldCopyReference(source: string, destination: string): boolean {
  const relative = toPosixPath(path.relative(source, destination));
  if (relative === "") {
    return true;
  }

  return !relative.split("/").some((part) => GENERATED_REFERENCE_DIRS.has(part));
}

export async function addReference(options: AddReferenceOptions): Promise<AddReferenceResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  const source = path.resolve(options.source);
  const now = options.now ?? new Date();
  const relativePath = workspaceSubpath(
    layout,
    "references",
    "frozen",
    monthStamp(now),
    slugify(options.name),
  );
  const destination = path.join(root, relativePath);

  if (await exists(destination)) {
    throw new FrameworkAlreadyExistsError(`reference already exists: ${relativePath}`);
  }

  await cp(source, destination, {
    recursive: true,
    filter: (_source, dest) => shouldCopyReference(destination, dest),
  });

  // Freeze = open a case file, not just copy files. The reference.yaml records
  // where the material came from and when it was captured; without it a frozen
  // directory is a pile of files with no provenance.
  const referenceYamlPath = path.join(destination, "reference.yaml");
  await writeFile(
    referenceYamlPath,
    referenceYaml({
      name: options.name,
      source,
      freezePath: relativePath,
      frozenOn: nowIso(now),
    }),
    "utf8",
  );

  const eventFile = await appendEvent(
    root,
    {
      event: "reference.frozen",
      name: options.name,
      path: relativePath,
      source,
      reference_file: `${relativePath}/reference.yaml`,
    },
    now,
  );

  return {
    root,
    source,
    path: relativePath,
    absolutePath: destination,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

/**
 * Build the reference.yaml case-file content for a frozen reference. Kept as
 * plain YAML so it is human-readable and editable without a YAML dependency.
 */
function referenceYaml(input: {
  readonly name: string;
  readonly source: string;
  readonly freezePath: string;
  readonly frozenOn: string;
}): string {
  return [
    "# Reference case file. Managed by `assay`. Edit provenance fields freely.",
    `name: ${yamlScalar(input.name)}`,
    `source: ${yamlScalar(input.source)}`,
    `freeze_path: ${yamlScalar(input.freezePath)}`,
    `frozen_on: ${input.frozenOn}`,
    "# analysis_points: fill with concrete questions this reference should answer",
    "analysis_points: []",
    "",
  ].join("\n");
}

export interface BackfillReferenceOptions {
  readonly root: string;
  /** Workspace-relative path of the frozen reference directory. */
  readonly path: string;
  /** Where the material originally came from, when it is known. */
  readonly source?: string;
  readonly now?: Date;
}

export interface BackfillReferenceResult {
  readonly root: string;
  readonly path: string;
  readonly referenceFile: string;
  /** False when the directory already had a case file; nothing was written. */
  readonly created: boolean;
  readonly eventFile?: string;
}

/**
 * Write the missing `reference.yaml` for a frozen reference that predates the
 * case file, or was created by hand.
 *
 * `check --advisories` names this command with the path already filled in, so
 * the fix is one line away from the report instead of being a documented
 * procedure. An existing case file is never overwritten: provenance already
 * recorded is the thing worth protecting here.
 */
export async function backfillReferenceCaseFile(
  options: BackfillReferenceOptions,
): Promise<BackfillReferenceResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  const now = options.now ?? new Date();
  const target = resolveContainedPath(root, options.path, "reference path");
  const frozenPrefix = `${workspaceSubpath(layout, "references", "frozen")}/`;
  if (!target.relativePath.startsWith(frozenPrefix)) {
    throw new FrameworkError(
      `not a frozen reference path: ${target.relativePath} (expected a directory under ${frozenPrefix})`,
    );
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target.absolutePath);
  } catch {
    throw new FrameworkNotFoundError(`reference not found: ${target.relativePath}`);
  }
  if (!info.isDirectory()) {
    throw new FrameworkError(`reference path is not a directory: ${target.relativePath}`);
  }

  const referenceFile = `${target.relativePath}/reference.yaml`;
  const yamlPath = path.join(target.absolutePath, "reference.yaml");
  if (await exists(yamlPath)) {
    return { root, path: target.relativePath, referenceFile, created: false };
  }

  await writeFile(
    yamlPath,
    referenceYaml({
      name: path.basename(target.relativePath),
      source: options.source ?? "unknown",
      freezePath: target.relativePath,
      // The freeze happened when the directory was written, not now.
      frozenOn: nowIso(info.mtime),
    }),
    "utf8",
  );
  const eventFile = await appendEvent(
    root,
    {
      event: "reference.backfilled",
      path: target.relativePath,
      reference_file: referenceFile,
      source: options.source ?? null,
    },
    now,
  );

  return {
    root,
    path: target.relativePath,
    referenceFile,
    created: true,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

/** Quote a YAML scalar only when it contains characters that need quoting. */
function yamlScalar(value: string): string {
  if (value === "" || /[:#\[\]\{\},&*!|>'"%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Read the scalar fields of a reference.yaml case file. Parsing goes through
 * the YAML library, and unknown keys are ignored, so a case file written by an
 * older build — including one that still carries the removed `analyzed` flag —
 * keeps resolving its provenance.
 */
function parseReferenceYaml(content: string): {
  name?: string;
  source?: string;
  freezePath?: string;
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(content) as unknown;
  } catch (error) {
    throw new FrameworkError("reference case file cannot be parsed as YAML", {
      code: "IO_ERROR",
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const result: { name?: string; source?: string; freezePath?: string } = {};
  if (typeof record.name === "string") result.name = record.name;
  if (typeof record.source === "string") result.source = record.source;
  if (typeof record.freeze_path === "string") result.freezePath = record.freeze_path;
  return result;
}

/**
 * Absorb an external source as a frozen reference AND open an analysis for it
 * in one step. This is the command that replaces "freeze then forget": it
 * freezes (via addReference, which writes reference.yaml), then creates a
 * bound analysis (via createAnalysis --forReference) and pre-fills the
 * Architecture/structure section with a lightweight probe of the source — the
 * README lead and a one-level directory tree. The result is an open analysis
 * that `check` can track, not a frozen directory with no follow-up.
 *
 * Mode routing:
 * - learning (default): source is frozen under references/frozen/ as a
 *   reference and a bound analysis is opened.
 * - absorption: source is copied under problem/<name>/ as project-level
 *   material (it IS the project, not an external reference) and an analysis is
 *   opened against it. No reference.yaml is written because the source is not
 *   a reference.
 */
export async function readFrameworkMode(root: string): Promise<"learning" | "absorption"> {
  try {
    const manifest = await loadManifest(root);
    return manifest?.project.mode ?? "learning";
  } catch {
    // unreadable/missing manifest; schema legacy default is learning
  }
  return "learning";
}

export async function absorbReference(
  options: AbsorbReferenceOptions,
): Promise<AbsorbReferenceResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const source = path.resolve(options.source);
  const now = options.now ?? new Date();

  if (!(await exists(source))) {
    throw new FrameworkNotFoundError(`source not found: ${source}`);
  }
  const sourceStats = await stat(source);
  if (!sourceStats.isDirectory()) {
    throw new FrameworkError(`absorb expects a directory source, got file: ${source}`, {
      code: "IO_ERROR",
    });
  }

  const name = options.name ?? path.basename(source);
  const mode = await readFrameworkMode(root);

  let sourcePath: string;
  let eventPayload: Record<string, unknown>;
  if (mode === "absorption") {
    const outlet = normalizeAbsorptionOutlet(options.outlet);
    sourcePath = await absorbAsProjectSource(root, source, name, now, outlet);
    eventPayload = {
      event: "source.absorbed",
      name,
      absorb_path: sourcePath,
      outlet,
      source,
    };
  } else {
    if (options.outlet !== undefined) {
      throw new FrameworkError(
        `absorb outlet is only valid in absorption mode; manifest mode is ${mode}`,
      );
    }
    // Learning mode: freeze + reference.yaml case file.
    const frozen = await addReference({ root, source, name, now });
    sourcePath = frozen.path;
    eventPayload = {
      event: "reference.absorbed",
      name,
      reference_path: frozen.path,
      source,
    };
  }

  // Probe the source for lightweight pre-fill content.
  const probe = await probeSource(source);

  // Create a bound analysis, then append the probe into its
  // ## Architecture / structure section so the analysis carries real
  // content instead of being an empty shell.
  const title = `Absorb ${name}`;
  const analysis = await createAnalysis({
    root,
    title,
    forReference: sourcePath,
    now,
  });

  if (probe.hasContent) {
    const analysisContent = await readFile(analysis.absolutePath, "utf8");
    const sectionHeader = "Architecture / structure";
    await writeFile(
      analysis.absolutePath,
      appendToSection(analysisContent, sectionHeader, probe.body),
      "utf8",
    );
  }

  const eventFile = await appendEvent(root, { ...eventPayload, analysis_path: analysis.path }, now);

  return {
    root,
    source,
    referencePath: sourcePath,
    analysisPath: analysis.path,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

/**
 * Absorption-mode landing: copy the source under problem/<name>/ or
 * intake/<name>/ as project-level material. Unlike a frozen reference, this is
 * the project's own source, so no reference.yaml is written. Returns the
 * relative path.
 */
function normalizeAbsorptionOutlet(outlet: AbsorptionOutlet | undefined): AbsorptionOutlet {
  const normalized = outlet ?? "problem";
  if (!ABSORPTION_OUTLETS.includes(normalized)) {
    throw new FrameworkError(`absorb outlet must be one of: ${ABSORPTION_OUTLETS.join(", ")}`);
  }
  return normalized;
}

async function absorbAsProjectSource(
  root: string,
  source: string,
  name: string,
  now: Date,
  outlet: AbsorptionOutlet,
): Promise<string> {
  const relativePath = `${outlet}/${slugify(name)}`;
  const destination = path.join(root, relativePath);
  if (await exists(destination)) {
    throw new FrameworkAlreadyExistsError(`${outlet} source already exists: ${relativePath}`);
  }
  await mkdir(path.join(root, outlet), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (_src, dest) => shouldCopyReference(destination, dest),
  });
  // Write a minimal source.yaml so the absorption is still tracked as a case
  // file (without the reference-specific `analyzed` flag).
  const sourceYamlPath = path.join(destination, "source.yaml");
  await writeFile(
    sourceYamlPath,
    [
      "# Project-level source case file. Managed by `assay`.",
      `name: ${yamlScalar(name)}`,
      `source: ${yamlScalar(source)}`,
      `absorb_path: ${yamlScalar(relativePath)}`,
      `absorbed_on: ${nowIso(now)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return relativePath;
}

interface SourceProbe {
  readonly hasContent: boolean;
  readonly body: string;
}

const README_CANDIDATES = [
  "README.md",
  "README.MD",
  "README.rst",
  "README.txt",
  "readme.md",
  "readme.txt",
  "Readme.md",
];

/**
 * Lightweight source probe: extract the README lead (first non-empty paragraph
 * block, capped to a few lines) and a one-level directory tree. Deliberately
 * shallow — no source parsing, no dependency-file heuristics — to keep the
 * first version low on false fills.
 */
async function probeSource(source: string): Promise<SourceProbe> {
  const parts: string[] = [];

  const readmeLead = await readReadmeLead(source);
  if (readmeLead) {
    parts.push("**README lead:**\n");
    parts.push(readmeLead);
    parts.push("");
  }

  const tree = await oneLevelTree(source);
  if (tree.length > 0) {
    parts.push("**Top-level layout:**\n");
    parts.push("```");
    parts.push(...tree);
    parts.push("```");
    parts.push("");
  }

  const body = parts.join("\n").trim();
  return { hasContent: body.length > 0, body };
}

async function readReadmeLead(source: string): Promise<string> {
  for (const candidate of README_CANDIDATES) {
    const candidatePath = path.join(source, candidate);
    if (!(await exists(candidatePath))) continue;
    try {
      const raw = await readFile(candidatePath, "utf8");
      return extractLead(raw);
    } catch {
      // unreadable readme; try next candidate
    }
  }
  return "";
}

/**
 * Extract the first meaningful paragraph block from a README: skip the leading
 * H1 title and blank lines, then take up to 8 lines of the first non-empty
 * block. Caps length so a huge README cannot dominate the analysis.
 */
function extractLead(raw: string): string {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  let start = 0;
  // Skip a leading H1.
  if (lines.length > 0 && /^#\s+/.test(lines[0] ?? "")) {
    start = 1;
  }
  // Skip blank lines.
  while (start < lines.length && (lines[start]?.trim() ?? "") === "") {
    start += 1;
  }
  const block: string[] = [];
  for (let i = start; i < lines.length && block.length < 8; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    block.push(line);
  }
  return block.join("\n");
}

async function oneLevelTree(source: string): Promise<string[]> {
  try {
    const entries = await readdir(source, { withFileTypes: true });
    const lines: string[] = [];
    for (const entry of entries.slice(0, 40)) {
      lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }
    if (entries.length > 40) {
      lines.push(`... (${entries.length - 40} more entries)`);
    }
    return lines;
  } catch {
    return [];
  }
}

export async function createAnalysis(
  options: CreateAnalysisOptions,
): Promise<CreateAnalysisResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = workspaceSubpath(
    layout,
    "analyses",
    "references",
    `${date}-${slugify(options.title)}.md`,
  );
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`analysis already exists: ${relativePath}`);
  }

  if (options.forReference && options.forSource) {
    throw new FrameworkError("analysis can bind either --for-reference or --for-source, not both");
  }

  // When bound to a frozen reference, pre-fill the provenance fields from its
  // reference.yaml instead of leaving an empty shell. This is what makes the
  // analysis "carry content forward" rather than being a blank template the AI
  // forgets to fill.
  let refName = "";
  let refSource = "";
  let refFreezePath = "";
  let sourceBlock = "";
  let referenceRelativePath: string | null = null;
  if (options.forReference) {
    const reference = resolveContainedPath(root, options.forReference, "reference path");
    const refPath = reference.relativePath;
    const refAbsolute = reference.absolutePath;
    referenceRelativePath = refPath;
    const yamlPath = path.join(refAbsolute, "reference.yaml");
    if (!(await exists(refAbsolute))) {
      throw new FrameworkNotFoundError(`reference not found: ${refPath}`);
    }
    if (await exists(yamlPath)) {
      const parsed = parseReferenceYaml(await readFile(yamlPath, "utf8"));
      refName = parsed.name ?? path.basename(refPath);
      refSource = parsed.source ?? "";
      refFreezePath = parsed.freezePath ?? refPath;
    } else {
      // Pre-reference.yaml freeze (legacy or manual): degrade gracefully.
      refName = path.basename(refPath);
      refFreezePath = refPath;
    }
  }
  if (options.forSource) {
    const source = await resolveSourceObservation({
      root,
      alias: options.forSource,
      ...(options.observation === undefined ? {} : { observation: options.observation }),
    });
    refName = source.alias;
    sourceBlock = [
      `- Source alias: ${source.alias}`,
      `- Source path: ${source.sourcePath}`,
      `- Source observation: ${source.observation.observation_id}`,
      `- Source observation path: ${source.observationFile}`,
      `- Source change class: ${source.observation.change_class}`,
      `- Source analysis status: ${source.observation.analysis_status}`,
      `- Source manifest: ${source.manifestFile}`,
      `- Source materials: ${source.materialsPath}`,
      ...(source.checkoutPath ? [`- Source checkout: ${source.checkoutPath}`] : []),
      ...(source.diffFile ? [`- Source diff: ${source.diffFile}`] : []),
      "",
    ].join("\n");
  }

  const referenceBlock =
    options.forReference && (refFreezePath || refName)
      ? `- Reference: ${refName}\n- Source: ${refSource}\n- Freeze path: ${refFreezePath}\n`
      : "";
  const content = `# ${options.title}\n\n- Date: ${date}\n- Status: draft\n${referenceBlock}${sourceBlock}\n## Reference\n\n${refName || ""}\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Next iteration\n\n## Decision exit\n\n- [ ] adopt\n- [ ] reject\n- [ ] experiment\n- [ ] ADR\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.created",
      path: relativePath,
      title: options.title,
      ...(referenceRelativePath ? { for_reference: referenceRelativePath } : {}),
      ...(options.forSource ? { for_source: options.forSource } : {}),
      ...(options.observation ? { source_observation: options.observation } : {}),
    },
    now,
  );

  return {
    root,
    path: relativePath,
    absolutePath,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function startIteration(
  options: StartIterationOptions,
): Promise<StartIterationResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  await requireCapability(root, "iteration");
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = workspaceSubpath(layout, "iterations", `${date}-${slugify(options.title)}`);
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`iteration already exists: ${relativePath}`);
  }

  await mkdir(absolutePath, { recursive: true });
  const planPath = path.join(absolutePath, "plan.md");
  await writeFile(
    planPath,
    `# ${options.title}\n\n- Date: ${date}\n- Status: open\n\n## Hypothesis\n\n## Scope\n\n## Verification\n\n## Rollback\n\n## Result\n`,
    "utf8",
  );
  const eventFile = await appendEvent(
    root,
    { event: "iteration.started", path: relativePath, title: options.title },
    now,
  );

  return {
    root,
    path: relativePath,
    planPath: `${relativePath}/plan.md`,
    absolutePath,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function captureEvent(options: CaptureEventOptions): Promise<CaptureEventResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const eventFile = await appendEvent(
    root,
    { event: "capture.created", kind: options.kind, text: options.text },
    options.now ?? new Date(),
  );

  return { root, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function closeIteration(
  options: CloseIterationOptions,
): Promise<CloseIterationResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  await requireCapability(root, "iteration");
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  // Resolve iteration directory from selector (path or date-slug prefix)
  const iterationsRelative = workspaceRelativePath(layout, "iterations");
  const iterationsDir = path.join(root, iterationsRelative);
  let iterPath: string | null = null;
  const selector = resolveContainedPath(root, options.selector, "iteration selector");
  const selectorNormalized = selector.relativePath;

  // Try as direct path
  const directPath = selector.absolutePath;
  if (await exists(directPath)) {
    iterPath = selectorNormalized;
  } else {
    // Search by prefix match
    if (await exists(iterationsDir)) {
      const entries = await readdir(iterationsDir, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(options.selector))
        .map((e) => e.name);
      if (matches.length === 1 && matches[0]) {
        iterPath = `${iterationsRelative}/${matches[0]}`;
      } else if (matches.length > 1) {
        throw new FrameworkNotFoundError(
          `iteration selector '${options.selector}' is ambiguous (${matches.join(", ")})`,
        );
      }
    }
  }

  if (!iterPath) {
    throw new FrameworkNotFoundError(`iteration not found: ${options.selector}`);
  }

  const planPath = path.join(root, iterPath, "plan.md");
  if (!(await exists(planPath))) {
    throw new FrameworkNotFoundError(`iteration plan not found: ${iterPath}/plan.md`);
  }

  // Update plan.md: set Status to closed, add Result
  let content = await readFile(planPath, "utf8");
  const resultLine = `- ${options.result} on ${date}${options.note ? ` — ${options.note}` : ""}`;
  content = setHeaderField(content, "Status", "closed", `iteration ${iterPath}/plan.md`);
  content = appendToSection(content, "Result", resultLine);
  await writeFile(planPath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "iteration.closed",
      path: iterPath,
      result: options.result,
      note: options.note ?? null,
    },
    now,
  );

  return { root, path: iterPath, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function closeAnalysis(options: CloseAnalysisOptions): Promise<CloseAnalysisResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const analysis = resolveContainedPath(root, options.path, "analysis path");
  const analysisPath = analysis.relativePath;
  const absolutePath = analysis.absolutePath;
  if (!(await exists(absolutePath))) {
    throw new FrameworkNotFoundError(`analysis not found: ${analysisPath}`);
  }

  let content = await readFile(absolutePath, "utf8");
  const sourceAlias = readHeaderToken(content, "Source alias");
  const sourceObservation = readHeaderToken(content, "Source observation");
  const sourceBinding =
    sourceAlias && sourceObservation
      ? { alias: sourceAlias, observation: sourceObservation }
      : null;
  const sourceResolution = sourceBinding
    ? await resolveSourceObservation({
        root,
        alias: sourceBinding.alias,
        observation: sourceBinding.observation,
      })
    : null;
  const sourceObservationSnapshot = sourceResolution
    ? {
        absolutePath: path.join(root, sourceResolution.observationFile),
        content: await readFile(path.join(root, sourceResolution.observationFile), "utf8"),
      }
    : null;
  const sourceObservationAlreadyClosed =
    sourceResolution?.observation.analysis_status === "closed" &&
    sourceResolution.observation.analysis_path === analysisPath &&
    sourceResolution.observation.analysis_exit === options.exit;
  // Set status
  const statusMap: Record<AnalysisExit, string> = {
    adopt: "applied",
    reject: "rejected",
    experiment: "experiment",
    adr: "adr",
  };
  const statusValue = statusMap[options.exit];
  content = setHeaderField(content, "Status", statusValue, `analysis ${analysisPath}`);
  // Tick the decision-exit checkbox inside the `## Decision exit` section. An
  // analysis card that does not carry that section records its exit through the
  // header alone; one that does carry it must contain the matching checkbox,
  // otherwise the requested exit cannot be recorded and the close fails.
  const exitLabel = options.exit === "adr" ? "ADR" : options.exit;
  if (findSection(content, "Decision exit") !== null) {
    const ticked = checkSectionCheckbox(content, "Decision exit", exitLabel);
    if (ticked === null) {
      throw new FrameworkError(
        `analysis ${analysisPath}: '## Decision exit' has no '- [ ] ${exitLabel}' checkbox to record this exit`,
        { code: "IO_ERROR" },
      );
    }
    content = ticked;
  }
  if (options.note) {
    content += `\n> Closed on ${date}: ${options.note}\n`;
  }

  let closedSourceObservation: string | null = null;
  let sourceObservationChanged = false;
  if (sourceBinding && sourceObservationSnapshot) {
    if (sourceObservationAlreadyClosed && sourceResolution) {
      closedSourceObservation = sourceResolution.observationFile;
    } else {
      try {
        const closed = await closeSourceObservationAnalysis({
          root,
          alias: sourceBinding.alias,
          observation: sourceBinding.observation,
          analysisPath,
          analysisExit: options.exit,
          now,
        });
        closedSourceObservation = closed.observationFile;
        sourceObservationChanged = true;
      } catch (error) {
        try {
          await writeFile(
            sourceObservationSnapshot.absolutePath,
            sourceObservationSnapshot.content,
            "utf8",
          );
        } catch (rollbackError) {
          throw new FrameworkError("source observation close failed and could not be rolled back", {
            cause: error,
            details: {
              rollback:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          });
        }
        throw error;
      }
    }
    content = setHeaderField(
      content,
      "Source analysis status",
      "closed",
      `analysis ${analysisPath}`,
    );
  }

  try {
    await writeFile(absolutePath, content, "utf8");
  } catch (error) {
    if (sourceObservationSnapshot && sourceObservationChanged) {
      try {
        await writeFile(
          sourceObservationSnapshot.absolutePath,
          sourceObservationSnapshot.content,
          "utf8",
        );
      } catch (rollbackError) {
        throw new FrameworkError(
          "analysis close failed and the source observation could not be rolled back",
          {
            cause: error,
            details: {
              rollback:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          },
        );
      }
    }
    throw error;
  }

  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.closed",
      path: analysisPath,
      exit: options.exit,
      note: options.note ?? null,
      ...(closedSourceObservation
        ? { marked_source_observation_closed: closedSourceObservation }
        : {}),
    },
    now,
  );

  return { root, path: analysisPath, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function addKnowledge(options: AddKnowledgeOptions): Promise<AddKnowledgeResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = layoutForManifest(manifest);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const typeDir = workspaceSubpath(layout, "knowledge", KNOWLEDGE_TYPE_DIRS[options.type]);
  const fileName = `${date}-${slugify(options.title)}.md`;
  const relativePath = `${typeDir}/${fileName}`;
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`knowledge entry already exists: ${relativePath}`);
  }

  const refs: string[] = [];
  if (options.fromAnalysis) {
    refs.push(`- from analysis: ${options.fromAnalysis}`);
  }
  if (options.fromIteration) {
    refs.push(`- from iteration: ${options.fromIteration}`);
  }
  const refBlock = refs.length > 0 ? `\n${refs.join("\n")}\n` : "\n";

  const content = `# ${options.title}\n\n- Type: ${options.type}\n- Date: ${date}\n- Status: accepted${refBlock}\n## Summary\n\n## Detail\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "knowledge.added",
      path: relativePath,
      type: options.type,
      title: options.title,
      from_analysis: options.fromAnalysis ?? null,
      from_iteration: options.fromIteration ?? null,
    },
    now,
  );

  return { root, path: relativePath, eventFile: relativeDisplayPath(eventFile, root) };
}
