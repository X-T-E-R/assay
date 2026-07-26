import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REGISTRY_ROOT_ENV, isolatedRegistryRootForProcess } from "./registry.js";

/**
 * Per-worker guarantee that nothing in this run touches the user's project
 * registry.
 *
 * `init`, `adopt`, `attach`, and `update` register the workspace they operate
 * on under `~/.assay/projects` unless told otherwise, and the suites create
 * hundreds of throwaway workspaces. The global setup already points the run at
 * a temp registry; this repeats it inside each worker so a worker that started
 * without inheriting the variable is still isolated, and so a single test file
 * run on its own gets the same treatment. Child processes inherit
 * `process.env`, which covers the CLI suites that spawn `dist/cli.js`.
 */
const configured = process.env[REGISTRY_ROOT_ENV];
if (!configured || configured.trim() === "") {
  const registryRoot = isolatedRegistryRootForProcess();
  mkdirSync(path.dirname(registryRoot), { recursive: true });
  process.env[REGISTRY_ROOT_ENV] = registryRoot;
}

// Keep the temp directory reachable for debugging a failed run.
export const testRegistryRoot = process.env[REGISTRY_ROOT_ENV] ?? path.join(tmpdir(), "assay");
