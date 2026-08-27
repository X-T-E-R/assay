import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { FIXTURE_ROOT_ENV, fixtureRoot } from "./filesystem.js";
import {
  CLONE_REGISTRY_ENV,
  REGISTRY_ROOT_ENV,
  isolatedCloneRegistryForProcess,
  isolatedRegistryRootForProcess,
} from "./registry.js";

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
  const configuredCloneRegistry = process.env[CLONE_REGISTRY_ENV];
  if (!configuredCloneRegistry || configuredCloneRegistry.trim() === "") {
    const cloneRegistry = isolatedCloneRegistryForProcess();
    mkdirSync(path.dirname(cloneRegistry), { recursive: true });
    process.env[CLONE_REGISTRY_ENV] = cloneRegistry;
  }

  // Workers inherit the fixture root through the environment so every one of
  // them files its workspaces under the same run directory.
  const configuredFixtureRoot = process.env[FIXTURE_ROOT_ENV];
  const ownsFixtureRoot = !configuredFixtureRoot || configuredFixtureRoot.trim() === "";
  if (ownsFixtureRoot) process.env[FIXTURE_ROOT_ENV] = fixtureRoot();
  const runFixtureRoot = fixtureRoot();
  mkdirSync(runFixtureRoot, { recursive: true });

  return async () => {
    if (ownsTempRegistry) {
      await rm(path.dirname(registryRoot), { recursive: true, force: true });
    }
    if (ownsFixtureRoot) {
      await rm(runFixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  };
}
