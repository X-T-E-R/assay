import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLONE_REGISTRY_ENV,
  REGISTRY_ROOT_ENV,
  isolatedCloneRegistryForProcess,
  isolatedRegistryRootForProcess,
} from "./registry.js";

/**
 * Per-worker guarantee that explicit workspace-index tests use disposable state.
 */
const configured = process.env[REGISTRY_ROOT_ENV];
if (!configured || configured.trim() === "") {
  const registryRoot = isolatedRegistryRootForProcess();
  mkdirSync(path.dirname(registryRoot), { recursive: true });
  process.env[REGISTRY_ROOT_ENV] = registryRoot;
}

const configuredCloneRegistry = process.env[CLONE_REGISTRY_ENV];
if (!configuredCloneRegistry || configuredCloneRegistry.trim() === "") {
  const cloneRegistry = isolatedCloneRegistryForProcess();
  mkdirSync(path.dirname(cloneRegistry), { recursive: true });
  process.env[CLONE_REGISTRY_ENV] = cloneRegistry;
}

// Keep the temp directory reachable for debugging a failed run.
export const testRegistryRoot = process.env[REGISTRY_ROOT_ENV] ?? path.join(tmpdir(), "assay");
