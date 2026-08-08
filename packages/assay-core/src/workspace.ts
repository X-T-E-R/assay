import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import {
  ASSAY_AGENTS_FILE,
  ASSAY_AGENTS_MALFORMED_REASON,
  type AssayAgentsBlockResult,
  applyAssayAgentsBlock,
  describeAssayAgentsBlockAction,
  planAssayAgentsBlock,
} from "./agents.js";
import { MANAGED_DIR, MANIFEST_FILE, SYSTEMS_REGISTRY_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { fileHash } from "./hashing.js";
import {
  type WorkspaceArea,
  defaultOverlayLayout,
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspacePath,
  workspaceRelativePath,
  workspaceSubpath,
  workspaceTemplateRelativePath,
  workspaceWorkRelativePath,
} from "./layout.js";
import { defaultManifest, loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import {
  assertNoAncestorWorkspaceAuthority,
  relativeDisplayPath,
  resolveContainedPath,
  slugify,
} from "./paths.js";
import { externalPluginCheckRows } from "./plugins/external.js";
import {
  type Archetype,
  dirsForArchetype,
  loadArchetype,
  readInstalledArchetype,
} from "./profile.js";
import {
  ensureNativeProject,
  loadNativeProject,
  preflightNativeProjectBoundary,
  preflightWorkspaceManifestBoundary,
  projectFileRelativePath,
  projectRootRelativePath,
  validateNativeProjectStructure,
} from "./project.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "./results.js";
import { RoadmapError, validateRoadmaps } from "./roadmap.js";
import type {
  FrameworkManifest,
  ProjectArchetype,
  ProjectMode,
  WorkspaceLayout,
} from "./schemas/index.js";
import {
  collectSourceAdoptionIntegrityRows,
  getSourceAdoptionSummary,
} from "./source-adoptions.js";
import { collectSourceHealthRows, getSourceStatus, resolveSourceObservation } from "./sources.js";
import { SpecError, validateSpecs } from "./spec.js";
import { loadSystemsRegistry, resolveRegistryPath } from "./systems-registry.js";
import { TaskError, validateTasks } from "./task.js";
import { archetypeTemplates } from "./templates.js";
import { nowIso } from "./time.js";
import { type UpstreamStatus, collectUpstreamStatus } from "./upstream.js";
import { NATIVE_LAZY_DIRECTORIES, archetypeZones } from "./zones.js";

/**
 * Runtime template set for a workspace, resolved through its layout.
 *
 * Overlay workspaces keep every Assay-managed file under `.assay/`, so the
 * archetype's root-relative template paths are translated before `update` uses
 * them. Without the layout, `assay update` would create `README.md`,
 * `.gitignore`, `analyses/`, and `knowledge/` in an attached product
 * repository — the files `attach` deliberately leaves alone.
 *
 */
export async function desiredRuntimeTemplates(
  project: string,
  archetype: ProjectArchetype,
  mode: ProjectMode,
  options: {
    readonly root?: string;
    readonly layout?: WorkspaceLayout;
  } = {},
) {
  const archetypeDefinition = await loadArchetype(archetype, options);
  return archetypeTemplates(project, mode, archetypeDefinition, options.layout);
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

export interface FrameworkStatusSources {
  readonly total: number;
  readonly living: number;
  readonly frozen: number;
  readonly majorChanges: number;
}

export interface FrameworkStatusSourceAdoptions {
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
  readonly nativeProject?: {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly authority: string;
  };
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
  readonly sources?: FrameworkStatusSources;
  /** Drift of each living source's checkout; omitted when there are none. */
  readonly upstream?: UpstreamStatus;
  /** Sources whose latest change grade suggests recording a decision. */
  readonly sourceAdoptions?: FrameworkStatusSourceAdoptions;
  readonly knowledgeEntries?: number;
  /** Records in a workspace-root `runs.jsonl`; omitted when there is no file. */
  readonly runRecords?: number;
}

export interface CreateAnalysisOptions {
  readonly root: string;
  readonly title: string;
  /** Source alias this analysis is bound to. */
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

export type AnalysisExit = "adopt" | "reject" | "experiment";

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

export type KnowledgeType = "pattern" | "guide" | "troubleshooting";

// Map each knowledge type to its directory name. Most types pluralize by
// appending "s", but "troubleshooting" is already the directory name used by
// the templates and constants (knowledge/troubleshooting/). Appending "s"
// here would create a parallel "knowledge/troubleshootings/" directory and
// split entries from their README — the bug this map exists to prevent.
const KNOWLEDGE_TYPE_DIRS: Record<KnowledgeType, string> = {
  pattern: "patterns",
  guide: "guides",
  troubleshooting: "troubleshooting",
};

export interface AddKnowledgeOptions {
  readonly root: string;
  readonly type: KnowledgeType;
  readonly title: string;
  readonly fromAnalysis?: string;
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
    value === "sources" ||
    value === "analyses" ||
    value === "knowledge" ||
    value === "systemsContracts"
  );
}

function layoutDirectoryPath(layout: WorkspaceLayout, directory: string): string {
  return isWorkspaceArea(directory)
    ? workspaceRelativePath(layout, directory)
    : workspaceWorkRelativePath(layout, directory);
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
    return basename !== "README.md";
  }).length;
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
  await assertNoAncestorWorkspaceAuthority(root);
  const installedManifest = await loadManifest(root);
  const project = options.name ?? path.basename(root);
  const report = createEmptyReport();

  const archetype = options.archetype ?? "study";
  const archetypeDefinition = await loadArchetype(archetype, { root });
  const mode = archetypeDefinition.mode;

  await preflightNativeProjectBoundary(root, defaultStandaloneLayout());

  await ensureDir(root, root, report);

  let manifest = installedManifest ?? defaultManifest(project, { archetype, mode });
  manifest.project.archetype = archetype;
  manifest.project.mode = mode;

  const directories = new Set(dirsForArchetype(archetypeDefinition, mode));
  for (const directory of directories) {
    await ensureDir(path.join(root, directory), root, report);
  }

  const nativeProject = await ensureNativeProject(
    root,
    defaultStandaloneLayout(),
    manifest.project.name,
  );
  report.created_dirs.push(...nativeProject.createdDirectories);
  report.created_files.push(...nativeProject.createdFiles);

  for (const template of archetypeTemplates(project, mode, archetypeDefinition)) {
    const result = await writeTemplateFile(root, template.path, template.content, report, {
      force: options.force ?? false,
      createNew: options.createNew ?? false,
      executable: template.executable,
    });
    if (result === "written") {
      recordTemplate(manifest, template);
    }
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

export async function checkFramework(
  options: CheckFrameworkOptions,
): Promise<CheckFrameworkResult> {
  const root = path.resolve(options.root);
  const includeAdvisories = options.includeAdvisories ?? false;

  try {
    await preflightWorkspaceManifestBoundary(root);
  } catch (error) {
    return {
      root,
      ok: false,
      rows: [
        {
          path: MANIFEST_FILE,
          status: "error",
          message: error instanceof Error ? error.message : "Assay manifest boundary is redirected",
        },
      ],
    };
  }

  // Resolve the workspace layout up front so checks point at the right paths
  // for both standalone (work folders at root) and overlay (work folders
  // under .assay/). If the manifest cannot be read, fall back to standalone.
  const manifestForLayout = await loadManifest(root);
  const layout = layoutForManifest(manifestForLayout);
  if (manifestForLayout) {
    try {
      await preflightNativeProjectBoundary(root, layout);
    } catch (error) {
      return {
        root,
        ok: false,
        rows: [
          {
            path: projectRootRelativePath(layout),
            status: "error",
            message:
              error instanceof Error ? error.message : "native Project boundary is redirected",
          },
        ],
      };
    }
  }

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
    ["native Project directory", workspaceWorkRelativePath(layout, "project")],
  ];

  // If a workspace declares its archetype, augment checks with that archetype's
  // top-level dirs (intake/, problem/, sources/, analyses/,
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
      if (
        top &&
        !top.startsWith(".") &&
        top !== "project" &&
        top !== "systems" &&
        top !== "knowledge"
      ) {
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

  const rows: CheckRow[] = [...archetypeDegradations];

  for (const [label, target] of checkTargets) {
    rows.push({
      path: target,
      status: (await exists(path.join(root, target))) ? "ok" : "missing",
      message: label,
    });
  }

  const manifest = manifestForLayout;

  if (manifest) {
    rows.push({
      path: MANIFEST_FILE,
      status: "ok",
      message: `manifest schema ${manifest.__schema}; archetype ${manifest.project.archetype}; mode ${manifest.project.mode}`,
    });

    try {
      await validateNativeProjectStructure(root, layout);
      const project = await loadNativeProject(root, layout);
      rows.push(
        project
          ? {
              path: projectFileRelativePath(layout),
              status: "ok",
              message: `native Project ${project.id}; authority ${project.authority.mode}:${project.authority.pointer}`,
            }
          : {
              path: projectFileRelativePath(layout),
              status: "missing",
              message: "native Project envelope is required",
            },
      );
    } catch (error) {
      rows.push({
        path: projectFileRelativePath(layout),
        status: "error",
        message:
          error instanceof Error ? error.message : "native Project envelope failed validation",
      });
    }

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

  if (manifest) {
    rows.push(...(await externalPluginCheckRows(root)));
  }

  // Semantic check 2: systems registry consistency
  let primaryName: string | null = null;
  let systemCount = 0;
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

  // Semantic check 3: knowledge directory-name consistency
  // The framework owns the base knowledge subdirectory names (patterns,
  // guides, troubleshooting). A legacy bug appended "s" to every
  // knowledge type, producing a parallel "knowledge/troubleshootings/"
  // directory that split troubleshooting entries from their README. Flag any
  // knowledge subdirectory that is neither a base name nor declared by the
  // workspace's archetype, so real drift is visible while a custom archetype's
  // own knowledge folders stay clean.
  try {
    const knowledgeRoot = workspacePath(root, layout, "knowledge");
    if (await exists(knowledgeRoot)) {
      const expectedKnowledgeDirs = new Set([
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

  // Advisory check 1: empty draft analyses.
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
      const queueCandidates = [path.join(root, MANAGED_DIR, "queue.json")];
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

  // Advisory check 5: superseded systems no chain points at. `system promote`
  // demotes the previous primary without writing a supersedes link.
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

  // Advisory check 6: placement. `check` has always validated that declared
  // directories exist; these three report the opposite — content sitting where
  // the archetype never said it should. They are advisories on purpose:
  // writing straight into a directory instead of going through a command is
  // normal usage, and the goal is to make misplacement visible and fixable
  // rather than to fail the workspace over it.
  if (includeAdvisories) {
    rows.push(...(await collectPlacementAdvisories(root, layout, manifestForLayout)));
  }

  // Advisory check 7: the AGENTS.md managed block no longer matches the
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

  // Semantic check 6: Source observation integrity. Analysis lifecycle state
  // is intentionally absent; missing referenced records remain visible in the
  // default structural check.
  // External sources live at sources/<source>/ with source.yaml plus their
  // observation ledger in the same Source entry.
  try {
    rows.push(...(await collectSourceHealthRows(root, { includeAdvisories })));
  } catch (error) {
    rows.push({
      path: workspaceRelativePath(layout, "sources"),
      status: "error",
      message:
        error instanceof Error ? error.message : "source observation state failed validation",
    });
  }

  // Semantic check 7: Source adoption receipt integrity. Ordinary source/target
  // changes and advisory evidence intentionally stay out of global check.
  try {
    rows.push(...(await collectSourceAdoptionIntegrityRows(root)));
  } catch (error) {
    rows.push({
      path: `${MANAGED_DIR}/donors`,
      status: "error",
      message: error instanceof Error ? error.message : "source adoption state failed validation",
    });
  }

  // Semantic check 8: native Roadmap structure, graph, and Task references.
  // Partial validation keeps healthy siblings visible when one item is bad.
  try {
    const roadmapValidation = await validateRoadmaps({ root });
    for (const item of roadmapValidation.items) {
      rows.push({
        path: item.path,
        status: item.valid ? "ok" : "error",
        message: item.valid
          ? "native roadmap item is valid"
          : item.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
    }
  } catch (error) {
    rows.push({
      path: `${projectRootRelativePath(layout)}/roadmap`,
      status: "error",
      message:
        error instanceof RoadmapError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "native roadmap records failed validation",
    });
  }

  // Semantic check 9: native Spec envelopes, scope, provenance, and replacement graph.
  // Spec storage is lazy; partial validation keeps healthy siblings visible.
  try {
    const specValidation = await validateSpecs({ root });
    for (const item of specValidation.items) {
      rows.push({
        path: item.path,
        status: item.valid ? "ok" : "error",
        message: item.valid
          ? "native spec is valid"
          : item.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
    }
    for (const issue of specValidation.issues.filter((candidate) => candidate.id === undefined)) {
      rows.push({
        path: issue.path ?? `${projectRootRelativePath(layout)}/specs`,
        status: "error",
        message: `${issue.code}: ${issue.message}`,
      });
    }
  } catch (error) {
    rows.push({
      path: `${projectRootRelativePath(layout)}/specs`,
      status: "error",
      message:
        error instanceof SpecError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "native specs failed validation",
    });
  }

  // Semantic check 10: native Task history. Task storage is optional, and one
  // malformed historical record must not hide validation results for others.
  try {
    const taskValidation = await validateTasks({ root });
    for (const task of taskValidation.tasks) {
      rows.push({
        path: task.path,
        status: task.valid ? "ok" : "error",
        message: task.valid
          ? `native task record is valid (${task.status})`
          : task.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
    }
    if (taskValidation.context_issues.length > 0) {
      rows.push({
        path: taskValidation.context_path,
        status: "error",
        message: taskValidation.context_issues
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; "),
      });
    }
  } catch (error) {
    rows.push({
      path: workspaceWorkRelativePath(layout, "tasks"),
      status: "error",
      message:
        error instanceof TaskError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "native task records failed validation",
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
    ...(systemCount > 0 || primaryName !== null
      ? { systems: { primary: primaryName, total: systemCount } }
      : {}),
  };
}

/**
 * Directories under a work root that belong to Assay's own machinery rather
 * than to an archetype. In an overlay workspace the work root and the state
 * root are the same directory, so these sit next to the work folders and must
 * not be reported as stray placement.
 */
const NON_ZONE_WORK_ROOT_ENTRIES = new Set(["donors", "archetypes", "node_modules", "tasks"]);

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

  const declared = new Set<string>(NON_ZONE_WORK_ROOT_ENTRIES);
  for (const directory of [
    ...dirsForArchetype(archetype, manifest.project.mode),
    ...NATIVE_LAZY_DIRECTORIES.map((directory) => directory.path),
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
 * `- Source observation:`, ...) are written into this block, so reads and rewrites
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

function insertHeaderLine(header: string, line: string): string {
  const body = header.replace(/\s+$/, "");
  if (body === "") {
    return `${line}\n\n${header}`;
  }
  const trailing = header.slice(body.length);
  return `${body}\n${line}${trailing === "" ? "\n" : trailing}`;
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
    if (/^- \[[ xX]\]\s+(adopt|reject|experiment)$/i.test(trimmed)) return false;
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
 * holds content the archetype never declared. Status must not hide content in
 * a current layout-owned work area merely because the archetype omits it.
 */
const WORK_AREA_ZONE_PURPOSES: ReadonlyArray<readonly [WorkspaceArea, string]> = [
  ["sources", "External systems captured as evidence"],
  ["analyses", "Conversion layer from Sources to decisions"],
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
): Promise<FrameworkZoneCount[]> {
  const declared = archetype ? archetypeZones(archetype, mode) : [];
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
  await preflightWorkspaceManifestBoundary(root);
  const manifest = await loadManifest(root);
  if (manifest) {
    await preflightNativeProjectBoundary(root, layoutForManifest(manifest));
  }
  const layout = layoutForManifest(manifest);
  const { archetype: archetypeDefinition, degradation: archetypeNotice } =
    await readArchetypeForStatus(root, manifest);
  const zones = await resolveStatusZones(
    root,
    layout,
    archetypeDefinition,
    manifest?.project.mode ?? archetypeDefinition?.mode ?? "learning",
  );

  // Systems section from registry
  let systems: readonly FrameworkStatusSystem[] | undefined;
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

  let sourceSummary: FrameworkStatusSources | undefined;
  try {
    const status = await getSourceStatus({ root });
    const sources = status.sources;
    sourceSummary = {
      total: sources.length,
      living: sources.filter((source) => source.mode === "living").length,
      frozen: sources.filter((source) => source.mode === "frozen").length,
      majorChanges: sources.filter((source) => source.latestChangeClass === "major").length,
    };
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

  let sourceAdoptions: FrameworkStatusSourceAdoptions | undefined;
  try {
    sourceAdoptions = (await getSourceAdoptionSummary(root)) ?? undefined;
  } catch {
    // operational adoption state may be absent or mid-repair; check reports structural errors
  }

  const knowledgeCount = await countKnowledgeEntries(root, layout);
  const runRecords = await countRunRecords(root, layout);
  let nativeProject: FrameworkStatusResult["nativeProject"];
  if (manifest) {
    try {
      const loaded = await loadNativeProject(root, layout);
      if (loaded) {
        nativeProject = {
          id: loaded.id,
          name: loaded.name,
          path: projectFileRelativePath(layout),
          authority: `${loaded.authority.mode}:${loaded.authority.pointer}`,
        };
      }
    } catch {
      // `check` reports the exact validation failure; status remains readable.
    }
  }

  if (!manifest) {
    return {
      root,
      hasManifest: false,
      managedFiles: 0,
      zones,
      ...(systems ? { systems } : {}),
      ...(sourceSummary ? { sources: sourceSummary } : {}),
      ...(upstream ? { upstream } : {}),
      ...(sourceAdoptions ? { sourceAdoptions } : {}),
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
    ...(nativeProject ? { nativeProject } : {}),
    archetype: manifest.project.archetype,
    ...(archetypeDefinition && archetypeDefinition.description !== ""
      ? { archetypeDescription: archetypeDefinition.description }
      : {}),
    ...(archetypeNotice ? { archetypeNotice } : {}),
    mode: manifest.project.mode,
    managedFiles: Object.keys(manifest.managed_files).length,
    zones,
    ...(systems ? { systems } : {}),
    ...(sourceSummary ? { sources: sourceSummary } : {}),
    ...(upstream ? { upstream } : {}),
    ...(sourceAdoptions ? { sourceAdoptions } : {}),
    knowledgeEntries: knowledgeCount,
    ...(runRecords !== undefined ? { runRecords } : {}),
  };
}

export async function readFrameworkMode(root: string): Promise<"learning" | "absorption"> {
  const manifest = await loadManifest(root);
  return manifest?.project.mode ?? "learning";
}
export async function createAnalysis(
  options: CreateAnalysisOptions,
): Promise<CreateAnalysisResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  await loadArchetype(manifest.project.archetype, { root });
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

  let sourceName = "";
  let sourceBlock = "";
  if (options.forSource) {
    const source = await resolveSourceObservation({
      root,
      alias: options.forSource,
      ...(options.observation === undefined ? {} : { observation: options.observation }),
    });
    sourceName = source.alias;
    sourceBlock = [
      `- Source alias: ${source.alias}`,
      `- Source path: ${source.sourcePath}`,
      `- Source observation: ${source.observation.observation_id}`,
      `- Source observation path: ${source.observationFile}`,
      `- Source change class: ${source.observation.change_class}`,
      `- Source manifest: ${source.manifestFile}`,
      `- Source materials: ${source.materialsPath}`,
      ...(source.checkoutPath ? [`- Source checkout: ${source.checkoutPath}`] : []),
      "",
    ].join("\n");
  }

  const content = `# ${options.title}\n\n- Date: ${date}\n- Status: draft\n${sourceBlock}\n## Source\n\n${sourceName}\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Next step\n\n## Decision exit\n\n- [ ] adopt\n- [ ] reject\n- [ ] experiment\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.created",
      path: relativePath,
      title: options.title,
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

export async function closeAnalysis(options: CloseAnalysisOptions): Promise<CloseAnalysisResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  await loadArchetype(manifest.project.archetype, { root });
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const analysis = resolveContainedPath(root, options.path, "analysis path");
  const analysisPath = analysis.relativePath;
  const absolutePath = analysis.absolutePath;
  if (!(await exists(absolutePath))) {
    throw new FrameworkNotFoundError(`analysis not found: ${analysisPath}`);
  }

  let content = await readFile(absolutePath, "utf8");
  // Set status
  const statusMap: Record<AnalysisExit, string> = {
    adopt: "applied",
    reject: "rejected",
    experiment: "experiment",
  };
  const statusValue = statusMap[options.exit];
  content = setHeaderField(content, "Status", statusValue, `analysis ${analysisPath}`);
  // Tick the decision-exit checkbox inside the `## Decision exit` section. An
  // analysis card that does not carry that section records its exit through the
  // header alone; one that does carry it must contain the matching checkbox,
  // otherwise the requested exit cannot be recorded and the close fails.
  const exitLabel = options.exit;
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

  await writeFile(absolutePath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.closed",
      path: analysisPath,
      exit: options.exit,
      note: options.note ?? null,
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
    },
    now,
  );

  return { root, path: relativePath, eventFile: relativeDisplayPath(eventFile, root) };
}
