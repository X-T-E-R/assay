import { FrameworkError } from "../errors.js";
import type { FrameworkManifest, PluginDeclaration, PluginsState } from "../schemas/index.js";

export const INTENT_PLUGIN_ID = "assay.intent";
export const TRELLIS_PLUGIN_ID = "assay.trellis";

export type PluginInstallStrategy = "workspace-scaffold" | "workspace-runtime";

export interface PluginDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly kind: string;
  readonly protocolVersion: number | null;
  readonly stateVersion: number;
  readonly installStrategy: PluginInstallStrategy;
  readonly contributedCapabilities: readonly string[];
  readonly runtimeCapabilities: readonly string[];
  readonly operationalResponsibilities: readonly string[];
  readonly providedResponsibilities: readonly string[];
  readonly legacyCapabilities: readonly string[];
}

const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  {
    id: INTENT_PLUGIN_ID,
    aliases: ["intent"],
    kind: "workspace-module",
    protocolVersion: null,
    stateVersion: 1,
    installStrategy: "workspace-scaffold",
    contributedCapabilities: ["intent"],
    runtimeCapabilities: [],
    operationalResponsibilities: [],
    providedResponsibilities: [],
    legacyCapabilities: ["intent"],
  },
  {
    id: TRELLIS_PLUGIN_ID,
    aliases: ["trellis"],
    kind: "workspace-runtime",
    protocolVersion: 1,
    stateVersion: 1,
    installStrategy: "workspace-runtime",
    contributedCapabilities: [],
    runtimeCapabilities: [
      "task-store",
      "session-store",
      "journal-store",
      "runtime-config",
      "durable-channel",
      "external-worker-protocol",
      "codex-memory-reader",
      "legacy-migration",
      "context-provider",
      "host-hook-registration",
    ],
    operationalResponsibilities: [
      "task-lifecycle",
      "session-context",
      "journal",
      "channel-leases",
      "external-worker-state",
      "codex-memory-read",
      "legacy-migration",
      "codex-hook",
    ],
    providedResponsibilities: [],
    legacyCapabilities: [],
  },
];

const PLUGINS_BY_ID = new Map(BUILTIN_PLUGINS.map((plugin) => [plugin.id, plugin]));
const PLUGIN_ALIASES = new Map(
  BUILTIN_PLUGINS.flatMap((plugin) => plugin.aliases.map((alias) => [alias, plugin.id] as const)),
);

export function listPluginDefinitions(): readonly PluginDefinition[] {
  return BUILTIN_PLUGINS;
}

export function resolvePluginId(value: string): string {
  const normalized = value.trim();
  return PLUGIN_ALIASES.get(normalized) ?? normalized;
}

export function getPluginDefinition(value: string): PluginDefinition | null {
  return PLUGINS_BY_ID.get(resolvePluginId(value)) ?? null;
}

export function pluginDeclarationFor(value: string): {
  readonly id: string;
  readonly declaration: PluginDeclaration;
} {
  const plugin = getPluginDefinition(value);
  if (!plugin) {
    const supported = BUILTIN_PLUGINS.map((entry) => entry.id).join(", ");
    throw new FrameworkError(`unsupported plugin '${value}'; supported plugins: ${supported}`);
  }
  return { id: plugin.id, declaration: { kind: plugin.kind } };
}

/**
 * Capability modules supplied by explicit plugin declarations.
 *
 * This is a compatibility bridge while intent moves from the legacy
 * capability flag to `assay.intent`. Unknown plugins and kind mismatches
 * deliberately contribute nothing; plugin reconcile reports them instead of
 * granting command access.
 */
export function pluginCapabilities(
  plugins: FrameworkManifest["plugins"] | undefined,
  state: PluginsState | null | undefined,
): readonly string[] {
  if (!plugins || !state) return [];
  const capabilities = new Set<string>();
  for (const [id, declaration] of Object.entries(plugins)) {
    const definition = PLUGINS_BY_ID.get(id);
    const receipt = state.plugins[id];
    if (
      !definition ||
      declaration.enabled === false ||
      definition.kind !== declaration.kind ||
      receipt?.kind !== definition.kind ||
      receipt.state_version !== definition.stateVersion
    ) {
      continue;
    }
    for (const capability of definition.contributedCapabilities) {
      capabilities.add(capability);
    }
  }
  return [...capabilities].sort();
}
