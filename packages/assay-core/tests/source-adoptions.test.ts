import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  decideSourceAdoption,
  getFrameworkStatus,
  getSourceAdoption,
  getSourceAdoptionHistory,
  getSourceAdoptionStatus,
  importSourceContent,
  initFramework,
  inspectSourceAdoption,
  listSourceAdoptions,
  recordSourceAdoptionEvidence,
  recordSourceAdoptionRollback,
  registerSourceAdoption,
  registerSystem,
  setConvertRoadmapProbeForTests,
  sourceAdoptionDefinitionSchema,
  updateSourceAdoption,
  updateSystem,
  verifySourceAdoptionInspection,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-source-adoptions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  setConvertRoadmapProbeForTests(undefined);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  await writeFile(path.join(sourceRoot, "LICENSE"), "Example license v1\n", "utf8");
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

  return {
    root,
    sourceRoot,
    targetRoot,
    observation: source.observation.observation_id,
  };
}

function definition(
  fixture: SourceAdoptionFixture,
  options: {
    readonly id?: string;
    readonly includeRequiredEvidence?: boolean;
    readonly secondTarget?: boolean;
  } = {},
) {
  const targets = [{ id: "product", system: "product", adapter: "local-system/v1" as const }];
  const mappings = [
    {
      id: "alpha",
      kind: "source-code",
      mode: "adapt",
      source: { path: "src/alpha.txt", match: "exact" as const },
      target: {
        target_id: "product",
        path: "integrations/alpha.txt",
        match: "exact" as const,
      },
      evidence: options.includeRequiredEvidence ? ["focused-test", "review-note"] : [],
    },
    {
      id: "beta",
      kind: "prompt",
      mode: "adapt",
      source: { path: "src/beta.txt", match: "exact" as const },
      target: {
        target_id: "product",
        path: "integrations/beta.txt",
        match: "exact" as const,
      },
      evidence: [],
    },
  ];
  if (options.secondTarget) {
    targets.push({
      id: "docs",
      system: "docs",
      adapter: "local-system/v1" as const,
    });
    mappings.push({
      id: "docs-alpha",
      kind: "documentation",
      mode: "adapt",
      source: { path: "src/alpha.txt", match: "exact" as const },
      target: {
        target_id: "docs",
        path: "alpha.md",
        match: "exact" as const,
      },
      evidence: [],
    });
  }
  return {
    schema: "assay.source-adoption-definition/v1" as const,
    id: options.id ?? "upstream-product",
    title: "Upstream adoption",
    source: {
      alias: "upstream",
      observation: fixture.observation,
    },
    targets,
    mappings,
    evidence: options.includeRequiredEvidence
      ? [
          {
            id: "focused-test",
            description: "Focused target test",
            policy: "required" as const,
          },
          {
            id: "review-note",
            description: "Optional reviewer note",
            policy: "advisory" as const,
          },
        ]
      : [],
  };
}

describe("Source adoption lifecycle", () => {
  it("rejects the unpublished Donor definition token without a compatibility alias", async () => {
    const fixture = await createFixture("no-donor-codec");
    expect(
      sourceAdoptionDefinitionSchema.safeParse({
        ...definition(fixture),
        schema: "assay.donor-adoption/v1",
      }).success,
    ).toBe(false);
  });

  it("fail-closes a Source adoption decision after a move boundary and preserves a usable target snapshot", async () => {
    const root = path.join(await tempDir(), "root");
    await mkdir(path.join(root, "integrations"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"root"}\n', "utf8");
    await writeFile(path.join(root, "integrations", "alpha.txt"), "target-v1\n", "utf8");
    for (const args of [
      ["init"],
      ["config", "user.email", "assay@example.test"],
      ["config", "user.name", "Assay Test"],
      ["add", "."],
      ["commit", "-m", "initial"],
    ]) {
      const result = await execa("git", args, { cwd: root, reject: false });
      expect(result.exitCode, result.stderr).toBe(0);
    }
    await attachExistingRepo({ root, name: "Root", privacy: "private" });
    const docsRoot = path.join(root, "docs-system");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "target-docs-v1\n", "utf8");
    await registerSystem(root, {
      name: "docs",
      path: "docs-system",
      vcs: "none",
    });
    const sourceRoot = path.join(await tempDir(), "upstream");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "source-v1\n", "utf8");
    const source = await addSource({ root, source: sourceRoot, alias: "upstream" });
    const registered = await registerSourceAdoption({
      root,
      definition: {
        schema: "assay.source-adoption-definition/v1",
        id: "upstream-root",
        title: "Concurrent Source adoption",
        source: { alias: "upstream", observation: source.observation.observation_id },
        targets: [
          { id: "product", system: "root", adapter: "local-system/v1" },
          { id: "docs", system: "docs", adapter: "local-system/v1" },
        ],
        mappings: [
          {
            id: "alpha",
            kind: "source-code",
            mode: "adapt",
            source: { path: "src/alpha.txt", match: "exact" },
            target: { target_id: "product", path: "integrations/alpha.txt", match: "exact" },
            evidence: [],
          },
          {
            id: "docs-alpha",
            kind: "documentation",
            mode: "adapt",
            source: { path: "src/alpha.txt", match: "exact" },
            target: { target_id: "docs", path: "alpha.md", match: "exact" },
            evidence: [],
          },
        ],
        evidence: [],
      },
    });
    const inspected = await inspectSourceAdoption({
      root,
      adoptionId: "upstream-root",
      targetId: "product",
    });
    const opaqueReceipt = path.join(
      root,
      ".assay",
      "source-adoptions",
      "upstream-root",
      "opaque",
      "note.bin",
    );
    await mkdir(path.dirname(opaqueReceipt), { recursive: true });
    await writeFile(opaqueReceipt, "unknown-receipt-bytes\n", "utf8");
    await writeFile(
      path.join(root, ".assay", "source-adoptions", "upstream-root", ".lock"),
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
      await expect(
        decideSourceAdoption({
          root,
          adoptionId: "upstream-root",
          targetId: "product",
          outcome: "reject",
          inspectionId: inspected.inspection.id,
        }),
      ).rejects.toThrow(/workspace conversion/);
    } finally {
      release();
    }
    await conversion;

    const converted = await getSourceAdoption({ root: target, adoptionId: "upstream-root" });
    expect(converted.definitionDigest).toBe(registered.definitionDigest);
    expect(converted.state.current_definition).toBe(registered.state.current_definition);
    expect(converted.definition.targets.map((candidate) => candidate.id).sort()).toEqual([
      "docs",
      "product",
    ]);
    const docsInspection = await inspectSourceAdoption({
      root: target,
      adoptionId: "upstream-root",
      targetId: "docs",
    });
    expect(docsInspection.inspection.mappings[0]?.target.change).toBe("activation");

    expect(
      (await getSourceAdoptionHistory({ root: target, adoptionId: "upstream-root" })).decisions,
    ).toEqual([]);
    await expect(
      stat(path.join(target, ".assay", "source-adoptions", "upstream-root", ".lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        path.join(target, ".assay", "source-adoptions", "upstream-root", "opaque", "note.bin"),
        "utf8",
      ),
    ).toBe("unknown-receipt-bytes\n");
    const completed = await decideSourceAdoption({
      root: target,
      adoptionId: "upstream-root",
      targetId: "product",
      outcome: "reject",
      inspectionId: inspected.inspection.id,
    });
    expect(completed.decision.outcome).toBe("reject");
  }, 45_000);

  it("fails conversion before target writes when a Source adoption System target no longer resolves", async () => {
    const root = path.join(await tempDir(), "preflight-root");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"preflight-root"}\n', "utf8");
    for (const args of [
      ["init"],
      ["config", "user.email", "assay@example.test"],
      ["config", "user.name", "Assay Test"],
      ["add", "."],
      ["commit", "-m", "initial"],
    ]) {
      const result = await execa("git", args, { cwd: root, reject: false });
      expect(result.exitCode, result.stderr).toBe(0);
    }
    await attachExistingRepo({ root, name: "Preflight Root", privacy: "private" });
    const sourceRoot = path.join(await tempDir(), "preflight-upstream");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "source-v1\n", "utf8");
    const source = await addSource({ root, source: sourceRoot, alias: "upstream" });
    const docsRoot = path.join(root, "docs-system");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "docs-v1\n", "utf8");
    await registerSystem(root, { name: "docs", path: "docs-system", vcs: "none" });
    await registerSourceAdoption({
      root,
      definition: {
        schema: "assay.source-adoption-definition/v1",
        id: "upstream-docs",
        source: { alias: "upstream", observation: source.observation.observation_id },
        targets: [{ id: "docs", system: "docs", adapter: "local-system/v1" }],
        mappings: [
          {
            id: "docs-alpha",
            source: { path: "src/alpha.txt", match: "exact" },
            target: { target_id: "docs", path: "alpha.md", match: "exact" },
            evidence: [],
          },
        ],
        evidence: [],
      },
    });
    await rm(docsRoot, { recursive: true, force: true });
    const target = path.join(await tempDir(), "preflight-converted");

    await expect(convertOverlayToStandalone({ root, target })).rejects.toThrow(
      /target system 'docs' does not resolve before conversion/,
    );
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("registers a reviewable definition and keeps global check structural", async () => {
    const fixture = await createFixture("AdoptionRegister");
    await rm(path.join(fixture.targetRoot, "integrations", "alpha.txt"));

    const registered = await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
      now: new Date("2026-07-25T09:00:00"),
    });

    expect(registered.state.targets.product?.baseline).toBeNull();
    expect(
      await readFile(
        path.join(
          fixture.root,
          ".assay",
          "source-adoptions",
          "upstream-product",
          "definitions",
          `${registered.definitionDigest}.json`,
        ),
        "utf8",
      ),
    ).toContain('"schema": "assay.source-adoption-definition/v1"');

    const listed = await listSourceAdoptions({ root: fixture.root });
    expect(listed.adoptions[0]?.targets[0]?.baselineDecision).toBeNull();

    const status = await getSourceAdoptionStatus({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(status.targets[0]?.inspection.mappings[0]?.target.change).toBe("missing");

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) =>
          row.path.includes(".assay/source-adoptions/upstream-product/state.json") &&
          row.status === "ok",
      ),
    ).toBe(true);
    expect(
      check.rows.some((row) => row.path.includes("source-adoptions") && row.status === "warning"),
    ).toBe(false);

    const frameworkStatus = await getFrameworkStatus({ root: fixture.root });
    expect(frameworkStatus.sourceAdoptions).toEqual({
      adoptions: 1,
      targets: 1,
      acceptedTargets: 0,
      draftTargets: 1,
    });
  });

  it("keeps advisory evidence non-blocking and enforces only explicit required policy", async () => {
    const fixture = await createFixture("AdoptionEvidence");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture, { includeRequiredEvidence: true }),
      now: new Date("2026-07-25T09:00:00"),
    });
    const inspected = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      now: new Date("2026-07-25T09:10:00"),
    });

    const missing = await verifySourceAdoptionInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(missing.ok).toBe(false);
    expect(missing.policy.required_missing).toEqual(["focused-test"]);
    expect(missing.policy.advisory_missing).toEqual(["review-note"]);

    await expect(
      decideSourceAdoption({
        root: fixture.root,
        adoptionId: "upstream-product",
        targetId: "product",
        outcome: "accept",
        inspectionId: inspected.inspection.id,
        now: new Date("2026-07-25T09:20:00"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_ADOPTION_POLICY_BLOCKED" });

    await recordSourceAdoptionEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.source-adoption-evidence-input/v1",
        check_id: "focused-test",
        result: "passed",
        producer: { id: "vitest", version: "2" },
      },
      now: new Date("2026-07-25T09:30:00"),
    });
    await recordSourceAdoptionEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.source-adoption-evidence-input/v1",
        check_id: "review-note",
        result: "inconclusive",
        summary: "Reviewer did not record a conclusion.",
      },
      now: new Date("2026-07-25T09:31:00"),
    });

    const verified = await verifySourceAdoptionInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(verified.ok).toBe(true);
    expect(verified.policy.failed).toEqual(["review-note"]);

    const accepted = await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      inspectionId: inspected.inspection.id,
      now: new Date("2026-07-25T09:40:00"),
    });
    expect(accepted.decision.baseline_after?.target.working_tree).toBe("not-versioned");
    expect(accepted.state.targets.product?.baseline?.decision_id).toBe(accepted.decision.id);
  });

  it("records a dirty Git target as evidence instead of imposing a universal block", async () => {
    const fixture = await createFixture("AdoptionDirtyTarget");
    for (const args of [
      ["init"],
      ["config", "user.email", "assay@example.test"],
      ["config", "user.name", "Assay Test"],
      ["add", "."],
      ["commit", "-m", "initial target"],
    ]) {
      const result = await execa("git", args, {
        cwd: fixture.targetRoot,
        reject: false,
      });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    }
    await updateSystem(fixture.root, "product", { vcs: "independent-git" });
    await writeFile(
      path.join(fixture.targetRoot, "integrations", "alpha.txt"),
      "target-alpha-dirty\n",
      "utf8",
    );

    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    expect(inspected.inspection.target.working_tree).toBe("dirty");
    expect(
      inspected.inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "source-adoption.target.working_tree_dirty",
      ),
    ).toBe(true);

    const accepted = await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    expect(accepted.decision.baseline_after?.target.working_tree).toBe("dirty");
  }, 30_000);

  it("reports source and target facts independently and invalidates stale inspections", async () => {
    const fixture = await createFixture("AdoptionDrift");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
      now: new Date("2026-07-25T09:00:00"),
    });
    const accepted = await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      now: new Date("2026-07-25T09:10:00"),
    });

    await writeFile(path.join(fixture.sourceRoot, "src", "alpha.txt"), "alpha-v2\n", "utf8");
    await importSourceContent({
      root: fixture.root,
      alias: "upstream",
      from: fixture.sourceRoot,
      now: new Date("2026-07-25T10:00:00"),
    });
    const afterSync = await getSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(afterSync.state.targets.product?.baseline?.decision_id).toBe(accepted.decision.id);
    const sourceOnly = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      now: new Date("2026-07-25T10:10:00"),
    });
    const alpha = sourceOnly.inspection.mappings.find((mapping) => mapping.id === "alpha");
    const beta = sourceOnly.inspection.mappings.find((mapping) => mapping.id === "beta");
    expect(alpha?.source.change).toBe("direct-change");
    expect(alpha?.target.change).toBe("unchanged");
    expect(beta?.source.change).toBe("no-direct-change");

    await writeFile(
      path.join(fixture.targetRoot, "integrations", "alpha.txt"),
      "target-alpha-v2\n",
      "utf8",
    );
    const stale = await verifySourceAdoptionInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: sourceOnly.inspection.id,
    });
    expect(stale.current).toBe(false);
    await expect(
      decideSourceAdoption({
        root: fixture.root,
        adoptionId: "upstream-product",
        targetId: "product",
        outcome: "accept",
        inspectionId: sourceOnly.inspection.id,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_ADOPTION_STALE" });

    const both = await getSourceAdoptionStatus({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const bothAlpha = both.targets[0]?.inspection.mappings.find(
      (mapping) => mapping.id === "alpha",
    );
    expect(bothAlpha?.facts).toContain("both-changed");
    expect(bothAlpha?.facts).not.toContain("conflict");
  });

  it("advances multi-target baselines independently", async () => {
    const fixture = await createFixture("AdoptionMultiTarget");
    const docsRoot = path.join(fixture.root, "systems", "docs");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "docs-alpha-v1\n", "utf8");
    await registerSystem(fixture.root, {
      name: "docs",
      path: "systems/docs",
      vcs: "none",
    });
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture, { secondTarget: true }),
    });

    const accepted = await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    expect(accepted.state.targets.product?.baseline).not.toBeNull();
    expect(accepted.state.targets.docs?.baseline).toBeNull();

    const current = await getSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(current.state.targets.product?.baseline?.decision_id).toBe(accepted.decision.id);
    expect(current.state.targets.docs?.baseline).toBeNull();
  });

  it("records a verified external rollback without changing target files", async () => {
    const fixture = await createFixture("AdoptionRollback");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const first = await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      now: new Date("2026-07-25T09:00:00"),
    });
    const alphaPath = path.join(fixture.targetRoot, "integrations", "alpha.txt");
    const original = await readFile(alphaPath, "utf8");

    await writeFile(alphaPath, "target-alpha-v2\n", "utf8");
    await writeFile(path.join(fixture.sourceRoot, "src", "alpha.txt"), "alpha-v2\n", "utf8");
    await importSourceContent({
      root: fixture.root,
      alias: "upstream",
      from: fixture.sourceRoot,
      now: new Date("2026-07-25T10:00:00"),
    });
    await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      now: new Date("2026-07-25T10:10:00"),
    });

    await expect(
      recordSourceAdoptionRollback({
        root: fixture.root,
        adoptionId: "upstream-product",
        decisionId: first.decision.id,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_ADOPTION_STALE" });

    await writeFile(alphaPath, original, "utf8");
    const rollback = await recordSourceAdoptionRollback({
      root: fixture.root,
      adoptionId: "upstream-product",
      decisionId: first.decision.id,
      reason: "External rollback completed.",
      now: new Date("2026-07-25T11:00:00"),
    });
    expect(rollback.decision.outcome).toBe("rollback");
    expect(rollback.decision.restored_from_decision).toBe(first.decision.id);
    expect(await readFile(alphaPath, "utf8")).toBe(original);

    const history = await getSourceAdoptionHistory({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(history.decisions.map((decision) => decision.outcome)).toEqual([
      "accept",
      "accept",
      "rollback",
    ]);
  });

  it("makes definition revisions stale without rewriting prior records", async () => {
    const fixture = await createFixture("AdoptionDefinitionRevision");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const revised = definition(fixture);
    revised.title = "Revised adoption";
    await updateSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      definition: revised,
    });

    const verification = await verifySourceAdoptionInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(verification.current).toBe(false);
    expect(
      verification.diagnostics.some(
        (diagnostic) => diagnostic.code === "source-adoption.inspection.definition_stale",
      ),
    ).toBe(true);
  });

  it("detects tampered content-addressed evidence without inspecting the target", async () => {
    const fixture = await createFixture("SourceAdoptionTamper");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const recorded = await recordSourceAdoptionEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.source-adoption-evidence-input/v1",
        check_id: "supplemental-note",
        result: "passed",
      },
    });
    const absoluteEvidence = path.join(fixture.root, recorded.path);
    const content = await readFile(absoluteEvidence, "utf8");
    await writeFile(absoluteEvidence, content.replace('"passed"', '"failed"'), "utf8");

    const check = await checkFramework({ root: fixture.root });
    // The row must name the tampered evidence file. Blaming state.json, which
    // is intact, sends an operator to the wrong file.
    expect(
      check.rows.some(
        (row) =>
          row.path === recorded.path &&
          row.status === "error" &&
          row.message?.includes("evidence digest mismatch"),
      ),
      JSON.stringify(check.rows, null, 2),
    ).toBe(true);
    expect(
      check.rows.some((row) => row.path.includes("state.json") && row.status === "error"),
    ).toBe(false);
  });

  it("detects content-addressed record filename mismatches", async () => {
    const fixture = await createFixture("SourceAdoptionFilenameTamper");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const recorded = await recordSourceAdoptionEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.source-adoption-evidence-input/v1",
        check_id: "supplemental-note",
        result: "passed",
      },
    });
    const absoluteEvidence = path.join(fixture.root, recorded.path);
    await rename(
      absoluteEvidence,
      path.join(path.dirname(absoluteEvidence), "evidence-renamed.json"),
    );

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) => row.status === "error" && row.message?.includes("evidence file identity mismatch"),
      ),
    ).toBe(true);
  });

  it("detects state baselines that contradict committed decision history", async () => {
    const fixture = await createFixture("SourceAdoptionStateTamper");
    await registerSourceAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    await decideSourceAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });

    const statePath = path.join(
      fixture.root,
      ".assay",
      "source-adoptions",
      "upstream-product",
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      targets: { product: { baseline: { decision_id: string } } };
    };
    state.targets.product.baseline.decision_id = "decision-forged";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) =>
          row.status === "error" &&
          row.message?.includes("baseline for target 'product' does not match committed history"),
      ),
    ).toBe(true);
  });
});
