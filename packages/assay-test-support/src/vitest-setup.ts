import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REGISTRY_ROOT_ENV, isolatedRegistryRootForProcess } from "./registry.js";

/**
 * Per-worker guarantee that explicit workspace-index tests use disposable state.
 */
const configured = process.env[REGISTRY_ROOT_ENV];
if (!configured || configured.trim() === "") {
  const registryRoot = isolatedRegistryRootForProcess();
  mkdirSync(path.dirname(registryRoot), { recursive: true });
  process.env[REGISTRY_ROOT_ENV] = registryRoot;
}

// Keep the temp directory reachable for debugging a failed run.
export const testRegistryRoot = process.env[REGISTRY_ROOT_ENV] ?? path.join(tmpdir(), "assay");
