import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reportsDirectory: "coverage",
    },
    include: ["packages/*/tests/**/*.test.ts"],
    // Same project-registry isolation the per-package configs install, by path
    // because the workspace root does not depend on assay-test-support.
    globalSetup: ["./packages/assay-test-support/dist/vitest-global-setup.js"],
    setupFiles: ["./packages/assay-test-support/dist/vitest-setup.js"],
  },
});
