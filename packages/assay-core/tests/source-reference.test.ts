import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  addSource,
  attachExistingRepo,
  captureSource,
  checkFramework,
  diffSource,
  findClonesByAlias,
  findClonesByOrigin,
  getSourceLog,
  getSourceStatus,
  initFramework,
  linkSource,
  loadManifest,
  normalizeOriginUri,
  recordSourceClone,
  resolveSourceHome,
  setWorkspaceMutationProbeForTests,
  syncSource,
  unlinkSource,
} from "../src/index.js";

/**
 * Source references and the clone registry.
 *
 * The cases here are the ones the design says must not be allowed to rot: a
 * write through a reference has to land in the home and nowhere else, a removal
 * must never follow the pointer, and a home that moved must fail locally rather
 * than half-work. The registry is exercised only as a hint — every assertion
 * about it also holds when the file is deleted.
 */

const tempRoots: string[] = [];
const GIT_TIMEOUT_MS = 45_000;

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-source-ref-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
}

/** A workspace of the given layout, so resolution is proven against both. */
async function workspace(
  name: string,
  mode: "standalone" | "overlay" = "standalone",
): Promise<string> {
  const root = path.join(await tempDir(), name);
  if (mode === "standalone") {
    await initFramework({ target: root, name });
    return root;
  }
  await mkdir(root, { recursive: true });
  await git(root, ["init"]);
  await attachExistingRepo({ root, name, privacy: "private" });
  return root;
}

async function gitRepo(name: string, body: string): Promise<string> {
  const repo = path.join(await tempDir(), name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "assay@example.test"]);
  await git(repo, ["config", "user.name", "Assay Test"]);
  await writeFile(path.join(repo, "README.md"), body, "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  return repo;
}

/** A copied Source, cheap enough for the cases that do not need Git. */
async function copiedSource(root: string, alias: string, registryFile: string): Promise<string> {
  const material = path.join(await tempDir(), `${alias}-material`);
  await mkdir(material, { recursive: true });
  await writeFile(path.join(material, "README.md"), `# ${alias}\n`, "utf8");
  await addSource({ root, source: material, alias, registryFile });
  return material;
}

/** Registry file inside a temp directory, never the developer's real one. */
async function registryFile(): Promise<string> {
  return path.join(await tempDir(), "clone-registry.json");
}

function sourcesRelativeFor(mode: "standalone" | "overlay"): string {
  return mode === "overlay" ? path.join(".assay", "sources") : "sources";
}

async function referenceRecord(
  root: string,
  alias: string,
  mode: "standalone" | "overlay" = "standalone",
): Promise<Record<string, unknown>> {
  const file = path.join(root, sourcesRelativeFor(mode), alias, "source.ref.yaml");
  return parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("source reference resolution", () => {
  it.each(["standalone", "overlay"] as const)(
    "resolves a %s target workspace and reads through to its ledger",
    async (mode) => {
      const registry = await registryFile();
      const home = await workspace("home", mode);
      const consumer = await workspace("consumer");
      await copiedSource(home, "qiskit", registry);

      const linked = await linkSource({
        root: consumer,
        workspace: home,
        source: "qiskit",
        registryFile: registry,
      });
      expect(linked.created).toBe(true);
      expect(linked.home.workspace).toBe(home);
      expect(linked.home.alias).toBe("qiskit");

      const record = await referenceRecord(consumer, "qiskit");
      expect(record.schema).toBe("assay.source-reference/v1");
      expect(record.source).toBe("qiskit");

      const status = await getSourceStatus({ root: consumer });
      expect(status.broken).toEqual([]);
      expect(status.sources).toHaveLength(1);
      const entry = status.sources[0];
      expect(entry?.relation).toBe("ref");
      expect(entry?.reference?.homeRoot).toBe(home);
      expect(entry?.absolutePath).toBe(path.join(home, sourcesRelativeFor(mode), "qiskit"));

      const log = await getSourceLog({ root: consumer, alias: "qiskit" });
      expect(log.entries).toHaveLength(1);
      expect(log.reference?.homeRoot).toBe(home);
    },
    GIT_TIMEOUT_MS,
  );

  it("keeps the shell thin: no checkout, content, observations, or captures", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const shell = path.join(consumer, "sources", "qiskit");
    expect(await readdir(shell)).toEqual(["source.ref.yaml"]);
  });

  it("refuses a shell that also holds material", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    await mkdir(path.join(consumer, "sources", "qiskit", "checkout"), { recursive: true });

    await expect(getSourceStatus({ root: consumer })).rejects.toThrow(/thin pointer|checkout/i);
  });

  it("records a relative workspace path and resolves it back", async () => {
    const registry = await registryFile();
    const shared = await tempDir();
    const home = path.join(shared, "shared-research");
    const consumer = path.join(shared, "product");
    await initFramework({ target: home, name: "Shared Research" });
    await initFramework({ target: consumer, name: "Product" });
    await copiedSource(home, "qiskit", registry);

    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    const record = await referenceRecord(consumer, "qiskit");
    expect(record.workspace).toBe("../shared-research");

    const resolved = await resolveSourceHome({ root: consumer, alias: "qiskit" });
    expect(resolved.homeWorkspace).toBe(home);
  });

  it("resolves a recorded absolute path with a drive letter, whatever its casing", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    // A hand-edited shell is a supported shape: absolute is allowed, and on
    // Windows the drive letter's case is not information.
    const recased =
      process.platform === "win32" ? home.charAt(0).toLowerCase() + home.slice(1) : home;
    await writeFile(
      path.join(consumer, "sources", "qiskit", "source.ref.yaml"),
      ["schema: assay.source-reference/v1", `workspace: ${recased}`, "source: qiskit", ""].join(
        "\n",
      ),
      "utf8",
    );

    const resolved = await resolveSourceHome({ root: consumer, alias: "qiskit" });
    expect(resolved.relation).toBe("ref");
    expect(path.resolve(resolved.homeWorkspace).toLowerCase()).toBe(home.toLowerCase());
  });

  it("lets the local alias differ from the target alias", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);

    const linked = await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      alias: "quantum",
      registryFile: registry,
    });
    expect(linked.alias).toBe("quantum");
    expect(linked.home.alias).toBe("qiskit");

    const resolved = await resolveSourceHome({ root: consumer, alias: "quantum" });
    expect(resolved.homeAlias).toBe("qiskit");
    expect(await exists(path.join(consumer, "sources", "quantum", "source.ref.yaml"))).toBe(true);

    const status = await getSourceStatus({ root: consumer });
    expect(status.sources.map((entry) => entry.alias)).toEqual(["quantum"]);
  });

  it("flattens a reference chain at link time so runtime is one hop", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const middle = await workspace("middle");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: middle,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const linked = await linkSource({
      root: consumer,
      workspace: middle,
      source: "qiskit",
      registryFile: registry,
    });
    expect(linked.flattenedHops).toBe(1);
    expect(linked.home.workspace).toBe(home);
    expect(linked.notices.some((notice) => /Flattened/.test(notice))).toBe(true);

    const record = await referenceRecord(consumer, "qiskit");
    expect(path.resolve(consumer, String(record.workspace))).toBe(home);
  });

  it("reports linking an already-linked target instead of failing", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const again = await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    expect(again.created).toBe(false);
    expect(again.alreadyLinkedAs).toBe("qiskit");
    expect(again.notices.some((notice) => /Already linked/.test(notice))).toBe(true);
  });

  it("refuses to link a Source this workspace already owns", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    await copiedSource(home, "qiskit", registry);

    await expect(
      linkSource({ root: home, workspace: home, source: "qiskit", registryFile: registry }),
    ).rejects.toThrow(/owned by this workspace/);
  });

  it("does not consume a manifest layout entry for the shell", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);

    const before = await loadManifest(consumer);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    const after = await loadManifest(consumer);

    expect(after?.layout.entries).toEqual(before?.layout.entries);
    expect(after?.layout.entries.some((entry) => entry.path.includes("sources/qiskit"))).toBe(
      false,
    );
  });
});

describe("source reference write-through", () => {
  it(
    "syncs into the home workspace and leaves the consumer shell untouched",
    async () => {
      const registry = await registryFile();
      const repo = await gitRepo("upstream", "# Upstream\nv1\n");
      const home = await workspace("home");
      const consumer = await workspace("consumer");
      await addSource({ root: home, source: repo, alias: "qiskit", registryFile: registry });
      await linkSource({
        root: consumer,
        workspace: home,
        source: "qiskit",
        registryFile: registry,
      });

      await writeFile(path.join(repo, "README.md"), "# Upstream\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);

      const notices: string[] = [];
      const synced = await syncSource({
        root: consumer,
        alias: "qiskit",
        registryFile: registry,
        onNotice: (notice) => notices.push(notice),
      });

      // The result names the home, and said so before doing the work.
      expect(synced.root).toBe(home);
      expect(synced.reference?.homeRoot).toBe(home);
      expect(notices.some((notice) => notice.includes(home))).toBe(true);

      const homeObservations = await readdir(path.join(home, "sources", "qiskit", "observations"));
      expect(homeObservations).toHaveLength(2);
      expect(await readdir(path.join(consumer, "sources", "qiskit"))).toEqual(["source.ref.yaml"]);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "runs under the home workspace's mutation coordination, not the consumer's",
    async () => {
      const registry = await registryFile();
      const repo = await gitRepo("upstream", "# Upstream\nv1\n");
      const home = await workspace("home");
      const consumer = await workspace("consumer");
      await addSource({ root: home, source: repo, alias: "qiskit", registryFile: registry });
      await linkSource({
        root: consumer,
        workspace: home,
        source: "qiskit",
        registryFile: registry,
      });

      // The lock this write takes is the home's, named by the coordinator itself.
      const acquired: string[] = [];
      setWorkspaceMutationProbeForTests(async (phase, root) => {
        if (phase === "after-acquire") acquired.push(root);
      });
      try {
        const synced = await syncSource({
          root: consumer,
          alias: "qiskit",
          registryFile: registry,
        });
        expect(synced.root).toBe(home);
      } finally {
        setWorkspaceMutationProbeForTests(undefined);
      }
      expect(acquired).toContain(home);
      expect(acquired).not.toContain(consumer);

      // And a fail-closed boundary in the home stops the write, which a shared
      // Source being converted or moved is exactly what that boundary is for.
      const boundary = path.join(home, ".assay", "coordination", "conversion-boundary");
      await mkdir(path.dirname(boundary), { recursive: true });
      await writeFile(boundary, "", "utf8");
      await expect(
        syncSource({ root: consumer, alias: "qiskit", registryFile: registry }),
      ).rejects.toThrow(/conversion is in progress/);
      await rm(boundary, { force: true });
    },
    GIT_TIMEOUT_MS,
  );

  it("captures into the home and reports the reference", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const captured = await captureSource({ root: consumer, alias: "qiskit", note: "pinned" });
    expect(captured.root).toBe(home);
    expect(captured.reference?.homeRoot).toBe(home);
    expect(await exists(path.join(home, "sources", "qiskit", "captures"))).toBe(true);
    expect(await exists(path.join(consumer, "sources", "qiskit", "captures"))).toBe(false);

    const diffed = await diffSource({ root: consumer, alias: "qiskit" });
    expect(diffed.reference?.homeRoot).toBe(home);
  });

  it("deletes only the local shell on unlink, never the Source", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const unlinked = await unlinkSource({ root: consumer, alias: "qiskit" });
    expect(unlinked.homeWorkspace).toBe(home);
    expect(unlinked.homeReachable).toBe(true);
    expect(await exists(path.join(consumer, "sources", "qiskit"))).toBe(false);
    expect(await exists(path.join(home, "sources", "qiskit", "source.yaml"))).toBe(true);
    expect(await exists(path.join(home, "sources", "qiskit", "content"))).toBe(true);

    const homeStatus = await getSourceStatus({ root: home });
    expect(homeStatus.sources.map((entry) => entry.alias)).toEqual(["qiskit"]);
  });

  it("refuses to unlink a Source this workspace owns", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    await copiedSource(home, "qiskit", registry);

    await expect(unlinkSource({ root: home, alias: "qiskit" })).rejects.toThrow(
      /owned by this workspace/,
    );
    expect(await exists(path.join(home, "sources", "qiskit", "source.yaml"))).toBe(true);
  });
});

describe("broken source references", () => {
  it("stays local: listed as broken, commands fail, the rest of the workspace works", async () => {
    const registry = await registryFile();
    const shared = await tempDir();
    const home = path.join(shared, "shared-research");
    const consumer = path.join(shared, "product");
    await initFramework({ target: home, name: "Shared Research" });
    await initFramework({ target: consumer, name: "Product" });
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    await rename(home, path.join(shared, "shared-research-moved"));

    const status = await getSourceStatus({ root: consumer });
    expect(status.sources).toEqual([]);
    expect(status.broken).toHaveLength(1);
    expect(status.broken[0]?.alias).toBe("qiskit");
    expect(status.broken[0]?.display).toBe("../shared-research#qiskit");
    expect(status.broken[0]?.reason).toMatch(/not there/);

    await expect(syncSource({ root: consumer, alias: "qiskit" })).rejects.toThrow(
      /broken reference/,
    );
    await expect(resolveSourceHome({ root: consumer, alias: "qiskit" })).rejects.toThrow(
      /broken reference/,
    );

    // A structure finding, not a scan for the home and not a repair.
    const check = await checkFramework({ root: consumer });
    const finding = check.rows.find((row) => row.path.includes("qiskit"));
    expect(finding?.status).toBe("error");
    expect(finding?.message).toMatch(/broken reference/);
    expect(await exists(path.join(consumer, "sources", "qiskit", "source.ref.yaml"))).toBe(true);
  });

  it("unlinks a broken reference without touching anything else", async () => {
    const registry = await registryFile();
    const shared = await tempDir();
    const home = path.join(shared, "home");
    const consumer = path.join(shared, "consumer");
    await initFramework({ target: home, name: "Home" });
    await initFramework({ target: consumer, name: "Consumer" });
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });
    await rename(home, path.join(shared, "home-moved"));

    const unlinked = await unlinkSource({ root: consumer, alias: "qiskit" });
    expect(unlinked.homeReachable).toBe(false);
    expect(unlinked.homeWorkspace).toBe(home);
    expect(await exists(path.join(consumer, "sources", "qiskit"))).toBe(false);
    expect(await exists(path.join(shared, "home-moved", "sources", "qiskit", "source.yaml"))).toBe(
      true,
    );
  });

  it("appends the registry's current location when one verifies", async () => {
    const registry = await registryFile();
    const shared = await tempDir();
    const home = path.join(shared, "home");
    const consumer = path.join(shared, "consumer");
    await initFramework({ target: home, name: "Home" });
    await initFramework({ target: consumer, name: "Consumer" });
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const moved = path.join(shared, "home-moved");
    await rename(home, moved);
    await recordSourceClone({
      workspace: moved,
      alias: "qiskit",
      origin: "https://example.test/qiskit.git",
      registryFile: registry,
    });

    const status = await getSourceStatus({ root: consumer, registryFile: registry });
    expect(status.broken[0]?.suggestions.some((line) => line.includes(moved))).toBe(true);

    // Without the registry the failure is the same, minus the suggestion.
    const withoutRegistry = await getSourceStatus({
      root: consumer,
      registryFile: path.join(shared, "missing-registry.json"),
    });
    expect(withoutRegistry.broken).toHaveLength(1);
    expect(withoutRegistry.broken[0]?.suggestions).toEqual([]);
  });

  it("rejects a shell that declares a branch, revision, or pin", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    for (const field of ["branch", "revision", "pin"]) {
      await writeFile(
        path.join(consumer, "sources", "qiskit", "source.ref.yaml"),
        [
          "schema: assay.source-reference/v1",
          `workspace: ${path.relative(consumer, home).split(path.sep).join("/")}`,
          "source: qiskit",
          `${field}: main`,
          "",
        ].join("\n"),
        "utf8",
      );
      await expect(getSourceStatus({ root: consumer })).rejects.toThrow(
        new RegExp(`must not declare '${field}'`),
      );
    }
  });
});

describe("clone registry", () => {
  it("collapses spellings of one origin into a single key", () => {
    const canonical = normalizeOriginUri("https://github.com/Qiskit/qiskit.git");
    expect(normalizeOriginUri("https://github.com/qiskit/qiskit")).toBe(canonical);
    expect(normalizeOriginUri("git@github.com:Qiskit/qiskit.git")).toBe(canonical);
    expect(normalizeOriginUri("ssh://git@github.com/Qiskit/qiskit/")).toBe(canonical);
    expect(normalizeOriginUri("")).toBe("");
  });

  it("records homes on add and finds them by origin", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const material = await copiedSource(home, "qiskit", registry);

    const found = await findClonesByOrigin(material, { registryFile: registry });
    expect(found).toHaveLength(1);
    expect(found[0]?.workspace).toBe(home);
    expect(found[0]?.alias).toBe("qiskit");
    expect(path.isAbsolute(found[0]?.workspace ?? "")).toBe(true);
  });

  it("advises linking instead of a second clone, then proceeds anyway", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const other = await workspace("other");
    const material = await copiedSource(home, "qiskit", registry);

    const notices: string[] = [];
    const added = await addSource({
      root: other,
      source: material,
      alias: "qiskit",
      registryFile: registry,
      onNotice: (notice) => notices.push(notice),
    });

    expect(added.path).toBe("sources/qiskit");
    expect(notices.some((notice) => notice.includes(home))).toBe(true);
    expect(notices.some((notice) => /source link/.test(notice))).toBe(true);
    expect(added.notices.some((notice) => notice.includes(home))).toBe(true);
  });

  it("resolves a bare link through the registry when exactly one home verifies", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);

    const linked = await linkSource({
      root: consumer,
      source: "qiskit",
      registryFile: registry,
    });
    expect(linked.home.workspace).toBe(home);
    expect(linked.notices.some((notice) => notice.includes(home))).toBe(true);
  });

  it("lists every candidate and stops when the registry knows more than one", async () => {
    const registry = await registryFile();
    const first = await workspace("first");
    const second = await workspace("second");
    const consumer = await workspace("consumer");
    await copiedSource(first, "qiskit", registry);
    await copiedSource(second, "qiskit", registry);

    const failure = linkSource({ root: consumer, source: "qiskit", registryFile: registry });
    await expect(failure).rejects.toThrow(/knows 2 homes/);
    await expect(failure).rejects.toThrow(new RegExp(first.replace(/\\/g, "\\\\")));
    await expect(failure).rejects.toThrow(new RegExp(second.replace(/\\/g, "\\\\")));
  });

  it("drops entries whose workspace or alias no longer verifies", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const material = await copiedSource(home, "qiskit", registry);
    await recordSourceClone({
      workspace: path.join(await tempDir(), "never-existed"),
      alias: "qiskit",
      origin: material,
      registryFile: registry,
    });

    const found = await findClonesByAlias("qiskit", { registryFile: registry });
    expect(found).toHaveLength(1);
    expect(found[0]?.workspace).toBe(home);

    // The prune is persisted, not just filtered out of the answer.
    const persisted = JSON.parse(await readFile(registry, "utf8")) as {
      readonly entries: readonly unknown[];
    };
    expect(persisted.entries).toHaveLength(1);
  });

  it("never records a consumer's reference shell", async () => {
    const registry = await registryFile();
    const home = await workspace("home");
    const consumer = await workspace("consumer");
    await copiedSource(home, "qiskit", registry);
    await linkSource({
      root: consumer,
      workspace: home,
      source: "qiskit",
      registryFile: registry,
    });

    const found = await findClonesByAlias("qiskit", { registryFile: registry });
    expect(found.map((entry) => entry.workspace)).toEqual([home]);
  });

  it("treats a missing or malformed file as an empty cache", async () => {
    const directory = await tempDir();
    const missing = path.join(directory, "nope.json");
    expect(await findClonesByAlias("qiskit", { registryFile: missing })).toEqual([]);

    const malformed = path.join(directory, "broken.json");
    await writeFile(malformed, "{ not json", "utf8");
    expect(await findClonesByAlias("qiskit", { registryFile: malformed })).toEqual([]);
  });

  it("keeps working when the registry cannot be written", async () => {
    const registry = path.join(await tempDir(), "as-a-directory");
    await mkdir(registry, { recursive: true });
    const home = await workspace("home");

    // The file path is a directory, so every write fails. The command does not.
    const added = await copiedSource(home, "qiskit", registry);
    expect(added).toBeTruthy();
    const status = await getSourceStatus({ root: home, registryFile: registry });
    expect(status.sources.map((entry) => entry.alias)).toEqual(["qiskit"]);
  });
});
