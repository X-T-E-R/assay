#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonCli = path.join(
  repoRoot,
  "packages",
  "metasystem-framework-cli-python",
  "scripts",
  "bootstrap_framework.py",
);
const tsCli = path.join(repoRoot, "packages", "metasystem-framework-cli", "dist", "cli.js");

const keyManagedFiles = [
  "README.md",
  ".framework/VERSION",
  ".framework/README.md",
  ".framework/config.yaml",
  "references/README.md",
  "references/intake/README.md",
  "references/frozen/README.md",
  "analyses/templates/reference-analysis-card.md",
  "analyses/templates/gap-analysis.md",
  "analyses/templates/pattern-card.md",
  "systems/parity-demo-core/framework.yaml",
  "systems/parity-demo-core/docs/architecture.md",
  "systems/parity-demo-core/docs/update-mechanism.md",
  "iterations/README.md",
  "knowledge/README.md",
];

const ignoredTreePaths = new Set();

function fail(message) {
  throw new Error(message);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function run(label, command, args, options = {}) {
  try {
    return execFileSync(command, args, {
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

function runPython(args) {
  return run("Python CLI", "python", [pythonCli, ...args], {
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, "packages", "metasystem-framework-cli-python", "src"),
    },
  });
}

function runTypeScript(args) {
  return run("TypeScript CLI", process.execPath, [tsCli, ...args]);
}

function assertEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${name} mismatch\nactual: ${JSON.stringify(actual, null, 2)}\nexpected: ${JSON.stringify(expected, null, 2)}`,
    );
  }
}

async function walkTree(root) {
  const entries = [];

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = toPosix(path.relative(root, absolute));
      if (ignoredTreePaths.has(relative)) {
        continue;
      }
      entries.push(`${child.isDirectory() ? "dir" : "file"}:${relative}`);
      if (child.isDirectory()) {
        await visit(absolute);
      }
    }
  }

  await visit(root);
  return entries.sort();
}

function readNormalized(root, relativePath) {
  return normalizeText(readFileSync(path.join(root, relativePath), "utf8"));
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

async function listRelativeChildren(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    return [];
  }
  return (await readdir(absolute)).sort();
}

async function listBackupSnapshots(root) {
  return (await listRelativeChildren(root, ".framework/backups")).filter(
    (name) => name !== ".gitkeep",
  );
}

function normalizeManifest(manifest) {
  const managedEntries = Object.entries(manifest.managed_files ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, record]) => [
      file,
      {
        executable: record.executable,
        hash: record.hash,
        installed_version: record.installed_version,
        protected: record.protected,
        template_id: record.template_id,
      },
    ]);

  return {
    __schema: manifest.__schema,
    applied_migrations: manifest.applied_migrations ?? [],
    framework_version: manifest.framework_version,
    layout_version: manifest.layout_version,
    managed_files: Object.fromEntries(managedEntries),
    project: manifest.project,
    user_deleted: manifest.user_deleted ?? [],
  };
}

async function createPair(tempRoot, scenario) {
  const pyRoot = path.join(tempRoot, `${scenario}-python`);
  const tsRoot = path.join(tempRoot, `${scenario}-typescript`);
  runPython(["init", pyRoot, "--name", "Parity Demo"]);
  runTypeScript(["init", tsRoot, "--name", "Parity Demo"]);
  return { pyRoot, tsRoot };
}

async function compareInitParity(tempRoot) {
  const { pyRoot, tsRoot } = await createPair(tempRoot, "init");

  assertEqual("initial directory tree", await walkTree(tsRoot), await walkTree(pyRoot));

  for (const relativePath of keyManagedFiles) {
    assertEqual(
      `managed file ${relativePath}`,
      readNormalized(tsRoot, relativePath),
      readNormalized(pyRoot, relativePath),
    );
  }

  assertEqual(
    "manifest shape and managed records",
    normalizeManifest(readJson(tsRoot, ".framework/manifest.json")),
    normalizeManifest(readJson(pyRoot, ".framework/manifest.json")),
  );
}

async function compareModifiedUpdate(tempRoot) {
  const { pyRoot, tsRoot } = await createPair(tempRoot, "modified-update");
  const userEdit = "# user edit\n";
  writeFileSync(path.join(pyRoot, "README.md"), userEdit, "utf8");
  writeFileSync(path.join(tsRoot, "README.md"), userEdit, "utf8");

  runPython(["update", "--root", pyRoot]);
  runTypeScript(["update", "--root", tsRoot]);

  assertEqual("modified managed file skip", readNormalized(tsRoot, "README.md"), userEdit);
  assertEqual("Python modified managed file skip", readNormalized(pyRoot, "README.md"), userEdit);
}

async function compareUserDeletedUpdate(tempRoot) {
  const { pyRoot, tsRoot } = await createPair(tempRoot, "user-deleted");
  const deletedFile = "knowledge/guides/README.md";
  rmSync(path.join(pyRoot, deletedFile));
  rmSync(path.join(tsRoot, deletedFile));

  runPython(["update", "--root", pyRoot]);
  runTypeScript(["update", "--root", tsRoot]);

  assertEqual(
    "user-deleted file stays absent in Python",
    existsSync(path.join(pyRoot, deletedFile)),
    false,
  );
  assertEqual(
    "user-deleted file stays absent in TypeScript",
    existsSync(path.join(tsRoot, deletedFile)),
    false,
  );
  assertEqual(
    "user-deleted manifest records",
    normalizeManifest(readJson(tsRoot, ".framework/manifest.json")).user_deleted,
    normalizeManifest(readJson(pyRoot, ".framework/manifest.json")).user_deleted,
  );
}

async function compareDryRunUpdate(tempRoot) {
  const { pyRoot, tsRoot } = await createPair(tempRoot, "dry-run-update");
  const userEdit = "# dry run edit\n";
  writeFileSync(path.join(pyRoot, "README.md"), userEdit, "utf8");
  writeFileSync(path.join(tsRoot, "README.md"), userEdit, "utf8");

  const beforePyManifest = normalizeManifest(readJson(pyRoot, ".framework/manifest.json"));
  const beforeTsManifest = normalizeManifest(readJson(tsRoot, ".framework/manifest.json"));

  runPython(["update", "--root", pyRoot, "--dry-run"]);
  runTypeScript(["update", "--root", tsRoot, "--dry-run"]);

  assertEqual("dry-run README preserved in Python", readNormalized(pyRoot, "README.md"), userEdit);
  assertEqual(
    "dry-run README preserved in TypeScript",
    readNormalized(tsRoot, "README.md"),
    userEdit,
  );
  assertEqual(
    "dry-run Python manifest unchanged",
    normalizeManifest(readJson(pyRoot, ".framework/manifest.json")),
    beforePyManifest,
  );
  assertEqual(
    "dry-run TypeScript manifest unchanged",
    normalizeManifest(readJson(tsRoot, ".framework/manifest.json")),
    beforeTsManifest,
  );
  assertEqual("Python dry-run creates no backup snapshots", await listBackupSnapshots(pyRoot), []);
  assertEqual(
    "TypeScript dry-run creates no backup snapshots",
    await listBackupSnapshots(tsRoot),
    [],
  );
}

async function compareMigration(tempRoot) {
  const { pyRoot, tsRoot } = await createPair(tempRoot, "migration");
  for (const root of [pyRoot, tsRoot]) {
    await mkdir(path.join(root, "experiments", "2026-01-01-old"), { recursive: true });
    writeFileSync(
      path.join(root, "experiments", "2026-01-01-old", "note.md"),
      "# legacy\n",
      "utf8",
    );
    await mkdir(path.join(root, "references", "202601"), { recursive: true });
    writeFileSync(path.join(root, "references", "202601", "README.md"), "# ref\n", "utf8");
    await mkdir(path.join(root, ".metasystem"), { recursive: true });
    writeFileSync(path.join(root, ".metasystem", "config.yaml"), "legacy: true\n", "utf8");
  }

  runPython(["migrate-layout", "--root", pyRoot, "--dry-run"]);
  runTypeScript(["migrate-layout", "--root", tsRoot, "--dry-run"]);

  for (const [label, root] of [
    ["Python", pyRoot],
    ["TypeScript", tsRoot],
  ]) {
    assertEqual(
      `${label} migration dry-run does not copy experiments`,
      existsSync(path.join(root, "iterations", "2026-01-01-old")),
      false,
    );
    assertEqual(
      `${label} migration dry-run does not copy references`,
      existsSync(path.join(root, "references", "frozen", "202601")),
      false,
    );
    assertEqual(
      `${label} migration dry-run does not copy legacy config`,
      existsSync(path.join(root, ".framework", "legacy-metasystem", "config.yaml")),
      false,
    );
  }

  runPython(["migrate-layout", "--root", pyRoot, "--apply"]);
  runTypeScript(["migrate-layout", "--root", tsRoot, "--apply"]);

  for (const [label, root] of [
    ["Python", pyRoot],
    ["TypeScript", tsRoot],
  ]) {
    assertEqual(
      `${label} migration copied experiments`,
      existsSync(path.join(root, "iterations", "2026-01-01-old", "note.md")),
      true,
    );
    assertEqual(
      `${label} migration copied references`,
      existsSync(path.join(root, "references", "frozen", "202601", "README.md")),
      true,
    );
    assertEqual(
      `${label} migration copied legacy config`,
      existsSync(path.join(root, ".framework", "legacy-metasystem", "config.yaml")),
      true,
    );
    assertEqual(
      `${label} migration preserved source experiments`,
      existsSync(path.join(root, "experiments", "2026-01-01-old", "note.md")),
      true,
    );
    assertEqual(
      `${label} migration preserved source references`,
      existsSync(path.join(root, "references", "202601", "README.md")),
      true,
    );
  }
}

async function main() {
  if (!existsSync(pythonCli)) {
    fail(`Python reference bootstrap not found: ${pythonCli}`);
  }
  if (!existsSync(tsCli)) {
    fail(`Built TypeScript CLI not found: ${tsCli}. Run "pnpm build" first.`);
  }
  if (!statSync(tsCli).isFile()) {
    fail(`Built TypeScript CLI path is not a file: ${tsCli}`);
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "metasystem-parity-"));
  try {
    await compareInitParity(tempRoot);
    await compareModifiedUpdate(tempRoot);
    await compareUserDeletedUpdate(tempRoot);
    await compareDryRunUpdate(tempRoot);
    await compareMigration(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("MetaSystem Kit Python/TypeScript parity harness passed.");
}

await main();
