import type { z } from "zod";

import type {
  checkRowSchema,
  operationReportSchema,
  updateAnalysisSchema,
  updateChangeSchema,
  updatePlanSchema,
} from "./schemas/index.js";

export type OperationStatus = "ok" | "changed" | "failed";

export type OperationReport = z.infer<typeof operationReportSchema>;

export type CheckStatus = "ok" | "missing" | "warning" | "error";

export type CheckRow = z.infer<typeof checkRowSchema>;

export type UpdateChangeKind =
  | "new"
  | "auto-update"
  | "modified-by-user"
  | "user-deleted"
  | "untracked-existing"
  | "unchanged";

export type UpdateAction = "create" | "update" | "skip" | "force" | "create-new";

export type UpdateConflictAction = "skip" | "force" | "create-new";

export type UpdateChange = z.infer<typeof updateChangeSchema>;

export type UpdateAnalysis = z.infer<typeof updateAnalysisSchema>;

export type UpdatePlan = z.infer<typeof updatePlanSchema>;

export interface OperationResult<TReport extends OperationReport = OperationReport> {
  readonly status: OperationStatus;
  readonly report: TReport;
}

export function createEmptyReport(): OperationReport {
  return {
    created_dirs: [],
    existing_dirs: [],
    created_files: [],
    updated_files: [],
    skipped_files: [],
    conflicted_files: [],
    new_copies: [],
    notes: [],
  };
}
