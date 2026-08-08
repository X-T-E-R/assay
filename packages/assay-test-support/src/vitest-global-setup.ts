import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { REGISTRY_ROOT_ENV, isolatedRegistryRootForProcess } from "./registry.js";

/**
 * Run-level workspace-index isolation. Tests never inspect the real user index.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const configured = process.env[REGISTRY_ROOT_ENV];
  const ownsTempRegistry = !configured || configured.trim() === "";
  const registryRoot = ownsTempRegistry ? isolatedRegistryRootForProcess() : configured;
  if (ownsTempRegistry) {
    mkdirSync(path.dirname(registryRoot), { recursive: true });
    process.env[REGISTRY_ROOT_ENV] = registryRoot;
  }

  return async () => {
    if (ownsTempRegistry) {
      await rm(path.dirname(registryRoot), { recursive: true, force: true });
    }
  };
}
