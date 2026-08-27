import { z } from "zod";

/**
 * One Source adoption record is one mapping.
 *
 * The record answers a single question — where did this material land, and what
 * was it when it landed — so it carries a source endpoint, a target endpoint, an
 * optional rationale note, and an optional tier-1 identity pin. An intent that
 * moves several paths is several records; there is no container above them to
 * hold a shared workflow, because there is no workflow.
 */
export const SOURCE_ADOPTION_SCHEMA = "assay.source-adoption/v1" as const;

/**
 * Whether the material was carried over verbatim or reworked on the way in.
 * Descriptive only: nothing branches on it, but reviewing an upstream change is
 * a different job for a verbatim copy than for something already adapted.
 */
export const SOURCE_ADOPTION_TAKE_MODES_CODEC = ["adapt", "copy"] as const;
export type SourceAdoptionTakeMode = (typeof SOURCE_ADOPTION_TAKE_MODES_CODEC)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceAdoptionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "reserved Source adoption identifier");

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
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

export const sourceAdoptionMatchSchema = z.enum(["exact", "prefix"]);

/**
 * A path and how much of the tree it names: `exact` is one file, `prefix` is a
 * directory and everything beneath it. Shared by both endpoints and by the
 * upstream impact report, so "does this change touch adopted material?" has one
 * answer.
 */
export const sourceAdoptionPathLocatorSchema = z
  .object({
    path: sourceAdoptionRelativePathSchema,
    match: sourceAdoptionMatchSchema.default("exact"),
  })
  .strict();

/**
 * Tier-1 identity of the source material, as of the moment it was adopted.
 *
 * A checkout-backed source has one for free: the commit, plus the origin it came
 * from. Copied content has no commit to cite, so its identity is a tree hash
 * computed at this point and nowhere else. Either way the pin is optional — a
 * mapping is still worth recording without one.
 */
export const sourceAdoptionPinSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("git-commit"),
      commit: z.string().min(1),
      origin: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("content-hash"),
      algorithm: z.literal("sha256-tree-v1"),
      value: sha256Schema,
    })
    .strict(),
]);

export const sourceAdoptionSourceRefSchema = z
  .object({
    alias: z.string().min(1),
    /** Observation the material was read from, for the traceable "as of when". */
    observation: z.string().min(1),
    path: sourceAdoptionRelativePathSchema,
    match: sourceAdoptionMatchSchema.default("exact"),
    pin: sourceAdoptionPinSchema.optional(),
  })
  .strict();

export const sourceAdoptionTargetRefSchema = z
  .object({
    /** Registered system selector; the registry owns where that resolves. */
    system: z.string().min(1),
    path: sourceAdoptionRelativePathSchema,
    match: sourceAdoptionMatchSchema.default("exact"),
  })
  .strict();

export const sourceAdoptionRecordSchema = z
  .object({
    schema: z.literal(SOURCE_ADOPTION_SCHEMA),
    id: sourceAdoptionIdSchema,
    mode: z.enum(SOURCE_ADOPTION_TAKE_MODES_CODEC).default("adapt"),
    source: sourceAdoptionSourceRefSchema,
    target: sourceAdoptionTargetRefSchema,
    note: z.string().min(1).optional(),
    recorded_on: z.string().min(1),
  })
  .strict();

export type SourceAdoptionMatch = z.infer<typeof sourceAdoptionMatchSchema>;
export type SourceAdoptionPathLocator = z.infer<typeof sourceAdoptionPathLocatorSchema>;
export type SourceAdoptionPin = z.infer<typeof sourceAdoptionPinSchema>;
export type SourceAdoptionSourceRef = z.infer<typeof sourceAdoptionSourceRefSchema>;
export type SourceAdoptionTargetRef = z.infer<typeof sourceAdoptionTargetRefSchema>;
export type SourceAdoptionRecord = z.infer<typeof sourceAdoptionRecordSchema>;
