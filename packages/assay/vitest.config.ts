import os from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    // The suites spawn `dist/cli.js`, which inherits `process.env`, so pinning
    // the machine-local clone registry here keeps a test run out of the
    // developer's real home directory in the child processes too.
    env: {
      ABSORB_CLONE_REGISTRY: path.join(
        os.tmpdir(),
        `assay-tests-${process.pid}`,
        "clone-registry.json",
      ),
      // Byte-exact assertions against Git checkouts need the line endings that
      // were written; Windows CI turns on core.autocrlf globally.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
    },
  },
});
