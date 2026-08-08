import { z } from "zod";

export const DONOR_ADOPTION_SCHEMA = "assay.donor-adoption/v1" as const;
export const DONOR_STATE_SCHEMA = "assay.donor-state/v1" as const;
export const DONOR_INSPECTION_SCHEMA = "assay.donor-inspection/v1" as const;
export const DONOR_EVIDENCE_INPUT_SCHEMA = "assay.donor-evidence-input/v1" as const;
export const DONOR_EVIDENCE_SCHEMA = "assay.donor-evidence/v1" as const;
export const DONOR_DECISION_SCHEMA = "assay.donor-decision/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const donorIdSchema = z
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

export const donorRelativePathSchema = z
  .string()
  .min(1)
  .transform(normalizeRelativePath)
  .refine(isSafeRelativePath, "path must be a contained relative path");

export const donorPathLocatorSchema = z
  .object({
    path: donorRelativePathSchema,
    match: z.enum(["exact", "prefix"]).default("exact"),
  })
  .strict();

export const donorTargetLocatorSchema = donorPathLocatorSchema
  .extend({
    target_id: donorIdSchema,
  })
  .strict();

export const donorEvidencePolicySchema = z.enum(["advisory", "required"]);

export const donorEvidenceRequirementSchema = z
  .object({
    id: donorIdSchema,
    description: z.string().min(1).optional(),
    policy: donorEvidencePolicySchema.default("advisory"),
  })
  .strict();

export const donorTargetDefinitionSchema = z
  .object({
    id: donorIdSchema,
    system: z.string().min(1),
    adapter: z.literal("local-system/v1").default("local-system/v1"),
  })
  .strict();

export const donorMappingSchema = z
  .object({
    id: donorIdSchema,
    kind: z.string().min(1).default("artifact"),
    mode: z.string().min(1).default("adapt"),
    source: donorPathLocatorSchema,
    target: donorTargetLocatorSchema,
    evidence: z.array(donorIdSchema).default([]),
  })
  .strict();

export const donorAdoptionDefinitionSchema = z
  .object({
    schema: z.literal(DONOR_ADOPTION_SCHEMA),
    id: donorIdSchema,
    title: z.string().min(1).optional(),
    source: z
      .object({
        alias: z.string().min(1),
        observation: z.string().min(1),
      })
      .strict(),
    targets: z.array(donorTargetDefinitionSchema).min(1),
    mappings: z.array(donorMappingSchema).min(1),
    evidence: z.array(donorEvidenceRequirementSchema).default([]),
  })
  .strict();

export const donorSnapshotFileSchema = z
  .object({
    path: donorRelativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const donorLocatorSnapshotSchema = z
  .object({
    locator: donorPathLocatorSchema,
    state: z.enum(["present", "missing", "unresolvable"]),
    digest: sha256Schema.nullable(),
    files: z.array(donorSnapshotFileSchema),
    message: z.string().min(1).optional(),
  })
  .strict();

export const donorSourceSnapshotSchema = z
  .object({
    alias: z.string().min(1),
    lineage_id: z.string().min(1),
    observation_id: z.string().min(1),
    manifest_fingerprint: sha256Schema,
    vcs_commit: z.string().min(1).nullable(),
    locators: z.record(donorLocatorSnapshotSchema),
  })
  .strict();

export const donorTargetSnapshotSchema = z
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
    locators: z.record(donorLocatorSnapshotSchema),
  })
  .strict();

export const donorAcceptedBaselineSchema = z
  .object({
    decision_id: donorIdSchema,
    definition_digest: sha256Schema,
    source: donorSourceSnapshotSchema,
    target: donorTargetSnapshotSchema,
    accepted_at: z.string().min(1),
  })
  .strict();

export const donorTargetStateSchema = z
  .object({
    baseline: donorAcceptedBaselineSchema.nullable(),
  })
  .strict();

export const donorStateSchema = z
  .object({
    schema: z.literal(DONOR_STATE_SCHEMA),
    adoption_id: donorIdSchema,
    current_definition: sha256Schema,
    generation: z.number().int().nonnegative(),
    targets: z.record(donorTargetStateSchema),
    decisions: z.array(donorIdSchema),
    updated_at: z.string().min(1),
  })
  .strict();

export const donorDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    mapping_id: donorIdSchema.optional(),
  })
  .strict();

export const donorMappingInspectionSchema = z
  .object({
    id: donorIdSchema,
    source: z
      .object({
        baseline: donorLocatorSnapshotSchema.nullable(),
        candidate: donorLocatorSnapshotSchema,
        change: z.enum(["activation", "no-direct-change", "direct-change", "missing"]),
      })
      .strict(),
    target: z
      .object({
        baseline: donorLocatorSnapshotSchema.nullable(),
        candidate: donorLocatorSnapshotSchema,
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
    evidence: z.array(donorIdSchema),
  })
  .strict();

export const donorInspectionSchema = z
  .object({
    schema: z.literal(DONOR_INSPECTION_SCHEMA),
    id: donorIdSchema,
    adoption_id: donorIdSchema,
    definition_digest: sha256Schema,
    target_id: donorIdSchema,
    baseline_decision_id: donorIdSchema.nullable(),
    source: donorSourceSnapshotSchema,
    target: donorTargetSnapshotSchema,
    mappings: z.array(donorMappingInspectionSchema),
    required_evidence: z.array(donorIdSchema),
    advisory_evidence: z.array(donorIdSchema),
    diagnostics: z.array(donorDiagnosticSchema),
    created_at: z.string().min(1),
  })
  .strict();

export const donorEvidenceArtifactSchema = z
  .object({
    ref: z.string().min(1),
    sha256: sha256Schema.optional(),
    redacted: z.boolean().default(false),
  })
  .strict();

export const donorEvidenceInputSchema = z
  .object({
    schema: z.literal(DONOR_EVIDENCE_INPUT_SCHEMA),
    check_id: donorIdSchema,
    result: z.enum(["passed", "failed", "inconclusive"]),
    producer: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    summary: z.string().min(1).optional(),
    artifacts: z.array(donorEvidenceArtifactSchema).default([]),
  })
  .strict();

export const donorEvidenceSchema = z
  .object({
    schema: z.literal(DONOR_EVIDENCE_SCHEMA),
    id: donorIdSchema,
    adoption_id: donorIdSchema,
    definition_digest: sha256Schema,
    target_id: donorIdSchema,
    inspection_id: donorIdSchema,
    source_observation: z.string().min(1),
    target_fingerprint: sha256Schema,
    check_id: donorIdSchema,
    result: z.enum(["passed", "failed", "inconclusive"]),
    producer: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    summary: z.string().min(1).optional(),
    artifacts: z.array(donorEvidenceArtifactSchema),
    recorded_at: z.string().min(1),
  })
  .strict();

export const donorPolicyEvaluationSchema = z
  .object({
    required_missing: z.array(donorIdSchema),
    advisory_missing: z.array(donorIdSchema),
    failed: z.array(donorIdSchema),
  })
  .strict();

export const donorDecisionOutcomeSchema = z.enum(["accept", "reject", "defer", "rollback"]);

export const donorDecisionSchema = z
  .object({
    schema: z.literal(DONOR_DECISION_SCHEMA),
    id: donorIdSchema,
    adoption_id: donorIdSchema,
    definition_digest: sha256Schema,
    target_id: donorIdSchema,
    inspection_id: donorIdSchema,
    outcome: donorDecisionOutcomeSchema,
    reason: z.string().min(1).nullable(),
    evidence_ids: z.array(donorIdSchema),
    policy: donorPolicyEvaluationSchema,
    baseline_before: donorIdSchema.nullable(),
    baseline_after: donorAcceptedBaselineSchema.nullable(),
    restored_from_decision: donorIdSchema.nullable(),
    state_generation: z.number().int().nonnegative(),
    decided_at: z.string().min(1),
  })
  .strict();

export type SourceAdoptionDefinition = z.infer<typeof donorAdoptionDefinitionSchema>;
export type SourceAdoptionPathLocator = z.infer<typeof donorPathLocatorSchema>;
export type SourceAdoptionTargetDefinition = z.infer<typeof donorTargetDefinitionSchema>;
export type SourceAdoptionMapping = z.infer<typeof donorMappingSchema>;
export type SourceAdoptionEvidenceRequirement = z.infer<typeof donorEvidenceRequirementSchema>;
export type SourceAdoptionLocatorSnapshot = z.infer<typeof donorLocatorSnapshotSchema>;
export type SourceAdoptionSourceSnapshot = z.infer<typeof donorSourceSnapshotSchema>;
export type SourceAdoptionTargetSnapshot = z.infer<typeof donorTargetSnapshotSchema>;
export type SourceAdoptionAcceptedBaseline = z.infer<typeof donorAcceptedBaselineSchema>;
export type SourceAdoptionState = z.infer<typeof donorStateSchema>;
export type SourceAdoptionDiagnostic = z.infer<typeof donorDiagnosticSchema>;
export type SourceAdoptionMappingInspection = z.infer<typeof donorMappingInspectionSchema>;
export type SourceAdoptionInspection = z.infer<typeof donorInspectionSchema>;
export type SourceAdoptionEvidenceInput = z.infer<typeof donorEvidenceInputSchema>;
export type SourceAdoptionEvidence = z.infer<typeof donorEvidenceSchema>;
export type SourceAdoptionPolicyEvaluation = z.infer<typeof donorPolicyEvaluationSchema>;
export type SourceAdoptionDecisionOutcome = z.infer<typeof donorDecisionOutcomeSchema>;
export type SourceAdoptionDecision = z.infer<typeof donorDecisionSchema>;
