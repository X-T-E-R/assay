import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture } from "assay-test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  getSourceAdoption,
  initFramework,
  registerSourceAdoption,
  registerSystem,
  takeSourceAdoptionMaterial,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-source-adoption-take");

afterEach(async () => {
  await tempDirs.cleanup();
});

interface Fixture {
  readonly root: string;
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

  const system = path.join(root, "systems", "product");
  await mkdir(path.join(system, "integrations"), { recursive: true });
  await writeFile(path.join(system, "integrations", "alpha.txt"), "target-v1\n", "utf8");
  await registerSystem(root, {
    name: "product",
    path: "systems/product",
    vcs: "none",
    primary: true,
  });

  return { root, observation: source.observation.observation_id };
}

describe("Source adoption take", () => {
  it("fails an old workspace tuple before validating or writing Source adoption input", async () => {
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
      registerSourceAdoption({ root: fixture.root, definition: {} }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CUTOVER_REQUIRED" });
    await expect(stat(path.join(fixture.root, ".assay", "coordination"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers the same definition a hand-written single mapping would", async () => {
    const taken = await createFixture("AdoptionTakeSynth");
    const takeResult = await takeSourceAdoptionMaterial({
      root: taken.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "product",
      targetPath: "integrations/alpha.txt",
    });

    expect(takeResult.adoptionId).toBe("upstream-product-src-alpha-txt");
    expect(takeResult.targetId).toBe("product");
    expect(takeResult.mappingId).toBe("src-alpha-txt");
    expect(takeResult.match).toBe("exact");
    expect(takeResult.observation).toBe(taken.observation);

    // The same relationship, written out by hand in a second workspace.
    const handWritten = await createFixture("AdoptionTakeHandWritten");
    const registered = await registerSourceAdoption({
      root: handWritten.root,
      definition: {
        schema: "assay.donor-adoption/v1",
        id: "upstream-product-src-alpha-txt",
        source: { alias: "upstream", observation: handWritten.observation },
        targets: [{ id: "product", system: "product" }],
        mappings: [
          {
            id: "src-alpha-txt",
            source: { path: "src/alpha.txt" },
            target: { target_id: "product", path: "integrations/alpha.txt" },
          },
        ],
      },
    });

    // Identical content digest: the synthesized definition is the hand-written
    // one, not a lookalike with extra fields or different defaults.
    expect(takeResult.definitionDigest).toBe(registered.definitionDigest);
    expect(takeResult.definition).toEqual(registered.definition);

    // And it is a real adoption, readable by the ordinary Source adoption commands.
    const stored = await getSourceAdoption({
      root: taken.root,
      adoptionId: takeResult.adoptionId,
    });
    expect(stored.definitionDigest).toBe(takeResult.definitionDigest);
    expect(stored.state.targets.product?.baseline).toBeNull();
  });

  it("records the requested mode and infers a directory locator", async () => {
    const fixture = await createFixture("AdoptionTakeDirectory");
    const result = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/agents",
      targetSystem: "product",
      targetPath: "integrations",
      mode: "copy",
    });

    expect(result.match).toBe("prefix");
    const mapping = result.definition.mappings[0];
    expect(mapping?.mode).toBe("copy");
    expect(mapping?.source).toEqual({ path: "src/agents", match: "prefix" });
    expect(mapping?.target).toEqual({
      target_id: "product",
      path: "integrations",
      match: "prefix",
    });
  });

  it("refuses a source path the observation does not contain", async () => {
    const fixture = await createFixture("AdoptionTakeMissing");
    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/nowhere.txt",
        targetSystem: "product",
        targetPath: "integrations/nowhere.txt",
      }),
    ).rejects.toThrow(/does not resolve in observation/);
  });

  it("refuses a target path that is not relative to the registered system", async () => {
    const fixture = await createFixture("AdoptionTakeAbsolute");
    await expect(
      takeSourceAdoptionMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "product",
        targetPath: "C:/elsewhere/alpha.txt",
      }),
    ).rejects.toThrow(/contained relative path/);
  });
});
