#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsCli = path.join(repoRoot, "packages", "assay-cli", "dist", "cli.js");
const requiredNodeEngine = ">=22.13.0";

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

/**
 * The version every package must declare, taken from the build rather than
 * repeated here. A release bump changes `CURRENT_VERSION` once, and this check
 * still catches a package.json that was left behind.
 */
async function releaseVersion() {
  const constants = path.join(repoRoot, "packages", "assay-core", "dist", "constants.js");
  if (!existsSync(constants)) {
    fail(`Built assay-core constants not found: ${constants}. Run "pnpm build" first.`);
  }
  const { CURRENT_VERSION } = await import(pathToFileURL(constants).href);
  return CURRENT_VERSION;
}

async function assertReleaseMetadata() {
  const expectedVersion = await releaseVersion();
  const manifests = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "packages", "assay-core", "package.json"),
    path.join(repoRoot, "packages", "assay-cli", "package.json"),
  ].map((file) => ({ file, value: JSON.parse(readFileSync(file, "utf8")) }));
  for (const { file, value } of manifests) {
    if (value.version !== expectedVersion) {
      fail(`${path.relative(repoRoot, file)} must declare version ${expectedVersion}.`);
    }
    if (value.engines?.node !== requiredNodeEngine) {
      fail(`${path.relative(repoRoot, file)} must require Node.js ${requiredNodeEngine}.`);
    }
  }
  if (manifests[0].value.packageManager !== "pnpm@11.3.0") {
    fail("root package.json must pin pnpm@11.3.0.");
  }
}

async function main() {
  await assertReleaseMetadata();
  if (!existsSync(tsCli)) {
    fail(`Built TypeScript CLI not found: ${tsCli}. Run "pnpm build" first.`);
  }
  if (!statSync(tsCli).isFile()) {
    fail(`Built TypeScript CLI path is not a file: ${tsCli}`);
  }

  const help = run("CLI help", ["--help"]);
  if (!help.includes("Bootstrap and update an Assay evidence workbench.")) {
    fail("CLI help did not include the expected description.");
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "assay-smoke-"));
  try {
    const demo = path.join(tempRoot, "demo");
    mkdirSync(demo);
    const smokeEnv = {
      ...process.env,
      ASSAY_WORKSPACES_ROOT: path.join(tempRoot, "workspaces"),
    };
    const smokeOptions = { env: smokeEnv, cwd: demo };
    run("CLI init", ["init", "--name", "Assay Smoke"], smokeOptions);
    run("CLI check", ["check"], smokeOptions);
    run("CLI status", ["status"], smokeOptions);
    run("CLI update dry-run", ["update", "--dry-run"], smokeOptions);

    const adoptionSource = path.join(tempRoot, "adoption-source");
    mkdirSync(path.join(adoptionSource, "src"), { recursive: true });
    writeFileSync(path.join(adoptionSource, "src", "feature.txt"), "source-v1\n", "utf8");
    const sourceAdd = run(
      "CLI source adoption source add",
      ["source", "add", adoptionSource, "adoption-source"],
      smokeOptions,
    );
    if (!sourceAdd.match(/observations\/([^/\s]+)\.yaml/)?.[1]) {
      fail("CLI source adoption source add did not report an observation id.");
    }
    mkdirSync(path.join(demo, "systems", "product", "adopted"), { recursive: true });
    writeFileSync(
      path.join(demo, "systems", "product", "adopted", "feature.txt"),
      "target-v1\n",
      "utf8",
    );
    run(
      "CLI source adoption target register",
      ["system", "register", "systems/product", "--name", "product", "--vcs", "none", "--primary"],
      smokeOptions,
    );
    const adoptionTake = run(
      "CLI source adoption take",
      [
        "source",
        "adoption",
        "take",
        "adoption-source:src/feature.txt",
        "--into",
        "product:adopted/feature.txt",
        "--note",
        "Smoke adoption.",
      ],
      smokeOptions,
    );
    const adoptionId = adoptionTake.match(/Recorded source adoption: (\S+)/)?.[1];
    if (!adoptionId) {
      fail("CLI source adoption take did not report the recorded adoption id.");
    }
    const adoptionList = run(
      "CLI source adoption list",
      ["source", "adoption", "list"],
      smokeOptions,
    );
    if (!adoptionList.includes("adoption-source:src/feature.txt -> product:adopted/feature.txt")) {
      fail("CLI source adoption list did not report the recorded mapping.");
    }
    const adoptionShow = run(
      "CLI source adoption show",
      ["source", "adoption", "show", adoptionId],
      smokeOptions,
    );
    if (!adoptionShow.includes("Resolves: systems/product/adopted/feature.txt")) {
      fail("CLI source adoption show did not resolve the target path.");
    }
    run("CLI check with Source adoption record", ["check"], smokeOptions);
    run("CLI source adoption remove", ["source", "adoption", "remove", adoptionId], smokeOptions);

    const beforeTrack = run(
      "CLI workspace list before track",
      ["workspace", "list", "--json"],
      smokeOptions,
    );
    if (beforeTrack.trim() !== "[]") {
      fail("Lifecycle commands wrote the explicit workspace index.");
    }
    run("CLI workspace track", ["workspace", "track", demo], smokeOptions);
    const workspaces = run("CLI workspace list", ["workspace", "list", "--json"], smokeOptions);
    if (!workspaces.includes("Assay Smoke") && !workspaces.includes("project-assay-smoke")) {
      fail("CLI workspace list did not include the explicitly tracked workspace.");
    }

    const adopted = path.join(tempRoot, "adopted");
    mkdirSync(path.join(adopted, "src"), { recursive: true });
    writeFileSync(path.join(adopted, "README.md"), "# Existing Project\n", "utf8");
    writeFileSync(path.join(adopted, "src", "index.ts"), "export const legacy = true;\n", "utf8");
    const adoptOptions = { env: smokeEnv, cwd: adopted };
    run("CLI adopt dry-run", ["adopt", "--name", "Adopted Smoke"], adoptOptions);
    run("CLI adopt apply", ["adopt", "--apply", "--name", "Adopted Smoke"], adoptOptions);
    run("CLI adopted check", ["check"], adoptOptions);
    const archiveRoot = path.join(adopted, ".old");
    const archives = readdirSync(archiveRoot);
    if (archives.length !== 1) {
      fail(`Expected one adoption archive, found ${archives.length}.`);
    }
    if (!existsSync(path.join(archiveRoot, archives[0], "src", "index.ts"))) {
      fail("Adoption archive did not contain the legacy source file.");
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("Assay TypeScript CLI smoke checks passed.");
}

await main();
