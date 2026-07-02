import { chmod, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ASSAY_AGENTS_MALFORMED_REASON,
  type AssayAgentsBlockMode,
  type AssayAgentsBlockResult,
  applyAssayAgentsBlock,
  describeAssayAgentsBlockAction,
  planAssayAgentsBlock,
} from "./agents.js";
import {
  BACKUPS_DIR,
  CURRENT_VERSION,
  LAYOUT_VERSION,
  MANIFEST_FILE,
  SYSTEMS_REGISTRY_FILE,
  VERSION_FILE,
} from "./constants.js";
import { FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { computeHash, fileHash } from "./hashing.js";
import { loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import {
  type OperationReport,
  type UpdateAnalysis,
  type UpdateChange,
  type UpdateConflictAction,
  type UpdatePlan,
  createEmptyReport,
} from "./results.js";
import type {
  FrameworkManifest,
  MigrationPlan,
  MigrationStep,
  SystemsRegistry,
} from "./schemas/index.js";
import { migrationPlanSchema, updateAnalysisSchema, updatePlanSchema } from "./schemas/index.js";
import {
  defaultSystemsRegistry,
  loadSystemsRegistry,
  saveSystemsRegistry,
} from "./systems-registry.js";
import type { TemplateFile } from "./templates.js";
import { nowIso } from "./time.js";
import { desiredRuntimeTemplates } from "./workspace.js";

export interface AnalyzeUpdateOptions {
  readonly root: string;
}

export interface PlanUpdateOptions extends AnalyzeUpdateOptions {
  readonly dryRun?: boolean;
  readonly action?: UpdateConflictAction;
  readonly agents?: boolean;
}

export interface ApplyUpdateOptions extends PlanUpdateOptions {
  readonly now?: Date;
}

export interface BackupResult {
  readonly path: string;
  readonly relativePath: string;
  readonly copied: string[];
}

export interface ApplyUpdateResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly action: UpdateConflictAction;
  readonly analysis: UpdateAnalysis;
  readonly plan: UpdatePlan;
  readonly report: OperationReport;
  readonly backup?: BackupResult;
  readonly eventFile?: string;
}

function updateAgentsMode(value: boolean | undefined): AssayAgentsBlockMode {
  if (value === true) {
    return "install";
  }
  if (value === false) {
    return "skip";
  }
  return "refresh-existing";
}

function recordAssayAgentsResult(report: OperationReport, result: AssayAgentsBlockResult): void {
  if (result.changed && result.dryRun) {
    report.notes.push(describeAssayAgentsBlockAction(result));
    return;
  }

  if (!result.changed) {
    if (result.reason === ASSAY_AGENTS_MALFORMED_REASON) {
      report.notes.push(describeAssayAgentsBlockAction(result));
    }
    return;
  }

  if (result.action === "create") {
    report.created_files.push(result.path);
  } else if (result.action === "append" || result.action === "replace") {
    report.updated_files.push(result.path);
  }
}

export interface BuildLayoutMigrationPlanOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly apply?: boolean;
}

export interface MigrateLayoutOptions extends BuildLayoutMigrationPlanOptions {
  readonly backup?: boolean;
  readonly now?: Date;
}

export interface MigrateLayoutResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly plan: MigrationPlan;
  readonly backup?: BackupResult;
  readonly eventFile?: string;
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

async function pathStats(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function backupStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}-${hour}${minute}${second}`;
}

function updateChange(
  template: TemplateFile,
  kind: UpdateChange["kind"],
  hashes: {
    readonly currentHash?: string;
    readonly previousHash?: string;
    readonly desiredHash?: string;
    readonly reason?: string;
  } = {},
): UpdateChange {
  const change: UpdateChange = {
    path: template.path,
    template_id: template.template_id,
    kind,
  };
  if (hashes.currentHash !== undefined) {
    change.current_hash = hashes.currentHash;
  }
  if (hashes.previousHash !== undefined) {
    change.previous_hash = hashes.previousHash;
  }
  if (hashes.desiredHash !== undefined) {
    change.desired_hash = hashes.desiredHash;
  }
  if (hashes.reason !== undefined) {
    change.reason = hashes.reason;
  }
  return change;
}

function changeSummary(changes: UpdateAnalysis["changes"]): UpdateChange[] {
  return [
    ...changes.new,
    ...changes.auto_update,
    ...changes.modified_by_user,
    ...changes.user_deleted,
    ...changes.untracked_existing,
    ...changes.unchanged,
  ];
}

function changeAction(change: UpdateChange, conflictAction: UpdateConflictAction): UpdateChange {
  const next: UpdateChange = { ...change };
  if (change.kind === "new") {
    next.action = "create";
  } else if (change.kind === "auto-update") {
    next.action = "update";
  } else if (change.kind === "modified-by-user" || change.kind === "untracked-existing") {
    next.action = conflictAction;
  } else {
    next.action = "skip";
  }
  return next;
}

function requireManifest(manifest: FrameworkManifest | null, root: string): FrameworkManifest {
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}. Run init first.`,
    );
  }
  return manifest;
}

function projectNameFromManifest(
  manifest: FrameworkManifest | null | undefined,
  fallbackRoot: string,
): string {
  return manifest?.project.name || path.basename(path.resolve(fallbackRoot));
}

function legacyCoreNameForV2Manifest(manifest: FrameworkManifest, root: string): string {
  // Compatibility island for v2→v3 migration only. New runtime/update template
  // analysis must read manifest.project.archetype/mode and must not use
  // manifest.project.core.
  return manifest.project.core ?? `${slugify(path.basename(path.resolve(root)))}-core`;
}

function isLegacySystemManagedFile(managedPath: string, coreName: string): boolean {
  if (!managedPath.startsWith(`systems/${coreName}/`)) {
    return false;
  }
  return managedPath !== `systems/${coreName}/system.yaml`;
}

async function writeTemplate(root: string, template: TemplateFile): Promise<void> {
  const target = path.join(root, template.path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, template.content, "utf8");
  if (template.executable) {
    const mode = (await stat(target)).mode;
    await chmod(target, mode | 0o755);
  }
}

async function writeNewCopy(root: string, template: TemplateFile): Promise<string> {
  const target = `${path.join(root, template.path)}.new`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, template.content, "utf8");
  return relativeDisplayPath(target, root);
}

export async function analyzeUpdate(options: AnalyzeUpdateOptions): Promise<UpdateAnalysis> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const project = projectNameFromManifest(manifest, root);
  const changes: UpdateAnalysis["changes"] = {
    new: [],
    auto_update: [],
    modified_by_user: [],
    user_deleted: [],
    untracked_existing: [],
    unchanged: [],
  };

  for (const template of await desiredRuntimeTemplates(
    project,
    manifest.project.archetype,
    manifest.project.mode,
    { root },
  )) {
    const target = path.join(root, template.path);
    const record = manifest.managed_files[template.path];
    const desiredHash = computeHash(template.content);
    if (!(await exists(target))) {
      if (record) {
        changes.user_deleted.push(
          updateChange(template, "user-deleted", {
            previousHash: record.hash,
            desiredHash,
            reason: "managed file is recorded but missing on disk",
          }),
        );
      } else {
        changes.new.push(updateChange(template, "new", { desiredHash }));
      }
      continue;
    }

    const currentHash = await fileHash(target);
    if (!record) {
      if (currentHash === desiredHash) {
        changes.unchanged.push(updateChange(template, "unchanged", { currentHash, desiredHash }));
      } else {
        changes.untracked_existing.push(
          updateChange(template, "untracked-existing", {
            currentHash,
            desiredHash,
            reason: "file exists but is not tracked in the manifest",
          }),
        );
      }
      continue;
    }

    if (currentHash === desiredHash) {
      changes.unchanged.push(
        updateChange(template, "unchanged", {
          currentHash,
          previousHash: record.hash,
          desiredHash,
        }),
      );
    } else if (currentHash === record.hash) {
      changes.auto_update.push(
        updateChange(template, "auto-update", {
          currentHash,
          previousHash: record.hash,
          desiredHash,
          reason: "managed file is unchanged by the user and differs from the current template",
        }),
      );
    } else {
      changes.modified_by_user.push(
        updateChange(template, "modified-by-user", {
          currentHash,
          previousHash: record.hash,
          desiredHash,
          reason: "managed file differs from both manifest record and current template",
        }),
      );
    }
  }

  return updateAnalysisSchema.parse({
    root,
    dry_run: false,
    changes,
  });
}

export async function planUpdate(options: PlanUpdateOptions): Promise<UpdatePlan> {
  const action = options.action ?? "skip";
  const analysis = await analyzeUpdate(options);
  const changes = changeSummary(analysis.changes).map((change) => changeAction(change, action));
  const notes = options.dryRun ? ["dry-run: no changes applied"] : [];
  return updatePlanSchema.parse({
    root: analysis.root,
    dry_run: options.dryRun ?? false,
    action,
    changes,
    notes,
  });
}

export async function createBackup(
  rootInput: string,
  relativePaths: readonly string[],
  now = new Date(),
): Promise<BackupResult> {
  const root = path.resolve(rootInput);
  const backup = path.join(root, BACKUPS_DIR, backupStamp(now));
  await mkdir(backup, { recursive: true });

  const copied: string[] = [];
  const candidates = [...new Set([MANIFEST_FILE, VERSION_FILE, ...relativePaths])];
  for (const relativePath of candidates) {
    const source = path.join(root, relativePath);
    const stats = await pathStats(source);
    if (!stats) {
      continue;
    }

    const destination = path.join(backup, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    if (stats.isDirectory()) {
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } else if (stats.isFile()) {
      await copyFile(source, destination);
    } else {
      continue;
    }
    copied.push(relativePath);
  }

  return {
    path: backup,
    relativePath: relativeDisplayPath(backup, root),
    copied,
  };
}

async function createFileBackup(
  rootInput: string,
  relativePaths: readonly string[],
  now = new Date(),
): Promise<BackupResult | null> {
  const root = path.resolve(rootInput);
  const backup = path.join(root, BACKUPS_DIR, backupStamp(now));
  const copied: string[] = [];
  const candidates = [...new Set(relativePaths)];

  for (const relativePath of candidates) {
    const source = path.join(root, relativePath);
    const stats = await pathStats(source);
    if (!stats?.isFile()) {
      continue;
    }

    if (copied.length === 0) {
      await mkdir(backup, { recursive: true });
    }

    const destination = path.join(backup, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied.push(relativePath);
  }

  if (copied.length === 0) {
    return null;
  }

  return {
    path: backup,
    relativePath: relativeDisplayPath(backup, root),
    copied,
  };
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const root = path.resolve(options.root);
  const action = options.action ?? "skip";
  const dryRun = options.dryRun ?? false;
  const analysis = await analyzeUpdate({ root });
  const plan = await planUpdate({ root, dryRun, action });
  const report = createEmptyReport();
  const agentsMode = updateAgentsMode(options.agents);
  const agentsPlan = await planAssayAgentsBlock({ root, mode: agentsMode });

  if (dryRun) {
    report.notes.push("dry-run: no changes applied");
    recordAssayAgentsResult(
      report,
      await applyAssayAgentsBlock({ root, mode: agentsMode, dryRun: true }),
    );
    return { root, dryRun, action, analysis, plan, report };
  }

  const manifest = requireManifest(await loadManifest(root), root);
  const project = projectNameFromManifest(manifest, root);
  const templatesByPath = new Map(
    (
      await desiredRuntimeTemplates(project, manifest.project.archetype, manifest.project.mode, {
        root,
      })
    ).map((template) => [template.path, template]),
  );
  const backupPaths = [
    ...analysis.changes.auto_update,
    ...analysis.changes.modified_by_user,
    ...analysis.changes.untracked_existing,
  ]
    .map((change) => change.path)
    .filter((relativePath) => templatesByPath.has(relativePath));
  const backupPathsWithAgents =
    agentsPlan.changed && agentsPlan.action !== "create"
      ? [...backupPaths, agentsPlan.path]
      : backupPaths;
  const backup = await createBackup(root, backupPathsWithAgents, options.now);
  report.notes.push(`backup: ${backup.relativePath}`);

  for (const change of plan.changes) {
    const template = templatesByPath.get(change.path);
    if (!template) {
      continue;
    }

    if (change.action === "create") {
      await writeTemplate(root, template);
      report.created_files.push(template.path);
      recordTemplate(manifest, template);
    } else if (change.action === "update" || change.action === "force") {
      await writeTemplate(root, template);
      report.updated_files.push(template.path);
      recordTemplate(manifest, template);
    } else if (change.action === "create-new") {
      report.new_copies.push(await writeNewCopy(root, template));
      if (change.kind === "modified-by-user" || change.kind === "untracked-existing") {
        report.conflicted_files.push(template.path);
      }
    } else if (change.kind === "user-deleted") {
      if (!manifest.user_deleted.includes(template.path)) {
        manifest.user_deleted.push(template.path);
      }
      report.skipped_files.push(`${template.path} (user-deleted)`);
    } else if (change.kind === "modified-by-user" || change.kind === "untracked-existing") {
      report.skipped_files.push(template.path);
      report.conflicted_files.push(template.path);
    }
  }

  recordAssayAgentsResult(report, await applyAssayAgentsBlock({ root, mode: agentsMode }));

  manifest.framework_version = CURRENT_VERSION;
  await saveManifest(root, manifest);
  const eventFile = await appendEvent(root, {
    action,
    event: "framework.updated",
    summary: {
      created: report.created_files.length,
      new_copies: report.new_copies.length,
      skipped: report.skipped_files.length,
      updated: report.updated_files.length,
    },
    version: CURRENT_VERSION,
  });

  return {
    root,
    dryRun,
    action,
    analysis,
    plan: updatePlanSchema.parse({ ...plan, backup_dir: backup.relativePath }),
    report,
    backup,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function buildLayoutMigrationPlan(
  options: BuildLayoutMigrationPlanOptions,
): Promise<MigrationPlan> {
  const root = path.resolve(options.root);
  const steps: MigrationStep[] = [];

  // --- v2 → v3 migration: systems registry creation ---
  const existingRegistry = await loadSystemsRegistry(root);
  const manifest = await loadManifest(root);
  if (!existingRegistry && manifest && manifest.layout_version < LAYOUT_VERSION) {
    const coreName = legacyCoreNameForV2Manifest(manifest, root);
    const systemsDir = path.join(root, "systems");

    // Step 1: create systems-registry.json from manifest core
    steps.push({
      type: "create-systems-registry",
      from: ".framework/manifest.json",
      to: SYSTEMS_REGISTRY_FILE,
      reason: `initialize registry from manifest core '${coreName}'`,
      action: "create",
    });

    // Step 2: detect and register active systems under systems/
    if (await exists(systemsDir)) {
      for (const child of await readdir(systemsDir, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name === "archive") continue;
        const childPath = path.join(systemsDir, child.name);
        const hasGit = await exists(path.join(childPath, ".git"));
        const isPrimary = child.name === coreName;
        steps.push({
          type: "generate-contract",
          from: `systems/${child.name}`,
          to: `systems/${child.name}/system.yaml`,
          reason: `register ${child.name} as ${isPrimary ? "primary" : "active"} (${hasGit ? "independent-git" : "embedded"})`,
          action: "generate",
        });
      }
    }

    // Step 3: detect archived systems under systems/archive/
    const archiveDir = path.join(root, "systems", "archive");
    if (await exists(archiveDir)) {
      for (const archiveChild of await readdir(archiveDir, { withFileTypes: true })) {
        if (!archiveChild.isDirectory()) continue;
        const datedDir = path.join(archiveDir, archiveChild.name);
        for (const sysDir of await readdir(datedDir, { withFileTypes: true })) {
          if (!sysDir.isDirectory()) continue;
          steps.push({
            type: "create-systems-registry",
            from: `systems/archive/${archiveChild.name}/${sysDir.name}`,
            to: SYSTEMS_REGISTRY_FILE,
            reason: `register ${sysDir.name} as archived`,
            action: "create",
          });
        }
      }
    }

    // Step 4: mark old systems/<core>/** managed files as user-deleted
    for (const managedPath of Object.keys(manifest.managed_files)) {
      if (isLegacySystemManagedFile(managedPath, coreName)) {
        steps.push({
          type: "mark-user-deleted",
          from: managedPath,
          to: "(removed from managed_files)",
          reason: "system-internal templates are no longer managed in layout v3",
          action: "mark",
        });
      }
    }

    // Step 5: upgrade manifest schema and layout version
    steps.push({
      type: "upgrade-manifest",
      from: MANIFEST_FILE,
      to: MANIFEST_FILE,
      reason: `keep __schema at 1, upgrade layout_version to ${LAYOUT_VERSION}`,
      action: "upgrade",
    });
  }

  if (
    manifest &&
    manifest.layout_version < LAYOUT_VERSION &&
    !steps.some((step) => step.type === "upgrade-manifest")
  ) {
    steps.push({
      type: "upgrade-manifest",
      from: MANIFEST_FILE,
      to: MANIFEST_FILE,
      reason: `keep __schema at 1, upgrade layout_version to ${LAYOUT_VERSION}`,
      action: "upgrade",
    });
  }

  // --- legacy layout migrations (v0/v1 → v2) ---
  const references = path.join(root, "references");
  if (await exists(references)) {
    for (const child of await readdir(references, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name === "frozen" || child.name === "intake") {
        continue;
      }
      if (/^\d{6}$/.test(child.name)) {
        steps.push({
          type: "copy-dir",
          from: `references/${child.name}`,
          to: `references/frozen/${child.name}`,
          action: "copy",
        });
      }
    }
  }

  if ((await pathStats(path.join(root, "experiments")))?.isDirectory()) {
    steps.push({ type: "copy-dir", from: "experiments", to: "iterations", action: "copy" });
  }

  const legacyMeta = path.join(root, ".assay");
  if (await exists(legacyMeta)) {
    for (const item of ["events", "queue.json", "config.yaml"]) {
      if (await exists(path.join(legacyMeta, item))) {
        steps.push({
          type: "copy",
          from: `.assay/${item}`,
          to: `.framework/legacy-assay/${item}`,
          action: "copy",
        });
      }
    }
  }

  if ((await pathStats(path.join(root, "knowledge", "evaluations")))?.isDirectory()) {
    steps.push({
      type: "manual-review",
      from: "knowledge/evaluations",
      to: "analyses/references or analyses/gaps",
      reason: "semantic classification required",
      action: "manual-review",
    });
  }

  return migrationPlanSchema.parse({
    root,
    dry_run: options.dryRun ?? true,
    apply: options.apply ?? false,
    steps,
    notes: [],
  });
}

async function migrationBackupPaths(root: string, plan: MigrationPlan): Promise<string[]> {
  const candidates = new Set<string>();
  if (
    plan.steps.some((step) => step.type === "mark-user-deleted" || step.type === "upgrade-manifest")
  ) {
    candidates.add(MANIFEST_FILE);
  }

  for (const step of plan.steps) {
    if (step.type === "generate-contract") {
      candidates.add(step.to);
    } else if (step.type === "create-systems-registry" && step.to === SYSTEMS_REGISTRY_FILE) {
      candidates.add(SYSTEMS_REGISTRY_FILE);
    }
  }

  const existingFiles: string[] = [];
  for (const relativePath of candidates) {
    const stats = await pathStats(path.join(root, relativePath));
    if (stats?.isFile()) {
      existingFiles.push(relativePath);
    }
  }
  return existingFiles;
}

export async function migrateLayout(options: MigrateLayoutOptions): Promise<MigrateLayoutResult> {
  const root = path.resolve(options.root);
  const shouldApply = options.apply ?? false;
  const dryRun = options.dryRun ?? !shouldApply;
  const plan = await buildLayoutMigrationPlan({ root, dryRun, apply: shouldApply });

  if (dryRun || !shouldApply) {
    return { root, dryRun, apply: shouldApply, plan };
  }

  const backup = options.backup
    ? await createFileBackup(root, await migrationBackupPaths(root, plan), options.now)
    : null;

  // --- Apply v2→v3 steps as a batch (registry + contracts + manifest upgrade) ---
  const v2v3Steps = plan.steps.filter(
    (s) =>
      s.type === "create-systems-registry" ||
      s.type === "generate-contract" ||
      s.type === "mark-user-deleted" ||
      s.type === "upgrade-manifest",
  );

  if (v2v3Steps.length > 0) {
    await applyV2ToV3Migration(root, plan.steps);
  }

  // --- Apply legacy copy steps ---
  for (const step of plan.steps) {
    const source = path.join(root, step.from);
    const destination = path.join(root, step.to);
    const stats = await pathStats(source);
    if (!stats || step.type === "manual-review") {
      continue;
    }
    if (v2v3Steps.includes(step)) {
      continue; // already handled above
    }

    if (step.type === "copy-dir" && stats.isDirectory()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } else if (step.type === "copy" && stats.isFile() && !(await exists(destination))) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else if (step.type === "copy" && stats.isDirectory() && !(await exists(destination))) {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
  }

  const eventFile = await appendEvent(root, {
    ...(backup ? { backup: backup.relativePath } : {}),
    event: "layout.migrated",
    plan: plan.steps,
  });

  return {
    root,
    dryRun,
    apply: shouldApply,
    plan: backup ? migrationPlanSchema.parse({ ...plan, backup_dir: backup.relativePath }) : plan,
    ...(backup ? { backup } : {}),
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

const SYSTEM_YAML_TEMPLATE = (
  project: string,
  name: string,
  vcs: string,
  isPrimary: boolean,
  supersedes: readonly string[],
): string => {
  const supersedesLine =
    supersedes.length > 0 ? `\n  supersedes: [${supersedes.map((s) => `"${s}"`).join(", ")}]` : "";
  return `system:
  project: ${project}
  name: ${name}
  version: 0.1.0
  status: ${isPrimary ? "primary" : "active"}
  vcs: ${vcs}
  vcs_ref: ""${supersedesLine}
contract_managed_by: assay
`;
};

interface LegacyFrameworkYaml {
  status?: string;
  supersedes?: readonly string[];
  version?: string;
  vcs_ref?: string;
}

async function readLegacyFrameworkYaml(
  root: string,
  systemPath: string,
): Promise<LegacyFrameworkYaml | null> {
  const yamlPath = path.join(root, systemPath, "framework.yaml");
  if (!(await exists(yamlPath))) {
    return null;
  }
  try {
    const content = await readFile(yamlPath, "utf8");
    const statusMatch = content.match(/status:\s*(\S+)/);
    const versionMatch = content.match(/version:\s*(\S+)/);
    const vcsRefMatch = content.match(/vcs_ref:\s*"?([^"\n]+)"?/);
    const supersedesMatch = content.match(/supersedes:\s*\[([^\]]*)\]/);
    const result: LegacyFrameworkYaml = {
      supersedes: [],
    };
    if (statusMatch?.[1]) {
      result.status = statusMatch[1];
    }
    if (versionMatch?.[1]) {
      result.version = versionMatch[1];
    }
    if (vcsRefMatch?.[1]) {
      result.vcs_ref = vcsRefMatch[1];
    }
    if (supersedesMatch?.[1]) {
      result.supersedes = supersedesMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/"/g, ""))
        .filter(Boolean);
    }
    return result;
  } catch {
    return null;
  }
}

async function applyV2ToV3Migration(root: string, steps: readonly MigrationStep[]): Promise<void> {
  const manifest = await loadManifest(root);
  if (!manifest) return;

  const coreName = legacyCoreNameForV2Manifest(manifest, root);
  const projectName = manifest.project.name;
  const needsRegistryWrite = steps.some(
    (step) =>
      step.type === "generate-contract" ||
      (step.type === "create-systems-registry" && step.to === SYSTEMS_REGISTRY_FILE),
  );
  const registry = (await loadSystemsRegistry(root)) ?? defaultSystemsRegistry();

  // Process generate-contract steps: register active systems
  for (const step of steps) {
    if (step.type !== "generate-contract") continue;
    const systemName = path.basename(step.from);
    const systemPath = path.join(root, step.from);
    const hasGit = await exists(path.join(systemPath, ".git"));
    const vcs = hasGit ? "independent-git" : "embedded";
    const isPrimary = systemName === coreName;

    const legacy = await readLegacyFrameworkYaml(root, step.from);
    const status = legacy?.status === "primary" || isPrimary ? "primary" : "active";
    const supersedes = legacy?.supersedes ?? [];
    const version = legacy?.version ?? "0.1.0";
    const vcsRef = legacy?.vcs_ref ?? (hasGit ? "main" : "");

    // Generate system.yaml contract
    const contractContent = SYSTEM_YAML_TEMPLATE(
      projectName,
      systemName,
      vcs,
      status === "primary",
      supersedes,
    );
    await mkdir(path.dirname(path.join(root, step.to)), { recursive: true });
    await writeFile(path.join(root, step.to), contractContent, "utf8");

    // Add to registry
    registry.systems[systemName] = {
      name: systemName,
      path: step.from,
      status,
      vcs,
      vcs_ref: vcsRef,
      version,
      contract_file: step.to,
      supersedes: [...supersedes],
      absorbed_on: nowIso().slice(0, 10),
      archived_on: null,
      archive_path: null,
    };
    if (status === "primary") {
      registry.primary = systemName;
    }
  }

  // Process create-systems-registry steps for archived systems
  for (const step of steps) {
    if (step.type !== "create-systems-registry") continue;
    if (step.to !== SYSTEMS_REGISTRY_FILE) continue;
    if (step.from === MANIFEST_FILE) continue; // skip the initial registry creation step

    // Archived system under systems/archive/<date>/<name>
    const systemName = path.basename(step.from);
    const archiveMatch = step.from.match(/^systems\/archive\/([^/]+)\/(.+)$/);
    const archiveDate = archiveMatch?.[1]
      ?.replace(/-pre-.*$/, "")
      .replace(/-/g, "")
      .slice(0, 8);
    const dateStamp = archiveDate
      ? `${archiveDate.slice(0, 4)}-${archiveDate.slice(4, 6)}-${archiveDate.slice(6, 8)}`
      : nowIso().slice(0, 10);

    const hasGit = await exists(path.join(root, step.from, ".git"));
    const vcs = hasGit ? "independent-git" : "embedded";

    registry.systems[systemName] = {
      name: systemName,
      path: step.from,
      status: "archived",
      vcs,
      vcs_ref: hasGit ? "main" : "",
      version: "0.1.0",
      contract_file: null,
      supersedes: [],
      absorbed_on: dateStamp,
      archived_on: dateStamp,
      archive_path: step.from,
    };
  }

  if (needsRegistryWrite) {
    await saveSystemsRegistry(root, registry);
  }

  // Process mark-user-deleted steps: remove old system-internal managed files from manifest
  const manifestToDelete = new Set(
    steps.filter((s) => s.type === "mark-user-deleted").map((s) => s.from),
  );
  if (manifest) {
    const updatedManaged: Record<string, (typeof manifest.managed_files)[string]> = {};
    for (const [filePath, record] of Object.entries(manifest.managed_files)) {
      if (!manifestToDelete.has(filePath)) {
        updatedManaged[filePath] = record;
      }
    }
    if (manifestToDelete.size > 0) {
      manifest.managed_files = updatedManaged;
      manifest.user_deleted = [...manifest.user_deleted, ...manifestToDelete];
    }

    // Process upgrade-manifest step: upgrade schema and layout version
    const hasUpgrade = steps.some((s) => s.type === "upgrade-manifest");
    if (hasUpgrade) {
      // Note: __schema upgrade from 1→2 requires schema change; for now we keep __schema:1
      // but update layout_version to signal v3 readiness. Full schema upgrade deferred.
      manifest.layout_version = LAYOUT_VERSION;
    }

    await saveManifest(root, manifest);
  }
}
