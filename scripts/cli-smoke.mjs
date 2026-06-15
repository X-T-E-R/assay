#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsCli = path.join(repoRoot, "packages", "metasystem-framework-cli", "dist", "cli.js");

function fail(message) {
  throw new Error(message);
}

function run(label, args, options = {}) {
  try {
    return execFileSync(process.execPath, [tsCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    fail(`${label} failed with exit code ${error.status ?? "unknown"}\n${stdout}${stderr}`.trim());
  }
}

function main() {
  if (!existsSync(tsCli)) {
    fail(`Built TypeScript CLI not found: ${tsCli}. Run "pnpm build" first.`);
  }
  if (!statSync(tsCli).isFile()) {
    fail(`Built TypeScript CLI path is not a file: ${tsCli}`);
  }

  const help = run("CLI help", ["--help"]);
  if (!help.includes("Bootstrap and update an external-system-learning framework.")) {
    fail("CLI help did not include the expected description.");
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "metasystem-kit-smoke-"));
  try {
    const demo = path.join(tempRoot, "demo");
    run("CLI init", ["init", demo, "--name", "MetaSystem Smoke"]);
    run("CLI check", ["check", "--root", demo]);
    run("CLI status", ["status", "--root", demo]);
    run("CLI update dry-run", ["update", "--root", demo, "--dry-run"]);
    run("CLI migrate-layout dry-run", ["migrate-layout", "--root", demo, "--dry-run"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("MetaSystem Kit TypeScript CLI smoke checks passed.");
}

main();
