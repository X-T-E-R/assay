import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  checkFramework,
  decideDonorAdoption,
  getDonorAdoption,
  getDonorHistory,
  getDonorStatus,
  getFrameworkStatus,
  initFramework,
  inspectDonorAdoption,
  listDonorAdoptions,
  recordDonorEvidence,
  recordDonorRollback,
  registerDonorAdoption,
  registerSystem,
  syncSource,
  updateDonorAdoption,
  updateSystem,
  verifyDonorInspection,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-donors-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface DonorFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly observation: string;
}

async function createFixture(name: string): Promise<DonorFixture> {
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
  fixture: DonorFixture,
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
    schema: "assay.donor-adoption/v1" as const,
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

describe("donor adoption lifecycle", () => {
  it("registers a reviewable definition and keeps global check structural", async () => {
    const fixture = await createFixture("DonorRegister");
    await rm(path.join(fixture.targetRoot, "integrations", "alpha.txt"));

    const registered = await registerDonorAdoption({
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
          "donors",
          "upstream-product",
          "definitions",
          `${registered.definitionDigest}.json`,
        ),
        "utf8",
      ),
    ).toContain('"schema": "assay.donor-adoption/v1"');

    const listed = await listDonorAdoptions({ root: fixture.root });
    expect(listed.adoptions[0]?.targets[0]?.baselineDecision).toBeNull();

    const status = await getDonorStatus({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(status.targets[0]?.inspection.mappings[0]?.target.change).toBe("missing");

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) =>
          row.path.includes(".assay/donors/upstream-product/state.json") && row.status === "ok",
      ),
    ).toBe(true);
    expect(check.rows.some((row) => row.path.includes("donors") && row.status === "warning")).toBe(
      false,
    );

    const frameworkStatus = await getFrameworkStatus({ root: fixture.root });
    expect(frameworkStatus.donors).toEqual({
      adoptions: 1,
      targets: 1,
      acceptedTargets: 0,
      draftTargets: 1,
    });
  });

  it("keeps advisory evidence non-blocking and enforces only explicit required policy", async () => {
    const fixture = await createFixture("DonorEvidence");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture, { includeRequiredEvidence: true }),
      now: new Date("2026-07-25T09:00:00"),
    });
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      now: new Date("2026-07-25T09:10:00"),
    });

    const missing = await verifyDonorInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(missing.ok).toBe(false);
    expect(missing.policy.required_missing).toEqual(["focused-test"]);
    expect(missing.policy.advisory_missing).toEqual(["review-note"]);

    await expect(
      decideDonorAdoption({
        root: fixture.root,
        adoptionId: "upstream-product",
        targetId: "product",
        outcome: "accept",
        inspectionId: inspected.inspection.id,
        now: new Date("2026-07-25T09:20:00"),
      }),
    ).rejects.toMatchObject({ code: "DONOR_POLICY_BLOCKED" });

    await recordDonorEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.donor-evidence-input/v1",
        check_id: "focused-test",
        result: "passed",
        producer: { id: "vitest", version: "2" },
      },
      now: new Date("2026-07-25T09:30:00"),
    });
    await recordDonorEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.donor-evidence-input/v1",
        check_id: "review-note",
        result: "inconclusive",
        summary: "Reviewer did not record a conclusion.",
      },
      now: new Date("2026-07-25T09:31:00"),
    });

    const verified = await verifyDonorInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(verified.ok).toBe(true);
    expect(verified.policy.failed).toEqual(["review-note"]);

    const accepted = await decideDonorAdoption({
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
    const fixture = await createFixture("DonorDirtyTarget");
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

    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    expect(inspected.inspection.target.working_tree).toBe("dirty");
    expect(
      inspected.inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "donor.target.working_tree_dirty",
      ),
    ).toBe(true);

    const accepted = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    expect(accepted.decision.baseline_after?.target.working_tree).toBe("dirty");
  });

  it("reports source and target facts independently and invalidates stale inspections", async () => {
    const fixture = await createFixture("DonorDrift");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
      now: new Date("2026-07-25T09:00:00"),
    });
    await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      now: new Date("2026-07-25T09:10:00"),
    });

    await writeFile(path.join(fixture.sourceRoot, "src", "alpha.txt"), "alpha-v2\n", "utf8");
    await syncSource({
      root: fixture.root,
      alias: "upstream",
      now: new Date("2026-07-25T10:00:00"),
    });
    const sourceOnly = await inspectDonorAdoption({
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
    const stale = await verifyDonorInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: sourceOnly.inspection.id,
    });
    expect(stale.current).toBe(false);
    await expect(
      decideDonorAdoption({
        root: fixture.root,
        adoptionId: "upstream-product",
        targetId: "product",
        outcome: "accept",
        inspectionId: sourceOnly.inspection.id,
      }),
    ).rejects.toMatchObject({ code: "DONOR_STALE" });

    const both = await getDonorStatus({
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
    const fixture = await createFixture("DonorMultiTarget");
    const docsRoot = path.join(fixture.root, "systems", "docs");
    await mkdir(docsRoot, { recursive: true });
    await writeFile(path.join(docsRoot, "alpha.md"), "docs-alpha-v1\n", "utf8");
    await registerSystem(fixture.root, {
      name: "docs",
      path: "systems/docs",
      vcs: "none",
    });
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture, { secondTarget: true }),
    });

    const accepted = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    expect(accepted.state.targets.product?.baseline).not.toBeNull();
    expect(accepted.state.targets.docs?.baseline).toBeNull();

    const current = await getDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
    });
    expect(current.state.targets.product?.baseline?.decision_id).toBe(accepted.decision.id);
    expect(current.state.targets.docs?.baseline).toBeNull();
  });

  it("records a verified external rollback without changing target files", async () => {
    const fixture = await createFixture("DonorRollback");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const first = await decideDonorAdoption({
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
    await syncSource({
      root: fixture.root,
      alias: "upstream",
      now: new Date("2026-07-25T10:00:00"),
    });
    await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
      now: new Date("2026-07-25T10:10:00"),
    });

    await expect(
      recordDonorRollback({
        root: fixture.root,
        adoptionId: "upstream-product",
        decisionId: first.decision.id,
      }),
    ).rejects.toMatchObject({ code: "DONOR_STALE" });

    await writeFile(alphaPath, original, "utf8");
    const rollback = await recordDonorRollback({
      root: fixture.root,
      adoptionId: "upstream-product",
      decisionId: first.decision.id,
      reason: "External rollback completed.",
      now: new Date("2026-07-25T11:00:00"),
    });
    expect(rollback.decision.outcome).toBe("rollback");
    expect(rollback.decision.restored_from_decision).toBe(first.decision.id);
    expect(await readFile(alphaPath, "utf8")).toBe(original);

    const history = await getDonorHistory({
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
    const fixture = await createFixture("DonorDefinitionRevision");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const revised = definition(fixture);
    revised.title = "Revised adoption";
    await updateDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      definition: revised,
    });

    const verification = await verifyDonorInspection({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
    });
    expect(verification.current).toBe(false);
    expect(
      verification.diagnostics.some(
        (diagnostic) => diagnostic.code === "donor.inspection.definition_stale",
      ),
    ).toBe(true);
  });

  it("detects tampered content-addressed evidence without inspecting the target", async () => {
    const fixture = await createFixture("DonorTamper");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const recorded = await recordDonorEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.donor-evidence-input/v1",
        check_id: "supplemental-note",
        result: "passed",
      },
    });
    const absoluteEvidence = path.join(fixture.root, recorded.path);
    const content = await readFile(absoluteEvidence, "utf8");
    await writeFile(absoluteEvidence, content.replace('"passed"', '"failed"'), "utf8");

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) =>
          row.path.includes(".assay/donors/upstream-product/state.json") &&
          row.status === "error" &&
          row.message?.includes("evidence digest mismatch"),
      ),
    ).toBe(true);
  });

  it("detects content-addressed record filename mismatches", async () => {
    const fixture = await createFixture("DonorFilenameTamper");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const recorded = await recordDonorEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.donor-evidence-input/v1",
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
    const fixture = await createFixture("DonorStateTamper");
    await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture),
    });
    await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });

    const statePath = path.join(fixture.root, ".assay", "donors", "upstream-product", "state.json");
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
