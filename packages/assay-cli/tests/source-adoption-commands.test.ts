import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-source-adoption-cli");
let cliRunner: BuiltCliRunner;
const SOURCE_ADOPTION_CLI_TIMEOUT_MS = 90_000;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({
    registryRoot: await createIsolatedRegistryRoot(tempDirs),
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function createFixture(name: string, requiredEvidence = false) {
  const root = await createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
  });
  const source = path.join(await tempDirs.createTempDir(), "upstream");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  const added = await cliRunner.runCli(["source", "add", source, "upstream", "--root", root]);
  expect(added.exitCode).toBe(0);
  const observation = added.stdout.match(/observations\/([^/\s]+)\.yaml/)?.[1];
  expect(observation).toBeTruthy();

  const target = path.join(root, "systems", "product");
  await mkdir(path.join(target, "integrations"), { recursive: true });
  await writeFile(path.join(target, "integrations", "alpha.txt"), "target-v1\n", "utf8");
  const registeredSystem = await cliRunner.runCli([
    "system",
    "register",
    "systems/product",
    "--name",
    "product",
    "--vcs",
    "none",
    "--primary",
    "--root",
    root,
  ]);
  expect(registeredSystem.exitCode).toBe(0);

  const definition = path.join(await tempDirs.createTempDir(), "source-adoption.json");
  await writeFile(
    definition,
    `${JSON.stringify(
      {
        schema: "assay.donor-adoption/v1",
        id: "upstream-product",
        source: { alias: "upstream", observation },
        targets: [{ id: "product", system: "product" }],
        mappings: [
          {
            id: "alpha",
            source: { path: "src/alpha.txt" },
            target: { target_id: "product", path: "integrations/alpha.txt" },
            evidence: requiredEvidence ? ["focused-test"] : [],
          },
        ],
        evidence: requiredEvidence ? [{ id: "focused-test", policy: "required" }] : [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, definition };
}

describe("assay source adoption CLI", () => {
  it(
    "registers, inspects, decides, reports status, and keeps history",
    async () => {
      const fixture = await createFixture("SourceAdoptionCli");
      const registered = await cliRunner.runCli([
        "source",
        "adoption",
        "register",
        "--file",
        fixture.definition,
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(registered.exitCode).toBe(0);
      expect(JSON.parse(registered.stdout).adoptionId).toBe("upstream-product");

      const inspected = await cliRunner.runCli([
        "source",
        "adoption",
        "inspect",
        "upstream-product",
        "--target",
        "product",
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(inspected.exitCode).toBe(0);
      const inspectionId = JSON.parse(inspected.stdout).inspection.id as string;
      expect(inspectionId).toMatch(/^inspection-/);

      const decision = await cliRunner.runCli([
        "source",
        "adoption",
        "decide",
        "upstream-product",
        "--target",
        "product",
        "--outcome",
        "accept",
        "--inspection",
        inspectionId,
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(decision.exitCode).toBe(0);
      expect(JSON.parse(decision.stdout).decision.outcome).toBe("accept");

      const status = await cliRunner.runCli([
        "source",
        "adoption",
        "status",
        "upstream-product",
        "--root",
        fixture.root,
      ]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("source=no-direct-change");
      expect(status.stdout).toContain("target=unchanged");

      const history = await cliRunner.runCli([
        "source",
        "adoption",
        "history",
        "upstream-product",
        "--root",
        fixture.root,
      ]);
      expect(history.exitCode).toBe(0);
      expect(history.stdout).toContain("accept");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );

  it(
    "blocks only explicitly required evidence and accepts a bound receipt",
    async () => {
      const fixture = await createFixture("SourceAdoptionCliEvidence", true);
      await cliRunner.runCli([
        "source",
        "adoption",
        "register",
        "--file",
        fixture.definition,
        "--root",
        fixture.root,
      ]);
      const inspected = await cliRunner.runCli([
        "source",
        "adoption",
        "inspect",
        "upstream-product",
        "--target",
        "product",
        "--root",
        fixture.root,
        "--json",
      ]);
      const inspectionId = JSON.parse(inspected.stdout).inspection.id as string;

      const blocked = await cliRunner.runCli([
        "source",
        "adoption",
        "decide",
        "upstream-product",
        "--target",
        "product",
        "--outcome",
        "accept",
        "--inspection",
        inspectionId,
        "--root",
        fixture.root,
      ]);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("required Source adoption evidence has not passed");

      const evidenceFile = path.join(await tempDirs.createTempDir(), "evidence.yaml");
      await writeFile(
        evidenceFile,
        [
          "schema: assay.donor-evidence-input/v1",
          "check_id: focused-test",
          "result: passed",
          "producer:",
          "  id: fixture",
          "",
        ].join("\n"),
        "utf8",
      );
      const evidence = await cliRunner.runCli([
        "source",
        "adoption",
        "evidence",
        "add",
        "upstream-product",
        inspectionId,
        "--file",
        evidenceFile,
        "--root",
        fixture.root,
      ]);
      expect(evidence.exitCode).toBe(0);
      expect(evidence.stdout).toContain("Result: passed");

      const verified = await cliRunner.runCli([
        "source",
        "adoption",
        "verify",
        "upstream-product",
        inspectionId,
        "--root",
        fixture.root,
      ]);
      expect(verified.exitCode).toBe(0);
      expect(verified.stdout).toContain("Required policy: satisfied");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );

  it(
    "takes a single mapping without a definition file and parses colons safely",
    async () => {
      const fixture = await createFixture("SourceAdoptionTakeCli");

      const taken = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:integrations/alpha.txt",
        "--mode",
        "adapt",
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(taken.exitCode).toBe(0);
      const payload = JSON.parse(taken.stdout);
      expect(payload.adoptionId).toBe("upstream-product-src-alpha-txt");
      expect(payload.definition.mappings[0]).toMatchObject({
        mode: "adapt",
        source: { path: "src/alpha.txt", match: "exact" },
        target: { target_id: "product", path: "integrations/alpha.txt", match: "exact" },
      });

      // The adoption is a first-class one: the ordinary verbs read it.
      const shown = await cliRunner.runCli([
        "source",
        "adoption",
        "show",
        payload.adoptionId,
        "--root",
        fixture.root,
      ]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("src/alpha.txt -> product:integrations/alpha.txt");

      // A Windows-style absolute path is refused by name, never split at its
      // drive colon into a different alias and path.
      const windowsTarget = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:C:/absolute/alpha.txt",
        "--root",
        fixture.root,
      ]);
      expect(windowsTarget.exitCode).not.toBe(0);
      expect(windowsTarget.stderr).toContain("target path must be a contained relative path");
      expect(windowsTarget.stderr).toContain("C:/absolute/alpha.txt");

      const windowsSource = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "C:\\repo\\src\\alpha.txt",
        "--into",
        "product:integrations/alpha.txt",
        "--root",
        fixture.root,
      ]);
      expect(windowsSource.exitCode).not.toBe(0);
      expect(windowsSource.stderr).toContain("looks like a Windows absolute path");

      const missingSeparator = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream/src/alpha.txt",
        "--into",
        "product:integrations/alpha.txt",
        "--root",
        fixture.root,
      ]);
      expect(missingSeparator.exitCode).not.toBe(0);
      expect(missingSeparator.stderr).toContain("Source adoption input must be <name>:<path>");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );

  it(
    "exposes Source adoption commands in help",
    async () => {
      const root = await createInitializedCliWorkspace({
        tempDirs,
        runner: cliRunner,
        directoryName: "SourceAdoptionHelp",
      });
      const rootHelp = await cliRunner.runCli(["--help"]);
      expect(rootHelp.exitCode).toBe(0);
      expect(rootHelp.stdout).not.toContain("donor");
      expect(rootHelp.stdout).toContain("source");

      expect(root).toBeTruthy();
      const adoptionHelp = await cliRunner.runCli(["source", "adoption", "--help"]);
      expect(adoptionHelp.exitCode).toBe(0);
      expect(adoptionHelp.stdout).toContain("take");
      expect(adoptionHelp.stdout).toContain("inspect");
      expect(adoptionHelp.stdout).toContain("decide");
      expect(adoptionHelp.stdout).toContain("evidence");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );
});
