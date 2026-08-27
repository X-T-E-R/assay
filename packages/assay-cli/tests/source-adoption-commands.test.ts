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

async function createFixture(name: string) {
  const root = await createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
  });
  const source = path.join(await tempDirs.createTempDir(), "upstream");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  await writeFile(path.join(source, "src", "beta.txt"), "beta-v1\n", "utf8");
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

  return { root, observation: observation as string };
}

describe("assay source adoption CLI", () => {
  it(
    "takes, lists, shows, and removes a mapping",
    async () => {
      const fixture = await createFixture("SourceAdoptionCli");

      const taken = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:integrations/alpha.txt",
        "--mode",
        "adapt",
        "--note",
        "Kept the parser shape.",
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(taken.exitCode).toBe(0);
      const payload = JSON.parse(taken.stdout);
      expect(payload.adoptionId).toBe("upstream-product-src-alpha-txt");
      expect(payload.record).toMatchObject({
        mode: "adapt",
        note: "Kept the parser shape.",
        source: { alias: "upstream", path: "src/alpha.txt", match: "exact" },
        target: { system: "product", path: "integrations/alpha.txt", match: "exact" },
      });
      expect(payload.record.source.pin.kind).toBe("content-hash");

      const second = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/beta.txt",
        "--into",
        "product:integrations/beta.txt",
        "--root",
        fixture.root,
      ]);
      expect(second.exitCode).toBe(0);
      // The default mode is descriptive metadata, not ceremony: it is recorded
      // without being asked for.
      expect(second.stdout).toContain("(adapt, match exact)");
      // The target file does not exist, and the mapping is recorded anyway.
      expect(second.stdout).toContain("not present in product yet");

      const listed = await cliRunner.runCli(["source", "adoption", "list", "--root", fixture.root]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("upstream:src/alpha.txt -> product:integrations/alpha.txt");
      expect(listed.stdout).toContain("upstream:src/beta.txt -> product:integrations/beta.txt");
      expect(listed.stdout).toContain("pinned");

      const shown = await cliRunner.runCli([
        "source",
        "adoption",
        "show",
        payload.adoptionId,
        "--root",
        fixture.root,
      ]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("Source: upstream:src/alpha.txt (exact)");
      expect(shown.stdout).toContain("Target: product:integrations/alpha.txt (exact)");
      expect(shown.stdout).toContain("Resolves: systems/product/integrations/alpha.txt");
      expect(shown.stdout).toContain("Note: Kept the parser shape.");

      const removed = await cliRunner.runCli([
        "source",
        "adoption",
        "remove",
        payload.adoptionId,
        "--root",
        fixture.root,
      ]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).toContain(`Removed source adoption: ${payload.adoptionId}`);
      expect(removed.stdout).toContain(
        "Was: upstream:src/alpha.txt -> product:integrations/alpha.txt",
      );

      const afterRemove = await cliRunner.runCli([
        "source",
        "adoption",
        "list",
        "--root",
        fixture.root,
        "--json",
      ]);
      expect(JSON.parse(afterRemove.stdout).adoptions).toHaveLength(1);

      const missing = await cliRunner.runCli([
        "source",
        "adoption",
        "show",
        payload.adoptionId,
        "--root",
        fixture.root,
      ]);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("not found");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );

  it(
    "parses colons safely in both locators",
    async () => {
      const fixture = await createFixture("SourceAdoptionTakeCli");

      // A Windows-style absolute path is refused by name, never split at its
      // drive colon into a different system and path.
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
    "offers --id when the derived id is already taken",
    async () => {
      const fixture = await createFixture("SourceAdoptionIdCli");
      const first = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:integrations/alpha.txt",
        "--root",
        fixture.root,
      ]);
      expect(first.exitCode).toBe(0);

      const collision = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:integrations/alpha-copy.txt",
        "--root",
        fixture.root,
      ]);
      expect(collision.exitCode).not.toBe(0);
      expect(collision.stderr).toContain("--id <adoption-id>");

      const resolved = await cliRunner.runCli([
        "source",
        "adoption",
        "take",
        "upstream:src/alpha.txt",
        "--into",
        "product:integrations/alpha-copy.txt",
        "--id",
        "upstream-product-alpha-copy",
        "--root",
        fixture.root,
      ]);
      expect(resolved.exitCode).toBe(0);
      expect(resolved.stdout).toContain("upstream-product-alpha-copy");
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );

  it(
    "exposes exactly the four adoption commands in help",
    async () => {
      const rootHelp = await cliRunner.runCli(["--help"]);
      expect(rootHelp.exitCode).toBe(0);
      expect(rootHelp.stdout).not.toContain("donor");
      expect(rootHelp.stdout).toContain("source");

      const adoptionHelp = await cliRunner.runCli(["source", "adoption", "--help"]);
      expect(adoptionHelp.exitCode).toBe(0);
      // Read the command names out of the Commands: block rather than searching
      // the whole help text, which legitimately says "registered system".
      const commands = adoptionHelp.stdout
        .split(/^Commands:\r?\n/m)[1]
        ?.split(/\r?\n/)
        // A command entry starts at column 2; a wrapped description is indented
        // to the description column.
        .filter((line) => /^ {2}\S/.test(line))
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((name): name is string => Boolean(name) && name !== "help");
      // The inspection/evidence/decision workflow is gone, not hidden: a
      // single-user workbench records decisions in `analysis close --exit` and
      // in the adoption note.
      expect(commands, adoptionHelp.stdout).toEqual(["take", "list", "show", "remove"]);
    },
    SOURCE_ADOPTION_CLI_TIMEOUT_MS,
  );
});
