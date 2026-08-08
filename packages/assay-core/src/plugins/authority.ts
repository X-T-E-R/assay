import path from "node:path";

import { FrameworkError } from "../errors.js";
import type { ProviderTarget } from "../schemas/index.js";
import { findSystem, loadSystemsRegistry } from "../systems-registry.js";

export type ProviderHealth = "healthy" | "unhealthy" | "unverifiable" | "not-checked";
export type ResponsibilityState = "active" | "disabled" | "blocked";

/** Compatibility shape retained for generic plugin receipts. */
export interface ProviderObservation {
  readonly provider_locator: string;
  readonly provider_version: string;
}

export interface ResponsibilityStatus {
  readonly id: string;
  readonly configuredProvider: string | null;
  readonly desiredProvider: string;
  readonly activeProvider: string | null;
  readonly target: ProviderTarget | null;
  readonly state: ResponsibilityState;
  readonly message: string;
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
