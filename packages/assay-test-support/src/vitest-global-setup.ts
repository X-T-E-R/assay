import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  REGISTRY_ROOT_ENV,
  diffRegistryFingerprints,
  fingerprintRegistry,
  isolatedRegistryRootForProcess,
  userProjectRegistryRoot,
} from "./registry.js";

/**
 * Run-level project registry isolation, with the assertion that proves it.
 *
 * Setup redirects the whole run at a temp registry (unless the caller already
 * pointed it somewhere, as `scripts/check.sh` does). Teardown compares the
 * user's real `~/.assay/projects` against the fingerprint taken before the
 * first test and fails the run if a single record was added, removed, or
 * rewritten — the leak this guards against filled that directory with 813 dead
 * temp-path records before anyone noticed.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const userRegistryRoot = userProjectRegistryRoot();
  const before = await fingerprintRegistry(userRegistryRoot);

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

    const changes = diffRegistryFingerprints(before, await fingerprintRegistry(userRegistryRoot));
    if (changes.length > 0) {
      throw new Error(
        [
          `The test run wrote to the user project registry at ${userRegistryRoot}.`,
          `Tests must set ${REGISTRY_ROOT_ENV} or pass registryRoot/noTrack.`,
          ...changes.slice(0, 20),
          ...(changes.length > 20 ? [`... and ${changes.length - 20} more`] : []),
        ].join("\n"),
      );
    }
  };
}
