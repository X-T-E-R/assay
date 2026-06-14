export type FrameworkErrorCode =
  | "FRAMEWORK_ERROR"
  | "INVALID_MANIFEST"
  | "INVALID_EVENT"
  | "INVALID_OPERATION_REPORT"
  | "INVALID_UPDATE_PLAN"
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
