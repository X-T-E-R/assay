import { FrameworkError, type FrameworkErrorCode } from "assay-core";

const USER_ERROR_CODES = new Set<FrameworkErrorCode>([
  "INVALID_MANIFEST",
  "INVALID_EVENT",
  "INVALID_OPERATION_REPORT",
  "INVALID_UPDATE_PLAN",
  "INVALID_DONOR",
  "DONOR_POLICY_BLOCKED",
  "DONOR_STALE",
  "DONOR_BUSY",
  "ALREADY_EXISTS",
  "NOT_FOUND",
]);

export interface CliFailure {
  readonly exitCode: number;
  readonly message: string;
}

export function mapCliError(error: unknown): CliFailure {
  if (error instanceof FrameworkError) {
    const prefix = USER_ERROR_CODES.has(error.code) ? "Error" : "Runtime error";
    return { exitCode: 1, message: `${prefix}: ${error.message}` };
  }

  if (error instanceof Error) {
    return { exitCode: 1, message: `Runtime error: ${error.message}` };
  }

  return { exitCode: 1, message: `Runtime error: ${String(error)}` };
}
