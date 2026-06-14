import { z } from "zod";

export const managedFileRecordSchema = z
  .object({
    template_id: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    installed_version: z.string().min(1),
    protected: z.boolean(),
    executable: z.boolean(),
    updated_at: z.string().min(1),
  })
  .strict();

export const frameworkProjectSchema = z
  .object({
    name: z.string().min(1),
    core: z.string().min(1),
  })
  .strict();

export const frameworkManifestSchema = z
  .object({
    __schema: z.literal(1),
    framework_version: z.string().min(1),
    layout_version: z.number().int().nonnegative(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    project: frameworkProjectSchema,
    managed_files: z.record(managedFileRecordSchema),
    user_deleted: z.array(z.string()),
    applied_migrations: z.array(z.string()),
  })
  .strict();

export const eventEntrySchema = z
  .object({
    ts: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    text: z.string().optional(),
  })
  .catchall(z.unknown());

export const persistedEventEntrySchema = eventEntrySchema.extend({
  ts: z.string().min(1),
});

export const operationReportSchema = z
  .object({
    created_dirs: z.array(z.string()),
    existing_dirs: z.array(z.string()),
    created_files: z.array(z.string()),
    updated_files: z.array(z.string()),
    skipped_files: z.array(z.string()),
    conflicted_files: z.array(z.string()),
    new_copies: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .strict();

export const checkRowSchema = z
  .object({
    path: z.string(),
    status: z.enum(["ok", "missing", "warning", "error"]),
    message: z.string().optional(),
  })
  .strict();

export const updateChangeKindSchema = z.enum([
  "new",
  "auto-update",
  "modified-by-user",
  "user-deleted",
  "untracked-existing",
  "unchanged",
]);

export const updateActionSchema = z.enum(["create", "update", "skip", "force", "create-new"]);

export const updateConflictActionSchema = z.enum(["skip", "force", "create-new"]);

export const updateChangeSchema = z
  .object({
    path: z.string().min(1),
    template_id: z.string().min(1).optional(),
    kind: updateChangeKindSchema,
    action: updateActionSchema.optional(),
    current_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    previous_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    desired_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: z.string().optional(),
  })
  .strict();

export const updateChangeSetSchema = z
  .object({
    new: z.array(updateChangeSchema),
    auto_update: z.array(updateChangeSchema),
    modified_by_user: z.array(updateChangeSchema),
    user_deleted: z.array(updateChangeSchema),
    untracked_existing: z.array(updateChangeSchema),
    unchanged: z.array(updateChangeSchema),
  })
  .strict();

export const updateAnalysisSchema = z
  .object({
    root: z.string(),
    dry_run: z.boolean(),
    changes: updateChangeSetSchema,
    report: operationReportSchema.optional(),
  })
  .strict();

export const updatePlanSchema = z
  .object({
    root: z.string(),
    dry_run: z.boolean(),
    action: updateConflictActionSchema.optional(),
    changes: z.array(updateChangeSchema),
    backup_dir: z.string().optional(),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export const migrationStepTypeSchema = z.enum(["copy-dir", "copy", "manual-review"]);

export const migrationStepSchema = z
  .object({
    type: migrationStepTypeSchema,
    from: z.string().min(1),
    to: z.string().min(1),
    reason: z.string().optional(),
    action: z.enum(["copy", "manual-review", "skip"]).optional(),
  })
  .strict();

export const migrationPlanSchema = z
  .object({
    root: z.string(),
    dry_run: z.boolean(),
    apply: z.boolean(),
    steps: z.array(migrationStepSchema),
    backup_dir: z.string().optional(),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export type ManagedFileRecord = z.infer<typeof managedFileRecordSchema>;
export type FrameworkProject = z.infer<typeof frameworkProjectSchema>;
export type FrameworkManifest = z.infer<typeof frameworkManifestSchema>;
export type EventEntry = z.input<typeof eventEntrySchema>;
export type PersistedEventEntry = z.infer<typeof persistedEventEntrySchema>;
export type MigrationStep = z.infer<typeof migrationStepSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
