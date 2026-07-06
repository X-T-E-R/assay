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

export const projectArchetypeSchema = z.string().min(1);

export const projectModeSchema = z.enum(["learning", "absorption"]);

export const frameworkProjectSchema = z
  .object({
    name: z.string().min(1),
    // Legacy v2 manifests may still carry project.core. Layout v3 keeps it
    // optional for migration reads only; fresh manifests must not materialize it.
    core: z.string().min(1).optional(),
    archetype: projectArchetypeSchema.default("study"),
    mode: projectModeSchema.default("learning"),
  })
  .strict();

// --- Systems registry (layout v3) -------------------------------------------

export const systemVcsSchema = z.enum(["independent-git", "embedded", "none"]);

export const systemStatusSchema = z.enum(["primary", "active", "archived", "superseded"]);

export const systemRecordSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    status: systemStatusSchema,
    vcs: systemVcsSchema,
    vcs_ref: z.string(),
    version: z.string(),
    contract_file: z.string().nullable(),
    supersedes: z.array(z.string().min(1)),
    absorbed_on: z.string().nullable(),
    archived_on: z.string().nullable(),
    archive_path: z.string().nullable(),
  })
  .strict();

export const systemsRegistrySchema = z
  .object({
    __schema: z.literal(1),
    primary: z.string().min(1).nullable(),
    systems: z.record(systemRecordSchema),
    updated_at: z.string().min(1),
  })
  .strict();

// --- ADR index (layout v3) ---------------------------------------------------

export const adrStatusSchema = z.enum(["proposed", "accepted", "superseded", "deprecated"]);

export const adrRecordSchema = z
  .object({
    id: z.string().regex(/^ADR-\d{4}-.+/),
    number: z.number().int().positive(),
    title: z.string().min(1),
    slug: z.string().min(1),
    status: adrStatusSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    path: z.string().min(1),
    supersedes: z.array(z.string().min(1)),
    superseded_by: z.string().min(1).nullable(),
    related_analysis: z.string().min(1).nullable(),
    related_iteration: z.string().min(1).nullable(),
  })
  .strict();

export const adrIndexSchema = z
  .object({
    __schema: z.literal(1),
    next_number: z.number().int().positive(),
    adrs: z.record(adrRecordSchema),
    updated_at: z.string().min(1),
  })
  .strict();

// --- Workspace layout (layout v4) -------------------------------------------
//
// The layout block tells every command where Assay-owned state and work
// folders live for this workspace. Layout v3 manifests carry no `layout`
// block; `resolveWorkspaceLayout` supplies a standalone-compatible fallback
// when reading them, so v3 workspaces keep working until migrated.

export const workspaceLayoutModeSchema = z.enum(["standalone", "overlay"]);
export const workspacePrivacySchema = z.enum(["tracked", "private", "private-git"]);

export const workspaceLayoutPathsSchema = z
  .object({
    manifest: z.string().min(1),
    events: z.string().min(1),
    backups: z.string().min(1),
    systems_registry: z.string().min(1),
    adrs_index: z.string().min(1),
    references: z.string().min(1),
    analyses: z.string().min(1),
    iterations: z.string().min(1),
    knowledge: z.string().min(1),
    systems_contracts: z.string().min(1),
  })
  .strict();

export const workspaceLayoutSchema = z
  .object({
    version: z.literal(4),
    mode: workspaceLayoutModeSchema,
    // `.assay` for v4 workspaces; `.framework` only appears in the in-memory
    // fallback for v3 manifests being read before migration and is never
    // written to a fresh manifest.
    state_root: z.enum([".assay", ".framework"]),
    work_root: z.enum([".", ".assay"]),
    privacy: workspacePrivacySchema,
    paths: workspaceLayoutPathsSchema,
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
    // Layout v4+: path map and privacy policy. Optional so v3 manifests (which
    // have no layout block) still validate; resolveWorkspaceLayout fills in a
    // standalone fallback when this is absent.
    layout: workspaceLayoutSchema.optional(),
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

export const migrationStepTypeSchema = z.enum([
  "copy-dir",
  "copy",
  "manual-review",
  "create-systems-registry",
  "generate-contract",
  "mark-user-deleted",
  "upgrade-manifest",
]);

export const migrationStepSchema = z
  .object({
    type: migrationStepTypeSchema,
    from: z.string().min(1),
    to: z.string().min(1),
    reason: z.string().optional(),
    action: z
      .enum(["copy", "manual-review", "skip", "create", "generate", "mark", "upgrade"])
      .optional(),
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
export type ProjectArchetype = z.infer<typeof projectArchetypeSchema>;
export type ProjectMode = z.infer<typeof projectModeSchema>;
export type FrameworkProject = z.infer<typeof frameworkProjectSchema>;
export type FrameworkManifest = z.infer<typeof frameworkManifestSchema>;
export type WorkspaceLayoutMode = z.infer<typeof workspaceLayoutModeSchema>;
export type WorkspacePrivacy = z.infer<typeof workspacePrivacySchema>;
export type WorkspaceLayoutPaths = z.infer<typeof workspaceLayoutPathsSchema>;
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export type SystemVcs = z.infer<typeof systemVcsSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type SystemRecord = z.infer<typeof systemRecordSchema>;
export type SystemsRegistry = z.infer<typeof systemsRegistrySchema>;
export type AdrStatus = z.infer<typeof adrStatusSchema>;
export type AdrRecord = z.infer<typeof adrRecordSchema>;
export type AdrIndex = z.infer<typeof adrIndexSchema>;
export type EventEntry = z.input<typeof eventEntrySchema>;
export type PersistedEventEntry = z.infer<typeof persistedEventEntrySchema>;
export type MigrationStep = z.infer<typeof migrationStepSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
