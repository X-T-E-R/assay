import { Command, Option } from "@commander-js/extra-typings";
import {
  type MetaSystemProjectRegistryStatus,
  addReference,
  adoptExistingProject,
  applyUpdate,
  captureEvent,
  checkFramework,
  createAnalysis,
  discoverFrameworkRoot,
  findProjectRecord,
  forgetProject,
  getFrameworkStatus,
  initFramework,
  listProjectRecords,
  migrateLayout,
  pruneProjects,
  recordProjectLifecycleBestEffort,
  scanForProjects,
  startIteration,
} from "metasystem-framework-core";

import { mapCliError } from "./errors.js";
import {
  formatAdoptionResult,
  formatCheckResult,
  formatInitResult,
  formatMigrationResult,
  formatProjectList,
  formatProjectRecord,
  formatStatusResult,
  formatUpdateResult,
} from "./format.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

export interface CreateProgramOptions {
  readonly output?: Partial<CliOutput>;
}

interface ProjectListOptions {
  readonly all?: boolean;
  readonly json?: boolean;
  readonly status?: string;
}

interface ProjectJsonOptions {
  readonly json?: boolean;
}

interface ProjectPruneOptions extends ProjectJsonOptions {
  readonly dryRun?: boolean;
}

const PROJECT_STATUSES: readonly MetaSystemProjectRegistryStatus[] = [
  "active",
  "missing",
  "uninstalled",
];

function defaultOutput(): CliOutput {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function createOutput(options?: CreateProgramOptions): CliOutput {
  const fallback = defaultOutput();
  return {
    stdout: options?.output?.stdout ?? fallback.stdout,
    stderr: options?.output?.stderr ?? fallback.stderr,
    setExitCode: options?.output?.setExitCode ?? fallback.setExitCode,
  };
}

function writeLine(
  output: Pick<CliOutput, "stdout" | "stderr">,
  stream: "stdout" | "stderr",
  text: string,
): void {
  output[stream](`${text}\n`);
}

async function discoveredRoot(root: string): Promise<string> {
  return discoverFrameworkRoot(root);
}

function writeJson(output: { readonly stdout: CliOutput["stdout"] }, value: unknown): void {
  output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseStatusFilter(status?: string): MetaSystemProjectRegistryStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (PROJECT_STATUSES.includes(status as MetaSystemProjectRegistryStatus)) {
    return status as MetaSystemProjectRegistryStatus;
  }
  throw new Error(`--status must be one of: ${PROJECT_STATUSES.join(", ")}`);
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("metasystem")
    .description("Bootstrap and update an external-system-learning framework.")
    .version("0.2.0")
    .configureOutput({
      writeOut: (text) => output.stdout(text),
      writeErr: (text) => output.stderr(text),
    });

  program
    .command("init")
    .description("Initialize a versioned framework structure without overwriting by default")
    .argument("[target-dir]", "target framework directory", process.cwd())
    .option("--name <project-name>", "project name")
    .option("--core <core-name>", "core system directory name")
    .option("--git", "initialize a git repository in the framework root")
    .option("--force", "overwrite existing files and track them as managed")
    .option("--create-new", "write .new copies when files already exist")
    .action(async (targetDir, commandOptions) => {
      const result = await initFramework({
        target: targetDir,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.core === undefined ? {} : { core: commandOptions.core }),
        git: commandOptions.git ?? false,
        force: commandOptions.force ?? false,
        createNew: commandOptions.createNew ?? false,
      });
      await recordProjectLifecycleBestEffort(result.root, "init");
      writeLine(output, "stdout", formatInitResult(result));
    });

  program
    .command("adopt")
    .description("Archive an existing project into .old and initialize a clean MetaSystem scaffold")
    .option("--root <target-dir>", "existing project root to adopt", process.cwd())
    .option("--name <project-name>", "project name")
    .option("--core <core-name>", "core system directory name")
    .addOption(new Option("--dry-run", "plan adoption without applying writes").conflicts("apply"))
    .addOption(
      new Option("--apply", "move existing root entries and initialize the scaffold").conflicts(
        "dryRun",
      ),
    )
    .action(async (commandOptions) => {
      const result = await adoptExistingProject({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.core === undefined ? {} : { core: commandOptions.core }),
        dryRun: commandOptions.dryRun ?? false,
        apply: commandOptions.apply ?? false,
      });
      writeLine(output, "stdout", formatAdoptionResult(result));
      if (!result.dryRun && result.failures.length > 0) {
        output.setExitCode(1);
      }
    });

  program
    .command("check")
    .description("Check required framework structure")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await checkFramework({ root });
      writeLine(output, "stdout", formatCheckResult(result));
      if (!result.ok) {
        output.setExitCode(1);
      }
    });

  program
    .command("status")
    .description("Print framework status")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      writeLine(output, "stdout", formatStatusResult(await getFrameworkStatus({ root })));
    });

  program
    .command("update")
    .description("Update managed framework files using manifest hashes")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .option("--dry-run", "plan update without applying writes")
    .addOption(
      new Option("--force", "overwrite modified/conflicting files").conflicts([
        "skipAll",
        "createNew",
      ]),
    )
    .addOption(
      new Option("--skip-all", "skip modified/conflicting files").conflicts(["force", "createNew"]),
    )
    .addOption(
      new Option("--create-new", "write modified/conflicting templates as .new").conflicts([
        "force",
        "skipAll",
      ]),
    )
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const action = commandOptions.force
        ? "force"
        : commandOptions.createNew
          ? "create-new"
          : "skip";
      const result = await applyUpdate({
        root,
        dryRun: commandOptions.dryRun ?? false,
        action,
      });
      await recordProjectLifecycleBestEffort(root, "update");
      writeLine(output, "stdout", formatUpdateResult(result));
    });

  const projects = program
    .command("projects")
    .description("List and manage MetaSystem scaffolded projects")
    .action(async () => {
      const records = (await listProjectRecords()).filter(
        (record) => record.status !== "uninstalled",
      );
      writeLine(output, "stdout", formatProjectList("tracked MetaSystem projects", records));
    });

  projects
    .command("list")
    .description("List tracked MetaSystem projects")
    .option("--json", "emit JSON")
    .option("--all", "include uninstalled projects")
    .addOption(
      new Option("--status <status>", "filter: active | missing | uninstalled").choices([
        ...PROJECT_STATUSES,
      ]),
    )
    .action(async (commandOptions: ProjectListOptions) => {
      const status = parseStatusFilter(commandOptions.status);
      const records = (await listProjectRecords()).filter((record) => {
        if (status) {
          return record.status === status;
        }
        if (commandOptions.all) {
          return true;
        }
        return record.status !== "uninstalled";
      });

      if (commandOptions.json) {
        writeJson(output, records);
        return;
      }
      writeLine(output, "stdout", formatProjectList("tracked MetaSystem projects", records));
    });

  projects
    .command("show")
    .description("Show one tracked project by id, id prefix, or path")
    .argument("<selector>", "project id, id prefix, or filesystem path")
    .option("--json", "emit JSON")
    .action(async (selector: string, commandOptions: ProjectJsonOptions) => {
      const record = await findProjectRecord(selector);
      if (commandOptions.json) {
        writeJson(output, record);
        return;
      }
      writeLine(output, "stdout", formatProjectRecord(record));
    });

  projects
    .command("scan")
    .description("Scan directories for .framework/manifest.json projects and register them")
    .argument("<roots...>", "directories to scan")
    .option("--json", "emit JSON")
    .action(async (roots: string[], commandOptions: ProjectJsonOptions) => {
      const records = await scanForProjects(roots);
      if (commandOptions.json) {
        writeJson(output, records);
        return;
      }
      writeLine(
        output,
        "stdout",
        records.length === 0
          ? "No MetaSystem projects found."
          : formatProjectList(`registered ${records.length} MetaSystem project(s)`, records),
      );
    });

  projects
    .command("forget")
    .description("Remove a project from the registry without touching files")
    .argument("<selector>", "project id, id prefix, or filesystem path")
    .action(async (selector: string) => {
      const record = await forgetProject(selector);
      writeLine(output, "stdout", `Forgot ${record.id}\n  ${record.path}`);
    });

  projects
    .command("prune")
    .description("Remove missing/uninstalled projects from the registry")
    .option("--dry-run", "show what would be removed")
    .option("--json", "emit JSON")
    .action(async (commandOptions: ProjectPruneOptions) => {
      const records = await pruneProjects({ dryRun: commandOptions.dryRun ?? false });
      if (commandOptions.json) {
        writeJson(output, records);
        return;
      }
      if (records.length === 0) {
        writeLine(output, "stdout", "No missing or uninstalled projects to prune.");
        return;
      }
      const verb = commandOptions.dryRun ? "Would prune" : "Pruned";
      writeLine(
        output,
        "stdout",
        formatProjectList(`${verb} ${records.length} project(s)`, records),
      );
    });

  program
    .command("migrate-layout")
    .description("Plan or apply old-to-new folder layout migration")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .addOption(new Option("--dry-run", "plan migration without applying writes").conflicts("apply"))
    .addOption(new Option("--apply", "apply copy-first migration steps").conflicts("dryRun"))
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const shouldApply = commandOptions.apply === true;
      const result = await migrateLayout({
        root,
        dryRun: !shouldApply,
        apply: shouldApply,
      });
      writeLine(output, "stdout", formatMigrationResult(result));
    });

  const reference = program.command("reference").description("Reference operations");
  reference
    .command("add")
    .description("Copy a local source directory into references/frozen/YYYYMM")
    .argument("<source-dir>", "local source directory to freeze")
    .argument("<name>", "reference name")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (sourceDir, name, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addReference({ root, source: sourceDir, name });
      writeLine(output, "stdout", `Frozen reference: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  const analysis = program.command("analysis").description("Analysis operations");
  analysis
    .command("new")
    .description("Create a reference analysis draft")
    .argument("<title>", "analysis title")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await createAnalysis({ root, title });
      writeLine(output, "stdout", `Created analysis: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  const iteration = program.command("iteration").description("Iteration operations");
  iteration
    .command("start")
    .description("Start an iteration against our own framework")
    .argument("<title>", "iteration title")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await startIteration({ root, title });
      writeLine(output, "stdout", `Started iteration: ${result.path}`);
      writeLine(output, "stdout", `Plan: ${result.planPath}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  const event = program.command("event").description("Event ledger operations");
  event
    .command("capture")
    .description("Capture a low-friction event")
    .addOption(
      new Option("--kind <kind>", "event kind")
        .choices(["observation", "analysis", "decision", "gotcha", "note"])
        .makeOptionMandatory(),
    )
    .requiredOption("--text <text>", "event text")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await captureEvent({
        root,
        kind: commandOptions.kind,
        text: commandOptions.text,
      });
      writeLine(output, "stdout", `Captured event: ${result.eventFile}`);
    });

  return program;
}

export async function runCli(
  argv: readonly string[],
  options: CreateProgramOptions = {},
): Promise<number> {
  let exitCode = 0;
  const runtimeOutput = createOutput(options);
  const output = {
    stdout: runtimeOutput.stdout,
    stderr: runtimeOutput.stderr,
    setExitCode: (code: number) => {
      exitCode = code;
      runtimeOutput.setExitCode(code);
    },
  } satisfies CliOutput;
  const program = createProgram({ ...options, output }).exitOverride();

  try {
    await program.parseAsync([...argv], { from: "node" });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") {
      return 0;
    }
    if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") {
      return error.exitCode;
    }
    const failure = mapCliError(error);
    runtimeOutput.stderr(`${failure.message}\n`);
    return failure.exitCode;
  }

  return exitCode;
}
