import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  getSourceAdoption,
  initFramework,
  registerSystem,
  takeSourceAdoptionMaterial,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-source-adoption-take");

afterEach(async () => {
  await tempDirs.cleanup();
});

interface Fixture {
  readonly root: string;
  readonly targetRoot: string;
  readonly observation: string;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });

  const sourceRoot = path.join(await tempDirs.createTempDir(), "upstream");
  await mkdir(path.join(sourceRoot, "src", "agents"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  await writeFile(path.join(sourceRoot, "src", "agents", "loop.py"), "loop\n", "utf8");
  const source = await addSource({ root, source: sourceRoot, alias: "upstream" });

  const targetRoot = path.join(root, "systems", "product");
  await mkdir(path.join(targetRoot, "integrations"), { recursive: true });
  await writeFile(path.join(targetRoot, "integrations", "alpha.txt"), "target-v1\n", "utf8");
  await registerSystem(root, {
    name: "product",
    path: "systems/product",
    vcs: "none",
    primary: true,
  });

  return { root, targetRoot, observation: source.observation.observation_id };
}

/**
 * Create a directory link at `linkPath`, returning false when the platform
 * refuses (unprivileged Windows without developer mode). A skipped link means
 * the escape being tested cannot be constructed here.
 */
async function createDirectoryLink(target: string, linkPath: string): Promise<boolean> {
  for (const type of ["junction", "dir"] as const) {
    try {
      await symlink(target, linkPath, type);
      return (await lstat(linkPath)).isSymbolicLink() || (await exists(linkPath));
    } catch {
      // Try the next link type.
    }
  }
  return false;
}

describe("Source adoption take", () => {
  it("fails an old workspace tuple before validating or writing anything", async () => {
    const fixture = await createFixture("OldTupleAdoption");
    const manifestFile = path.join(fixture.root, ".assay", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
      framework_version: string;
      minimum_assay_version: string;
      layout_version: number;
      layout: { version: number; paths: Record<string, string> };
    };
    manifest.framework_version = "0.9.0";
    manifest.minimum_assay_version = "0.9.0";
    manifest.layout_version = 6;
    manifest.layout.version = 6;
    const { sources: _currentSources, ...oldPaths } = manifest.layout.paths;
    manifest.layout.paths = { ...oldPaths, references: "references" };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "product",
        targetPath: "integrations/alpha.txt",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CUTOVER_REQUIRED" });
    // The gate runs before the mutation lock, so a refused command leaves no
    // coordination state behind for the next run to clean up.
    await expect(stat(path.join(fixture.root, ".assay", "coordination"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("derives the record from the two endpoints and nothing else", async () => {
    const fixture = await createFixture("AdoptionTakeDerived");
    const taken = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "integrations/alpha.txt",
      note: "The parser shape is the part we needed.",
      now: new Date("2026-07-25T09:00:00"),
    });

    expect(taken.adoptionId).toBe("upstream-product-src-alpha-txt");
    expect(taken.path).toBe(".assay/source-adoptions/upstream-product-src-alpha-txt.json");
    expect(taken.targetPresent).toBe(true);
    expect(taken.record.source).toMatchObject({
      alias: "upstream",
      observation: fixture.observation,
      path: "src/alpha.txt",
      match: "exact",
    });
    expect(taken.record.target).toEqual({
      system: "product",
      path: "integrations/alpha.txt",
      match: "exact",
    });
    expect(taken.record.mode).toBe("adapt");
    expect(taken.record.note).toBe("The parser shape is the part we needed.");
    expect(taken.record.recorded_on.startsWith("2026-07-25T09:00:00")).toBe(true);

    // Copied content has no commit to cite, so the tier-1 pin is the content
    // fingerprint — the one place a copied tree gets hashed outside an explicit
    // `source capture`.
    expect(taken.record.source.pin).toMatchObject({
      kind: "content-hash",
      algorithm: "sha256-tree-v1",
    });

    const stored = await getSourceAdoption({
      root: fixture.root,
      adoptionId: taken.adoptionId,
    });
    expect(stored.record).toEqual(taken.record);
    expect(stored.targetPath).toBe("systems/product/integrations/alpha.txt");
    expect(await readFile(path.join(fixture.root, taken.path), "utf8")).toContain(
      '"schema": "assay.source-adoption/v1"',
    );
  });

  it("pins a checkout-backed source by commit and origin, for free", async () => {
    const root = path.join(await tempDirs.createTempDir(), "AdoptionGitPin");
    await initFramework({ target: root, name: "AdoptionGitPin" });
    const upstream = path.join(await tempDirs.createTempDir(), "upstream-git");
    await mkdir(path.join(upstream, "src"), { recursive: true });
    await writeFile(path.join(upstream, "src", "alpha.txt"), "alpha-v1\n", "utf8");
    for (const args of [
      ["init"],
      ["config", "user.email", "assay@example.test"],
      ["config", "user.name", "Assay Test"],
      ["add", "."],
      ["commit", "-m", "initial upstream"],
    ]) {
      const result = await execa("git", args, { cwd: upstream, reject: false });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    }
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: upstream })).stdout.trim();

    await addSource({ root, source: upstream, alias: "upstream" });
    const system = path.join(root, "systems", "product");
    await mkdir(system, { recursive: true });
    await writeFile(path.join(system, "alpha.txt"), "target\n", "utf8");
    await registerSystem(root, {
      name: "product",
      path: "systems/product",
      vcs: "none",
      primary: true,
    });

    const taken = await takeSourceAdoptionMaterial({
      root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "alpha.txt",
    });
    expect(taken.record.source.pin?.kind).toBe("git-commit");
    expect(taken.record.source.pin).toMatchObject({ commit: head });
    // The commit alone does not say which repository it is a commit of.
    const pin = taken.record.source.pin;
    expect(pin?.kind === "git-commit" ? pin.origin : null).toContain("upstream-git");
  }, 30_000);

  it("infers a directory locator and records the requested mode", async () => {
    const fixture = await createFixture("AdoptionTakeDirectory");
    const taken = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/agents",
      targetSystem: "product",
      targetPath: "integrations",
      mode: "copy",
    });

    expect(taken.record.mode).toBe("copy");
    expect(taken.record.source.match).toBe("prefix");
    expect(taken.record.target.match).toBe("prefix");
  });

  it("records a target that is not on disk yet, and says so", async () => {
    const fixture = await createFixture("AdoptionTakeDraftTarget");
    const taken = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "integrations/planned.txt",
    });
    // Recording where material landed is not a claim that the file is still
    // there under that name, so a missing target is reported, not refused.
    expect(taken.targetPresent).toBe(false);
    expect(
      (await getSourceAdoption({ root: fixture.root, adoptionId: taken.adoptionId })).targetPresent,
    ).toBe(false);
  });

  it("names --id when the derived id is already taken", async () => {
    const fixture = await createFixture("AdoptionTakeCollision");
    await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "integrations/alpha.txt",
    });

    // The derived id is source + system + source path, so adopting the same
    // path into a second place in the same system collides. The error has to
    // name the way out.
    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "product",
        targetPath: "integrations/alpha-copy.txt",
      }),
    ).rejects.toThrow(/needs `--id <adoption-id>`/);

    const second = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "integrations/alpha-copy.txt",
      adoptionId: "upstream-product-alpha-copy",
    });
    expect(second.adoptionId).toBe("upstream-product-alpha-copy");
  });

  it("refuses a source path the observation does not contain", async () => {
    const fixture = await createFixture("AdoptionTakeMissingSource");
    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/nowhere.txt",
        targetSystem: "product",
        targetPath: "integrations/nowhere.txt",
      }),
    ).rejects.toThrow(/source path does not exist/);
  });

  it("refuses an unregistered target system", async () => {
    const fixture = await createFixture("AdoptionTakeUnknownSystem");
    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "not-registered",
        targetPath: "integrations/alpha.txt",
      }),
    ).rejects.toThrow(/registered target system not found/);
  });

  it("refuses a target path that is not relative to the registered system", async () => {
    const fixture = await createFixture("AdoptionTakeAbsolute");
    for (const targetPath of ["C:/elsewhere/alpha.txt", "/etc/alpha.txt", "../outside/alpha.txt"]) {
      await expect(
        takeSourceAdoptionMaterial({
          root: fixture.root,
          sourceAlias: "upstream",
          sourcePath: "src/alpha.txt",
          targetSystem: "product",
          targetPath,
        }),
      ).rejects.toThrow(/contained relative path/);
    }
  });

  it("refuses a target path that escapes the system through a symbolic link", async () => {
    const fixture = await createFixture("AdoptionTakeSymlink");
    const outside = path.join(await tempDirs.createTempDir(), "outside");
    await mkdir(path.join(outside, "src"), { recursive: true });
    await writeFile(path.join(outside, "src", "a.txt"), "outside-bytes\n", "utf8");
    const linkPath = path.join(fixture.targetRoot, "link");
    if (!(await createDirectoryLink(outside, linkPath))) return;

    // Textually inside systems/product, actually outside it. A record that
    // claims this system holds the material would be false.
    for (const targetPath of ["link/src/a.txt", "link/not-created-yet.txt"]) {
      await expect(
        takeSourceAdoptionMaterial({
          root: fixture.root,
          sourceAlias: "upstream",
          sourcePath: "src/alpha.txt",
          targetSystem: "product",
          targetPath,
        }),
      ).rejects.toThrow(/escapes registered system through a symbolic link/);
    }
    expect(await exists(path.join(fixture.root, ".assay", "source-adoptions"))).toBe(false);
  });
});
