export type FrameworkErrorCode =
  | "FRAMEWORK_ERROR"
  | "INVALID_MANIFEST"
  | "INVALID_EVENT"
  | "INVALID_OPERATION_REPORT"
  | "INVALID_UPDATE_PLAN"
  | "WORKSPACE_CUTOVER_REQUIRED"
  | "AUTHORITY_REPAIR_REQUIRED"
  | "AUTHORITY_WRITE_CONFLICT"
  | "RETIRED_ARCHETYPE_FIELD"
  | "RETIRED_ARCHETYPE_PATH"
  | "INVALID_SOURCE_ADOPTION"
  | "SOURCE_ADOPTION_POLICY_BLOCKED"
  | "SOURCE_ADOPTION_STALE"
  | "SOURCE_ADOPTION_BUSY"
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "IO_ERROR";

export interface FrameworkErrorOptions {
  readonly code?: FrameworkErrorCode;
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class FrameworkError extends Error {
  readonly code: FrameworkErrorCode;
  readonly details?: unknown;

  constructor(message: string, options: FrameworkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FrameworkError";
    this.code = options.code ?? "FRAMEWORK_ERROR";
    this.details = options.details;
  }
}

export class InvalidManifestError extends FrameworkError {
  readonly path: string;

  constructor(path: string, message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "INVALID_MANIFEST" });
    this.name = "InvalidManifestError";
    this.path = path;
  }
}

export class WorkspaceCutoverRequiredError extends FrameworkError {
  readonly observed: string;
  readonly required = "0.11.0+s3+l7";
  readonly locator: string;

  constructor(observed: string) {
    const locator = `assay-cutover:${observed}->0.11.0+s3+l7`;
    super(
      `Workspace cutover required: observed ${observed}; required 0.11.0+s3+l7; locator ${locator}`,
      {
        code: "WORKSPACE_CUTOVER_REQUIRED",
        details: { observed, required: "0.11.0+s3+l7", locator },
      },
    );
    this.name = "WorkspaceCutoverRequiredError";
    this.observed = observed;
    this.locator = locator;
  }
}

export class AuthorityRepairRequiredError extends FrameworkError {
  constructor(message: string, cause?: unknown, details?: unknown) {
    super(message, {
      code: "AUTHORITY_REPAIR_REQUIRED",
      ...(cause === undefined ? {} : { cause }),
      ...(details === undefined ? {} : { details }),
    });
    this.name = "AuthorityRepairRequiredError";
  }
}

export class AuthorityWriteConflictError extends FrameworkError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "AUTHORITY_WRITE_CONFLICT",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "AuthorityWriteConflictError";
  }
}

export class InvalidEventError extends FrameworkError {
  constructor(message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "INVALID_EVENT" });
    this.name = "InvalidEventError";
  }
}

export class InvalidOperationReportError extends FrameworkError {
  constructor(message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "INVALID_OPERATION_REPORT" });
    this.name = "InvalidOperationReportError";
  }
}

export class InvalidUpdatePlanError extends FrameworkError {
  constructor(message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "INVALID_UPDATE_PLAN" });
    this.name = "InvalidUpdatePlanError";
  }
}

export class FrameworkNotFoundError extends FrameworkError {
  constructor(message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "NOT_FOUND" });
    this.name = "FrameworkNotFoundError";
  }
}

export class FrameworkAlreadyExistsError extends FrameworkError {
  constructor(message: string, options: Omit<FrameworkErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "ALREADY_EXISTS" });
    this.name = "FrameworkAlreadyExistsError";
  }
}
