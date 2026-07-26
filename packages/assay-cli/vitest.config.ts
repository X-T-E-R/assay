import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
    // The CLI suites spawn `dist/cli.js`, which inherits `process.env`, so
    // redirecting the registry here also covers the child processes.
    globalSetup: ["assay-test-support/vitest-global-setup"],
    setupFiles: ["assay-test-support/vitest-setup"],
  },
});
