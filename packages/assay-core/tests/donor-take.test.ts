import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture } from "assay-test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  getDonorAdoption,
  initFramework,
  registerDonorAdoption,
  registerSystem,
  takeDonorMaterial,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-donor-take");

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

describe("donor take", () => {
  it("registers the same definition a hand-written single mapping would", async () => {
    const taken = await createFixture("DonorTakeSynth");
    const takeResult = await takeDonorMaterial({
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
    const handWritten = await createFixture("DonorTakeHandWritten");
    const registered = await registerDonorAdoption({
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

    // And it is a real adoption, readable by the ordinary donor commands.
    const stored = await getDonorAdoption({
      root: taken.root,
      adoptionId: takeResult.adoptionId,
    });
    expect(stored.definitionDigest).toBe(takeResult.definitionDigest);
    expect(stored.state.targets.product?.baseline).toBeNull();
  });

  it("records the requested mode and infers a directory locator", async () => {
    const fixture = await createFixture("DonorTakeDirectory");
    const result = await takeDonorMaterial({
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
    const fixture = await createFixture("DonorTakeMissing");
    await expect(
      takeDonorMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/nowhere.txt",
        targetSystem: "product",
        targetPath: "integrations/nowhere.txt",
      }),
    ).rejects.toThrow(/does not resolve in observation/);
  });

  it("refuses a target path that is not relative to the registered system", async () => {
    const fixture = await createFixture("DonorTakeAbsolute");
    await expect(
      takeDonorMaterial({
        root: fixture.root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "product",
        targetPath: "C:/elsewhere/alpha.txt",
      }),
    ).rejects.toThrow(/contained relative path/);
  });
});
