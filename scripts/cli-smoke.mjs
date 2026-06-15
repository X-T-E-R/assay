#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
    mkdirSync(demo);
    const smokeEnv = {
      ...process.env,
      METASYSTEM_PROJECT_REGISTRY_ROOT: path.join(tempRoot, "registry"),
    };
    const smokeOptions = { env: smokeEnv, cwd: demo };
    run("CLI init", ["init", "--name", "MetaSystem Smoke"], smokeOptions);
    run("CLI check", ["check"], smokeOptions);
    run("CLI status", ["status"], smokeOptions);
    run("CLI update dry-run", ["update", "--dry-run"], smokeOptions);
    const projects = run("CLI projects list", ["projects", "list", "--json"], smokeOptions);
    if (!projects.includes("MetaSystem Smoke")) {
      fail("CLI projects list did not include the initialized project.");
    }
    run("CLI migrate-layout dry-run", ["migrate-layout", "--dry-run"], smokeOptions);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("MetaSystem Kit TypeScript CLI smoke checks passed.");
}

main();
