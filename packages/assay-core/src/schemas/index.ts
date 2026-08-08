import { z } from "zod";

import { isReadableId } from "../readable-id.js";

export const managedFileRecordSchema = z
  .object({
    path: z.string().min(1),
    asset: z.string().min(1).optional(),
    generator: z.string().min(1).optional(),
    baseline_hash: z.string().regex(/^[a-f0-9]{64}$/),
    protected: z.boolean(),
    executable: z.boolean(),
  })
  .strict()
  .refine(
    (value) => Number(value.asset !== undefined) + Number(value.generator !== undefined) === 1,
    {
      message: "managed file record must declare exactly one of asset or generator",
    },
  );

export const managedFilesReceiptSchema = z
  .object({
    __schema: z.literal(1),
    files: z.array(managedFileRecordSchema).max(256),
  })
  .strict();

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

// --- Systems registry (schema 3; workspace layout remains v8) ----------------

export const systemVcsSchema = z.enum(["independent-git", "embedded", "none"]);

export const systemStatusSchema = z.enum(["primary", "active", "archived", "superseded"]);

export const systemRecordSchema = z
  .object({
    path: z.string().min(1),
    status: systemStatusSchema,
    vcs: systemVcsSchema,
    vcs_ref: z.string(),
    version: z.string(),
    supersedes: z.array(z.string().min(1)),
    absorbed_on: z.string().min(1).optional(),
    archived_on: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status === "superseded") {
      if (!record.absorbed_on) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["absorbed_on"],
          message: "superseded system must record absorbed_on",
        });
      }
      if (record.archived_on) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["archived_on"],
          message: "superseded system must not record archived_on",
        });
      }
      return;
    }
    if (record.status === "archived") {
      if (!record.archived_on) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["archived_on"],
          message: "archived system must record archived_on",
        });
      }
      if (record.absorbed_on) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["absorbed_on"],
          message: "archived system must not record absorbed_on",
        });
      }
      return;
    }
    if (record.absorbed_on || record.archived_on) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: record.absorbed_on ? ["absorbed_on"] : ["archived_on"],
        message: "live system must not record lifecycle transition dates",
      });
    }
  });

export const systemsRegistrySchema = z
  .object({
    __schema: z.literal(3),
    primary: z.string().min(1),
    systems: z.record(systemRecordSchema),
    updated_at: z.string().min(1),
  })
  .strict();

// --- Workspace layout (layout v8) -------------------------------------------

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
    systems: z.string().min(1),
  })
  .strict();

export const manifestEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["directory", "file"]),
    purpose: z.string(),
  })
  .strict();

export const workspaceLayoutSchema = z
  .object({
    version: z.literal(8),
    mode: workspaceLayoutModeSchema,
    state_root: z.literal(".assay"),
    work_root: z.enum([".", ".assay"]),
    privacy: workspacePrivacySchema,
    paths: workspaceLayoutPathsSchema,
    entries: z.array(manifestEntrySchema).max(1024),
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
      systems: "systems",
    } as const;
    const overlay = {
      ...standalone,
      sources: ".assay/sources",
      analyses: ".assay/analyses",
      knowledge: ".assay/knowledge",
      systems: ".assay/systems",
    } as const;
    const expected = layout.mode === "standalone" ? standalone : overlay;
    const expectedWorkRoot = layout.mode === "standalone" ? "." : ".assay";
    if (layout.work_root !== expectedWorkRoot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["work_root"],
        message: `layout v8 ${layout.mode} work_root must be '${expectedWorkRoot}'`,
      });
    }
    if (layout.mode === "standalone" && layout.privacy !== "tracked") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privacy"],
        message: "layout v8 standalone privacy must be 'tracked'",
      });
    }
    for (const [key, value] of Object.entries(expected)) {
      if (layout.paths[key as keyof typeof expected] !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", key],
          message: `layout v8 ${layout.mode} path '${key}' must be '${value}'`,
        });
      }
    }
    const seen = new Set<string>();
    for (const [index, entry] of layout.entries.entries()) {
      const normalized = entry.path.replaceAll("\\", "/");
      if (
        pathLikeAbsolute(normalized) ||
        normalized === "." ||
        normalized === ".." ||
        normalized.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "path"],
          message: "layout entry path must be a normalized workspace-relative path",
        });
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "path"],
          message: "layout entry paths must be unique",
        });
      }
      seen.add(key);
    }
  });

export const frameworkManifestSchema = z
  .object({
    __schema: z.literal(4),
    framework_version: z.literal("0.13.0"),
    layout: workspaceLayoutSchema,
  })
  .strict();

function pathLikeAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

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
    generator: z.string().min(1).optional(),
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
export type ManagedFilesReceipt = z.infer<typeof managedFilesReceiptSchema>;
export type NativeProject = z.infer<typeof nativeProjectSchema>;
export type FrameworkManifest = z.infer<typeof frameworkManifestSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
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
