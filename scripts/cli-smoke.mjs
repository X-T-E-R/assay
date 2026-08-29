import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "packages", "assay", "dist", "cli.js");
const pkg = JSON.parse(
  await readFile(path.join(repo, "packages", "assay", "package.json"), "utf8"),
);
if (pkg.version !== "0.15.0") throw new Error(`expected assay 0.15.0, found ${pkg.version}`);

const temp = await mkdtemp(path.join(os.tmpdir(), "assay-smoke-"));
const registry = path.join(temp, "clone-registry.json");

async function run(args, expected = 0) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env: { ...process.env, ABSORB_CLONE_REGISTRY: registry },
    });
    if (expected !== 0)
      throw new Error(`expected exit ${expected}, got 0: assay ${args.join(" ")}`);
    return result;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      if (error.code !== expected)
        throw new Error(
          `expected exit ${expected}, got ${error.code}: assay ${args.join(" ")}\n${error.stderr ?? ""}`,
        );
      return error;
    }
    throw error;
  }
}

try {
  const version = (await run(["--version"])).stdout.trim();
  if (version !== pkg.version)
    throw new Error(`CLI version ${version} != package version ${pkg.version}`);

  const help = (await run(["--help"])).stdout;
  for (const command of [
    // suite-owned
    "init",
    "check",
    "status",
    "prime",
    "explain",
    // study half
    "update",
    "add",
    "link",
    "home",
    "unlink",
    "capture",
    "import",
    "sync",
    "switch",
    "log",
    "diff",
    "analysis",
    "knowledge",
    // build half
    "task",
    "roadmap",
    "spec",
    "system",
  ])
    if (!help.includes(command)) throw new Error(`root help is missing ${command}`);
  if (help.includes("migrate-envelope"))
    throw new Error("the suite must not mount migrate-envelope over its own envelope");

  // The committed example is a workspace assay 0.14 wrote. Reading it here is
  // the gate's cheapest proof that the thin layer still accepts one.
  const example = path.join(repo, "examples", "framework-template");
  await run(["check", "--root", example]);
  await run(["update", "--root", example, "--dry-run"]);

  const root = path.join(temp, "workspace");
  const material = path.join(temp, "material");
  await mkdir(material, { recursive: true });
  await writeFile(path.join(material, "note.txt"), "evidence\n", "utf8");

  await run(["init", root, "--name", "Assay Smoke", "--no-agents"]);
  await run(["check", "--root", root]);
  await run(["status", "--root", root]);
  await run(["prime", "--root", root]);
  await run(["explain", "workspace"]);
  await run(["explain", "source"]);
  await run(["explain", "task"]);
  await run(["add", material, "sample", "--root", root]);
  await run(["capture", "sample", "--root", root]);
  await run(["status", "sample", "--root", root]);
  await run(["log", "sample", "--root", root]);
  const analysis = JSON.parse(
    (
      await run([
        "analysis",
        "new",
        "Smoke review",
        "--for-source",
        "sample",
        "--root",
        root,
        "--json",
      ])
    ).stdout,
  );
  await run(["analysis", "close", analysis.path, "--exit", "adopt", "--root", root]);
  await run(["knowledge", "add", "pattern", "Smoke pattern", "--root", root]);
  await run(["task", "create", "--title", "Smoke task", "--root", root]);
  await run(["roadmap", "create", "--title", "Smoke roadmap", "--root", root]);
  await run(["system", "register", ".", "--root", root, "--name", "Smoke System", "--primary"]);
  await run(["system", "list", "--root", root]);
  await run(["update", "--root", root, "--dry-run"]);
  await run(["check", "--root", root]);
  await run(["explain", "not-a-topic"], 1);
  await run(["migrate-envelope", "--root", root], 1);
  console.log(`assay smoke passed (${pkg.version})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
