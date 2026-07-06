import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { SYSTEMS_REGISTRY_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import {
  type SystemRecord,
  type SystemStatus,
  type SystemVcs,
  type SystemsRegistry,
  systemsRegistrySchema,
} from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";
import { nowIso } from "./time.js";

export interface SystemsRegistryOptions {
  readonly now?: Date;
}

export interface RegisterSystemInput {
  readonly name?: string;
  readonly path: string;
  readonly vcs?: SystemVcs;
  readonly vcsRef?: string;
  readonly version?: string;
  readonly primary?: boolean;
  readonly supersedes?: readonly string[];
  readonly contractFile?: string | null;
}

export interface RegisterSystemResult {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly system: SystemRecord;
  readonly eventFile: string;
}

export interface UpdateSystemInput {
  readonly path?: string;
  readonly vcs?: SystemVcs;
  readonly vcsRef?: string;
  readonly version?: string;
  readonly primary?: boolean;
  readonly supersedes?: readonly string[];
  readonly contractFile?: string | null;
}

export type SystemUpdateField =
  | "path"
  | "vcs"
  | "vcs_ref"
  | "version"
  | "contract_file"
  | "supersedes"
  | "status";

export type SystemUpdateValue = string | readonly string[] | null;

export interface SystemUpdateChange {
  readonly field: SystemUpdateField;
  readonly previous: SystemUpdateValue;
  readonly current: SystemUpdateValue;
}

export interface UpdateSystemResult {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly previous: SystemRecord;
  readonly system: SystemRecord;
  readonly changes: readonly SystemUpdateChange[];
  readonly eventFile: string;
}

export interface PromoteSystemResult {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly previousPrimary: SystemRecord | null;
  readonly system: SystemRecord;
  readonly eventFile: string;
}

export interface ArchiveSystemInput {
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface ArchiveSystemResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly registry: SystemsRegistry;
  readonly system: SystemRecord;
  readonly movedTo: string | null;
  readonly eventFile: string | null;
}

export function systemsRegistryPath(root: string): string {
  return path.join(root, SYSTEMS_REGISTRY_FILE);
}

export function defaultSystemsRegistry(): SystemsRegistry {
  const now = nowIso();
  return {
    __schema: 1,
    primary: null,
    systems: {},
    updated_at: now,
  };
}

export async function loadSystemsRegistry(root: string): Promise<SystemsRegistry | null> {
  const file = systemsRegistryPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new FrameworkError(`systems registry is not valid JSON: ${file}`, { cause: error });
  }

  const result = systemsRegistrySchema.safeParse(data);
  if (!result.success) {
    throw new FrameworkError(`systems registry failed validation: ${file}`, {
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
}

export async function saveSystemsRegistry(
  root: string,
  registry: SystemsRegistry,
): Promise<SystemsRegistry> {
  const file = systemsRegistryPath(root);
  const next = systemsRegistrySchema.parse({ ...registry, updated_at: nowIso() });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifySortedJson(next), "utf8");
  return next;
}

export async function requireSystemsRegistry(root: string): Promise<SystemsRegistry> {
  const registry = await loadSystemsRegistry(root);
  if (!registry) {
    throw new FrameworkNotFoundError(
      `No systems registry found at ${systemsRegistryPath(root)}. Run \`assay system register\` first.`,
    );
  }
  return registry;
}

function systemByName(registry: SystemsRegistry, name: string): SystemRecord | undefined {
  return registry.systems[name];
}

export async function findSystem(
  registry: SystemsRegistry,
  selector: string,
): Promise<SystemRecord> {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new FrameworkNotFoundError("system selector cannot be empty");
  }

  const direct = systemByName(registry, trimmed);
  if (direct) {
    return direct;
  }

  const matches = Object.values(registry.systems).filter((system) =>
    system.name.startsWith(trimmed),
  );
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new FrameworkNotFoundError(
      `system selector '${selector}' is ambiguous (${matches.map((system) => system.name).join(", ")})`,
    );
  }
  throw new FrameworkNotFoundError(`system not found: ${selector}`);
}

function setPrimaryInPlace(registry: SystemsRegistry, name: string): void {
  for (const [existingName, system] of Object.entries(registry.systems)) {
    if (system.status === "primary") {
      registry.systems[existingName] = {
        ...system,
        status: existingName === name ? "primary" : "superseded",
      };
    }
  }
  const target = registry.systems[name];
  if (target) {
    registry.systems[name] = { ...target, status: "primary" };
  }
  registry.primary = name;
}

function cloneSystemRecord(system: SystemRecord): SystemRecord {
  return { ...system, supersedes: [...system.supersedes] };
}

function normalizeRegistryPath(root: string, value: string): string {
  return relativeDisplayPath(path.resolve(root, value), root);
}

function updateValuesEqual(previous: SystemUpdateValue, current: SystemUpdateValue): boolean {
  if (Array.isArray(previous) || Array.isArray(current)) {
    if (!Array.isArray(previous) || !Array.isArray(current)) {
      return false;
    }
    return (
      previous.length === current.length &&
      previous.every((value, index) => current[index] === value)
    );
  }
  return previous === current;
}

function collectSystemUpdateChanges(
  previous: SystemRecord,
  current: SystemRecord,
): readonly SystemUpdateChange[] {
  const changes: SystemUpdateChange[] = [];
  const addChange = (
    field: SystemUpdateField,
    previousValue: SystemUpdateValue,
    currentValue: SystemUpdateValue,
  ): void => {
    if (!updateValuesEqual(previousValue, currentValue)) {
      changes.push({ field, previous: previousValue, current: currentValue });
    }
  };

  addChange("path", previous.path, current.path);
  addChange("vcs", previous.vcs, current.vcs);
  addChange("vcs_ref", previous.vcs_ref, current.vcs_ref);
  addChange("version", previous.version, current.version);
  addChange("contract_file", previous.contract_file, current.contract_file);
  addChange("supersedes", previous.supersedes, current.supersedes);
  addChange("status", previous.status, current.status);

  return changes;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function registerSystem(
  root: string,
  input: RegisterSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<RegisterSystemResult> {
  const now = options.now ?? new Date();
  const registry = (await loadSystemsRegistry(root)) ?? defaultSystemsRegistry();

  const systemPath = path.resolve(root, input.path);
  const relativeSystemPath = relativeDisplayPath(systemPath, root);
  const name = input.name ?? path.basename(systemPath);

  if (systemByName(registry, name)) {
    throw new FrameworkAlreadyExistsError(`system already registered: ${name}`);
  }

  const vcs: SystemVcs = input.vcs ?? "embedded";
  const contractFile = input.contractFile ?? `${relativeSystemPath}/system.yaml`;
  const dateStamp = nowIso(now).slice(0, 10);

  const record: SystemRecord = {
    name,
    path: relativeSystemPath,
    status: input.primary ? "primary" : "active",
    vcs,
    vcs_ref: input.vcsRef ?? "",
    version: input.version ?? "0.1.0",
    contract_file: contractFile,
    supersedes: [...(input.supersedes ?? [])],
    absorbed_on: dateStamp,
    archived_on: null,
    archive_path: null,
  };

  registry.systems[name] = record;
  if (input.primary) {
    setPrimaryInPlace(registry, name);
  }

  await saveSystemsRegistry(root, registry);
  const eventFile = await appendEvent(
    root,
    {
      event: "system.registered",
      name,
      path: relativeSystemPath,
      vcs,
      primary: input.primary ?? false,
    },
    now,
  );

  return { root, registry, system: record, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function updateSystem(
  root: string,
  selector: string,
  input: UpdateSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<UpdateSystemResult> {
  const now = options.now ?? new Date();
  const registry = await requireSystemsRegistry(root);
  const system = await findSystem(registry, selector);

  if (system.status === "archived") {
    throw new FrameworkError(`cannot update an archived system: ${system.name}`);
  }

  const previous = cloneSystemRecord(system);
  let updated = cloneSystemRecord(system);

  if (input.path !== undefined) {
    updated = { ...updated, path: normalizeRegistryPath(root, input.path) };
  }
  if (input.vcs !== undefined) {
    updated = { ...updated, vcs: input.vcs };
  }
  if (input.vcsRef !== undefined) {
    updated = { ...updated, vcs_ref: input.vcsRef };
  }
  if (input.version !== undefined) {
    updated = { ...updated, version: input.version };
  }
  if (input.contractFile !== undefined) {
    updated = {
      ...updated,
      contract_file:
        input.contractFile === null ? null : normalizeRegistryPath(root, input.contractFile),
    };
  }
  if (input.supersedes !== undefined) {
    updated = { ...updated, supersedes: [...input.supersedes] };
  }

  registry.systems[system.name] = updated;

  const previousPrimary =
    input.primary && registry.primary && registry.primary !== system.name ? registry.primary : null;
  if (input.primary) {
    setPrimaryInPlace(registry, system.name);
  }

  const savedRegistry = await saveSystemsRegistry(root, registry);
  const savedSystem = savedRegistry.systems[system.name];
  if (!savedSystem) {
    throw new FrameworkError(
      `internal error: updated system missing from registry: ${system.name}`,
    );
  }

  const changes = collectSystemUpdateChanges(previous, savedSystem);
  const eventFile = await appendEvent(
    root,
    {
      event: "system.updated",
      name: system.name,
      changed_fields: changes.map((change) => change.field),
      changes,
      primary: savedSystem.status === "primary",
      previous_primary: previousPrimary,
    },
    now,
  );

  return {
    root,
    registry: savedRegistry,
    previous,
    system: savedSystem,
    changes,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function promoteSystem(
  root: string,
  selector: string,
  options: SystemsRegistryOptions = {},
): Promise<PromoteSystemResult> {
  const now = options.now ?? new Date();
  const registry = await requireSystemsRegistry(root);
  const system = await findSystem(registry, selector);

  if (system.status === "archived") {
    throw new FrameworkError(`cannot promote an archived system: ${system.name}`);
  }

  const previousPrimary = registry.primary
    ? (systemByName(registry, registry.primary) ?? null)
    : null;
  const previousPrimaryName =
    previousPrimary && previousPrimary.name !== system.name ? previousPrimary : null;

  setPrimaryInPlace(registry, system.name);
  await saveSystemsRegistry(root, registry);

  const promotedSystem = registry.systems[system.name];
  if (!promotedSystem) {
    throw new FrameworkError(
      `internal error: promoted system missing from registry: ${system.name}`,
    );
  }

  const eventFile = await appendEvent(
    root,
    {
      event: "system.promoted",
      name: system.name,
      previous_primary: previousPrimaryName?.name ?? null,
    },
    now,
  );

  return {
    root,
    registry,
    previousPrimary: previousPrimaryName,
    system: promotedSystem,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function archiveSystem(
  root: string,
  selector: string,
  input: ArchiveSystemInput = {},
): Promise<ArchiveSystemResult> {
  const now = input.now ?? new Date();
  const dryRun = input.dryRun ?? false;
  const registry = await requireSystemsRegistry(root);
  const system = await findSystem(registry, selector);

  if (system.status === "archived") {
    throw new FrameworkAlreadyExistsError(`system already archived: ${system.name}`);
  }
  if (system.status === "primary") {
    throw new FrameworkError(
      `cannot archive the primary system; promote another system first: ${system.name}`,
    );
  }

  const dateStamp = nowIso(now).slice(0, 10);
  const archiveBase = `systems/archive/${dateStamp}-pre-${slugify(system.name)}`;
  const movedTo = path.join(root, archiveBase, path.basename(system.path));

  if (dryRun) {
    return {
      root,
      dryRun: true,
      registry,
      system,
      movedTo: relativeDisplayPath(movedTo, root),
      eventFile: null,
    };
  }

  const sourcePath = path.join(root, system.path);
  if (await exists(sourcePath)) {
    await mkdir(path.dirname(movedTo), { recursive: true });
    // copy-first then remove for rollback safety
    const { cp } = await import("node:fs/promises");
    await cp(sourcePath, movedTo, { recursive: true });
    await rm(sourcePath, { recursive: true, force: true });
  }

  const archived: SystemRecord = {
    ...system,
    status: "archived",
    archived_on: dateStamp,
    archive_path: relativeDisplayPath(movedTo, root),
    contract_file: null,
  };
  registry.systems[system.name] = archived;
  await saveSystemsRegistry(root, registry);

  const eventFile = await appendEvent(
    root,
    {
      event: "system.archived",
      name: system.name,
      archive_path: archived.archive_path,
    },
    now,
  );

  return {
    root,
    dryRun: false,
    registry,
    system: archived,
    movedTo: relativeDisplayPath(movedTo, root),
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function listSystems(root: string): Promise<{
  readonly registry: SystemsRegistry;
  readonly systems: SystemRecord[];
}> {
  const registry = await requireSystemsRegistry(root);
  const systems = Object.values(registry.systems).sort((a, b) => {
    const order: Record<SystemStatus, number> = {
      primary: 0,
      active: 1,
      superseded: 2,
      archived: 3,
    };
    return order[a.status] - order[b.status] || a.name.localeCompare(b.name);
  });
  return { registry, systems };
}
