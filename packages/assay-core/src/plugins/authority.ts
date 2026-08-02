import path from "node:path";

import { FrameworkError, FrameworkNotFoundError } from "../errors.js";
import { loadManifest } from "../manifest.js";
import type { FrameworkManifest, ProviderTarget, ResponsibilityBinding } from "../schemas/index.js";
import { findSystem, loadSystemsRegistry } from "../systems-registry.js";
import {
  DECISION_GOVERNANCE_RESPONSIBILITY,
  NATIVE_DECISION_PROVIDER,
  TRELLIS_PLUGIN_ID,
} from "./registry.js";

export type ProviderHealth = "healthy" | "unhealthy" | "not-checked";
export type ResponsibilityState = "active" | "disabled" | "blocked";

/** Compatibility shape retained for generic plugin receipts. */
export interface ProviderObservation {
  readonly provider_locator: string;
  readonly provider_version: string;
}

export interface ResponsibilityStatus {
  readonly id: typeof DECISION_GOVERNANCE_RESPONSIBILITY;
  readonly configuredProvider: string | null;
  readonly desiredProvider: string;
  readonly activeProvider: string | null;
  readonly target: ProviderTarget | null;
  readonly state: ResponsibilityState;
  readonly message: string;
}

export interface DecisionGovernanceStatus extends ResponsibilityStatus {
  readonly health: ProviderHealth;
  readonly observations: ProviderObservation | null;
}

/**
 * Normalize a generic provider target without probing or invoking a provider.
 * assay.trellis no longer accepts targets; this remains for the future SPI.
 */
export async function normalizeProviderTarget(
  rootValue: string,
  target: ProviderTarget,
): Promise<ProviderTarget> {
  if (target.kind === "workspace") return target;
  const root = path.resolve(rootValue);
  const registry = await loadSystemsRegistry(root);
  if (!registry) {
    throw new FrameworkError("provider target is unavailable: systems registry is unavailable", {
      code: "PROVIDER_UNAVAILABLE",
      details: { target },
    });
  }
  const system = await findSystem(registry, target.name);
  if (system.status === "archived") {
    throw new FrameworkError(`provider target system '${system.name}' is archived`, {
      code: "PROVIDER_UNAVAILABLE",
      details: { target: { kind: "system", name: system.name } },
    });
  }
  return { kind: "system", name: system.name };
}

function explicitDecisionBinding(
  manifest: Pick<FrameworkManifest, "bindings">,
): ResponsibilityBinding | undefined {
  return manifest.bindings?.[DECISION_GOVERNANCE_RESPONSIBILITY];
}

export function nativeDecisionGovernanceEnabled(
  manifest: Pick<FrameworkManifest, "bindings">,
): boolean {
  const binding = explicitDecisionBinding(manifest);
  return (
    binding === undefined ||
    binding.provider === NATIVE_DECISION_PROVIDER ||
    binding.provider === TRELLIS_PLUGIN_ID
  );
}

export async function getDecisionGovernanceStatus(
  rootValue: string,
  manifestValue?: FrameworkManifest,
): Promise<DecisionGovernanceStatus> {
  const root = path.resolve(rootValue);
  const manifest = manifestValue ?? (await loadManifest(root));
  if (!manifest) throw new FrameworkNotFoundError(`No Assay manifest found under ${root}.`);
  const binding = explicitDecisionBinding(manifest);
  if (!binding || binding.provider === NATIVE_DECISION_PROVIDER) {
    return {
      id: DECISION_GOVERNANCE_RESPONSIBILITY,
      configuredProvider: binding?.provider ?? null,
      desiredProvider: NATIVE_DECISION_PROVIDER,
      activeProvider: NATIVE_DECISION_PROVIDER,
      target: binding?.target ?? null,
      state: "active",
      health: "healthy",
      observations: null,
      message: "Assay native decision governance is active",
    };
  }

  if (binding.provider === TRELLIS_PLUGIN_ID) {
    return {
      id: DECISION_GOVERNANCE_RESPONSIBILITY,
      configuredProvider: binding.provider,
      desiredProvider: NATIVE_DECISION_PROVIDER,
      activeProvider: NATIVE_DECISION_PROVIDER,
      target: binding.target,
      state: "active",
      health: "healthy",
      observations: null,
      message:
        "legacy assay.trellis decision-governance binding is ignored; Assay native decision governance is active",
    };
  }

  return {
    id: DECISION_GOVERNANCE_RESPONSIBILITY,
    configuredProvider: binding.provider,
    desiredProvider: binding.provider,
    activeProvider: null,
    target: binding.target,
    state: "blocked",
    health: "not-checked",
    observations: null,
    message: `configured provider '${binding.provider}' is not provided by this Assay build`,
  };
}

export async function requireNativeDecisionGovernance(root: string): Promise<void> {
  const status = await getDecisionGovernanceStatus(root);
  if (status.activeProvider === NATIVE_DECISION_PROVIDER) return;
  throw new FrameworkError(`decision governance provider is unavailable: ${status.message}`, {
    code: "PROVIDER_UNAVAILABLE",
    details: status,
  });
}

/** Compatibility shim for lifecycle callers from the 0.5 preview. */
export async function preflightFederatedPlugin(
  root: string,
  pluginValue: string,
  target: ProviderTarget = { kind: "workspace" },
): Promise<void> {
  void root;
  void pluginValue;
  void target;
}
