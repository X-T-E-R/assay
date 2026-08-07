import { FrameworkError, type FrameworkErrorCode, TaskError } from "assay-core";

/**
 * Codes that mean "Assay itself misbehaved", printed with the `Runtime error:`
 * prefix. Everything else is a user-actionable error and prints `Error:`.
 *
 * The set enumerates internal faults rather than user errors because the
 * default code of `new FrameworkError(...)` is `FRAMEWORK_ERROR` and the most
 * common explicit code is `IO_ERROR`: a user-error allowlist silently
 * misclassifies every message that does not opt in, which is most of them.
 * Listing internal faults means a new code defaults to the user-facing prefix,
 * and only a deliberate internal-fault code opts into `Runtime error:`.
 *
 * `INVALID_MANIFEST`, `INVALID_EVENT`, `INVALID_OPERATION_REPORT`, and
 * `INVALID_UPDATE_PLAN` are raised when a persisted record fails schema
 * validation. Those records are Assay's own state, so a failure there is a
 * defect or external corruption, not something the caller phrased wrongly.
 */
const INTERNAL_ERROR_CODES = new Set<FrameworkErrorCode>([
  "INVALID_MANIFEST",
  "INVALID_EVENT",
  "INVALID_OPERATION_REPORT",
  "INVALID_UPDATE_PLAN",
]);

export interface CliFailure {
  readonly exitCode: number;
  readonly message: string;
}

export function mapCliError(error: unknown): CliFailure {
  if (error instanceof TaskError) {
    return { exitCode: 1, message: `Error [${error.code}]: ${error.message}` };
  }

  if (error instanceof FrameworkError) {
    const prefix = INTERNAL_ERROR_CODES.has(error.code) ? "Runtime error" : "Error";
    return { exitCode: 1, message: `${prefix}: ${error.message}` };
  }

  if (error instanceof Error) {
    return { exitCode: 1, message: `Runtime error: ${error.message}` };
  }

  return { exitCode: 1, message: `Runtime error: ${String(error)}` };
}
