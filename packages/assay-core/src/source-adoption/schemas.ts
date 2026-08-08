import { z } from "zod";

export const SOURCE_ADOPTION_DEFINITION_SCHEMA = "assay.source-adoption-definition/v1" as const;
export const SOURCE_ADOPTION_STATE_SCHEMA = "assay.source-adoption-state/v1" as const;
export const SOURCE_ADOPTION_INSPECTION_SCHEMA = "assay.source-adoption-inspection/v1" as const;
export const SOURCE_ADOPTION_EVIDENCE_INPUT_SCHEMA =
  "assay.source-adoption-evidence-input/v1" as const;
export const SOURCE_ADOPTION_EVIDENCE_SCHEMA = "assay.source-adoption-evidence/v1" as const;
export const SOURCE_ADOPTION_DECISION_SCHEMA = "assay.source-adoption-decision/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceAdoptionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "reserved Source adoption identifier");

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const sourceAdoptionRelativePathSchema = z
  .string()
  .min(1)
  .transform(normalizeRelativePath)
  .refine(isSafeRelativePath, "path must be a contained relative path");

export const sourceAdoptionPathLocatorSchema = z
  .object({
    path: sourceAdoptionRelativePathSchema,
    match: z.enum(["exact", "prefix"]).default("exact"),
  })
  .strict();

export const sourceAdoptionTargetLocatorSchema = sourceAdoptionPathLocatorSchema
  .extend({
    target_id: sourceAdoptionIdSchema,
  })
  .strict();

export const sourceAdoptionEvidencePolicySchema = z.enum(["advisory", "required"]);

export const sourceAdoptionEvidenceRequirementSchema = z
  .object({
    id: sourceAdoptionIdSchema,
    description: z.string().min(1).optional(),
    policy: sourceAdoptionEvidencePolicySchema.default("advisory"),
  })
  .strict();

export const sourceAdoptionTargetDefinitionSchema = z
  .object({
    id: sourceAdoptionIdSchema,
    system: z.string().min(1),
    adapter: z.literal("local-system/v1").default("local-system/v1"),
  })
  .strict();

export const sourceAdoptionMappingSchema = z
  .object({
    id: sourceAdoptionIdSchema,
    kind: z.string().min(1).default("artifact"),
    mode: z.string().min(1).default("adapt"),
    source: sourceAdoptionPathLocatorSchema,
    target: sourceAdoptionTargetLocatorSchema,
    evidence: z.array(sourceAdoptionIdSchema).default([]),
  })
  .strict();

export const sourceAdoptionDefinitionSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_DEFINITION_SCHEMA),
    id: sourceAdoptionIdSchema,
    title: z.string().min(1).optional(),
    source: z
      .object({
        alias: z.string().min(1),
        observation: z.string().min(1),
      })
      .strict(),
    targets: z.array(sourceAdoptionTargetDefinitionSchema).min(1),
    mappings: z.array(sourceAdoptionMappingSchema).min(1),
    evidence: z.array(sourceAdoptionEvidenceRequirementSchema).default([]),
  })
  .strict();

export const sourceAdoptionSnapshotFileSchema = z
  .object({
    path: sourceAdoptionRelativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const sourceAdoptionLocatorSnapshotSchema = z
  .object({
    locator: sourceAdoptionPathLocatorSchema,
    state: z.enum(["present", "missing", "unresolvable"]),
    digest: sha256Schema.nullable(),
    files: z.array(sourceAdoptionSnapshotFileSchema),
    message: z.string().min(1).optional(),
  })
  .strict();

export const sourceAdoptionSourceSnapshotSchema = z
  .object({
    alias: z.string().min(1),
    lineage_id: z.string().min(1),
    observation_id: z.string().min(1),
    manifest_fingerprint: sha256Schema,
    vcs_commit: z.string().min(1).nullable(),
    locators: z.record(sourceAdoptionLocatorSnapshotSchema),
  })
  .strict();

export const sourceAdoptionTargetSnapshotSchema = z
  .object({
    system: z.string().min(1),
    registered_path: z.string().min(1),
    adapter: z.literal("local-system/v1"),
    revision: z
      .object({
        kind: z.literal("git-commit"),
        value: z.string().min(1),
      })
      .strict()
      .nullable(),
    working_tree: z.enum(["clean", "dirty", "not-versioned", "unknown"]),
    fingerprint: sha256Schema,
    locators: z.record(sourceAdoptionLocatorSnapshotSchema),
  })
  .strict();

export const sourceAdoptionAcceptedBaselineSchema = z
  .object({
    decision_id: sourceAdoptionIdSchema,
    definition_digest: sha256Schema,
    source: sourceAdoptionSourceSnapshotSchema,
    target: sourceAdoptionTargetSnapshotSchema,
    accepted_at: z.string().min(1),
  })
  .strict();

export const sourceAdoptionTargetStateSchema = z
  .object({
    baseline: sourceAdoptionAcceptedBaselineSchema.nullable(),
  })
  .strict();

export const sourceAdoptionStateSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_STATE_SCHEMA),
    adoption_id: sourceAdoptionIdSchema,
    current_definition: sha256Schema,
    generation: z.number().int().nonnegative(),
    targets: z.record(sourceAdoptionTargetStateSchema),
    decisions: z.array(sourceAdoptionIdSchema),
    updated_at: z.string().min(1),
  })
  .strict();

export const sourceAdoptionDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    mapping_id: sourceAdoptionIdSchema.optional(),
  })
  .strict();

export const sourceAdoptionMappingInspectionSchema = z
  .object({
    id: sourceAdoptionIdSchema,
    source: z
      .object({
        baseline: sourceAdoptionLocatorSnapshotSchema.nullable(),
        candidate: sourceAdoptionLocatorSnapshotSchema,
        change: z.enum(["activation", "no-direct-change", "direct-change", "missing"]),
      })
      .strict(),
    target: z
      .object({
        baseline: sourceAdoptionLocatorSnapshotSchema.nullable(),
        candidate: sourceAdoptionLocatorSnapshotSchema,
        change: z.enum(["activation", "unchanged", "drifted", "missing", "unresolvable"]),
      })
      .strict(),
    facts: z.array(
      z.enum([
        "activation",
        "source-direct-change",
        "source-missing",
        "target-drift",
        "target-missing",
        "target-unresolvable",
        "both-changed",
      ]),
    ),
    evidence: z.array(sourceAdoptionIdSchema),
  })
  .strict();

export const sourceAdoptionInspectionSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_INSPECTION_SCHEMA),
    id: sourceAdoptionIdSchema,
    adoption_id: sourceAdoptionIdSchema,
    definition_digest: sha256Schema,
    target_id: sourceAdoptionIdSchema,
    baseline_decision_id: sourceAdoptionIdSchema.nullable(),
    source: sourceAdoptionSourceSnapshotSchema,
    target: sourceAdoptionTargetSnapshotSchema,
    mappings: z.array(sourceAdoptionMappingInspectionSchema),
    required_evidence: z.array(sourceAdoptionIdSchema),
    advisory_evidence: z.array(sourceAdoptionIdSchema),
    diagnostics: z.array(sourceAdoptionDiagnosticSchema),
    created_at: z.string().min(1),
  })
  .strict();

export const sourceAdoptionEvidenceArtifactSchema = z
  .object({
    ref: z.string().min(1),
    sha256: sha256Schema.optional(),
    redacted: z.boolean().default(false),
  })
  .strict();

export const sourceAdoptionEvidenceInputSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_EVIDENCE_INPUT_SCHEMA),
    check_id: sourceAdoptionIdSchema,
    result: z.enum(["passed", "failed", "inconclusive"]),
    producer: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    summary: z.string().min(1).optional(),
    artifacts: z.array(sourceAdoptionEvidenceArtifactSchema).default([]),
  })
  .strict();

export const sourceAdoptionEvidenceSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_EVIDENCE_SCHEMA),
    id: sourceAdoptionIdSchema,
    adoption_id: sourceAdoptionIdSchema,
    definition_digest: sha256Schema,
    target_id: sourceAdoptionIdSchema,
    inspection_id: sourceAdoptionIdSchema,
    source_observation: z.string().min(1),
    target_fingerprint: sha256Schema,
    check_id: sourceAdoptionIdSchema,
    result: z.enum(["passed", "failed", "inconclusive"]),
    producer: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    summary: z.string().min(1).optional(),
    artifacts: z.array(sourceAdoptionEvidenceArtifactSchema),
    recorded_at: z.string().min(1),
  })
  .strict();

export const sourceAdoptionPolicyEvaluationSchema = z
  .object({
    required_missing: z.array(sourceAdoptionIdSchema),
    advisory_missing: z.array(sourceAdoptionIdSchema),
    failed: z.array(sourceAdoptionIdSchema),
  })
  .strict();

export const sourceAdoptionDecisionOutcomeSchema = z.enum([
  "accept",
  "reject",
  "defer",
  "rollback",
]);

export const sourceAdoptionDecisionSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_DECISION_SCHEMA),
    id: sourceAdoptionIdSchema,
    adoption_id: sourceAdoptionIdSchema,
    definition_digest: sha256Schema,
    target_id: sourceAdoptionIdSchema,
    inspection_id: sourceAdoptionIdSchema,
    outcome: sourceAdoptionDecisionOutcomeSchema,
    reason: z.string().min(1).nullable(),
    evidence_ids: z.array(sourceAdoptionIdSchema),
    policy: sourceAdoptionPolicyEvaluationSchema,
    baseline_before: sourceAdoptionIdSchema.nullable(),
    baseline_after: sourceAdoptionAcceptedBaselineSchema.nullable(),
    restored_from_decision: sourceAdoptionIdSchema.nullable(),
    state_generation: z.number().int().nonnegative(),
    decided_at: z.string().min(1),
  })
  .strict();

export type SourceAdoptionDefinition = z.infer<typeof sourceAdoptionDefinitionSchema>;
export type SourceAdoptionPathLocator = z.infer<typeof sourceAdoptionPathLocatorSchema>;
export type SourceAdoptionTargetDefinition = z.infer<typeof sourceAdoptionTargetDefinitionSchema>;
export type SourceAdoptionMapping = z.infer<typeof sourceAdoptionMappingSchema>;
export type SourceAdoptionEvidenceRequirement = z.infer<
  typeof sourceAdoptionEvidenceRequirementSchema
>;
export type SourceAdoptionLocatorSnapshot = z.infer<typeof sourceAdoptionLocatorSnapshotSchema>;
export type SourceAdoptionSourceSnapshot = z.infer<typeof sourceAdoptionSourceSnapshotSchema>;
export type SourceAdoptionTargetSnapshot = z.infer<typeof sourceAdoptionTargetSnapshotSchema>;
export type SourceAdoptionAcceptedBaseline = z.infer<typeof sourceAdoptionAcceptedBaselineSchema>;
export type SourceAdoptionState = z.infer<typeof sourceAdoptionStateSchema>;
export type SourceAdoptionDiagnostic = z.infer<typeof sourceAdoptionDiagnosticSchema>;
export type SourceAdoptionMappingInspection = z.infer<typeof sourceAdoptionMappingInspectionSchema>;
export type SourceAdoptionInspection = z.infer<typeof sourceAdoptionInspectionSchema>;
export type SourceAdoptionEvidenceInput = z.infer<typeof sourceAdoptionEvidenceInputSchema>;
export type SourceAdoptionEvidence = z.infer<typeof sourceAdoptionEvidenceSchema>;
export type SourceAdoptionPolicyEvaluation = z.infer<typeof sourceAdoptionPolicyEvaluationSchema>;
export type SourceAdoptionDecisionOutcome = z.infer<typeof sourceAdoptionDecisionOutcomeSchema>;
export type SourceAdoptionDecision = z.infer<typeof sourceAdoptionDecisionSchema>;
