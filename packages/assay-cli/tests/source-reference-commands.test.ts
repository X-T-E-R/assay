import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
  pathExists,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The reference commands as a user meets them.
 *
 * Every read here checks that the relation is on screen, because the whole
 * failure mode this design guards against is a shared Source that looks owned.
 */

const tempDirs = createTempDirectoryFixture("assay-source-ref-cli");
let registryRoot = "";
let cloneRegistry = "";
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  registryRoot = await createIsolatedRegistryRoot(tempDirs);
  cloneRegistry = path.join(await tempDirs.createTempDir(), "clone-registry.json");
  cliRunner = createBuiltCliRunner({
    registryRoot,
    env: { ASSAY_CLONE_REGISTRY: cloneRegistry },
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function runCli(args: readonly string[]) {
  return cliRunner.runCli(args);
}

/** Two workspaces side by side, the way a research/product pair sits on disk. */
async function neighbourWorkspaces(): Promise<{ home: string; consumer: string }> {
  const parent = await tempDirs.createTempDir();
  const home = path.join(parent, "shared-research");
  const consumer = path.join(parent, "product");
  for (const target of [home, consumer]) {
    const init = await runCli(["init", target, "--name", path.basename(target)]);
    expect(init.exitCode, init.stderr).toBe(0);
  }
  return { home, consumer };
}

async function addCopiedSource(root: string, alias: string): Promise<string> {
  const material = path.join(await tempDirs.createTempDir(), `${alias}-material`);
  await mkdir(material, { recursive: true });
  await writeFile(path.join(material, "README.md"), `# ${alias}\n`, "utf8");
  const added = await runCli(["source", "add", material, alias, "--root", root]);
  expect(added.exitCode, added.stderr).toBe(0);
  return material;
}

describe("assay source link / home / unlink", () => {
  it("links by explicit path, names the home and its brief, and shows the relation", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await writeFile(path.join(home, "sources", "qiskit", "brief.md"), "# Why\n", "utf8");

    const linked = await runCli(["source", "link", home, "qiskit", "--root", consumer]);
    expect(linked.exitCode, linked.stderr).toBe(0);
    expect(linked.stdout).toContain("Linked source: sources/qiskit");
    expect(linked.stdout).toContain("ref -> ../shared-research#qiskit");
    expect(linked.stdout).toContain(`Home workspace: ${home}`);
    expect(linked.stdout).toContain(path.join(home, "sources", "qiskit", "brief.md"));

    expect(await readdir(path.join(consumer, "sources", "qiskit"))).toEqual(["source.ref.yaml"]);
    const shell = await readFile(
      path.join(consumer, "sources", "qiskit", "source.ref.yaml"),
      "utf8",
    );
    expect(shell).toContain("schema: assay.source-reference/v1");
    expect(shell).toContain("workspace: ../shared-research");
    expect(shell).not.toMatch(/branch|revision|pin|source_uri/);

    const status = await runCli(["source", "status", "--root", consumer]);
    expect(status.stdout).toContain("ref -> ../shared-research#qiskit");

    const homeCommand = await runCli(["source", "home", "qiskit", "--root", consumer]);
    expect(homeCommand.exitCode).toBe(0);
    expect(homeCommand.stdout).toContain("Relation: ref");
    expect(homeCommand.stdout).toContain(`Home workspace: ${home}`);

    const log = await runCli(["source", "log", "qiskit", "--root", consumer]);
    expect(log.stdout).toContain("Relation: ref -> ../shared-research#qiskit");
  });

  it("says the home keeps no brief rather than staying silent about it", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");

    const linked = await runCli(["source", "link", home, "qiskit", "--root", consumer]);
    expect(linked.stdout).toContain("Brief: none in the home workspace");
  });

  it("reports an owned Source as owned, with no reference lines", async () => {
    const { home } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");

    const homeCommand = await runCli(["source", "home", "qiskit", "--root", home]);
    expect(homeCommand.stdout).toContain("Relation: owned");
    expect(homeCommand.stdout).toContain(`Home workspace: ${home}`);

    const status = await runCli(["source", "status", "--root", home]);
    expect(status.stdout).not.toContain("ref ->");
  });

  it("unlinks the local shell and says the home was left alone", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await runCli(["source", "link", home, "qiskit", "--root", consumer]);

    const unlinked = await runCli(["source", "unlink", "qiskit", "--root", consumer]);
    expect(unlinked.exitCode, unlinked.stderr).toBe(0);
    expect(unlinked.stdout).toContain("Unlinked source: sources/qiskit");
    expect(unlinked.stdout).toContain(`Home workspace: ${home} (untouched)`);
    expect(await pathExists(path.join(consumer, "sources", "qiskit"))).toBe(false);
    expect(await pathExists(path.join(home, "sources", "qiskit", "source.yaml"))).toBe(true);
  });

  it("teaches instead of deleting when unlink is aimed at an owned Source", async () => {
    const { home } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");

    const refused = await runCli(["source", "unlink", "qiskit", "--root", home]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("owned by this workspace");
    expect(await pathExists(path.join(home, "sources", "qiskit", "source.yaml"))).toBe(true);
  });

  it("writes through to the home and says so before the work", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await runCli(["source", "link", home, "qiskit", "--root", consumer]);

    const captured = await runCli([
      "source",
      "capture",
      "qiskit",
      "--root",
      consumer,
      "--note",
      "pinned",
    ]);
    expect(captured.exitCode, captured.stderr).toBe(0);
    expect(captured.stdout).toContain("writing through to the Source home");
    expect(captured.stdout).toContain(`Home workspace: ${home}`);
    expect(await pathExists(path.join(home, "sources", "qiskit", "captures"))).toBe(true);
    expect(await pathExists(path.join(consumer, "sources", "qiskit", "captures"))).toBe(false);
  });

  it("fails locally on a broken reference and keeps the workspace usable", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await runCli(["source", "link", home, "qiskit", "--root", consumer]);
    await rename(home, `${home}-moved`);

    const status = await runCli(["source", "status", "--root", consumer]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("broken");
    expect(status.stdout).toContain("ref -> ../shared-research#qiskit");

    const failed = await runCli(["source", "capture", "qiskit", "--root", consumer]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("broken reference");
    expect(failed.stderr).toContain("assay source link");

    // The workspace itself still reads, and check names the finding.
    const workspaceStatus = await runCli(["status", "--root", consumer]);
    expect(workspaceStatus.exitCode).toBe(0);
    expect(workspaceStatus.stdout).toContain("broken references: 1");

    const check = await runCli(["check", "--root", consumer]);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain("sources/qiskit/source.ref.yaml");
    expect(check.stdout).toContain("broken reference");
    expect(await pathExists(path.join(consumer, "sources", "qiskit", "source.ref.yaml"))).toBe(
      true,
    );
  });

  it("emits the reference in JSON without printing the notice twice", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await runCli(["source", "link", home, "qiskit", "--root", consumer]);

    const captured = await runCli(["source", "capture", "qiskit", "--root", consumer, "--json"]);
    expect(captured.exitCode, captured.stderr).toBe(0);
    const parsed = JSON.parse(captured.stdout) as {
      readonly root: string;
      readonly reference: { readonly homeRoot: string } | null;
    };
    expect(parsed.root).toBe(home);
    expect(parsed.reference?.homeRoot).toBe(home);
  });
});

describe("assay source link and the clone registry", () => {
  it("advises linking when an origin already has a home, then adds anyway", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    const material = await addCopiedSource(home, "qiskit");

    const added = await runCli(["source", "add", material, "qiskit", "--root", consumer]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("Advisory:");
    expect(added.stdout).toContain(home);
    expect(added.stdout).toContain("assay source link");
    expect(added.stdout).toContain("Added source: sources/qiskit");
  });

  it("resolves a bare link through the registry and works again without it", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");

    const linked = await runCli(["source", "link", "qiskit", "--root", consumer]);
    expect(linked.exitCode, linked.stderr).toBe(0);
    expect(linked.stdout).toContain("Registry: resolved 'qiskit'");
    expect(linked.stdout).toContain(`Home workspace: ${home}`);

    // Deleting the cache loses the hint and nothing else.
    await rm(cloneRegistry, { force: true });
    const status = await runCli(["source", "status", "--root", consumer]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("ref -> ../shared-research#qiskit");

    const bare = await runCli(["source", "link", "qiskit", "--root", consumer, "--alias", "q2"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("no workspace given");
    expect(bare.stderr).toContain("assay source link <target-workspace> qiskit");
  });

  it("never indexes a consumer shell, so its alias resolves to nothing", async () => {
    const { home, consumer } = await neighbourWorkspaces();
    await addCopiedSource(home, "qiskit");
    await runCli(["source", "link", home, "qiskit", "--alias", "quantum", "--root", consumer]);

    const parent = path.dirname(consumer);
    const third = path.join(parent, "third");
    expect((await runCli(["init", third, "--name", "Third"])).exitCode).toBe(0);

    const bare = await runCli(["source", "link", "quantum", "--root", third]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("knows no home for 'quantum'");
  });
});
