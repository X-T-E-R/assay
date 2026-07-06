#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "packages", "assay-cli", "dist", "cli.js");
const exampleRoot = path.join(repoRoot, "examples", "framework-template");
const blockedUpdateCounts = [
  "new",
  "auto-update",
  "modified-by-user",
  "user-deleted",
  "untracked-existing",
];

function fail(message) {
  throw new Error(message);
}

function runCli(label, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }

  return result.stdout;
}

function assertBuiltCliExists() {
  if (!existsSync(cli)) {
    fail(`Built TypeScript CLI not found: ${cli}. Run "pnpm build" first.`);
  }
  if (!statSync(cli).isFile()) {
    fail(`Built TypeScript CLI path is not a file: ${cli}`);
  }
}

function assertNoRuntimeLedgers() {
  const eventsDir = path.join(exampleRoot, ".assay", "events");
  if (existsSync(eventsDir) && readdirSync(eventsDir).length > 0) {
    fail("examples/framework-template must not commit runtime event ledgers under .assay/events/.");
  }

  const localStatePaths = [
    path.join(exampleRoot, ".assay", ".runtime"),
    path.join(exampleRoot, ".assay", "systems-registry.json"),
  ];
  for (const localStatePath of localStatePaths) {
    if (existsSync(localStatePath)) {
      fail(
        `examples/framework-template must not commit local runtime state: ${path.relative(exampleRoot, localStatePath)}`,
      );
    }
  }
}

function parseUpdateSummary(output) {
  const counts = new Map();
  for (const match of output.matchAll(/^\s*-\s*([^:]+):\s*(\d+)\s*$/gm)) {
    counts.set(match[1], Number.parseInt(match[2], 10));
  }
  return counts;
}

function assertDryRunUnchanged(output) {
  const counts = parseUpdateSummary(output);
  const missing = blockedUpdateCounts.filter((name) => !counts.has(name));
  if (missing.length > 0) {
    fail(`Could not verify update dry-run summary counts: missing ${missing.join(", ")}.`);
  }

  const nonZero = blockedUpdateCounts.filter((name) => counts.get(name) !== 0);
  if (nonZero.length > 0) {
    fail(
      `Public example is not synchronized; non-zero update summary counts: ${nonZero.map((name) => `${name}=${counts.get(name)}`).join(", ")}.`,
    );
  }
}

function main() {
  assertBuiltCliExists();
  assertNoRuntimeLedgers();

  console.log("Checking committed public example...");
  runCli("public example check", ["check", "--root", exampleRoot]);
  const updateOutput = runCli("public example update dry-run", [
    "update",
    "--root",
    exampleRoot,
    "--dry-run",
    "--no-track",
  ]);
  assertDryRunUnchanged(updateOutput);
  console.log("Committed public example checks passed.");
}

main();
