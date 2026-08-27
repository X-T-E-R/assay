import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureRoot } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  getFrameworkStatus,
  getSourceAdoption,
  importSourceContent,
  initFramework,
  listSourceAdoptions,
  registerSystem,
  removeSourceAdoption,
  setConvertRoadmapProbeForTests,
  sourceAdoptionRecordSchema,
  takeSourceAdoptionMaterial,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(fixtureRoot(), "assay-source-adoptions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  setConvertRoadmapProbeForTests(undefined);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gitInit(cwd: string, message: string): Promise<void> {
  for (const args of [
    ["init"],
    ["config", "user.email", "assay@example.test"],
    ["config", "user.name", "Assay Test"],
    ["add", "."],
    ["commit", "-m", message],
  ]) {
    const result = await execa("git", args, { cwd, reject: false });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  }
}

interface SourceAdoptionFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly observation: string;
}

async function createFixture(name: string): Promise<SourceAdoptionFixture> {
  const root = path.join(await tempDir(), name);
  await initFramework({ target: root, name });

  const sourceRoot = path.join(await tempDir(), "upstream");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  await writeFile(path.join(sourceRoot, "src", "beta.txt"), "beta-v1\n", "utf8");
  const source = await addSource({
    root,
    source: sourceRoot,
    alias: "upstream",
    now: new Date("2026-07-25T08:00:00"),
  });

  const targetRoot = path.join(root, "systems", "product");
  await mkdir(path.join(targetRoot, "integrations"), { recursive: true });
  await writeFile(path.join(targetRoot, "integrations", "alpha.txt"), "target-alpha-v1\n", "utf8");
  await writeFile(path.join(targetRoot, "integrations", "beta.txt"), "target-beta-v1\n", "utf8");
  await registerSystem(root, {
    name: "product",
    path: "systems/product",
    vcs: "none",
    primary: true,
  });

  return { root, sourceRoot, targetRoot, observation: source.observation.observation_id };
}

async function adopt(
  fixture: SourceAdoptionFixture,
  sourcePath: string,
  targetPath: string,
  options: { readonly note?: string } = {},
) {
  return takeSourceAdoptionMaterial({
    root: fixture.root,
    sourceAlias: "upstream",
    sourcePath,
    targetSystem: "product",
    targetPath,
    ...options,
  });
}

describe("Source adoption records", () => {
  it("rejects the retired 0.13 definition token", async () => {
    // The 0.13 definition is not a degraded record to be half-read: `assay
    // update` rewrites it, and nothing else accepts it.
    expect(
      sourceAdoptionRecordSchema.safeParse({
        schema: "assay.source-adoption-definition/v1",
        id: "upstream-product",
        mode: "adapt",
        source: {
          alias: "upstream",
          observation: "obs",
          path: "src/alpha.txt",
          match: "exact",
        },
        target: { system: "product", path: "integrations/alpha.txt", match: "exact" },
        recorded_on: "2026-07-25T09:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("lists an intent that moved two paths as two records and summarizes them", async () => {
    const fixture = await createFixture("AdoptionTwoMappings");
    await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");
    await adopt(fixture, "src/beta.txt", "integrations/beta.txt");

    const listed = await listSourceAdoptions({ root: fixture.root });
    expect(listed.adoptions.map((record) => record.id)).toEqual([
      "upstream-product-src-alpha-txt",
      "upstream-product-src-beta-txt",
    ]);

    // One record is one mapping, so the workspace summary counts mappings,
    // the systems they reach, and how many carry an identity pin.
    expect((await getFrameworkStatus({ root: fixture.root })).sourceAdoptions).toEqual({
      adoptions: 2,
      systems: 1,
      pinned: 2,
    });
  });

  it("keeps global check structural", async () => {
    const fixture = await createFixture("AdoptionCheck");
    const taken = await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some((row) => row.path === taken.path && row.status === "ok"),
      JSON.stringify(check.rows, null, 2),
    ).toBe(true);
    expect(
      check.rows.some((row) => row.path.includes("source-adoptions") && row.status !== "ok"),
    ).toBe(false);
  });

  it("survives upstream movement without becoming wrong", async () => {
    const fixture = await createFixture("AdoptionUpstreamMove");
    const taken = await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");

    await writeFile(path.join(fixture.sourceRoot, "src", "alpha.txt"), "alpha-v2\n", "utf8");
    await importSourceContent({
      root: fixture.root,
      alias: "upstream",
      from: fixture.sourceRoot,
      now: new Date("2026-07-25T10:00:00"),
    });

    // The record says what was adopted, so a newer observation neither rewrites
    // it nor invalidates it. Movement is `assay status`'s answer; `check` stays
    // structural.
    const after = await getSourceAdoption({ root: fixture.root, adoptionId: taken.adoptionId });
    expect(after.record.source.observation).toBe(fixture.observation);
    expect(after.record.source.pin).toEqual(taken.record.source.pin);
    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some((row) => row.path.includes("source-adoptions") && row.status !== "ok"),
    ).toBe(false);
  });

  it("removes the record and leaves the target material alone", async () => {
    const fixture = await createFixture("AdoptionRemove");
    const taken = await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");
    const targetFile = path.join(fixture.targetRoot, "integrations", "alpha.txt");
    const before = await readFile(targetFile, "utf8");

    const removed = await removeSourceAdoption({
      root: fixture.root,
      adoptionId: taken.adoptionId,
    });
    expect(removed.record.target.path).toBe("integrations/alpha.txt");
    expect((await listSourceAdoptions({ root: fixture.root })).adoptions).toEqual([]);
    // Assay never wrote the target material and does not remove it.
    expect(await readFile(targetFile, "utf8")).toBe(before);
    await expect(stat(path.join(fixture.root, removed.path))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      removeSourceAdoption({ root: fixture.root, adoptionId: taken.adoptionId }),
    ).rejects.toThrow(/not found/);
  });

  it("reports a mapping whose system is no longer registered", async () => {
    const fixture = await createFixture("AdoptionUnregisteredSystem");
    const docsRoot = path.join(fixture.root, "systems", "docs");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "docs-v1\n", "utf8");
    await registerSystem(fixture.root, { name: "docs", path: "systems/docs", vcs: "none" });
    const taken = await takeSourceAdoptionMaterial({
      root: fixture.root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "docs",
      targetPath: "alpha.md",
    });

    // The system is dropped from the registry by hand, which is how a mapping
    // outlives its target in practice.
    const registryFile = path.join(fixture.root, ".assay", "systems-registry.json");
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as {
      systems: Record<string, unknown>;
    };
    registry.systems = Object.fromEntries(
      Object.entries(registry.systems).filter(([selector]) => selector !== "docs"),
    );
    await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find((candidate) => candidate.path === taken.path);
    expect(row, JSON.stringify(check.rows, null, 2)).toBeDefined();
    expect(row?.status).toBe("warning");
    expect(row?.message).toContain("no longer registered");
    // Both ways out are named: re-register the system, or drop the mapping.
    expect(row?.message).toContain(`adoption remove ${taken.adoptionId}`);
    expect(
      (await getSourceAdoption({ root: fixture.root, adoptionId: taken.adoptionId })).targetPath,
    ).toBeNull();
  });

  it("names the damaged record file rather than the store", async () => {
    const fixture = await createFixture("AdoptionDamagedRecord");
    const healthy = await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");
    const damaged = await adopt(fixture, "src/beta.txt", "integrations/beta.txt");
    const damagedFile = path.join(fixture.root, damaged.path);
    // A process killed mid-write leaves a partial record behind.
    await writeFile(damagedFile, (await readFile(damagedFile, "utf8")).slice(0, 40), "utf8");

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find((candidate) => candidate.path === damaged.path);
    expect(row, JSON.stringify(check.rows, null, 2)).toBeDefined();
    expect(row?.status).toBe("error");
    expect(row?.message).toContain("not valid JSON");
    // The intact record beside it is not blamed, and list keeps answering.
    expect(check.rows.some((candidate) => candidate.path === healthy.path)).toBe(true);
    expect(check.rows.find((candidate) => candidate.path === healthy.path)?.status).toBe("ok");
  });

  it("reports a record whose filename no longer matches its id", async () => {
    const fixture = await createFixture("AdoptionRenamedRecord");
    const taken = await adopt(fixture, "src/alpha.txt", "integrations/alpha.txt");
    const content = await readFile(path.join(fixture.root, taken.path), "utf8");
    const renamed = ".assay/source-adoptions/hand-renamed.json";
    await writeFile(path.join(fixture.root, ...renamed.split("/")), content, "utf8");
    await rm(path.join(fixture.root, taken.path));

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find((candidate) => candidate.path === renamed);
    expect(row?.status, JSON.stringify(check.rows, null, 2)).toBe("error");
    expect(row?.message).toContain("identity mismatch");
  });

  it("fail-closes an adoption write at a move boundary and carries the record across", async () => {
    const root = path.join(await tempDir(), "root");
    await mkdir(path.join(root, "integrations"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"root"}\n', "utf8");
    await writeFile(path.join(root, "integrations", "alpha.txt"), "target-v1\n", "utf8");
    await gitInit(root, "initial");
    await attachExistingRepo({ root, name: "Root", privacy: "private" });
    const sourceRoot = path.join(await tempDir(), "upstream");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "source-v1\n", "utf8");
    await addSource({ root, source: sourceRoot, alias: "upstream" });
    const taken = await takeSourceAdoptionMaterial({
      root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "root",
      targetPath: "integrations/alpha.txt",
      note: "Concurrent adoption fixture.",
    });

    // Bytes in the store that this version does not recognize are still the
    // workspace's: they travel. A stale lock left by 0.13 does not.
    const opaqueReceipt = path.join(root, ".assay", "source-adoptions", "legacy", "note.bin");
    await mkdir(path.dirname(opaqueReceipt), { recursive: true });
    await writeFile(opaqueReceipt, "unknown-receipt-bytes\n", "utf8");
    await writeFile(
      path.join(root, ".assay", "source-adoptions", "legacy", ".lock"),
      '{"stale":true}\n',
      "utf8",
    );

    const target = path.join(await tempDir(), "converted");
    let reached!: () => void;
    let release!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const continueConversion = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConvertRoadmapProbeForTests(async () => {
      reached();
      await continueConversion;
    });

    const conversion = convertOverlayToStandalone({
      root,
      target,
      move: true,
      keepOverlay: false,
    });
    await atBoundary;
    try {
      await expect(removeSourceAdoption({ root, adoptionId: taken.adoptionId })).rejects.toThrow(
        /workspace conversion/,
      );
    } finally {
      release();
    }
    await conversion;

    const converted = await getSourceAdoption({ root: target, adoptionId: taken.adoptionId });
    expect(converted.record).toEqual(taken.record);
    await expect(
      stat(path.join(target, ".assay", "source-adoptions", "legacy", ".lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(path.join(target, ".assay", "source-adoptions", "legacy", "note.bin"), "utf8"),
    ).toBe("unknown-receipt-bytes\n");

    // The mutation the boundary refused is the operator's to retry, and it
    // works in the converted workspace.
    const removed = await removeSourceAdoption({ root: target, adoptionId: taken.adoptionId });
    expect(removed.adoptionId).toBe(taken.adoptionId);
  }, 45_000);

  it("fails conversion before target writes when an adopted system no longer resolves", async () => {
    const root = path.join(await tempDir(), "preflight-root");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"preflight-root"}\n', "utf8");
    await gitInit(root, "initial");
    await attachExistingRepo({ root, name: "Preflight Root", privacy: "private" });
    const sourceRoot = path.join(await tempDir(), "preflight-upstream");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "source-v1\n", "utf8");
    await addSource({ root, source: sourceRoot, alias: "upstream" });
    const docsRoot = path.join(root, "docs-system");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "docs-v1\n", "utf8");
    await registerSystem(root, { name: "docs", path: "docs-system", vcs: "none" });
    await takeSourceAdoptionMaterial({
      root,
      sourceAlias: "upstream",
      sourcePath: "src/alpha.txt",
      targetSystem: "docs",
      targetPath: "alpha.md",
    });
    await rm(docsRoot, { recursive: true, force: true });
    const target = path.join(await tempDir(), "preflight-converted");

    await expect(convertOverlayToStandalone({ root, target })).rejects.toThrow(
      /target system 'docs' does not resolve before conversion/,
    );
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
