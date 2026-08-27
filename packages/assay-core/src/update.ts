import { copyFile, cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ASSAY_AGENTS_MALFORMED_REASON,
  type AssayAgentsBlockMode,
  type AssayAgentsBlockResult,
  applyAssayAgentsBlock,
  describeAssayAgentsBlockAction,
} from "./agents.js";
import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  recoverAuthorityFileWithResult,
  safelyWriteAuthorityFile,
} from "./authority-file-write.js";
import { BACKUPS_DIR, MANAGED_FILES_FILE, MANIFEST_FILE } from "./constants.js";
import {
  AuthorityWriteConflictError,
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
} from "./errors.js";
import { appendEvent } from "./events.js";
import { computeHash, fileHash } from "./hashing.js";
import { resolveWorkspaceLayout } from "./layout.js";
import { loadManagedFiles, managedFileRecord, saveManagedFiles } from "./managed-files.js";
import { loadManifest } from "./manifest.js";
import {
  type WorkspaceMigrationResult,
  analyzeWorkspaceMigration,
  applyWorkspaceMigration,
} from "./migrate.js";
import { assertNoAncestorWorkspaceAuthority, relativeDisplayPath } from "./paths.js";
import {
  loadNativeProject,
  preflightNativeProjectBoundary,
  preflightWorkspaceManifestBoundary,
} from "./project.js";
import {
  type OperationReport,
  type UpdateAnalysis,
  type UpdateChange,
  type UpdateConflictAction,
  type UpdatePlan,
  createEmptyReport,
} from "./results.js";
import type { FrameworkManifest, ManagedFileRecord, WorkspaceLayout } from "./schemas/index.js";
import { updateAnalysisSchema, updatePlanSchema } from "./schemas/index.js";
import { assertTemplateWriteBoundary } from "./template.js";
import { type TemplateFile, baseCoreTemplates } from "./templates.js";

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
  readonly eventFile?: string;
  /** Present when this run migrated (or, on a dry run, would migrate) records. */
  readonly migration?: WorkspaceMigrationResult;
}

let updateWriteProbe: AuthorityWriteProbe | undefined;

export function setUpdateWriteProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  updateWriteProbe = probe;
}

function updateAgentsMode(value: boolean | undefined): AssayAgentsBlockMode {
  if (value === true) return "install";
  if (value === false) return "skip";
  return "refresh-existing";
}

function recordAssayAgentsResult(report: OperationReport, result: AssayAgentsBlockResult): void {
  if (result.changed && result.dryRun) {
    report.notes.push(describeAssayAgentsBlockAction(result));
    return;
  }
  if (!result.changed) {
    if (result.reason === ASSAY_AGENTS_MALFORMED_REASON)
      report.notes.push(describeAssayAgentsBlockAction(result));
    return;
  }
  if (result.action === "create") report.created_files.push(result.path);
  else if (result.action === "append" || result.action === "replace")
    report.updated_files.push(result.path);
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

function requireManifest(manifest: FrameworkManifest | null, root: string): FrameworkManifest {
  if (!manifest)
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}. Run init first.`,
    );
  return manifest;
}

function requireLayout(manifest: FrameworkManifest): WorkspaceLayout {
  const layout = resolveWorkspaceLayout(manifest);
  if (!layout) throw new FrameworkError("workspace layout could not be resolved");
  return layout;
}

async function desiredCore(root: string, manifest: FrameworkManifest): Promise<TemplateFile[]> {
  const layout = requireLayout(manifest);
  const project = await loadNativeProject(root, layout);
  if (!project)
    throw new FrameworkNotFoundError("native Project envelope is required before update");
  return baseCoreTemplates(project.name, layout);
}

function change(
  template: TemplateFile,
  kind: UpdateChange["kind"],
  values: Partial<
    Pick<UpdateChange, "current_hash" | "previous_hash" | "desired_hash" | "reason">
  > = {},
): UpdateChange {
  return {
    path: template.path,
    generator: template.generator ?? template.asset,
    kind,
    ...values,
  };
}

export async function analyzeUpdate(options: AnalyzeUpdateOptions): Promise<UpdateAnalysis> {
  const root = path.resolve(options.root);
  await assertNoAncestorWorkspaceAuthority(root);
  await preflightWorkspaceManifestBoundary(root);
  const manifest = requireManifest(await loadManifest(root), root);
  const layout = requireLayout(manifest);
  await preflightNativeProjectBoundary(root, layout);
  const receipt = await loadManagedFiles(root);
  const desired = await desiredCore(root, manifest);
  await assertTemplateWriteBoundary(root, [
    ...desired.map((template) => template.path),
    MANAGED_FILES_FILE,
  ]);
  for (const template of desired) {
    const file = path.join(root, template.path);
    await recoverAuthorityFile({
      root,
      file,
      error: (message, cause) => new FrameworkError(message, cause === undefined ? {} : { cause }),
    });
  }
  const byPath = new Map(receipt.files.map((record) => [record.path, record]));
  const desiredPaths = new Set(desired.map((template) => template.path));
  for (const record of receipt.files) {
    if (!desiredPaths.has(record.path)) {
      throw new FrameworkError(
        `managed receipt references an unsupported core asset: ${record.path}`,
      );
    }
  }
  const changes: UpdateAnalysis["changes"] = {
    new: [],
    auto_update: [],
    modified_by_user: [],
    user_deleted: [],
    untracked_existing: [],
    unchanged: [],
  };
  for (const template of desired) {
    const target = path.join(root, template.path);
    const record = byPath.get(template.path);
    const desiredHash = computeHash(template.content);
    if (!(await exists(target))) {
      if (record)
        changes.user_deleted.push(
          change(template, "user-deleted", {
            previous_hash: record.baseline_hash,
            desired_hash: desiredHash,
            reason: "managed file is recorded but missing on disk",
          }),
        );
      else changes.new.push(change(template, "new", { desired_hash: desiredHash }));
      continue;
    }
    const currentHash = await fileHash(target);
    if (!record) {
      if (currentHash === desiredHash)
        changes.unchanged.push(
          change(template, "unchanged", { current_hash: currentHash, desired_hash: desiredHash }),
        );
      else
        changes.untracked_existing.push(
          change(template, "untracked-existing", {
            current_hash: currentHash,
            desired_hash: desiredHash,
            reason: "file exists but is not in the managed receipt",
          }),
        );
      continue;
    }
    if (currentHash === desiredHash)
      changes.unchanged.push(
        change(template, "unchanged", {
          current_hash: currentHash,
          previous_hash: record.baseline_hash,
          desired_hash: desiredHash,
        }),
      );
    else if (currentHash === record.baseline_hash)
      changes.auto_update.push(
        change(template, "auto-update", {
          current_hash: currentHash,
          previous_hash: record.baseline_hash,
          desired_hash: desiredHash,
          reason: "managed file is unchanged by the user and differs from the current generator",
        }),
      );
    else
      changes.modified_by_user.push(
        change(template, "modified-by-user", {
          current_hash: currentHash,
          previous_hash: record.baseline_hash,
          desired_hash: desiredHash,
          reason: "managed file differs from both its baseline and current generator",
        }),
      );
  }
  return updateAnalysisSchema.parse({ root, dry_run: false, changes });
}

function allChanges(changes: UpdateAnalysis["changes"]): UpdateChange[] {
  return [
    ...changes.new,
    ...changes.auto_update,
    ...changes.modified_by_user,
    ...changes.user_deleted,
    ...changes.untracked_existing,
    ...changes.unchanged,
  ];
}

export async function planUpdate(options: PlanUpdateOptions): Promise<UpdatePlan> {
  const analysis = await analyzeUpdate(options);
  return planAnalyzedUpdate(analysis, options);
}

async function planAnalyzedUpdate(
  analysis: UpdateAnalysis,
  options: Pick<PlanUpdateOptions, "action" | "dryRun">,
): Promise<UpdatePlan> {
  const action = options.action ?? "skip";
  const receipt = await loadManagedFiles(analysis.root);
  const records = new Map(receipt.files.map((record) => [record.path, record]));
  const changes = allChanges(analysis.changes).map((item): UpdateChange => {
    let nextAction: UpdateChange["action"] = "skip";
    if (item.kind === "new") nextAction = "create";
    else if (item.kind === "auto-update") nextAction = "update";
    else if (item.kind === "modified-by-user" || item.kind === "untracked-existing") {
      nextAction = records.get(item.path)?.protected && action === "force" ? "skip" : action;
    }
    return { ...item, action: nextAction };
  });
  return updatePlanSchema.parse({
    root: analysis.root,
    dry_run: options.dryRun ?? false,
    action,
    changes,
    notes: options.dryRun ? ["dry-run: no changes applied"] : [],
  });
}

function backupStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function createBackup(
  rootInput: string,
  relativePaths: readonly string[],
  now = new Date(),
): Promise<BackupResult> {
  const root = path.resolve(rootInput);
  await assertNoAncestorWorkspaceAuthority(root);
  const backup = path.join(root, BACKUPS_DIR, backupStamp(now));
  await assertTemplateWriteBoundary(root, [relativeDisplayPath(backup, root)]);
  await mkdir(backup, { recursive: true });
  const copied: string[] = [];
  for (const relative of [...new Set([MANIFEST_FILE, MANAGED_FILES_FILE, ...relativePaths])]) {
    const source = path.join(root, relative);
    if (!(await exists(source))) continue;
    const target = path.join(backup, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const info = await stat(source);
    if (info.isDirectory()) await cp(source, target, { recursive: true });
    else await copyFile(source, target);
    copied.push(relative);
  }
  return { path: backup, relativePath: relativeDisplayPath(backup, root), copied };
}

function updateAuthorityError(message: string, cause?: unknown): FrameworkError {
  return new FrameworkError(message, cause === undefined ? {} : { cause });
}

async function writeTemplate(
  root: string,
  template: TemplateFile,
  expectedHash: string | undefined,
): Promise<void> {
  const target = path.join(root, template.path);
  await safelyWriteAuthorityFile({
    root,
    file: target,
    content: template.content,
    validateExisting: (bytes) => {
      const currentHash = bytes ? computeHash(bytes.toString("utf8")) : undefined;
      if (currentHash !== expectedHash) {
        throw new AuthorityWriteConflictError(
          `managed file changed after update planning: ${template.path}`,
        );
      }
    },
    error: updateAuthorityError,
    textFileMode: {
      preserveExisting: true,
      createMode: template.executable ? 0o777 : 0o666,
    },
    ...(updateWriteProbe ? { probe: updateWriteProbe } : {}),
  });
}

async function preflightNewSidecars(
  root: string,
  plan: UpdatePlan,
  desired: ReadonlyMap<string, TemplateFile>,
): Promise<Set<string>> {
  const planned = plan.changes.filter((item) => item.action === "create-new");
  const recoveredInstalled = new Set<string>();
  if (planned.length === 0) return recoveredInstalled;
  await assertTemplateWriteBoundary(
    root,
    planned.map((item) => `${item.path}.new`),
  );
  for (const item of planned) {
    const relative = `${item.path}.new`;
    const file = path.join(root, relative);
    const recovery = await recoverAuthorityFileWithResult({
      root,
      file,
      error: updateAuthorityError,
    });
    if (recovery.replacementInstalled) {
      const template = desired.get(item.path);
      if (!template || !(await readFile(file)).equals(Buffer.from(template.content, "utf8"))) {
        throw new AuthorityWriteConflictError(
          `Recovered update sidecar does not match the current plan: ${relative}`,
        );
      }
      recoveredInstalled.add(relative);
      continue;
    }
    if (await exists(file)) {
      throw new FrameworkAlreadyExistsError(
        `Update sidecar already exists and will not be overwritten: ${relative}`,
      );
    }
  }
  return recoveredInstalled;
}

async function writeNewSidecar(root: string, template: TemplateFile): Promise<void> {
  const relative = `${template.path}.new`;
  await safelyWriteAuthorityFile({
    root,
    file: path.join(root, relative),
    content: template.content,
    validateExisting: (bytes) => {
      if (bytes !== null) {
        throw new AuthorityWriteConflictError(
          `Update sidecar was concurrently created and will not be overwritten: ${relative}`,
        );
      }
    },
    error: updateAuthorityError,
    textFileMode: { preserveExisting: true, createMode: 0o666 },
    ...(updateWriteProbe ? { probe: updateWriteProbe } : {}),
  });
}

/**
 * `assay update` is the one command that may read a workspace older than this
 * build, because it is the command that brings it forward. Everything else stays
 * fail-closed. A dry run reports what the migration would rewrite and stops
 * there: the template analysis behind it cannot even load the old envelope.
 */
async function migrateBeforeUpdate(
  root: string,
  dryRun: boolean,
  now: Date,
): Promise<WorkspaceMigrationResult | undefined> {
  const analysis = await analyzeWorkspaceMigration(root);
  if (!analysis.required) return undefined;
  if (dryRun) {
    return {
      root: analysis.root,
      from: analysis.from,
      to: analysis.to,
      changes: analysis.steps.map((step) => step.summary),
    };
  }
  return applyWorkspaceMigration({ root, now });
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const root = path.resolve(options.root);
  const dryRun = options.dryRun ?? false;
  const action = options.action ?? "skip";
  const migration = await migrateBeforeUpdate(root, dryRun, options.now ?? new Date());
  if (migration && dryRun) {
    const report = createEmptyReport();
    report.notes.push(
      `dry-run: workspace records would migrate from ${migration.from} to ${migration.to}`,
      ...migration.changes,
    );
    const pending = updateAnalysisSchema.parse({
      root,
      dry_run: true,
      changes: {
        new: [],
        auto_update: [],
        modified_by_user: [],
        user_deleted: [],
        untracked_existing: [],
        unchanged: [],
      },
    });
    return {
      root,
      dryRun,
      action,
      analysis: pending,
      plan: updatePlanSchema.parse({
        root,
        dry_run: true,
        action,
        changes: [],
        notes: ["dry-run: no changes applied"],
      }),
      report,
      migration,
    };
  }
  const analysis = await analyzeUpdate({ root });
  const plan = await planAnalyzedUpdate(analysis, {
    dryRun,
    action,
  });
  const report = createEmptyReport();
  if (migration) {
    report.notes.push(
      `migrated workspace records from ${migration.from} to ${migration.to}`,
      ...migration.changes,
    );
  }
  if (dryRun) {
    const agentsResult = await applyAssayAgentsBlock({
      root,
      mode: updateAgentsMode(options.agents),
      dryRun,
      authorityWrite: true,
    });
    recordAssayAgentsResult(report, agentsResult);
    return { root, dryRun, action, analysis, plan, report };
  }

  const manifest = requireManifest(await loadManifest(root), root);
  const layout = requireLayout(manifest);
  const project = await loadNativeProject(root, layout);
  if (!project)
    throw new FrameworkNotFoundError("native Project envelope is required before update");
  const desired = new Map(
    (await desiredCore(root, manifest)).map((template) => [template.path, template]),
  );
  const recoveredSidecars = await preflightNewSidecars(root, plan, desired);
  const agentsResult = await applyAssayAgentsBlock({
    root,
    mode: updateAgentsMode(options.agents),
    dryRun,
    authorityWrite: true,
  });
  recordAssayAgentsResult(report, agentsResult);
  const receipt = await loadManagedFiles(root);
  const receiptByPath = new Map(receipt.files.map((record) => [record.path, record]));
  const mutating = plan.changes.filter((item) =>
    ["create", "update", "force", "create-new"].includes(item.action ?? "skip"),
  );
  let receiptChanged = false;
  for (const item of plan.changes) {
    const template = desired.get(item.path);
    if (!template) continue;
    if (item.action === "create" || item.action === "update" || item.action === "force") {
      await writeTemplate(root, template, item.current_hash);
      (item.action === "create" ? report.created_files : report.updated_files).push(item.path);
      receiptByPath.set(item.path, managedFileRecord(template));
      receiptChanged = true;
    } else if (item.action === "create-new") {
      const newPath = `${path.join(root, item.path)}.new`;
      if (!recoveredSidecars.has(`${item.path}.new`)) await writeNewSidecar(root, template);
      report.new_copies.push(relativeDisplayPath(newPath, root));
    } else if (item.kind === "unchanged") {
      const desiredRecord = managedFileRecord(template);
      const existingRecord = receiptByPath.get(item.path);
      if (!existingRecord || JSON.stringify(existingRecord) !== JSON.stringify(desiredRecord)) {
        receiptByPath.set(item.path, desiredRecord);
        receiptChanged = true;
      }
    } else report.skipped_files.push(item.path);
  }
  if (receiptChanged) {
    await saveManagedFiles(root, {
      __schema: 1,
      files: [...receiptByPath.values()] as ManagedFileRecord[],
    });
    report.updated_files.push(MANAGED_FILES_FILE);
  }
  const mutated =
    migration !== undefined ||
    report.created_files.length + report.updated_files.length + report.new_copies.length > 0;
  let eventFile: string | undefined;
  if (mutated) {
    const file = await appendEvent(
      root,
      {
        event: "framework.updated",
        action,
        changed: mutating.length,
        ...(migration ? { migrated_from: migration.from, migrated_to: migration.to } : {}),
      },
      options.now ?? new Date(),
    );
    eventFile = relativeDisplayPath(file, root);
  }
  return {
    root,
    dryRun,
    action,
    analysis,
    plan,
    report,
    ...(eventFile ? { eventFile } : {}),
    ...(migration ? { migration } : {}),
  };
}
