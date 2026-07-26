import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    // Assay's lifecycle commands register every workspace they touch in a
    // user-level registry. These two keep the suite's throwaway workspaces out
    // of it, and fail the run if anything lands there anyway.
    globalSetup: ["assay-test-support/vitest-global-setup"],
    setupFiles: ["assay-test-support/vitest-setup"],
  },
});
