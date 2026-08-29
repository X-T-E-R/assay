import { Command, Option } from "@commander-js/extra-typings";
import { createProgram as createStudyProgram } from "absorb-anything";
import { discoverFrameworkRoot, getSourceStatus } from "absorb-anything-core";
import { createProgram as createBuildProgram } from "own-work";

import { ASSAY_VERSION } from "./constants.js";
import { mapCliError } from "./errors.js";
import { checkAssay, getAssayStatus, initAssay, primeAssay } from "./lifecycle.js";
import { mountHalf } from "./mount.js";
import { ASSAY_TOPICS, assayDigestSentence, requireAssaySemantics } from "./semantics.js";

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

function emit(output: Pick<CliOutput, "stdout">, value: unknown, json = false): void {
  output.stdout(`${json || typeof value !== "string" ? JSON.stringify(value, null, 2) : value}\n`);
}

async function rootFor(input: string): Promise<string> {
  return discoverFrameworkRoot(input);
}

function sourceSummary(result: Awaited<ReturnType<typeof getSourceStatus>>): string {
  if (result.sources.length === 0 && result.broken.length === 0) return "No Sources.";
  return [
    ...result.sources.map(
      (source) =>
        `${source.alias}: ${source.contentMode}${source.latestObservation ? ` @ ${source.latestObservation}` : ""}${source.reference ? `  ref -> ${source.reference.display}` : ""}`,
    ),
    ...result.broken.map(
      (reference) => `${reference.alias}: broken reference (${reference.reason})`,
    ),
  ].join("\n");
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("assay")
    .description(
      "One suite over absorb-anything and own-work: absorb what you study, build what you own.",
    )
    .version(ASSAY_VERSION)
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr });

  program
    .command("init")
    .description("Initialize a standalone .assay workspace; use --overlay to keep work inside it")
    .argument("[target]", "target workspace directory", process.cwd())
    .option("--name <project-name>", "project name")
    .option("--overlay", "keep every work folder inside the envelope")
    .option("--git", "initialize Git at the workspace root")
    .option("--no-agents", "skip the managed AGENTS.md block")
    .addOption(
      new Option(
        "--template <template>",
        "study, solve, explore, or an explicit YAML path",
      ).default("study"),
    )
    .option("--json", "emit JSON")
    .action(async (target, commandOptions) => {
      const result = await initAssay({
        target,
        ...(commandOptions.name ? { name: commandOptions.name } : {}),
        overlay: commandOptions.overlay ?? false,
        git: commandOptions.git ?? false,
        agents: commandOptions.agents,
        template: commandOptions.template,
      });
      emit(
        output,
        commandOptions.json
          ? result
          : [
              `Initialized ${result.mode} workspace: ${result.root}`,
              `Envelope: ${result.envelope} (${result.createdEnvelope ? "created" : "reused"})`,
              `Project: ${result.project}`,
              `Template: ${result.template ?? "existing workspace kept its own"}`,
              `System registry: ${result.createdRegistry && result.system ? `created (${result.system})` : "reused or deferred"}`,
            ].join("\n"),
        commandOptions.json,
      );
    });

  program
    .command("check")
    .description("Check the shared envelope plus study evidence and build records")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--advisories", "include non-blocking Source advisories")
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await checkAssay({
        root: await rootFor(commandOptions.root),
        includeAdvisories: commandOptions.advisories ?? false,
      });
      emit(
        output,
        commandOptions.json
          ? result
          : result.rows
              .map(
                (row) =>
                  `${row.status.toUpperCase()} ${row.path}${row.message ? ` — ${row.message}` : ""}`,
              )
              .join("\n"),
        commandOptions.json,
      );
      if (!result.ok) output.setExitCode(1);
    });

  program
    .command("status")
    .description("Show the workspace, its study summary, and its build counts")
    .argument("[alias]", "optional Source alias")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json", "emit JSON")
    .action(async (alias, commandOptions) => {
      const root = await rootFor(commandOptions.root);
      if (alias) {
        const all = await getSourceStatus({ root });
        const result = {
          ...all,
          sources: all.sources.filter((entry) => entry.alias === alias),
          broken: all.broken.filter((entry) => entry.alias === alias),
        };
        // An alias nobody holds must fail, not print an empty summary.
        if (result.sources.length === 0 && result.broken.length === 0) {
          await getSourceStatus({ root, alias });
        }
        emit(output, commandOptions.json ? result : sourceSummary(result), commandOptions.json);
        return;
      }
      const result = await getAssayStatus({ root });
      const human = result.common.hasManifest
        ? [
            "Assay status",
            `Root: ${result.common.root}`,
            `Envelope: ${result.common.envelope}`,
            `Project: ${result.common.project ?? "unknown"}`,
            `Sources: ${result.study.sources}`,
            `Broken references: ${result.study.brokenReferences}`,
            `Knowledge: ${result.study.knowledgeEntries}`,
            `Tasks: ${result.build.tasks}`,
            `Roadmaps: ${result.build.roadmaps}`,
            `Specs: ${result.build.specs}`,
            `Systems: ${result.build.systems}`,
            `Primary System: ${result.build.primarySystem ?? "none"}`,
          ].join("\n")
        : `Assay status\nRoot: ${result.common.root}\nWorkspace: not initialized`;
      emit(output, commandOptions.json ? result : human, commandOptions.json);
    });

  program
    .command("prime")
    .description("Orient a session with the merged object table and workspace state")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await primeAssay({ root: await rootFor(commandOptions.root) });
      const human = [
        "Assay prime",
        `Root: ${result.root}`,
        ...result.semantics.map((entry) => `- ${assayDigestSentence(entry)}`),
        result.workspace
          ? `Workspace: ${result.workspace.envelope} (${result.workspace.installedVersion ?? "unknown"}); Sources ${result.workspace.sources}; Knowledge ${result.workspace.knowledgeEntries}; Tasks ${result.workspace.tasks}; Roadmaps ${result.workspace.roadmaps}; Specs ${result.workspace.specs}; Systems ${result.workspace.systems}`
          : "Workspace: not initialized",
        `Details: ${result.detailsCommand}`,
      ].join("\n");
      emit(output, commandOptions.json ? result : human, commandOptions.json);
    });

  program
    .command("explain")
    .description(`Explain an object (${ASSAY_TOPICS.join(", ")})`)
    .argument("<topic>", "object topic")
    .option("--json", "emit JSON")
    .action(async (topic, commandOptions) => {
      const entry = requireAssaySemantics(topic);
      const human = [
        `${entry.label} — ${entry.purpose}`,
        `Most-broken rule: ${entry.antiRule}`,
        "Why it exists:",
        ...entry.whyItExists.map((line) => `- ${line}`),
        "When not to use it:",
        ...entry.whenNotToUse.map((line) => `- ${line}`),
        "Common misuses:",
        ...entry.commonMisuses.map((line) => `- ${line}`),
        "Commands:",
        ...entry.commands.map((line) => `- ${line}`),
      ].join("\n");
      emit(output, commandOptions.json ? entry : human, commandOptions.json);
    });

  mountHalf(program, createStudyProgram({ output }));
  mountHalf(program, createBuildProgram({ output }));
  return program;
}

export async function runCli(
  argv: readonly string[],
  options: CreateProgramOptions = {},
): Promise<number> {
  let exitCode = 0;
  const runtimeOutput = createOutput(options);
  const output = {
    ...runtimeOutput,
    setExitCode: (code: number) => {
      exitCode = code;
      runtimeOutput.setExitCode(code);
    },
  };
  const program = createProgram({ ...options, output }).exitOverride();
  try {
    await program.parseAsync([...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed")
      return 0;
    if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number")
      return error.exitCode;
    const failure = mapCliError(error);
    runtimeOutput.stderr(`${failure.message}\n`);
    return failure.exitCode;
  }
  return exitCode;
}
