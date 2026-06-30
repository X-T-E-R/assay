#!/usr/bin/env node
// Install the assay-builder skill from this repo.
//
// Builds the workspace and junctions (Windows) or symlinks (POSIX) the skill
// directory into a target skills dir, so an agent resolves it by relative path
// while it still points back to this repo (the single source of truth).
//
// Usage:
//   node scripts/install.mjs [--target <dir>] [--name <skill-name>]
//                            [--force] [--no-build] [--dry-run]
//
// Defaults: --target ~/.agents/skills   --name assay-builder
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const skillSrc = join(repoRoot, "skills", "assay-builder");

function parseArgs(argv) {
  const opts = {
    target: join(homedir(), ".agents", "skills"),
    name: "assay-builder",
    force: false,
    build: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") opts.target = resolve(argv[++i]);
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--no-build") opts.build = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const HELP = `assay-builder skill installer

  node scripts/install.mjs [--target <dir>] [--name <skill-name>]
                           [--force] [--no-build] [--dry-run]

  --target   skills directory to install into (default ~/.agents/skills)
  --name     installed skill directory name (default assay-builder)
  --force    replace an existing link/dir at the destination
  --no-build skip pnpm install + build (only link)
  --dry-run  print the plan without changing anything
`;

function run(cmd, opts) {
  console.log(`  $ ${cmd}`);
  if (opts.dryRun) return;
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

function linkState(dest) {
  if (!existsSync(dest)) {
    // existsSync follows links; a broken link still needs lstat.
    try {
      lstatSync(dest);
      return "broken-link";
    } catch {
      return "absent";
    }
  }
  const st = lstatSync(dest);
  return st.isSymbolicLink() ? "link" : "dir";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const dest = join(opts.target, opts.name);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  console.log(`assay-builder installer${opts.dryRun ? " (dry-run)" : ""}`);
  console.log(`  repo:   ${repoRoot}`);
  console.log(`  source: ${skillSrc}`);
  console.log(`  dest:   ${dest}  [${linkType}]`);

  if (!existsSync(skillSrc)) {
    throw new Error(`skill source missing: ${skillSrc}`);
  }

  if (opts.build) {
    console.log("\nbuilding workspace:");
    run("pnpm install --frozen-lockfile", opts);
    run("pnpm build", opts);
  } else {
    console.log("\nskipping build (--no-build)");
  }

  console.log("\nlinking skill:");
  const state = linkState(dest);
  if (state !== "absent") {
    if (!opts.force) {
      throw new Error(`destination exists (${state}): ${dest}\n  pass --force to replace it`);
    }
    console.log(`  removing existing ${state}: ${dest}`);
    if (!opts.dryRun) rmSync(dest, { recursive: true, force: true });
  }

  console.log(`  creating ${linkType}: ${dest} -> ${skillSrc}`);
  if (!opts.dryRun) {
    mkdirSync(opts.target, { recursive: true });
    symlinkSync(skillSrc, dest, linkType);
  }

  console.log(`\ndone.${opts.dryRun ? " (nothing changed)" : ""}`);
  console.log(`invoke: node ${join(dest, "scripts", "assay.mjs")} --help`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`install failed: ${err.message}\n`);
  process.exit(1);
}
