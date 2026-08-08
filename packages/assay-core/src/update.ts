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
import { BACKUPS_DIR, CURRENT_VERSION, MANIFEST_FILE, VERSION_FILE } from "./constants.js";
import { FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { computeHash, fileHash } from "./hashing.js";
import { defaultStandaloneLayout, resolveWorkspaceLayout } from "./layout.js";
import { loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import { assertNoAncestorWorkspaceAuthority, relativeDisplayPath } from "./paths.js";
import { archetypeAliasTarget } from "./profile.js";
import {
  ensureNativeProject,
  preflightNativeProjectBoundary,
  preflightWorkspaceManifestBoundary,
  projectFileRelativePath,
  projectRootRelativePath,
} from "./project.js";
import {
  type OperationReport,
  type UpdateAnalysis,
  type UpdateChange,
  type UpdateConflictAction,
  type UpdatePlan,
  createEmptyReport,
} from "./results.js";
import type { FrameworkManifest, SystemsRegistry, WorkspaceLayout } from "./schemas/index.js";
import { updateAnalysisSchema, updatePlanSchema } from "./schemas/index.js";
import { loadSystemsRegistry } from "./systems-registry.js";
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

function layoutForManifest(manifest: FrameworkManifest | null): WorkspaceLayout {
  return resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
}

function projectNameFromManifest(
  manifest: FrameworkManifest | null | undefined,
  fallbackRoot: string,
): string {
  return manifest?.project.name || path.basename(path.resolve(fallbackRoot));
}

function rewriteRenamedArchetype(manifest: FrameworkManifest, report: OperationReport): void {
  const current = archetypeAliasTarget(manifest.project.archetype);
  if (!current) {
    return;
  }
  const previous = manifest.project.archetype;
  manifest.project.archetype = current;
  report.notes.push(`archetype: renamed ${previous} to ${current} in the manifest`);
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
  await assertNoAncestorWorkspaceAuthority(root);
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
    { root, layout: layoutForManifest(manifest) },
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
  await assertNoAncestorWorkspaceAuthority(root);
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
  await assertNoAncestorWorkspaceAuthority(root);
  const action = options.action ?? "skip";
  const dryRun = options.dryRun ?? false;
  await preflightWorkspaceManifestBoundary(root);
  const boundaryManifest = requireManifest(await loadManifest(root), root);
  await preflightNativeProjectBoundary(root, layoutForManifest(boundaryManifest));
  const analysis = await analyzeUpdate({ root });
  const plan = await planUpdate({ root, dryRun, action });
  const report = createEmptyReport();
  const agentsMode = updateAgentsMode(options.agents);
  const agentsPlan = await planAssayAgentsBlock({ root, mode: agentsMode });

  if (dryRun) {
    report.notes.push("dry-run: no changes applied");
    const manifest = requireManifest(await loadManifest(root), root);
    const layout = layoutForManifest(manifest);
    const projectRoot = projectRootRelativePath(layout);
    for (const relative of [
      projectRoot,
      projectFileRelativePath(layout),
      `${projectRoot}/README.md`,
      `${projectRoot}/roadmap/README.md`,
    ]) {
      if (!(await exists(path.join(root, relative)))) {
        report.notes.push(`would create native Project path: ${relative}`);
      }
    }
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
        layout: layoutForManifest(manifest),
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

  const layout = layoutForManifest(manifest);
  const nativeProject = await ensureNativeProject(root, layout, manifest.project.name);
  report.created_dirs.push(...nativeProject.createdDirectories);
  report.created_files.push(...nativeProject.createdFiles);

  rewriteRenamedArchetype(manifest, report);
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
