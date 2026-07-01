import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import { defaultAdrIndex, loadAdrIndex, saveAdrIndex } from "./adrs.js";
import { ADRS_FILE, MANIFEST_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { fileHash } from "./hashing.js";
import { defaultManifest, loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { dirsForMode, loadProfile, readInstalledArchetype, requireCapability } from "./profile.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "./results.js";
import type {
  AdrIndex,
  AdrRecord,
  FrameworkManifest,
  ProjectArchetype,
  ProjectMode,
} from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";
import {
  closeSourceObservationAnalysis,
  collectSourceHealthRows,
  getSourceStatus,
  resolveSourceObservation,
} from "./sources.js";
import { loadSystemsRegistry } from "./systems-registry.js";
import { desiredTemplates } from "./templates.js";
import { nowIso } from "./time.js";

const GENERATED_REFERENCE_DIRS = new Set([
  ".venv",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".next",
]);

function profileAliasToArchetype(profile: string | undefined): ProjectArchetype {
  if (profile === "contest" || profile === "library") return profile;
  return "research";
}

function profileNameForArchetype(archetype: ProjectArchetype): string {
  return archetype;
}

function defaultModeForArchetype(archetype: ProjectArchetype): ProjectMode {
  return archetype === "contest" ? "absorption" : "learning";
}

export async function desiredRuntimeTemplates(
  project: string,
  archetype: ProjectArchetype,
  mode: ProjectMode,
) {
  const profileName = profileNameForArchetype(archetype);
  return desiredTemplates(project, mode, profileName);
}

export interface InitFrameworkOptions {
  readonly target: string;
  readonly name?: string;
  readonly git?: boolean;
  readonly force?: boolean;
  readonly createNew?: boolean;
  /** Project mode: "learning" treats external sources as references; "absorption" treats them as project-level sources. */
  readonly mode?: ProjectMode;
  /** Project archetype: research (default), contest, or library. */
  readonly archetype?: ProjectArchetype;
  /**
   * @deprecated Legacy alias for archetype. "assay" maps to "research".
   */
  readonly profile?: string;
}

export interface InitFrameworkResult {
  readonly root: string;
  readonly project: string;
  readonly archetype: ProjectArchetype;
  readonly mode: ProjectMode;
  readonly report: OperationReport;
}

export interface CheckFrameworkOptions {
  readonly root: string;
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

export interface FrameworkStatusResult {
  readonly root: string;
  readonly hasManifest: boolean;
  readonly installedVersion?: string;
  readonly layoutVersion?: number;
  readonly manifestFormat?: string;
  readonly project?: string;
  readonly archetype?: ProjectArchetype;
  readonly mode?: ProjectMode;
  readonly managedFiles: number;
  readonly zones: FrameworkZoneCount[];
  readonly systems?: readonly FrameworkStatusSystem[];
  readonly livingSources?: FrameworkStatusLivingSources;
  readonly openIterations?: number;
  readonly knowledgeEntries?: number;
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

async function countKnowledgeEntries(root: string): Promise<number> {
  const knowledgeRoot = path.join(root, "knowledge");
  if (!(await exists(knowledgeRoot))) return 0;
  const files: string[] = [];
  await collectMarkdownFiles(knowledgeRoot, files);
  return files.filter((file) => {
    const basename = path.basename(file);
    return basename !== "README.md" && basename !== "ADR-TEMPLATE.md";
  }).length;
}

const OPEN_STATUS_PATTERN = /(?<![a-z])Status:\s*open\b/i;

async function countOpenIterations(root: string): Promise<number> {
  const iterationsDir = path.join(root, "iterations");
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
      if (OPEN_STATUS_PATTERN.test(content)) {
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

export async function initFramework(options: InitFrameworkOptions): Promise<InitFrameworkResult> {
  const root = path.resolve(options.target);
  const project = options.name ?? path.basename(root);
  const report = createEmptyReport();

  const archetype = options.archetype ?? profileAliasToArchetype(options.profile);
  const profileName = profileNameForArchetype(archetype);
  const profile = await loadProfile(profileName);
  // Mode is manifest-owned. Explicit options win; otherwise use the archetype
  // default (falling back to the legacy profile while profiles are being
  // renamed in the adjacent partition).
  const mode = options.mode ?? defaultModeForArchetype(archetype) ?? profile.mode;

  await ensureDir(root, root, report);
  for (const directory of dirsForMode(profile, mode)) {
    await ensureDir(path.join(root, directory), root, report);
  }

  let manifest = (await loadManifest(root)) ?? defaultManifest(project, { archetype, mode });
  manifest.project.archetype = archetype;
  manifest.project.mode = mode;
  for (const template of await desiredRuntimeTemplates(project, archetype, mode)) {
    const result = await writeTemplateFile(root, template.path, template.content, report, {
      force: options.force ?? false,
      createNew: options.createNew ?? false,
      executable: template.executable,
    });
    if (result === "written") {
      recordTemplate(manifest, template);
    }
  }
  if (profile.modules.includes("adr")) {
    await scaffoldAdrIndex(root, report);
  }

  const manifestExisted = await exists(path.join(root, MANIFEST_FILE));
  manifest = await saveManifest(root, manifest);
  (manifestExisted ? report.updated_files : report.created_files).push(MANIFEST_FILE);

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

export async function checkFramework(
  options: CheckFrameworkOptions,
): Promise<CheckFrameworkResult> {
  const root = path.resolve(options.root);
  // Base structure check targets: always-required runtime files plus the
  // archetype-declared primary directories. The profile loader remains only as
  // a scaffold-data adapter until that partition renames profiles to
  // archetypes.
  const checkTargets: Array<readonly [string, string]> = [
    [".framework directory", ".framework"],
    [".framework/VERSION", ".framework/VERSION"],
    [".framework/manifest.json", ".framework/manifest.json"],
    ["systems directory", "systems"],
    ["knowledge directory", "knowledge"],
  ];

  // If a workspace declares its archetype, augment checks with that archetype's
  // top-level dirs (intake/, problem/, references/, analyses/, iterations/,
  // benchmarks/, submissions/...). Default to a permissive check when the
  // manifest/archetype cannot be read.
  try {
    const installedArchetype = await readInstalledProfileName(root);
    const profile = await loadProfile(profileNameForArchetype(installedArchetype ?? "research"));
    const mode = await readFrameworkMode(root);
    const topLevels = new Set<string>();
    for (const d of dirsForMode(profile, mode)) {
      const top = d.split("/")[0];
      if (top && !top.startsWith(".") && top !== "systems" && top !== "knowledge") {
        topLevels.add(top);
      }
    }
    for (const dir of topLevels) {
      checkTargets.push([`${dir} directory`, dir]);
    }
  } catch {
    // unreadable manifest/archetype; fall back to base targets only
  }
  const rows: CheckRow[] = [];

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
          path: ".framework/systems-registry.json",
          status: "error",
          message: `registry primary is '${registry.primary}' but no system has status: primary`,
        });
      } else if (primaries.length > 1) {
        rows.push({
          path: ".framework/systems-registry.json",
          status: "error",
          message: `expected exactly one primary system, found ${primaries.length}: ${primaries.map((s) => s.name).join(", ")}`,
        });
      }

      // Check each active/primary system exists on disk
      for (const system of Object.values(registry.systems)) {
        if (system.status === "archived") continue;
        const systemPath = path.join(root, system.path);
        if (!(await exists(systemPath))) {
          rows.push({
            path: system.path,
            status: "error",
            message: `registered system '${system.name}' missing on disk`,
          });
        }
        if (system.contract_file) {
          const contractPath = path.join(root, system.contract_file);
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
      path: ".framework/systems-registry.json",
      status: "error",
      message: error instanceof Error ? error.message : "systems registry error",
    });
  }

  // Semantic check 3: open iterations
  try {
    openIterations = await countOpenIterations(root);
    if (openIterations > 0) {
      rows.push({
        path: "iterations/",
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
  // The framework owns knowledge subdirectory names (decisions, patterns,
  // guides, troubleshooting). A legacy bug appended "s" to every knowledge
  // type, producing a parallel "knowledge/troubleshootings/" directory that
  // split troubleshooting entries from their README. Flag any knowledge
  // subdirectory that is not one of the expected names so the drift cannot
  // hide silently.
  try {
    const knowledgeRoot = path.join(root, "knowledge");
    if (await exists(knowledgeRoot)) {
      const EXPECTED_KNOWLEDGE_DIRS = new Set([
        "decisions",
        "patterns",
        "guides",
        "troubleshooting",
        "templates",
        "evaluations",
      ]);
      const entries = await readdir(knowledgeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!EXPECTED_KNOWLEDGE_DIRS.has(entry.name)) {
          rows.push({
            path: `knowledge/${entry.name}`,
            status: "warning",
            message: `unexpected knowledge subdirectory '${entry.name}' (expected one of: ${[...EXPECTED_KNOWLEDGE_DIRS].join(", ")}). A legacy bug created 'troubleshootings'; move entries into 'knowledge/troubleshooting/'.`,
          });
        }
      }
    }
  } catch {
    // knowledge dir may not exist; skip
  }

  // Semantic check 6: unanalyzed frozen references
  // The core loop is references → analyses → .... A frozen reference that no
  // analysis cites is "absorbed into the archive then forgotten" — exactly
  // the failure mode this framework exists to prevent. Scan every frozen
  // reference directory and check whether any analysis file mentions its name
  // or path. Unanalyzed references surface as warnings so they cannot hide.
  try {
    const frozenRoot = path.join(root, "references", "frozen");
    if (await exists(frozenRoot)) {
      const references = await collectFrozenReferences(frozenRoot);
      if (references.length > 0) {
        const analysisText = await readAllAnalysisText(root);
        for (const ref of references) {
          // Authoritative signal: reference.yaml.analyzed === true means an
          // analysis was closed against this reference (see closeAnalysis).
          const yamlPath = path.join(root, ref.relativePath, "reference.yaml");
          let explicitlyAnalyzed = false;
          try {
            if (await exists(yamlPath)) {
              const parsed = parseReferenceYaml(await readFile(yamlPath, "utf8"));
              explicitlyAnalyzed = parsed.analyzed === true;
            }
          } catch {
            // unreadable yaml; fall back to citation check
          }
          if (explicitlyAnalyzed) continue;
          const cited = analysisText.some(
            (text) => text.includes(ref.name) || text.includes(ref.relativePath),
          );
          if (!cited) {
            rows.push({
              path: ref.relativePath,
              status: "warning",
              message: `frozen reference '${ref.name}' has no analysis citing it (references → analyses loop is incomplete)`,
            });
          }
        }
      }
    }
  } catch {
    // references/frozen may not exist; skip
  }

  // Semantic check 7: empty draft analyses
  // An analysis card left at Status: draft with no Key observations content is
  // a shell that was never filled — the "write docs then stop" anti-pattern.
  try {
    const analysesRoot = path.join(root, "analyses");
    if (await exists(analysesRoot)) {
      const emptyDrafts = await findEmptyDraftAnalyses(analysesRoot);
      for (const draft of emptyDrafts) {
        rows.push({
          path: draft.relativePath,
          status: "warning",
          message: `analysis '${draft.relativePath}' is still a draft with empty 'Key observations' (content was never filled in)`,
        });
      }
    }
  } catch {
    // analyses dir may not exist; skip
  }

  // Semantic check 8: stale adoption archive
  // `adopt` moves existing content into .old/<stamp>/ and is supposed to be
  // followed by moving artifacts into the new structure once direction is
  // clear. A lingering .old/ means adoption stopped halfway.
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

  // Semantic check 9: dangling pending queue entries
  // A queue.json of pending reference-analysis actions that never get consumed
  // is the literal evidence of "freeze then forget". Surface pending entries so
  // the framework cannot report ok while work is stranded.
  try {
    const queueCandidates = [
      path.join(root, ".framework", "queue.json"),
      path.join(root, ".assay", "queue.json"),
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
          message: `queue has ${pending} pending entry/entries never consumed (freeze-then-forget). Process or prune them.`,
        });
      }
    }
  } catch {
    // queue may be missing or unreadable; skip
  }

  // Semantic check 10: living source observation health
  // New-style external sources live at references/<source>/ with source.yaml
  // plus an observation ledger under .assay/. These warnings keep the new
  // model from becoming another "blob exists, therefore done" escape hatch.
  try {
    rows.push(...(await collectSourceHealthRows(root)));
  } catch {
    // new-style references may not exist or may be legacy-only; skip
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

interface FrozenReference {
  readonly name: string;
  readonly relativePath: string;
}

/**
 * Collect frozen reference directories under references/frozen/<month>/<name>.
 * Each leaf directory (the <name> level) is one reference. Returns its name and
 * path relative to the framework root.
 */
async function collectFrozenReferences(frozenRoot: string): Promise<FrozenReference[]> {
  const references: FrozenReference[] = [];
  const rootParent = path.dirname(frozenRoot); // .../references
  const frameworkRoot = path.dirname(rootParent); // project root

  const months = await readdir(frozenRoot, { withFileTypes: true });
  for (const month of months) {
    if (!month.isDirectory()) continue;
    const monthPath = path.join(frozenRoot, month.name);
    const names = await readdir(monthPath, { withFileTypes: true });
    for (const name of names) {
      if (!name.isDirectory()) continue;
      const absolute = path.join(monthPath, name.name);
      const relativePath = toPosixPath(path.relative(frameworkRoot, absolute));
      references.push({ name: name.name, relativePath });
    }
  }
  return references;
}

/**
 * Read the concatenated text of every markdown file under analyses/. Used to
 * test whether a frozen reference is cited by any analysis.
 */
async function readAllAnalysisText(root: string): Promise<string[]> {
  const analysesRoot = path.join(root, "analyses");
  if (!(await exists(analysesRoot))) return [];
  const files: string[] = [];
  await collectMarkdownFiles(analysesRoot, files);
  const texts: string[] = [];
  for (const file of files) {
    try {
      texts.push(await readFile(file, "utf8"));
    } catch {
      // skip unreadable
    }
  }
  return texts;
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
async function findEmptyDraftAnalyses(analysesRoot: string): Promise<EmptyDraft[]> {
  const root = path.dirname(analysesRoot);
  const files: string[] = [];
  await collectMarkdownFiles(analysesRoot, files);
  const empty: EmptyDraft[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (!/- Status:\s*draft\b/i.test(content)) continue;
      if (!hasEmptyKeyObservations(content)) continue;
      empty.push({ relativePath: toPosixPath(path.relative(root, file)) });
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
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = content.match(new RegExp(`^##\\s+${escaped}\\s*$`, "im"));
  if (!headingMatch || headingMatch.index === undefined) {
    return null;
  }
  const after = content.slice(headingMatch.index + headingMatch[0].length);
  // Stop at the next ## heading.
  const nextHeading = after.match(/\n##\s/);
  return nextHeading && nextHeading.index !== undefined ? after.slice(0, nextHeading.index) : after;
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

function assertAnalysisCloseContent(
  content: string,
  exit: AnalysisExit,
  allowEmpty: boolean,
): void {
  if (allowEmpty) return;
  if (hasEmptyKeyObservations(content)) {
    throw new FrameworkError(
      "analysis close requires non-empty ## Key observations; use --allow-empty to override",
    );
  }

  const requiredSection =
    exit === "adopt"
      ? "Adopt"
      : exit === "reject"
        ? "Reject"
        : exit === "experiment"
          ? "Next iteration"
          : null;
  if (requiredSection && !sectionHasHumanContent(content, requiredSection)) {
    throw new FrameworkError(
      `analysis close --exit ${exit} requires non-empty ## ${requiredSection}; use --allow-empty to override`,
    );
  }
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

export async function getFrameworkStatus(
  options: CheckFrameworkOptions,
): Promise<FrameworkStatusResult> {
  const root = path.resolve(options.root);
  const manifest = await loadManifest(root);
  const zones = await Promise.all(
    [
      "references/frozen",
      "analyses/references",
      "analyses/patterns",
      "iterations",
      "knowledge",
    ].map(async (zone) => ({ path: zone, files: await countFiles(path.join(root, zone)) })),
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
    openIterations = await countOpenIterations(root);
  } catch {
    // iterations dir may not exist
  }

  let livingSources: FrameworkStatusLivingSources | undefined;
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
  } catch {
    // sources may not exist or may be mid-migration; status omits the summary
  }

  const knowledgeCount = await countKnowledgeEntries(root);

  if (!manifest) {
    return {
      root,
      hasManifest: false,
      managedFiles: 0,
      zones,
      ...(systems ? { systems } : {}),
      ...(livingSources ? { livingSources } : {}),
      ...(openIterations !== undefined ? { openIterations } : {}),
      knowledgeEntries: knowledgeCount,
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
    mode: manifest.project.mode,
    managedFiles: Object.keys(manifest.managed_files).length,
    zones,
    ...(systems ? { systems } : {}),
    ...(livingSources ? { livingSources } : {}),
    ...(openIterations !== undefined ? { openIterations } : {}),
    knowledgeEntries: knowledgeCount,
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
  requireManifest(await loadManifest(root), root);
  const source = path.resolve(options.source);
  const now = options.now ?? new Date();
  const relativePath = `references/frozen/${monthStamp(now)}/${slugify(options.name)}`;
  const destination = path.join(root, relativePath);

  if (await exists(destination)) {
    throw new FrameworkAlreadyExistsError(`reference already exists: ${relativePath}`);
  }

  await cp(source, destination, {
    recursive: true,
    filter: (_source, dest) => shouldCopyReference(destination, dest),
  });

  // Freeze = open a case file, not just copy files. Write a reference.yaml that
  // records provenance and an `analyzed: false` flag so the framework can track
  // whether this reference ever received an analysis. Without this, a frozen
  // reference is indistinguishable from "done" and tends to be forgotten.
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
      analyzed: false,
      analysis_required: true,
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
    "# Reference case file. Managed by `assay`. Edit provenance fields",
    "# freely; the `analyzed` flag is flipped by `analysis close`.",
    `name: ${yamlScalar(input.name)}`,
    `source: ${yamlScalar(input.source)}`,
    `freeze_path: ${yamlScalar(input.freezePath)}`,
    `frozen_on: ${input.frozenOn}`,
    "analyzed: false",
    "# analysis_points: fill with concrete questions this reference should answer",
    "analysis_points: []",
    "",
  ].join("\n");
}

/** Quote a YAML scalar only when it contains characters that need quoting. */
function yamlScalar(value: string): string {
  if (value === "" || /[:#\[\]\{\},&*!|>'"%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Minimal reference.yaml reader. Extracts the plain scalar fields we write
 * (name, source, freeze_path) without a YAML dependency. Returns the raw
 * string for each found field; unknown/missing fields are undefined.
 */
function parseReferenceYaml(content: string): {
  name?: string;
  source?: string;
  freezePath?: string;
  analyzed?: boolean;
} {
  const result: { name?: string; source?: string; freezePath?: string; analyzed?: boolean } = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const match = trimmed.match(/^([a-z_]+):\s*(.*)$/);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const key = match[1];
    let raw = match[2].trim();
    if (raw === "[]") continue;
    // Strip a surrounding JSON-style quote pair if present.
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    if (key === "name") result.name = raw;
    else if (key === "source") result.source = raw;
    else if (key === "freeze_path") result.freezePath = raw;
    else if (key === "analyzed") result.analyzed = raw === "true";
  }
  return result;
}

/**
 * Flip `analyzed: false` to `analyzed: true` in a reference.yaml, preserving
 * all other lines. Returns true if the file was updated.
 */
async function markReferenceAnalyzed(yamlPath: string): Promise<boolean> {
  if (!(await exists(yamlPath))) return false;
  const content = await readFile(yamlPath, "utf8");
  if (!/^analyzed:\s*false\s*$/m.test(content)) return false;
  const updated = content.replace(/^analyzed:\s*false\s*$/m, "analyzed: true");
  await writeFile(yamlPath, updated, "utf8");
  return true;
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

/**
 * Read the installed archetype from a workspace manifest.
 *
 * The legacy function name remains for source compatibility with CLI code that
 * has not yet been renamed from profile→archetype.
 */
export async function readInstalledProfileName(root: string): Promise<ProjectArchetype | null> {
  return readInstalledArchetype(root);
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
    let analysisContent = await readFile(analysis.absolutePath, "utf8");
    const sectionHeader = "## Architecture / structure";
    if (analysisContent.includes(sectionHeader)) {
      analysisContent = analysisContent.replace(sectionHeader, `${sectionHeader}\n\n${probe.body}`);
    } else {
      analysisContent += `\n${sectionHeader}\n\n${probe.body}\n`;
    }
    await writeFile(analysis.absolutePath, analysisContent, "utf8");
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
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = `analyses/references/${date}-${slugify(options.title)}.md`;
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
  if (options.forReference) {
    const refPath = options.forReference.replace(/\\/g, "/");
    const refAbsolute = path.join(root, refPath);
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
      ...(options.forReference ? { for_reference: options.forReference.replace(/\\/g, "/") } : {}),
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
  requireManifest(await loadManifest(root), root);
  await requireCapability(root, "iteration");
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = `iterations/${date}-${slugify(options.title)}`;
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
  await requireCapability(root, "events");
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
  requireManifest(await loadManifest(root), root);
  await requireCapability(root, "iteration");
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  // Resolve iteration directory from selector (path or date-slug prefix)
  const iterationsDir = path.join(root, "iterations");
  let iterPath: string | null = null;
  const selectorNormalized = options.selector.replace(/\\/g, "/");

  // Try as direct path
  const directPath = path.join(root, selectorNormalized);
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
        iterPath = `iterations/${matches[0]}`;
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
  content = content.replace(/(?<![a-z])Status:\s*open\b/i, "Status: closed");
  content = content.replace(
    /## Result\s*\n/,
    `## Result\n\n- ${options.result} on ${date}${options.note ? ` — ${options.note}` : ""}\n`,
  );
  if (!/## Result/.test(content)) {
    content += `\n## Result\n\n- ${options.result} on ${date}${options.note ? ` — ${options.note}` : ""}\n`;
  }
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

  const analysisPath = options.path.replace(/\\/g, "/");
  const absolutePath = path.join(root, analysisPath);
  if (!(await exists(absolutePath))) {
    throw new FrameworkNotFoundError(`analysis not found: ${analysisPath}`);
  }

  let content = await readFile(absolutePath, "utf8");
  assertAnalysisCloseContent(content, options.exit, options.allowEmpty ?? false);
  const sourceAliasMatch = content.match(/^- Source alias:\s*(\S+)/m);
  const sourceObservationMatch = content.match(/^- Source observation:\s*(\S+)/m);
  const sourceBinding =
    sourceAliasMatch?.[1] && sourceObservationMatch?.[1]
      ? { alias: sourceAliasMatch[1], observation: sourceObservationMatch[1] }
      : null;
  if (sourceBinding) {
    await resolveSourceObservation({
      root,
      alias: sourceBinding.alias,
      observation: sourceBinding.observation,
    });
  }
  // Set status
  const statusMap: Record<AnalysisExit, string> = {
    adopt: "applied",
    reject: "rejected",
    experiment: "experiment",
    adr: "adr",
  };
  const statusValue = statusMap[options.exit];
  if (/- Status:\s*\S+/i.test(content)) {
    content = content.replace(/- Status:\s*\S+/i, `- Status: ${statusValue}`);
  } else {
    content = `# Analysis\n\n- Status: ${statusValue}\n${content}`;
  }
  // Check the decision exit checkbox
  const exitLabel = options.exit === "adr" ? "ADR" : options.exit;
  const checkboxPattern = new RegExp(/- \[[\s]?\] /.source + exitLabel + /\b/.source, "i");
  content = content.replace(checkboxPattern, `- [x] ${exitLabel}`);
  if (options.note) {
    content += `\n> Closed on ${date}: ${options.note}\n`;
  }
  await writeFile(absolutePath, content, "utf8");

  // If this analysis was bound to a frozen reference, flip that reference's
  // `analyzed` flag to true so `check` stops warning about it. This closes the
  // references → analyses loop: freezing opens the case, closing the analysis
  // marks it resolved.
  const freezePathMatch = content.match(/^- Freeze path:\s*(\S+)/m);
  let analyzedReference: string | null = null;
  if (freezePathMatch?.[1]) {
    const freezePath = freezePathMatch[1];
    const yamlPath = path.join(root, freezePath, "reference.yaml");
    if (await markReferenceAnalyzed(yamlPath)) {
      analyzedReference = freezePath;
    }
  }

  let closedSourceObservation: string | null = null;
  if (sourceBinding) {
    const closed = await closeSourceObservationAnalysis({
      root,
      alias: sourceBinding.alias,
      observation: sourceBinding.observation,
      analysisPath,
      analysisExit: options.exit,
      now,
    });
    closedSourceObservation = closed.observationFile;
  }

  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.closed",
      path: analysisPath,
      exit: options.exit,
      note: options.note ?? null,
      ...(options.allowEmpty ? { allow_empty: true } : {}),
      ...(analyzedReference ? { marked_reference_analyzed: analyzedReference } : {}),
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
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const typeDir = `knowledge/${KNOWLEDGE_TYPE_DIRS[options.type]}`;
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
