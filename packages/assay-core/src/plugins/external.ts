import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { CURRENT_VERSION, MANAGED_DIR } from "../constants.js";
import { FrameworkError, FrameworkNotFoundError, InvalidManifestError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import { stringifySortedJson } from "../serialization.js";
import { withWorkspaceMutationCoordination } from "../tasks/task-storage.js";
import { nowIso } from "../time.js";

export const EXTERNAL_PLUGINS_STATE_FILE = `${MANAGED_DIR}/external-plugins.json`;
export const EXTERNAL_PLUGIN_SPI_VERSION = 1;

const exactVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "an exact version is required");
const integritySchema = z
  .string()
  .trim()
  .superRefine((value, context) => {
    if (/^sha256:[a-f0-9]{64}$/.test(value)) return;
    if (value.startsWith("sha512-")) {
      const encoded = value.slice("sha512-".length);
      const strictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
      if (encoded.length > 0 && encoded.length % 4 === 0 && strictBase64.test(encoded)) {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.length === 64 && decoded.toString("base64") === encoded) return;
      }
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "integrity must be sha256:<64 lowercase hex> or sha512-<64-byte base64>",
    });
  });
const qualifiedNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    "a lowercase dot-namespaced name is required",
  );
const assayStatePathSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    const normalizedPath = path.posix.normalize(normalized);
    const semanticPath = normalizedPath.toLowerCase();
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(value) ||
      /^[A-Za-z]:/.test(value) ||
      normalized.split("/").includes("..")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Assay-owned state paths must be workspace-relative and cannot escape the workspace",
      });
    }
    if (
      normalizedPath === "." ||
      semanticPath === MANAGED_DIR ||
      semanticPath.startsWith(`${MANAGED_DIR}/`)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external plugins cannot own the workspace root or Assay-managed state",
      });
    }
    if (semanticPath === "project" || semanticPath.startsWith("project/")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external plugins cannot own native Project authority paths",
      });
    }
  });
const hostStateLocatorSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/,
    "host-owned state locators must be non-empty symbolic names with a scheme",
  );
const stateOwnershipSchema = z.discriminatedUnion("owner", [
  z.object({ owner: z.literal("assay"), path: assayStatePathSchema }).strict(),
  z.object({ owner: z.literal("host"), locator: hostStateLocatorSchema }).strict(),
]);
const targetHostSchema = z
  .object({
    host: qualifiedNameSchema,
    version: exactVersionSchema.optional(),
  })
  .strict();

function refIdentifiesExactVersion(ref: string, version: string): boolean {
  return ref === version || ref.endsWith(`@${version}`) || ref.endsWith(`#${version}`);
}
const licenseSchema = z
  .object({
    spdx: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/, "a syntactically valid SPDX identifier is required"),
    url: z
      .string()
      .trim()
      .url("an authoritative license URL is required")
      .refine((value) => /^https?:\/\//.test(value), "license URLs must use HTTP or HTTPS"),
  })
  .strict();

export const externalPluginDescriptorSchema = z
  .object({
    __schema: z.literal(1),
    id: qualifiedNameSchema,
    adapter_version: exactVersionSchema,
    assay: z
      .object({
        spi_version: z.literal(EXTERNAL_PLUGIN_SPI_VERSION),
        version: exactVersionSchema,
      })
      .strict(),
    provenance: z
      .object({
        source: z.string().trim().min(1),
        ref: z.string().trim().min(1),
        license: licenseSchema,
      })
      .strict(),
    payload: z
      .object({
        locator: z.string().trim().min(1),
        version: exactVersionSchema,
        ref: z.string().trim().min(1),
        integrity: integritySchema,
      })
      .strict(),
    targets: z.array(targetHostSchema).min(1),
    requests: z
      .object({
        capabilities: z.array(qualifiedNameSchema),
        scopes: z.array(qualifiedNameSchema),
        surfaces: z.array(qualifiedNameSchema),
      })
      .strict(),
    state_ownership: z.array(stateOwnershipSchema),
    execution: z
      .object({
        owner: z.literal("external-host"),
        assay_executes: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.id.startsWith("assay.")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "the assay.* namespace is reserved for built-in plugins",
      });
    }
    if (descriptor.assay.version !== CURRENT_VERSION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assay", "version"],
        message: `this descriptor requires Assay ${descriptor.assay.version}; this build is ${CURRENT_VERSION}`,
      });
    }
    if (!refIdentifiesExactVersion(descriptor.payload.ref, descriptor.payload.version)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "ref"],
        message: "payload ref must end with an exact @version or #version token",
      });
    }
    for (const [key, values] of Object.entries(descriptor.requests)) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requests", key],
          message: "requested names must be unique",
        });
      }
    }
    const targetHosts = descriptor.targets.map((target) => target.host);
    if (new Set(targetHosts).size !== targetHosts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "target hosts must be unique",
      });
    }
    const ownershipKeys = descriptor.state_ownership.map((entry) => JSON.stringify(entry));
    if (new Set(ownershipKeys).size !== ownershipKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_ownership"],
        message: "state ownership entries must be unique",
      });
    }
  });

export const externalPluginObservationSchema = z
  .object({
    __schema: z.literal(1),
    plugin_id: qualifiedNameSchema,
    descriptor_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    payload_integrity: integritySchema,
    host: qualifiedNameSchema,
    host_version: exactVersionSchema,
    granted_scopes: z.array(qualifiedNameSchema),
    granted_surfaces: z.array(qualifiedNameSchema),
    state_ownership: z.array(stateOwnershipSchema),
    installation: z.enum(["installed", "not-installed"]),
    activation: z.enum(["active", "inactive"]),
    health: z.enum(["healthy", "unhealthy", "unverifiable"]),
    observed_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.activation === "active" && observation.installation !== "installed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activation"],
        message: "active host state requires an installed payload",
      });
    }
    if (observation.health !== "unverifiable" && observation.installation !== "installed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["health"],
        message: "healthy or unhealthy host state requires an installed payload",
      });
    }
  });

const externalPluginLockSchema = z
  .object({
    descriptor: externalPluginDescriptorSchema,
    descriptor_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    enabled: z.boolean(),
    registered_at: z.string().min(1),
    updated_at: z.string().min(1),
    observation: externalPluginObservationSchema.optional(),
  })
  .strict();

const externalPluginsStateSchema = z
  .object({
    __schema: z.literal(1),
    plugins: z.record(qualifiedNameSchema, externalPluginLockSchema),
    updated_at: z.string().min(1),
  })
  .strict();

export type ExternalPluginDescriptor = z.infer<typeof externalPluginDescriptorSchema>;
export type ExternalPluginObservation = z.infer<typeof externalPluginObservationSchema>;
export type ExternalPluginLock = z.infer<typeof externalPluginLockSchema>;
export type ExternalPluginsState = z.infer<typeof externalPluginsStateSchema>;

export interface ExternalPluginStatus {
  readonly id: string;
  readonly descriptorVerification: "verified";
  readonly descriptorDigest: string;
  readonly adapterVersion: string;
  readonly payload: ExternalPluginDescriptor["payload"];
  readonly provenance: ExternalPluginDescriptor["provenance"];
  readonly targets: ExternalPluginDescriptor["targets"];
  readonly requestedCapabilities: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly requestedSurfaces: readonly string[];
  readonly stateOwnership: ExternalPluginDescriptor["state_ownership"];
  readonly assayEnabled: boolean;
  readonly observedHost: string | null;
  readonly observedHostVersion: string | null;
  readonly hostInstallation: "installed" | "not-installed" | "unobserved";
  readonly hostActivation: "active" | "inactive" | "unobserved";
  readonly health: "healthy" | "unhealthy" | "unverifiable";
  readonly executionOwner: "external-host";
  readonly assayExecutes: false;
  readonly observedAt: string | null;
  readonly message: string;
}

function externalPluginsStatePath(root: string): string {
  return path.join(root, EXTERNAL_PLUGINS_STATE_FILE);
}

function externalPluginId(value: string): string {
  let id: string;
  try {
    id = qualifiedNameSchema.parse(value);
  } catch (error) {
    throw new FrameworkError("a qualified external plugin id is required", { cause: error });
  }
  if (id.startsWith("assay.")) {
    throw new FrameworkError(`'${id}' is a reserved built-in plugin id`);
  }
  return id;
}

function digestDescriptor(descriptor: ExternalPluginDescriptor): string {
  const canonical = stringifySortedJson(descriptor, 0);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDescriptor(descriptor: ExternalPluginDescriptor): ExternalPluginDescriptor {
  return {
    ...descriptor,
    requests: {
      capabilities: [...descriptor.requests.capabilities].sort(compareOrdinal),
      scopes: [...descriptor.requests.scopes].sort(compareOrdinal),
      surfaces: [...descriptor.requests.surfaces].sort(compareOrdinal),
    },
    targets: [...descriptor.targets].sort((left, right) => compareOrdinal(left.host, right.host)),
    state_ownership: descriptor.state_ownership
      .map((entry) =>
        entry.owner === "assay" ? { ...entry, path: entry.path.replaceAll("\\", "/") } : entry,
      )
      .sort((left, right) => compareOrdinal(JSON.stringify(left), JSON.stringify(right))),
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left]
      .sort(compareOrdinal)
      .every((value, index) => value === [...right].sort(compareOrdinal)[index])
  );
}

function sameOwnershipSet(
  left: readonly ExternalPluginObservation["state_ownership"][number][],
  right: readonly ExternalPluginDescriptor["state_ownership"][number][],
): boolean {
  const leftKeys = left.map((entry) => JSON.stringify(entry));
  const rightKeys = right.map((entry) => JSON.stringify(entry));
  return sameSet(leftKeys, rightKeys);
}

function validateObservation(
  lock: Pick<ExternalPluginLock, "descriptor" | "descriptor_digest">,
  observation: ExternalPluginObservation,
): void {
  const descriptor = lock.descriptor;
  const mismatches: string[] = [];
  if (observation.plugin_id !== descriptor.id) mismatches.push("plugin identity");
  if (observation.descriptor_digest !== lock.descriptor_digest)
    mismatches.push("descriptor integrity");
  if (observation.payload_integrity !== descriptor.payload.integrity)
    mismatches.push("payload integrity");
  const target = descriptor.targets.find((candidate) => candidate.host === observation.host);
  if (!target) mismatches.push("target host");
  else if (target.version && observation.host_version !== target.version)
    mismatches.push("target host version");
  if (!sameSet(observation.granted_scopes, descriptor.requests.scopes))
    mismatches.push("granted scopes");
  if (!sameSet(observation.granted_surfaces, descriptor.requests.surfaces))
    mismatches.push("granted surfaces");
  if (!sameOwnershipSet(observation.state_ownership, descriptor.state_ownership))
    mismatches.push("state ownership");
  if (mismatches.length > 0) {
    throw new FrameworkError(
      `external plugin observation rejected for '${descriptor.id}': ${mismatches.join(", ")} mismatch`,
    );
  }
}

function validateState(state: ExternalPluginsState): ExternalPluginsState {
  for (const [id, lock] of Object.entries(state.plugins)) {
    if (lock.descriptor.id !== id) {
      throw new FrameworkError(`external plugin lock key '${id}' does not match its descriptor id`);
    }
    if (digestDescriptor(lock.descriptor) !== lock.descriptor_digest) {
      throw new FrameworkError(
        `external plugin descriptor lock for '${id}' failed digest verification`,
      );
    }
    if (lock.observation) validateObservation(lock, lock.observation);
  }
  return state;
}

export async function loadExternalPluginsState(root: string): Promise<ExternalPluginsState | null> {
  await loadManifest(root);
  const file = externalPluginsStatePath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return validateState(externalPluginsStateSchema.parse(JSON.parse(text)));
  } catch (error) {
    throw new InvalidManifestError(file, "Assay external plugin state failed validation.", {
      cause: error,
    });
  }
}

async function saveExternalPluginsState(
  root: string,
  state: ExternalPluginsState,
  now: Date,
): Promise<ExternalPluginsState> {
  await requireWorkspace(root);
  const next = validateState(
    externalPluginsStateSchema.parse({ ...state, updated_at: nowIso(now) }),
  );
  const file = externalPluginsStatePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifySortedJson(next), "utf8");
  return next;
}

async function requireWorkspace(root: string): Promise<void> {
  if (!(await loadManifest(root))) {
    throw new FrameworkNotFoundError(`No framework manifest found under ${root}.`);
  }
}

async function readJsonFile(fileValue: string): Promise<unknown> {
  const file = path.resolve(fileValue);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FrameworkError(`invalid JSON in external plugin record: ${file}`);
    }
    throw error;
  }
}

async function registerExternalPluginUnlocked(options: {
  readonly root: string;
  readonly descriptor: unknown;
  readonly now?: Date;
}): Promise<{
  readonly root: string;
  readonly plugin: ExternalPluginStatus;
  readonly alreadyRegistered: boolean;
}> {
  const root = path.resolve(options.root);
  await requireWorkspace(root);
  let descriptor: ExternalPluginDescriptor;
  try {
    descriptor = normalizeDescriptor(externalPluginDescriptorSchema.parse(options.descriptor));
  } catch (error) {
    throw new FrameworkError("external plugin descriptor failed validation", { cause: error });
  }
  const descriptorDigest = digestDescriptor(descriptor);
  const now = options.now ?? new Date();
  const state =
    (await loadExternalPluginsState(root)) ??
    ({ __schema: 1, plugins: {}, updated_at: nowIso(now) } satisfies ExternalPluginsState);
  const existing = state.plugins[descriptor.id];
  if (existing && existing.descriptor_digest !== descriptorDigest) {
    throw new FrameworkError(
      `external plugin '${descriptor.id}' is already locked to a different descriptor; remove it before registering a replacement`,
    );
  }
  if (!existing) {
    state.plugins[descriptor.id] = {
      descriptor,
      descriptor_digest: descriptorDigest,
      enabled: true,
      registered_at: nowIso(now),
      updated_at: nowIso(now),
    };
    await saveExternalPluginsState(root, state, now);
  }
  const registered = existing ?? state.plugins[descriptor.id];
  if (!registered) throw new FrameworkError(`failed to lock external plugin '${descriptor.id}'`);
  return {
    root,
    plugin: externalStatus(registered),
    alreadyRegistered: existing !== undefined,
  };
}

export async function registerExternalPlugin(
  options: Parameters<typeof registerExternalPluginUnlocked>[0],
): ReturnType<typeof registerExternalPluginUnlocked> {
  await requireWorkspace(options.root);
  return withWorkspaceMutationCoordination(options.root, () =>
    registerExternalPluginUnlocked(options),
  );
}

export async function registerExternalPluginFromFile(options: {
  readonly root: string;
  readonly file: string;
  readonly now?: Date;
}): ReturnType<typeof registerExternalPlugin> {
  await requireWorkspace(options.root);
  return registerExternalPlugin({
    root: options.root,
    descriptor: await readJsonFile(options.file),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function observeExternalPluginUnlocked(options: {
  readonly root: string;
  readonly observation: unknown;
  readonly now?: Date;
}): Promise<{ readonly root: string; readonly plugin: ExternalPluginStatus }> {
  const root = path.resolve(options.root);
  let observation: ExternalPluginObservation;
  try {
    observation = externalPluginObservationSchema.parse(options.observation);
  } catch (error) {
    throw new FrameworkError("external plugin observation failed validation", { cause: error });
  }
  const state = await loadExternalPluginsState(root);
  const lock = state?.plugins[observation.plugin_id];
  if (!state || !lock) {
    throw new FrameworkError(`external plugin '${observation.plugin_id}' is not registered`);
  }
  validateObservation(lock, observation);
  const now = options.now ?? new Date();
  state.plugins[observation.plugin_id] = {
    ...lock,
    observation,
    updated_at: nowIso(now),
  };
  await saveExternalPluginsState(root, state, now);
  const recorded = state.plugins[observation.plugin_id];
  if (!recorded)
    throw new FrameworkError(`failed to record observation for '${observation.plugin_id}'`);
  return { root, plugin: externalStatus(recorded) };
}

export async function observeExternalPlugin(
  options: Parameters<typeof observeExternalPluginUnlocked>[0],
): ReturnType<typeof observeExternalPluginUnlocked> {
  await requireWorkspace(options.root);
  return withWorkspaceMutationCoordination(options.root, () =>
    observeExternalPluginUnlocked(options),
  );
}

export async function observeExternalPluginFromFile(options: {
  readonly root: string;
  readonly file: string;
  readonly now?: Date;
}): ReturnType<typeof observeExternalPlugin> {
  await requireWorkspace(options.root);
  return observeExternalPlugin({
    root: options.root,
    observation: await readJsonFile(options.file),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function setExternalPluginEnabledUnlocked(options: {
  readonly root: string;
  readonly plugin: string;
  readonly enabled: boolean;
  readonly now?: Date;
}): Promise<{
  readonly root: string;
  readonly plugin: ExternalPluginStatus;
  readonly changed: boolean;
}> {
  const root = path.resolve(options.root);
  const id = externalPluginId(options.plugin);
  const state = await loadExternalPluginsState(root);
  const lock = state?.plugins[id];
  if (!state || !lock) throw new FrameworkError(`external plugin '${id}' is not registered`);
  const changed = lock.enabled !== options.enabled;
  if (changed) {
    const now = options.now ?? new Date();
    state.plugins[id] = { ...lock, enabled: options.enabled, updated_at: nowIso(now) };
    await saveExternalPluginsState(root, state, now);
  }
  const recorded = state.plugins[id];
  if (!recorded) throw new FrameworkError(`external plugin '${id}' disappeared`);
  return { root, plugin: externalStatus(recorded), changed };
}

export async function setExternalPluginEnabled(
  options: Parameters<typeof setExternalPluginEnabledUnlocked>[0],
): ReturnType<typeof setExternalPluginEnabledUnlocked> {
  await requireWorkspace(options.root);
  return withWorkspaceMutationCoordination(options.root, () =>
    setExternalPluginEnabledUnlocked(options),
  );
}

async function removeExternalPluginUnlocked(options: {
  readonly root: string;
  readonly plugin: string;
  readonly now?: Date;
}): Promise<{
  readonly root: string;
  readonly plugin: string;
  readonly changed: boolean;
  readonly hostStatePreserved: true;
}> {
  const root = path.resolve(options.root);
  const id = externalPluginId(options.plugin);
  const state = await loadExternalPluginsState(root);
  if (!state?.plugins[id]) {
    return { root, plugin: id, changed: false, hostStatePreserved: true };
  }
  delete state.plugins[id];
  await saveExternalPluginsState(root, state, options.now ?? new Date());
  return { root, plugin: id, changed: true, hostStatePreserved: true };
}

export async function removeExternalPlugin(
  options: Parameters<typeof removeExternalPluginUnlocked>[0],
): ReturnType<typeof removeExternalPluginUnlocked> {
  await requireWorkspace(options.root);
  return withWorkspaceMutationCoordination(options.root, () =>
    removeExternalPluginUnlocked(options),
  );
}

function externalStatus(lock: ExternalPluginLock): ExternalPluginStatus {
  const observation = lock.observation;
  const message = !observation
    ? "descriptor verified; upstream artifact referenced; host installation/activation unobserved; Assay executes nothing"
    : `descriptor verified; host reports ${observation.installation}/${observation.activation}; Assay executes nothing`;
  return {
    id: lock.descriptor.id,
    descriptorVerification: "verified",
    descriptorDigest: lock.descriptor_digest,
    adapterVersion: lock.descriptor.adapter_version,
    payload: lock.descriptor.payload,
    provenance: lock.descriptor.provenance,
    targets: lock.descriptor.targets,
    requestedCapabilities: lock.descriptor.requests.capabilities,
    requestedScopes: lock.descriptor.requests.scopes,
    requestedSurfaces: lock.descriptor.requests.surfaces,
    stateOwnership: lock.descriptor.state_ownership,
    assayEnabled: lock.enabled,
    observedHost: observation?.host ?? null,
    observedHostVersion: observation?.host_version ?? null,
    hostInstallation: observation?.installation ?? "unobserved",
    hostActivation: observation?.activation ?? "unobserved",
    health: observation?.health ?? "unverifiable",
    executionOwner: "external-host",
    assayExecutes: false,
    observedAt: observation?.observed_at ?? null,
    message,
  };
}

export async function listExternalPlugins(
  rootValue: string,
): Promise<readonly ExternalPluginStatus[]> {
  const root = path.resolve(rootValue);
  const state = await loadExternalPluginsState(root);
  return Object.values(state?.plugins ?? {})
    .map(externalStatus)
    .sort((left, right) => compareOrdinal(left.id, right.id));
}

export async function externalPluginCheckRows(rootValue: string): Promise<
  readonly {
    readonly path: string;
    readonly status: "ok" | "warning" | "error";
    readonly message: string;
  }[]
> {
  try {
    const statuses = await listExternalPlugins(rootValue);
    return statuses.map((status) => ({
      path: EXTERNAL_PLUGINS_STATE_FILE,
      status:
        status.health === "unhealthy" ? "error" : status.health === "healthy" ? "ok" : "warning",
      message: `${status.id}: descriptor verified; payload ${status.payload.ref} referenced; host installation ${status.hostInstallation}; host activation ${status.hostActivation}; health ${status.health}; Assay executes nothing; Assay contribution ${status.assayEnabled ? "enabled" : "disabled"}`,
    }));
  } catch (error) {
    const expectedPath = path.resolve(rootValue, EXTERNAL_PLUGINS_STATE_FILE);
    if (error instanceof InvalidManifestError && path.resolve(error.path) === expectedPath) {
      return [
        {
          path: EXTERNAL_PLUGINS_STATE_FILE,
          status: "error",
          message: error.message,
        },
      ];
    }
    throw error;
  }
}

export interface CheckExternalPluginsResult {
  readonly root: string;
  readonly ok: boolean;
  readonly rows: Awaited<ReturnType<typeof externalPluginCheckRows>>;
}

export async function checkExternalPlugins(rootValue: string): Promise<CheckExternalPluginsResult> {
  const root = path.resolve(rootValue);
  const rows = await externalPluginCheckRows(root);
  return { root, ok: !rows.some((row) => row.status === "error"), rows };
}
