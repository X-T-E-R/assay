import { chmod, copyFile, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { BACKUPS_DIR, CURRENT_VERSION, MANIFEST_FILE, VERSION_FILE } from "./constants.js";
import { FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { computeHash, fileHash } from "./hashing.js";
import { loadManifest, projectFromManifest, recordTemplate, saveManifest } from "./manifest.js";
import { relativeDisplayPath } from "./paths.js";
import {
  type OperationReport,
  type UpdateAnalysis,
  type UpdateChange,
  type UpdateConflictAction,
  type UpdatePlan,
  createEmptyReport,
} from "./results.js";
import type { FrameworkManifest, MigrationPlan, MigrationStep } from "./schemas/index.js";
import { migrationPlanSchema, updateAnalysisSchema, updatePlanSchema } from "./schemas/index.js";
import type { TemplateFile } from "./templates.js";
import { desiredTemplates } from "./templates.js";

export interface AnalyzeUpdateOptions {
  readonly root: string;
}

export interface PlanUpdateOptions extends AnalyzeUpdateOptions {
  readonly dryRun?: boolean;
  readonly action?: UpdateConflictAction;
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

export interface BuildLayoutMigrationPlanOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly apply?: boolean;
}

export interface MigrateLayoutOptions extends BuildLayoutMigrationPlanOptions {
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
  const [project, core] = projectFromManifest(manifest, root);
  const changes: UpdateAnalysis["changes"] = {
    new: [],
    auto_update: [],
    modified_by_user: [],
    user_deleted: [],
    untracked_existing: [],
    unchanged: [],
  };

  for (const template of desiredTemplates(project, core)) {
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

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const root = path.resolve(options.root);
  const action = options.action ?? "skip";
  const dryRun = options.dryRun ?? false;
  const analysis = await analyzeUpdate({ root });
  const plan = await planUpdate({ root, dryRun, action });
  const report = createEmptyReport();

  if (dryRun) {
    report.notes.push("dry-run: no changes applied");
    return { root, dryRun, action, analysis, plan, report };
  }

  const manifest = requireManifest(await loadManifest(root), root);
  const [project, core] = projectFromManifest(manifest, root);
  const templatesByPath = new Map(
    desiredTemplates(project, core).map((template) => [template.path, template]),
  );
  const backupPaths = [
    ...analysis.changes.auto_update,
    ...analysis.changes.modified_by_user,
    ...analysis.changes.untracked_existing,
  ]
    .map((change) => change.path)
    .filter((relativePath) => templatesByPath.has(relativePath));
  const backup = await createBackup(root, backupPaths, options.now);
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

  const legacyMeta = path.join(root, ".metasystem");
  if (await exists(legacyMeta)) {
    for (const item of ["events", "queue.json", "config.yaml"]) {
      if (await exists(path.join(legacyMeta, item))) {
        steps.push({
          type: "copy",
          from: `.metasystem/${item}`,
          to: `.framework/legacy-metasystem/${item}`,
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

export async function migrateLayout(options: MigrateLayoutOptions): Promise<MigrateLayoutResult> {
  const root = path.resolve(options.root);
  const shouldApply = options.apply ?? false;
  const dryRun = options.dryRun ?? !shouldApply;
  const plan = await buildLayoutMigrationPlan({ root, dryRun, apply: shouldApply });

  if (dryRun || !shouldApply) {
    return { root, dryRun, apply: shouldApply, plan };
  }

  const backup = await createBackup(
    root,
    plan.steps.filter((step) => step.type !== "manual-review").map((step) => step.from),
    options.now,
  );

  for (const step of plan.steps) {
    const source = path.join(root, step.from);
    const destination = path.join(root, step.to);
    const stats = await pathStats(source);
    if (!stats || step.type === "manual-review") {
      continue;
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
    backup: backup.relativePath,
    event: "layout.migrated",
    plan: plan.steps,
  });

  return {
    root,
    dryRun,
    apply: shouldApply,
    plan: migrationPlanSchema.parse({ ...plan, backup_dir: backup.relativePath }),
    backup,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}
