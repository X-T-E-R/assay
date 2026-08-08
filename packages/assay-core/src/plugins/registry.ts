import { FrameworkError } from "../errors.js";
import type { PluginDeclaration } from "../schemas/index.js";

export const TRELLIS_PLUGIN_ID = "assay.trellis";

export type PluginInstallStrategy = "workspace-runtime";

export interface PluginDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly kind: string;
  readonly protocolVersion: number | null;
  readonly stateVersion: number;
  readonly installStrategy: PluginInstallStrategy;
  readonly runtimeCapabilities: readonly string[];
  readonly operationalResponsibilities: readonly string[];
  readonly providedResponsibilities: readonly string[];
}

const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  {
    id: TRELLIS_PLUGIN_ID,
    aliases: ["trellis"],
    kind: "workspace-runtime",
    protocolVersion: 1,
    stateVersion: 1,
    installStrategy: "workspace-runtime",
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
