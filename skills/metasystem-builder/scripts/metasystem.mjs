#!/usr/bin/env node
// Skill-local launcher for the bundled-in-repo MetaSystem CLI.
//
// The skill lives at <repo>/skills/metasystem-builder and is installed by
// junctioning that directory elsewhere (e.g. ~/.agents/skills). Node resolves
// import.meta.url through the junction back to its real location inside the
// repo, so we walk up from here to find the workspace CLI. There is no bundled
// copy of the kit — packages/ in the repo is the single source of truth.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_REL = join("packages", "metasystem-framework-cli", "dist", "cli.js");
const PKG_REL = join("packages", "metasystem-framework-cli", "package.json");

// Resolve through any junction/symlink to the real path inside the repo.
const here = dirname(realpathSync(fileURLToPath(import.meta.url)));

// Walk up looking for the repo that owns the CLI package.
let repoRoot = null;
let builtCli = null;
for (let dir = here; ; ) {
  if (existsSync(join(dir, PKG_REL))) {
    repoRoot = dir;
    const cli = join(dir, CLI_REL);
    if (existsSync(cli)) builtCli = cli;
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

if (!repoRoot) {
  process.stderr.write(
    "metasystem: could not locate the metasystem-kit repo from this skill.\n" +
      "The skill must be installed from inside the repo (clone it, then run\n" +
      "scripts/install.mjs, which junctions the skill so it resolves back here).\n",
  );
  process.exit(1);
}

if (!builtCli) {
  process.stderr.write(
    `metasystem: CLI not built at ${join(repoRoot, CLI_REL)}\n` +
      "dist/ is a build artifact and is not committed. Build the repo once:\n" +
      `  cd ${repoRoot}\n` +
      "  pnpm install --frozen-lockfile && pnpm build\n",
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(builtCli).href);
const exitCode = await main([process.argv[0] ?? "node", builtCli, ...process.argv.slice(2)]);
process.exitCode = exitCode;
