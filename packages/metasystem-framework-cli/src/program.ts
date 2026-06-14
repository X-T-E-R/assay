import { Command, Option } from "@commander-js/extra-typings";
import {
  addReference,
  applyUpdate,
  captureEvent,
  checkFramework,
  createAnalysis,
  discoverFrameworkRoot,
  getFrameworkStatus,
  initFramework,
  migrateLayout,
  startIteration,
} from "metasystem-framework-core";

import { mapCliError } from "./errors.js";
import {
  formatCheckResult,
  formatInitResult,
  formatMigrationResult,
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
      writeLine(output, "stdout", formatInitResult(result));
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
      writeLine(output, "stdout", formatUpdateResult(result));
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
