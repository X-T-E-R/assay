import { z } from "zod";

import { isReadableId } from "../readable-id.js";

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

/** Strict, versionable machine envelope for the workspace's one native Project. */
export const nativeProjectSchema = z
  .object({
    __schema: z.literal(1),
    id: z.string().refine((value) => isReadableId("project", value), "invalid native Project id"),
    name: z.string().trim().min(1),
    authority: z
      .object({
        mode: z.literal("native"),
        pointer: z.literal("README.md"),
      })
      .strict(),
  })
  .strict();

export const pluginDeclarationSchema = z
  .object({
    kind: z.string().trim().min(1),
    enabled: z.boolean().optional(),
  })
  .strict();

export const providerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("system"), name: z.string().trim().min(1) }).strict(),
]);

export const responsibilityBindingSchema = z
  .object({
    provider: z.string().trim().min(1),
    target: providerTargetSchema,
  })
  .strict();

export const frameworkProjectSchema = z
  .object({
    // Compatibility/cache fields used for workspace presentation and
    // archetype settings. The authoritative native Project identity and
    // charter live in <work-root>/project/project.yaml and README.md.
    name: z.string().min(1),
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
    __schema: z.literal(2),
    primary: z.string().min(1).nullable(),
    systems: z.record(systemRecordSchema),
    updated_at: z.string().min(1),
  })
  .strict();

// --- Workspace layout (layout v7) -------------------------------------------

export const workspaceLayoutModeSchema = z.enum(["standalone", "overlay"]);
export const workspacePrivacySchema = z.enum(["tracked", "private", "private-git"]);

export const workspaceLayoutPathsSchema = z
  .object({
    manifest: z.string().min(1),
    events: z.string().min(1),
    backups: z.string().min(1),
    systems_registry: z.string().min(1),
    sources: z.string().min(1),
    analyses: z.string().min(1),
    knowledge: z.string().min(1),
    systems_contracts: z.string().min(1),
  })
  .strict();

export const workspaceLayoutSchema = z
  .object({
    version: z.literal(7),
    mode: workspaceLayoutModeSchema,
    state_root: z.literal(".assay"),
    work_root: z.enum([".", ".assay"]),
    privacy: workspacePrivacySchema,
    paths: workspaceLayoutPathsSchema,
  })
  .strict()
  .superRefine((layout, context) => {
    const standalone = {
      manifest: ".assay/manifest.json",
      events: ".assay/events",
      backups: ".assay/backups",
      systems_registry: ".assay/systems-registry.json",
      sources: "sources",
      analyses: "analyses",
      knowledge: "knowledge",
      systems_contracts: "systems",
    } as const;
    const overlay = {
      ...standalone,
      sources: ".assay/sources",
      analyses: ".assay/analyses",
      knowledge: ".assay/knowledge",
      systems_contracts: ".assay/systems",
    } as const;
    const expected = layout.mode === "standalone" ? standalone : overlay;
    const expectedWorkRoot = layout.mode === "standalone" ? "." : ".assay";
    if (layout.work_root !== expectedWorkRoot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["work_root"],
        message: `layout v7 ${layout.mode} work_root must be '${expectedWorkRoot}'`,
      });
    }
    if (layout.mode === "standalone" && layout.privacy !== "tracked") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privacy"],
        message: "layout v7 standalone privacy must be 'tracked'",
      });
    }
    for (const [key, value] of Object.entries(expected)) {
      if (layout.paths[key as keyof typeof expected] !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", key],
          message: `layout v7 ${layout.mode} path '${key}' must be '${value}'`,
        });
      }
    }
  });

export const frameworkManifestSchema = z
  .object({
    __schema: z.literal(3),
    framework_version: z.string().min(1),
    minimum_assay_version: z.string().min(1),
    layout_version: z.literal(7),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    project: frameworkProjectSchema,
    managed_files: z.record(managedFileRecordSchema),
    user_deleted: z.array(z.string()),
    applied_migrations: z.array(z.string()),
    // Generic desired-plugin metadata is retained for external hosts and
    // future protocol consumers. Core does not install or execute it.
    plugins: z.record(z.string().trim().min(1), pluginDeclarationSchema).optional(),
    // Generic provider binding metadata is retained without activating or
    // probing a provider in this core build.
    bindings: z.record(z.string().trim().min(1), responsibilityBindingSchema).optional(),
    layout: workspaceLayoutSchema,
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

export type ManagedFileRecord = z.infer<typeof managedFileRecordSchema>;
export type ProjectArchetype = z.infer<typeof projectArchetypeSchema>;
export type ProjectMode = z.infer<typeof projectModeSchema>;
export type NativeProject = z.infer<typeof nativeProjectSchema>;
export type FrameworkProject = z.infer<typeof frameworkProjectSchema>;
export type FrameworkManifest = z.infer<typeof frameworkManifestSchema>;
export type PluginDeclaration = z.infer<typeof pluginDeclarationSchema>;
export type ProviderTarget = z.infer<typeof providerTargetSchema>;
export type ResponsibilityBinding = z.infer<typeof responsibilityBindingSchema>;
export type WorkspaceLayoutMode = z.infer<typeof workspaceLayoutModeSchema>;
export type WorkspacePrivacy = z.infer<typeof workspacePrivacySchema>;
export type WorkspaceLayoutPaths = z.infer<typeof workspaceLayoutPathsSchema>;
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export type SystemVcs = z.infer<typeof systemVcsSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type SystemRecord = z.infer<typeof systemRecordSchema>;
export type SystemsRegistry = z.infer<typeof systemsRegistrySchema>;
export type EventEntry = z.input<typeof eventEntrySchema>;
export type PersistedEventEntry = z.infer<typeof persistedEventEntrySchema>;
