import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ADRS_FILE, CURRENT_VERSION, MANIFEST_FILE, PLUGINS_STATE_FILE } from "../constants.js";
import { FrameworkError, FrameworkNotFoundError, InvalidManifestError } from "../errors.js";
import { appendEvent } from "../events.js";
import {
  defaultStandaloneLayout,
  resolveWorkspaceLayout,
  workspaceTemplateRelativePath,
} from "../layout.js";
import { loadManifest, projectFromManifest, recordTemplate, saveManifest } from "../manifest.js";
import { relativeDisplayPath } from "../paths.js";
import {
  type Archetype,
  type CapabilityModule,
  capabilityDirectories,
  loadArchetype,
} from "../profile.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "../results.js";
import type {
  FrameworkManifest,
  PluginInstallReceipt,
  PluginsState,
  ProviderTarget,
  WorkspaceLayout,
} from "../schemas/index.js";
import { type TemplateFile, capabilityTemplates } from "../templates.js";
import { nowIso } from "../time.js";
import {
  type ProviderHealth,
  type ProviderObservation,
  type ResponsibilityStatus,
  getDecisionGovernanceStatus,
  normalizeProviderTarget,
} from "./authority.js";
import {
  EXTERNAL_PLUGIN_SPI_VERSION,
  type ExternalPluginStatus,
  externalPluginCheckRows,
  listExternalPlugins,
  loadExternalPluginsState,
  setExternalPluginEnabled,
} from "./external.js";
import {
  DECISION_GOVERNANCE_RESPONSIBILITY,
  type PluginDefinition,
  getPluginDefinition,
  listPluginDefinitions,
  pluginDeclarationFor,
  resolvePluginId,
} from "./registry.js";
import { defaultPluginsState, loadPluginsState, savePluginsState } from "./state.js";
import { removeTrellisHook } from "./trellis-hooks.js";
import { initializeTrellisRuntime, probeTrellisRuntime } from "./trellis-runtime.js";
import {
  type VerifiedRemoveReceipt,
  atomicWriteJson,
  listSafeFiles,
  prepareVerifiedRemove,
  safeTrellisPath,
  verifiedRemove,
  withTrellisLock,
} from "./trellis-storage.js";

export type PluginDesiredSource =
  | "manifest"
  | "archetype"
  | "legacy-capability"
  | "external-descriptor";
export type PluginReconcileAction = "install" | "adopt" | "repair" | "refresh" | "noop" | "blocked";

export interface PluginReconcileEntry {
  readonly id: string;
  readonly kind: string;
  readonly desiredSources: readonly PluginDesiredSource[];
  readonly action: PluginReconcileAction;
  readonly missingPaths: readonly string[];
  readonly health: ProviderHealth;
  readonly observations: ProviderObservation | null;
  readonly message: string;
}

export interface ReconcilePluginsOptions {
  readonly root: string;
  /** Apply the plan. Omitted or false means a write-free preview. */
  readonly apply?: boolean;
  /** Limit the plan to plugins already desired by this workspace. */
  readonly plugins?: readonly string[];
  readonly now?: Date;
}

export interface ReconcilePluginsResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly plugins: readonly PluginReconcileEntry[];
  readonly report: OperationReport;
  readonly eventFile?: string;
}

export interface AddPluginOptions {
  readonly root: string;
  readonly plugin: string;
  readonly target?: ProviderTarget;
  readonly now?: Date;
}

export interface AddPluginResult extends ReconcilePluginsResult {
  readonly plugin: string;
  readonly alreadyDeclared: boolean;
}

export interface RemovePluginResult {
  readonly root: string;
  readonly plugin: string;
  readonly mode: "disable" | "uninstall";
  readonly changed: boolean;
  readonly hookRemoved: boolean;
  readonly dataPreserved: boolean;
  readonly purgeReceipt?: string;
  readonly eventFile?: string;
}

export interface PluginStatus {
  readonly id: string;
  readonly kind: string;
  readonly supported: boolean;
  readonly desired: boolean;
  readonly installed: boolean;
  readonly protocolVersion: number | null;
  readonly stateVersion: number | null;
  readonly healthy: boolean;
  readonly health: ProviderHealth;
  readonly contributedCapabilities: readonly string[];
  readonly runtimeCapabilities: readonly string[];
  readonly operationalResponsibilities: readonly string[];
  readonly providedResponsibilities: readonly string[];
  readonly activeResponsibilities: readonly string[];
  readonly missingPaths: readonly string[];
  readonly observations: ProviderObservation | null;
  readonly desiredSources: readonly PluginDesiredSource[];
  readonly action: PluginReconcileAction | "available" | "orphan" | "disabled";
  readonly message: string;
  /** Present only for descriptor-only plugins operated by an external host. */
  readonly external?: ExternalPluginStatus;
}

export interface ListPluginsResult {
  readonly root: string;
  readonly project: string;
  readonly plugins: readonly PluginStatus[];
  readonly responsibilities: readonly ResponsibilityStatus[];
}

export interface CheckPluginsResult {
  readonly root: string;
  readonly ok: boolean;
  readonly rows: readonly CheckRow[];
}

interface DesiredPlugin {
  readonly id: string;
  readonly sources: Set<PluginDesiredSource>;
  readonly declaredKind?: string;
}

interface PluginScaffold {
  readonly directories: readonly string[];
  readonly templates: readonly TemplateFile[];
}

interface ReconcileContext {
  readonly manifest: FrameworkManifest;
  readonly state: PluginsState | null;
  readonly entries: readonly PluginReconcileEntry[];
  readonly scaffolds: ReadonlyMap<string, PluginScaffold>;
  readonly observations: ReadonlyMap<string, ProviderObservation>;
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

function requireManifest(manifest: FrameworkManifest | null, root: string): FrameworkManifest {
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}. Run init or attach first.`,
    );
  }
  return manifest;
}

function layoutForManifest(manifest: FrameworkManifest): WorkspaceLayout {
  return resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
}

function desiredPlugins(
  manifest: FrameworkManifest,
  archetypeModules: readonly CapabilityModule[],
): Map<string, DesiredPlugin> {
  const desired = new Map<string, DesiredPlugin>();
  const add = (id: string, source: PluginDesiredSource, declaredKind?: string): void => {
    const current = desired.get(id);
    if (current) {
      current.sources.add(source);
      return;
    }
    desired.set(id, {
      id,
      sources: new Set([source]),
      ...(declaredKind === undefined ? {} : { declaredKind }),
    });
  };

  for (const [id, declaration] of Object.entries(manifest.plugins ?? {})) {
    if (declaration.enabled === false) continue;
    add(id, "manifest", declaration.kind);
  }

  const legacyCapabilities = new Set([
    ...archetypeModules,
    ...(manifest.project.capabilities ?? []),
  ]);
  for (const plugin of listPluginDefinitions()) {
    for (const capability of plugin.legacyCapabilities) {
      if (legacyCapabilities.has(capability)) {
        add(
          plugin.id,
          archetypeModules.includes(capability as CapabilityModule)
            ? "archetype"
            : "legacy-capability",
        );
      }
    }
  }
  return desired;
}

async function pluginScaffold(
  root: string,
  manifest: FrameworkManifest,
  plugin: PluginDefinition,
): Promise<PluginScaffold> {
  const archetype = await loadArchetype(manifest.project.archetype, { root });
  const layout = layoutForManifest(manifest);
  const capabilities = plugin.legacyCapabilities.filter(
    (value): value is CapabilityModule => value === "intent",
  );
  return {
    directories: capabilityDirectories(capabilities).map((directory) =>
      workspaceTemplateRelativePath(layout, directory.path),
    ),
    templates: capabilityTemplates(
      projectFromManifest(manifest, root),
      manifest.project.mode,
      archetype,
      capabilities,
      layout,
    ),
  };
}

async function inspectPluginEntry(
  root: string,
  desired: DesiredPlugin,
  state: PluginsState | null,
  manifest: FrameworkManifest,
): Promise<{ readonly entry: PluginReconcileEntry; readonly scaffold?: PluginScaffold }> {
  const plugin = getPluginDefinition(desired.id);
  const sources = [...desired.sources].sort();
  if (!plugin) {
    return {
      entry: {
        id: desired.id,
        kind: desired.declaredKind ?? "unknown",
        desiredSources: sources,
        action: "blocked",
        missingPaths: [],
        health: "not-checked",
        observations: null,
        message: "plugin is declared but this Assay build does not provide it",
      },
    };
  }
  if (desired.declaredKind !== undefined && desired.declaredKind !== plugin.kind) {
    const migratesLegacyTrellis =
      plugin.id === "assay.trellis" && desired.declaredKind === "federated-provider";
    if (migratesLegacyTrellis) {
      // Continue below. Reconcile v1 federated declarations into the built-in
      // workspace runtime without reading or modifying the old `.trellis` sidecar.
    } else {
      return {
        entry: {
          id: plugin.id,
          kind: desired.declaredKind,
          desiredSources: sources,
          action: "blocked",
          missingPaths: [],
          health: "not-checked",
          observations: null,
          message: `declared kind '${desired.declaredKind}' does not match built-in kind '${plugin.kind}'`,
        },
      };
    }
  }

  const receipt = state?.plugins[plugin.id];
  if (receipt && receipt.kind !== plugin.kind) {
    const migratesLegacyTrellis =
      plugin.id === "assay.trellis" && receipt.kind === "federated-provider";
    if (!migratesLegacyTrellis) {
      return {
        entry: {
          id: plugin.id,
          kind: plugin.kind,
          desiredSources: sources,
          action: "blocked",
          missingPaths: [],
          health: "not-checked",
          observations: null,
          message: `installed receipt kind '${receipt.kind}' does not match '${plugin.kind}'`,
        },
      };
    }
  }
  if (receipt && receipt.state_version > plugin.stateVersion) {
    return {
      entry: {
        id: plugin.id,
        kind: plugin.kind,
        desiredSources: sources,
        action: "blocked",
        missingPaths: [],
        health: "not-checked",
        observations: null,
        message: `installed state version ${receipt.state_version} is newer than supported version ${plugin.stateVersion}`,
      },
    };
  }

  if (plugin.installStrategy === "workspace-runtime") {
    const probe = await probeTrellisRuntime(root);
    const legacyDeclaration = desired.declaredKind === "federated-provider";
    const legacyReceipt = receipt?.kind === "federated-provider";
    const action: PluginReconcileAction =
      legacyDeclaration || legacyReceipt || (receipt && receipt.state_version < plugin.stateVersion)
        ? "repair"
        : probe.health === "unhealthy"
          ? receipt
            ? "repair"
            : "install"
          : receipt
            ? "noop"
            : "adopt";
    return {
      entry: {
        id: plugin.id,
        kind: plugin.kind,
        desiredSources: sources,
        action,
        missingPaths: probe.missingPaths,
        health: probe.health,
        observations: null,
        message:
          legacyDeclaration || legacyReceipt
            ? "migrate legacy federated assay.trellis metadata to the built-in workspace runtime"
            : action === "noop"
              ? "desired state, install receipt, and workspace runtime agree"
              : action === "adopt"
                ? "existing assay.trellis runtime can be adopted without rewriting it"
                : action === "install"
                  ? "assay.trellis runtime is desired but not installed"
                  : probe.message,
      },
    };
  }

  const scaffold = await pluginScaffold(root, manifest, plugin);
  const expectedPaths = [
    ...scaffold.directories,
    ...scaffold.templates.map((template) => template.path),
  ];
  const presence = await Promise.all(
    expectedPaths.map(async (relativePath) => ({
      relativePath,
      present: await exists(path.join(root, relativePath)),
    })),
  );
  const missingPaths = presence.filter((item) => !item.present).map((item) => item.relativePath);
  const presentCount = presence.length - missingPaths.length;

  let action: PluginReconcileAction;
  let message: string;
  if (missingPaths.length > 0) {
    action = receipt || presentCount > 0 ? "repair" : "install";
    message =
      action === "repair" ? "plugin scaffold is incomplete" : "plugin is desired but not installed";
  } else if (!receipt) {
    action = "adopt";
    message = "existing scaffold can be adopted without rewriting it";
  } else if (receipt.state_version < plugin.stateVersion) {
    action = "repair";
    message = `installed state version ${receipt.state_version} needs upgrade to ${plugin.stateVersion}`;
  } else {
    action = "noop";
    message = "desired state, install receipt, and scaffold agree";
  }

  return {
    entry: {
      id: plugin.id,
      kind: plugin.kind,
      desiredSources: sources,
      action,
      missingPaths,
      health: action === "noop" || action === "adopt" ? "healthy" : "unhealthy",
      observations: null,
      message,
    },
    scaffold,
  };
}

async function inspectReconcile(
  root: string,
  manifest: FrameworkManifest,
  filter: readonly string[] | undefined,
): Promise<ReconcileContext> {
  const archetype = await loadArchetype(manifest.project.archetype, { root });
  const desired = desiredPlugins(manifest, archetype.modules);
  const selectedIds =
    filter === undefined
      ? [...desired.keys()]
      : [...new Set(filter.map((value) => resolvePluginId(value)))];

  for (const id of selectedIds) {
    if (!desired.has(id)) {
      throw new FrameworkError(
        `plugin '${id}' is not desired by this workspace; add it with \`assay plugin add ${id}\` first`,
      );
    }
  }

  const state = await loadPluginsState(root);
  const entries: PluginReconcileEntry[] = [];
  const scaffolds = new Map<string, PluginScaffold>();
  const observations = new Map<string, ProviderObservation>();
  for (const id of selectedIds.sort()) {
    const desiredPlugin = desired.get(id);
    if (!desiredPlugin) {
      throw new FrameworkError(`plugin '${id}' is not desired by this workspace`);
    }
    const inspected = await inspectPluginEntry(root, desiredPlugin, state, manifest);
    entries.push(inspected.entry);
    if (inspected.scaffold) {
      scaffolds.set(id, inspected.scaffold);
    }
    if (inspected.entry.observations) {
      observations.set(id, inspected.entry.observations);
    }
  }
  return { manifest, state, entries, scaffolds, observations };
}

async function ensureDirectory(
  root: string,
  relativePath: string,
  report: OperationReport,
): Promise<void> {
  const target = path.join(root, relativePath);
  if (await exists(target)) {
    report.existing_dirs.push(relativePath);
    return;
  }
  await mkdir(target, { recursive: true });
  report.created_dirs.push(relativePath);
}

async function ensureTemplate(
  root: string,
  manifest: FrameworkManifest,
  template: TemplateFile,
  report: OperationReport,
): Promise<boolean> {
  const target = path.join(root, template.path);
  if (await exists(target)) {
    report.skipped_files.push(template.path);
    return false;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, template.content, "utf8");
  if (template.executable) {
    const mode = (await stat(target)).mode;
    await chmod(target, mode | 0o755);
  }
  recordTemplate(manifest, template);
  report.created_files.push(template.path);
  return true;
}

function nextReceipt(
  plugin: PluginDefinition,
  previous: PluginInstallReceipt | undefined,
  now: Date,
  observations?: ProviderObservation,
): PluginInstallReceipt {
  const timestamp = nowIso(now);
  return {
    kind: plugin.kind,
    state_version: plugin.stateVersion,
    installed_at: previous?.installed_at ?? timestamp,
    updated_at: timestamp,
    ...(observations ? { observations: { ...observations } } : {}),
  };
}

async function applyReconcileContext(
  root: string,
  context: ReconcileContext,
  now: Date,
  event: "plugins.reconciled" | "plugin.added",
  forceManifestSave = false,
): Promise<Omit<ReconcilePluginsResult, "dryRun">> {
  const report = createEmptyReport();
  const blocked = context.entries.filter((entry) => entry.action === "blocked");
  if (blocked.length > 0) {
    throw new FrameworkError(
      `plugin reconcile blocked: ${blocked.map((entry) => `${entry.id}: ${entry.message}`).join("; ")}`,
      { details: blocked },
    );
  }

  const changed = context.entries.filter((entry) => entry.action !== "noop");
  if (changed.length === 0 && !forceManifestSave) {
    return { root, plugins: context.entries, report };
  }

  let manifestChanged = forceManifestSave;
  const nextState = context.state ?? defaultPluginsState(now);
  for (const entry of changed) {
    const definition = getPluginDefinition(entry.id);
    if (!definition) {
      throw new FrameworkError(`plugin '${entry.id}' is not provided by this Assay build`);
    }
    const scaffold = context.scaffolds.get(entry.id);
    if ((entry.action === "install" || entry.action === "repair") && scaffold) {
      for (const directory of scaffold.directories) {
        await ensureDirectory(root, directory, report);
      }
      for (const template of scaffold.templates) {
        manifestChanged =
          (await ensureTemplate(root, context.manifest, template, report)) || manifestChanged;
      }
    }
    if (definition.installStrategy === "workspace-runtime") {
      const initialized = await initializeTrellisRuntime(root, now);
      report.created_dirs.push(...initialized.createdDirs);
      report.created_files.push(...initialized.createdFiles);
      if (context.manifest.plugins?.[entry.id]?.kind !== definition.kind) {
        context.manifest.plugins = {
          ...(context.manifest.plugins ?? {}),
          [entry.id]: { kind: definition.kind },
        };
        manifestChanged = true;
      }
      const legacyBinding = context.manifest.bindings?.[DECISION_GOVERNANCE_RESPONSIBILITY];
      if (legacyBinding?.provider === entry.id) {
        const nextBindings = { ...(context.manifest.bindings ?? {}) };
        Reflect.deleteProperty(nextBindings, DECISION_GOVERNANCE_RESPONSIBILITY);
        if (Object.keys(nextBindings).length === 0) {
          Reflect.deleteProperty(context.manifest, "bindings");
        } else {
          context.manifest.bindings = nextBindings;
        }
        manifestChanged = true;
        report.notes.push(
          "removed legacy assay.trellis decision-governance binding; Assay native ADR and intent remain active",
        );
      }
    }
    nextState.plugins[entry.id] = nextReceipt(
      definition,
      context.state?.plugins[entry.id],
      now,
      context.observations.get(entry.id),
    );
  }

  if (manifestChanged) {
    context.manifest.framework_version = CURRENT_VERSION;
    await saveManifest(root, context.manifest);
    report.updated_files.push(MANIFEST_FILE);
  }
  if (changed.length > 0) {
    await savePluginsState(root, nextState, now);
    (context.state ? report.updated_files : report.created_files).push(PLUGINS_STATE_FILE);
  }

  const eventFile = await appendEvent(
    root,
    {
      event,
      plugins: changed.map((entry) => ({ id: entry.id, action: entry.action })),
    },
    now,
  );
  return {
    root,
    plugins: context.entries,
    report,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function reconcilePlugins(
  options: ReconcilePluginsOptions,
): Promise<ReconcilePluginsResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const context = await inspectReconcile(root, manifest, options.plugins);
  if (!options.apply) {
    const report = createEmptyReport();
    report.notes.push("dry-run: no changes applied");
    return { root, dryRun: true, plugins: context.entries, report };
  }
  return {
    ...(await applyReconcileContext(
      root,
      context,
      options.now ?? new Date(),
      "plugins.reconciled",
    )),
    dryRun: false,
  };
}

export async function addPlugin(options: AddPluginOptions): Promise<AddPluginResult> {
  const root = path.resolve(options.root);
  const manifest = requireManifest(await loadManifest(root), root);
  const { id, declaration } = pluginDeclarationFor(options.plugin);
  const definition = getPluginDefinition(id);
  if (!definition) {
    throw new FrameworkError(`plugin '${id}' is not provided by this Assay build`);
  }
  const existing = manifest.plugins?.[id];
  if (existing && existing.kind !== declaration.kind) {
    const migratesLegacyTrellis = id === "assay.trellis" && existing.kind === "federated-provider";
    if (!migratesLegacyTrellis) {
      throw new FrameworkError(
        `plugin '${id}' is already declared with kind '${existing.kind}', expected '${declaration.kind}'`,
      );
    }
  }

  const alreadyDeclared = existing !== undefined;
  const declarationChanged = existing?.kind !== declaration.kind || existing.enabled === false;
  let bindingChanged = false;
  if (!alreadyDeclared || declarationChanged) {
    manifest.plugins = { ...(manifest.plugins ?? {}), [id]: declaration };
  }
  const responsibility = definition.providedResponsibilities[0];
  if (options.target && !responsibility) {
    throw new FrameworkError(`plugin '${id}' does not accept a provider target`);
  }
  if (responsibility) {
    const existingBinding = manifest.bindings?.[responsibility];
    const requestedTargetValue =
      options.target ?? existingBinding?.target ?? ({ kind: "workspace" } as const);
    const requestedTarget = await normalizeProviderTarget(root, requestedTargetValue);
    if (existingBinding && existingBinding.provider !== id) {
      throw new FrameworkError(
        `responsibility '${responsibility}' is already bound to '${existingBinding.provider}'`,
      );
    }
    if (
      existingBinding &&
      JSON.stringify(existingBinding.target) !== JSON.stringify(requestedTarget)
    ) {
      throw new FrameworkError(
        `responsibility '${responsibility}' is already bound to a different target`,
      );
    }
    if (!existingBinding) {
      manifest.bindings = {
        ...(manifest.bindings ?? {}),
        [responsibility]: { provider: id, target: requestedTarget },
      };
      bindingChanged = true;
    }
  }

  const context = await inspectReconcile(root, manifest, [id]);
  const blocked = context.entries.filter((entry) => entry.action === "blocked");
  if (blocked.length > 0) {
    throw new FrameworkError(`plugin add blocked: ${blocked[0]?.message ?? "unknown blocker"}`, {
      details: blocked,
    });
  }
  const applied = await applyReconcileContext(
    root,
    context,
    options.now ?? new Date(),
    "plugin.added",
    !alreadyDeclared || declarationChanged || bindingChanged,
  );
  if (
    bindingChanged &&
    (await exists(path.join(root, ADRS_FILE))) &&
    !applied.report.notes.some((note) => note.includes("inactive Assay-native decision archive"))
  ) {
    applied.report.notes.push(
      `${ADRS_FILE} preserved as an inactive Assay-native decision archive`,
    );
  }
  if (
    (!alreadyDeclared || declarationChanged) &&
    !applied.report.updated_files.includes(MANIFEST_FILE)
  ) {
    applied.report.updated_files.push(MANIFEST_FILE);
  }
  return {
    ...applied,
    dryRun: false,
    plugin: id,
    alreadyDeclared,
  };
}

export async function removePlugin(options: {
  readonly root: string;
  readonly plugin: string;
  readonly mode: "disable" | "uninstall";
  readonly purge?: boolean;
  readonly yes?: boolean;
  readonly now?: Date;
}): Promise<RemovePluginResult> {
  const root = path.resolve(options.root);
  const id = resolvePluginId(options.plugin);
  if (id !== "assay.trellis") {
    const external = (await loadExternalPluginsState(root))?.plugins[id];
    if (external && options.mode === "disable" && !options.purge) {
      const result = await setExternalPluginEnabled({
        root,
        plugin: id,
        enabled: false,
        ...(options.now ? { now: options.now } : {}),
      });
      return {
        root,
        plugin: id,
        mode: "disable",
        changed: result.changed,
        hookRemoved: false,
        dataPreserved: true,
      };
    }
    throw new FrameworkError("plugin disable/uninstall currently supports assay.trellis only");
  }
  if (options.mode === "disable" && options.purge) {
    throw new FrameworkError("plugin disable preserves runtime data; use uninstall --purge");
  }
  if (options.purge && !options.yes) {
    throw new FrameworkError("purging assay.trellis data requires both --purge and --yes");
  }
  const lifecyclePath = ".assay/plugin-lifecycle/assay.trellis.json";
  type LifecycleRecord = {
    __schema: 1;
    operation_id: string;
    mode: "disable" | "uninstall";
    purge: boolean;
    phase: "prepared" | "control-committed" | "completed";
    backup_root: string | null;
    purge_receipt: string | null;
    runtime_delete: VerifiedRemoveReceipt | null;
    updated_at: string;
  };
  let lifecycle: LifecycleRecord | null = null;
  try {
    lifecycle = JSON.parse(
      await readFile(await safeTrellisPath(root, lifecyclePath, false), "utf8"),
    ) as LifecycleRecord;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const beforeManifest = requireManifest(await loadManifest(root), root);
  const beforeState = await loadPluginsState(root);
  const declared = beforeManifest.plugins?.[id] !== undefined;
  const receipted = beforeState?.plugins[id] !== undefined;
  const alreadyAtDesiredControlState =
    options.mode === "disable" ? declared && !receipted : !declared && !receipted;
  if (
    lifecycle &&
    lifecycle.phase !== "completed" &&
    (lifecycle.mode !== options.mode || lifecycle.purge !== (options.purge === true))
  ) {
    throw new FrameworkError("a different assay.trellis lifecycle operation needs recovery first");
  }
  const recoveringLifecycle = lifecycle?.phase !== "completed" ? lifecycle : null;
  if (recoveringLifecycle && alreadyAtDesiredControlState) {
    if (recoveringLifecycle.purge) {
      if (
        !recoveringLifecycle.purge_receipt ||
        !(await exists(path.join(root, recoveringLifecycle.purge_receipt)))
      ) {
        throw new FrameworkError(
          "assay.trellis purge recovery is missing its validated backup receipt",
        );
      }
      if (!recoveringLifecycle.runtime_delete)
        throw new FrameworkError("assay.trellis purge recovery is missing its removal receipt");
      await verifiedRemove(root, recoveringLifecycle.runtime_delete, { recursive: true });
    }
    lifecycle = {
      ...recoveringLifecycle,
      phase: "completed",
      updated_at: nowIso(options.now ?? new Date()),
    };
    await atomicWriteJson(root, lifecyclePath, lifecycle);
    return {
      root,
      plugin: id,
      mode: options.mode,
      changed: true,
      hookRemoved: false,
      dataPreserved: !lifecycle.purge,
      ...(lifecycle.purge_receipt ? { purgeReceipt: lifecycle.purge_receipt } : {}),
    };
  }
  if (alreadyAtDesiredControlState || (!declared && !receipted)) {
    return {
      root,
      plugin: id,
      mode: options.mode,
      changed: false,
      hookRemoved: false,
      dataPreserved: true,
    };
  }
  const timestamp = nowIso(options.now ?? new Date()).replaceAll(":", "-");
  const activeLifecycle = lifecycle?.phase === "completed" ? null : lifecycle;
  const backupRoot = options.purge
    ? (activeLifecycle?.backup_root ?? `.assay/backups/assay-trellis-${timestamp}`)
    : null;
  let preparedLifecycle: LifecycleRecord = {
    __schema: 1,
    operation_id: activeLifecycle?.operation_id ?? `${process.pid}-${timestamp}`,
    mode: options.mode,
    purge: options.purge === true,
    phase: "prepared",
    backup_root: backupRoot,
    purge_receipt: activeLifecycle?.purge_receipt ?? null,
    runtime_delete: activeLifecycle?.runtime_delete ?? null,
    updated_at: nowIso(options.now ?? new Date()),
  };
  lifecycle = preparedLifecycle;
  await atomicWriteJson(root, lifecyclePath, preparedLifecycle);
  let hookRemoved = false;
  if (receipted) {
    try {
      hookRemoved = (await removeTrellisHook({ root, host: "codex", allowMissingOwned: true }))
        .removed;
    } catch (error) {
      if (!(error instanceof FrameworkError && /not installed/.test(error.message))) throw error;
    }
  }
  const result = await withTrellisLock(root, async () => {
    const manifest = requireManifest(await loadManifest(root), root);
    const state = (await loadPluginsState(root)) ?? defaultPluginsState(options.now ?? new Date());
    if (options.mode === "disable" && manifest.plugins?.[id]) {
      manifest.plugins = {
        ...manifest.plugins,
        [id]: { ...manifest.plugins[id], enabled: false },
      };
    } else if (options.mode === "uninstall" && manifest.plugins) {
      const plugins = { ...manifest.plugins };
      delete plugins[id];
      if (Object.keys(plugins).length) manifest.plugins = plugins;
      else Reflect.deleteProperty(manifest, "plugins");
    }
    delete state.plugins[id];
    let purgeReceipt: string | undefined;
    if (options.purge) {
      if (!backupRoot) throw new FrameworkError("purge backup root was not prepared");
      const files = (await listSafeFiles(root, ".assay/trellis")).filter(
        (relative) => relative !== ".assay/trellis/.lock",
      );
      const hashes: Record<string, string> = {};
      const { createHash } = await import("node:crypto");
      for (const relative of files) {
        const targetRelative = `${backupRoot}/data/${path.relative(".assay/trellis", relative).replaceAll("\\", "/")}`;
        const content = await readFile(await safeTrellisPath(root, relative, false));
        hashes[relative] = createHash("sha256").update(content).digest("hex");
        await mkdir(path.dirname(await safeTrellisPath(root, targetRelative)), { recursive: true });
        const target = await safeTrellisPath(root, targetRelative);
        try {
          await writeFile(target, content, { flag: "wx" });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          const existing = await readFile(target);
          if (!existing.equals(content))
            throw new FrameworkError(`purge backup conflict: ${targetRelative}`);
        }
        const copied = await readFile(target);
        if (createHash("sha256").update(copied).digest("hex") !== hashes[relative]) {
          throw new FrameworkError(`purge backup verification failed: ${targetRelative}`);
        }
      }
      purgeReceipt = `${backupRoot}/receipt.json`;
      await atomicWriteJson(root, purgeReceipt, {
        __schema: 1,
        plugin: id,
        backed_up_at: nowIso(options.now ?? new Date()),
        files: hashes,
        data_root: ".assay/trellis",
      });
      await atomicWriteJson(root, `${backupRoot}/control-before.json`, {
        __schema: 1,
        manifest: beforeManifest,
        plugins_state: beforeState,
      });
      preparedLifecycle = {
        ...preparedLifecycle,
        purge_receipt: purgeReceipt,
        runtime_delete:
          preparedLifecycle.runtime_delete ??
          (await prepareVerifiedRemove(root, ".assay/trellis", preparedLifecycle.operation_id)),
        updated_at: nowIso(options.now ?? new Date()),
      };
      lifecycle = preparedLifecycle;
      await atomicWriteJson(root, lifecyclePath, preparedLifecycle);
    }
    await saveManifest(root, manifest);
    await savePluginsState(root, state, options.now ?? new Date());
    const eventFile = await appendEvent(
      root,
      {
        event: `plugin.${options.mode}`,
        plugin: id,
        purge: options.purge === true,
        hook_removed: hookRemoved,
      },
      options.now ?? new Date(),
    );
    preparedLifecycle = {
      ...preparedLifecycle,
      phase: "control-committed",
      updated_at: nowIso(options.now ?? new Date()),
    };
    lifecycle = preparedLifecycle;
    await atomicWriteJson(root, lifecyclePath, preparedLifecycle);
    return {
      root,
      plugin: id,
      mode: options.mode,
      changed: true,
      hookRemoved,
      dataPreserved: !options.purge,
      ...(purgeReceipt ? { purgeReceipt } : {}),
      eventFile: relativeDisplayPath(eventFile, root),
    };
  });
  if (options.purge) {
    // The declaration and receipt are gone, so new runtime mutations fail closed.
    // Delete only after releasing the runtime lock (Windows cannot remove an open lock file).
    if (!preparedLifecycle.runtime_delete)
      throw new FrameworkError("assay.trellis purge removal receipt was not prepared");
    await verifiedRemove(root, preparedLifecycle.runtime_delete, { recursive: true });
  }
  lifecycle = {
    ...preparedLifecycle,
    phase: "completed",
    updated_at: nowIso(options.now ?? new Date()),
  };
  await atomicWriteJson(root, lifecyclePath, lifecycle);
  return result;
}

async function statusForWorkspace(root: string): Promise<{
  readonly manifest: FrameworkManifest;
  readonly statuses: PluginStatus[];
  readonly responsibilities: ResponsibilityStatus[];
}> {
  const manifest = requireManifest(await loadManifest(root), root);
  const decisionStatus = await getDecisionGovernanceStatus(root, manifest);
  let archetype: Archetype;
  try {
    archetype = await loadArchetype(manifest.project.archetype, { root });
  } catch (error) {
    // `checkFramework` already degrades an unavailable/removed archetype to a
    // warning. Do not turn that same condition into a plugin-state error when
    // the workspace has no explicit plugin or legacy capability declaration.
    // Orphan receipts remain visible because they do not need archetype
    // templates to be inspected.
    if (desiredPlugins(manifest, []).size > 0) {
      throw error;
    }
    const state = await loadPluginsState(root);
    const ids = new Set([
      ...listPluginDefinitions().map((plugin) => plugin.id),
      ...Object.keys(state?.plugins ?? {}),
    ]);
    return {
      manifest,
      statuses: [...ids].sort().map((id): PluginStatus => {
        const definition = getPluginDefinition(id);
        const receipt = state?.plugins[id];
        return {
          id,
          kind: definition?.kind ?? receipt?.kind ?? "unknown",
          supported: definition !== null,
          desired: false,
          installed: receipt !== undefined,
          protocolVersion: definition?.protocolVersion ?? null,
          stateVersion: definition?.stateVersion ?? receipt?.state_version ?? null,
          healthy: receipt === undefined,
          health: receipt === undefined ? "not-checked" : "unhealthy",
          contributedCapabilities: definition?.contributedCapabilities ?? [],
          runtimeCapabilities: definition?.runtimeCapabilities ?? [],
          operationalResponsibilities: definition?.operationalResponsibilities ?? [],
          providedResponsibilities: definition?.providedResponsibilities ?? [],
          activeResponsibilities: [],
          missingPaths: [],
          observations: null,
          desiredSources: [],
          action: receipt ? "orphan" : "available",
          message: receipt
            ? "install receipt exists but the plugin is no longer desired; removal is not automatic"
            : "plugin is available but not desired",
        };
      }),
      responsibilities: [decisionStatus],
    };
  }
  const desired = desiredPlugins(manifest, archetype.modules);
  const context = await inspectReconcile(root, manifest, undefined);
  const state = context.state;
  const entries = new Map(context.entries.map((entry) => [entry.id, entry]));
  const ids = new Set([
    ...listPluginDefinitions().map((plugin) => plugin.id),
    ...desired.keys(),
    ...Object.keys(state?.plugins ?? {}),
  ]);

  const statuses: PluginStatus[] = [];
  for (const id of [...ids].sort()) {
    const definition = getPluginDefinition(id);
    const entry = entries.get(id);
    const receipt = state?.plugins[id];
    const isDesired = desired.has(id);
    const action = !isDesired ? (receipt ? "orphan" : "available") : (entry?.action ?? "noop");
    const healthy =
      action === "noop" || action === "adopt" || action === "refresh" || action === "available";
    const health: ProviderHealth =
      entry?.health ?? (action === "available" ? "not-checked" : "unhealthy");
    const activeResponsibilities =
      decisionStatus.activeProvider === id ? [DECISION_GOVERNANCE_RESPONSIBILITY] : [];
    statuses.push({
      id,
      kind: definition?.kind ?? receipt?.kind ?? manifest.plugins?.[id]?.kind ?? "unknown",
      supported: definition !== null,
      desired: isDesired,
      installed: receipt !== undefined,
      protocolVersion: definition?.protocolVersion ?? null,
      stateVersion: definition?.stateVersion ?? receipt?.state_version ?? null,
      healthy,
      health,
      contributedCapabilities: definition?.contributedCapabilities ?? [],
      runtimeCapabilities: definition?.runtimeCapabilities ?? [],
      operationalResponsibilities: definition?.operationalResponsibilities ?? [],
      providedResponsibilities: definition?.providedResponsibilities ?? [],
      activeResponsibilities,
      missingPaths: entry?.missingPaths ?? [],
      observations: entry?.observations ?? null,
      desiredSources: entry?.desiredSources ?? [],
      action,
      message:
        action === "orphan"
          ? "install receipt exists but the plugin is no longer desired; removal is not automatic"
          : (entry?.message ?? "plugin is available but not desired"),
    });
  }
  return { manifest, statuses, responsibilities: [decisionStatus] };
}

export async function listPlugins(rootValue: string): Promise<ListPluginsResult> {
  const root = path.resolve(rootValue);
  const { manifest, statuses, responsibilities } = await statusForWorkspace(root);
  const externalStatuses = await listExternalPlugins(root);
  return {
    root,
    project: manifest.project.name,
    plugins: [
      ...statuses,
      ...externalStatuses.map(
        (external): PluginStatus => ({
          id: external.id,
          kind: "external-descriptor",
          supported: true,
          desired: external.assayEnabled,
          installed: false,
          protocolVersion: EXTERNAL_PLUGIN_SPI_VERSION,
          stateVersion: 1,
          healthy: external.health === "healthy",
          health: external.health,
          contributedCapabilities: [],
          runtimeCapabilities: [],
          operationalResponsibilities: [],
          providedResponsibilities: [],
          activeResponsibilities: [],
          missingPaths: [],
          observations: null,
          desiredSources: external.assayEnabled ? ["external-descriptor"] : [],
          action: external.assayEnabled ? "noop" : "disabled",
          message: external.message,
          external,
        }),
      ),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    responsibilities,
  };
}

export async function checkPlugins(rootValue: string): Promise<CheckPluginsResult> {
  const root = path.resolve(rootValue);
  const rows = await collectPluginCheckRows(root);
  return {
    root,
    ok: !rows.some((row) => row.status === "missing" || row.status === "error"),
    rows,
  };
}

export async function collectPluginCheckRows(rootValue: string): Promise<CheckRow[]> {
  const root = path.resolve(rootValue);
  try {
    const { statuses, responsibilities } = await statusForWorkspace(root);
    const rows = statuses
      .filter((status) => status.desired || status.installed)
      .map((status): CheckRow => {
        if (status.action === "blocked") {
          return {
            path: PLUGINS_STATE_FILE,
            status: "error",
            message: `${status.id}: ${status.message}`,
          };
        }
        if (status.action === "install" || status.action === "repair") {
          return {
            path: status.missingPaths[0] ?? PLUGINS_STATE_FILE,
            status: "missing",
            message: `${status.id}: ${status.message}; run \`assay reconcile --apply\``,
          };
        }
        if (status.action === "adopt") {
          return {
            path: PLUGINS_STATE_FILE,
            status: "warning",
            message: `${status.id}: scaffold exists without an install receipt; run \`assay reconcile --apply\``,
          };
        }
        if (status.action === "orphan") {
          return {
            path: PLUGINS_STATE_FILE,
            status: "warning",
            message: `${status.id}: ${status.message}`,
          };
        }
        if (status.action === "refresh") {
          return {
            path: PLUGINS_STATE_FILE,
            status: "warning",
            message: `${status.id}: ${status.message}; run \`assay reconcile --apply\``,
          };
        }
        return {
          path: PLUGINS_STATE_FILE,
          status: "ok",
          message: `${status.id}: installed and reconciled`,
        };
      });
    for (const responsibility of responsibilities) {
      if (responsibility.configuredProvider !== null && responsibility.activeProvider === null) {
        rows.push({
          path: MANIFEST_FILE,
          status: "error",
          message: `${responsibility.id}: ${responsibility.message}`,
        });
      }
    }
    rows.push(...(await externalPluginCheckRows(root)));
    return rows;
  } catch (error) {
    return [
      {
        path:
          error instanceof InvalidManifestError
            ? relativeDisplayPath(error.path, root)
            : PLUGINS_STATE_FILE,
        status: "error",
        message: error instanceof Error ? error.message : "plugin state check failed",
      },
    ];
  }
}
