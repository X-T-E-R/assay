import {
  CURRENT_VERSION,
  LAYOUT_VERSION,
  MIGRATABLE_VERSION,
  SYSTEMS_REGISTRY_SCHEMA,
} from "./constants.js";

export type FrameworkErrorCode =
  | "FRAMEWORK_ERROR"
  | "INVALID_MANIFEST"
  | "INVALID_EVENT"
  | "INVALID_OPERATION_REPORT"
  | "INVALID_UPDATE_PLAN"
  | "WORKSPACE_CUTOVER_REQUIRED"
  | "AUTHORITY_REPAIR_REQUIRED"
  | "AUTHORITY_WRITE_CONFLICT"
  | "INVALID_SOURCE_ADOPTION"
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

/** Envelope tuple this build writes and is willing to load. */
export const REQUIRED_WORKSPACE_TUPLE = `${CURRENT_VERSION}+s4+l${LAYOUT_VERSION}`;
/** The one older tuple `assay update` migrates in place. */
export const MIGRATABLE_WORKSPACE_TUPLE = `${MIGRATABLE_VERSION}+s4+l${LAYOUT_VERSION}`;

export class WorkspaceCutoverRequiredError extends FrameworkError {
  readonly observed: string;
  readonly required = REQUIRED_WORKSPACE_TUPLE;
  readonly locator: string;

  constructor(observed: string) {
    // One release back has a migration in `assay update`; everything older is
    // still the external tool's job. Naming the right one is the difference
    // between a command that works and an hour lost.
    const migratable = observed.endsWith(MIGRATABLE_WORKSPACE_TUPLE);
    const locator = migratable
      ? `assay-update:${observed}->${REQUIRED_WORKSPACE_TUPLE}`
      : `assay-cutover:${observed}->${REQUIRED_WORKSPACE_TUPLE}`;
    super(
      migratable
        ? `Workspace migration required: observed ${observed}; required ${REQUIRED_WORKSPACE_TUPLE}; run \`assay update\`; locator ${locator}`
        : `Workspace cutover required: observed ${observed}; required ${REQUIRED_WORKSPACE_TUPLE}; locator ${locator}`,
      {
        code: "WORKSPACE_CUTOVER_REQUIRED",
        details: { observed, required: REQUIRED_WORKSPACE_TUPLE, locator },
      },
    );
    this.name = "WorkspaceCutoverRequiredError";
    this.observed = observed;
    this.locator = locator;
  }
}

export class SystemsRegistryCutoverRequiredError extends FrameworkError {
  readonly observed: string;
  readonly required = `${REQUIRED_WORKSPACE_TUPLE}+r${SYSTEMS_REGISTRY_SCHEMA}`;
  readonly locator: string;

  constructor(observedRegistrySchema: number | "unknown") {
    const required = `${REQUIRED_WORKSPACE_TUPLE}+r${SYSTEMS_REGISTRY_SCHEMA}`;
    const observed = `${REQUIRED_WORKSPACE_TUPLE}+r${observedRegistrySchema}`;
    const locator = `assay-cutover:${observed}->${required}`;
    super(
      `Systems registry cutover required: observed ${observed}; required ${required}; locator ${locator}`,
      {
        code: "WORKSPACE_CUTOVER_REQUIRED",
        details: { observed, required, locator },
      },
    );
    this.name = "SystemsRegistryCutoverRequiredError";
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
