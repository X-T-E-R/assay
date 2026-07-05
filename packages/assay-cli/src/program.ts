import path from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type AdrStatus,
  type AnalysisExit,
  type AssayProjectRegistryStatus,
  type IterationResult,
  type KnowledgeType,
  SOURCE_CAPTURE_MODES,
  SOURCE_CHANGE_CLASSES,
  type SourceCaptureMode,
  type SourceChangeClass,
  type SystemVcs,
  type WorkspacePrivacy,
  absorbReference,
  acceptAdr,
  addKnowledge,
  addReference,
  addSource,
  adoptExistingProject,
  applyUpdate,
  archiveSystem,
  attachExistingRepo,
  captureEvent,
  checkFramework,
  closeAnalysis,
  closeIteration,
  createAdr,
  createAnalysis,
  deprecateAdr,
  diffSource,
  discoverFrameworkRoot,
  findAdr,
  findProjectRecord,
  findSystem,
  forgetProject,
  getFrameworkStatus,
  getSourceLog,
  getSourceStatus,
  initFramework,
  listAdrs,
  listAvailableArchetypes,
  listProjectRecords,
  listSystems,
  loadManifest,
  migrateLayout,
  promoteSystem,
  pruneProjects,
  recordProjectLifecycleBestEffort,
  registerSystem,
  requireAdrIndex,
  requireSystemsRegistry,
  scanForProjects,
  startIteration,
  supersedeAdr,
  switchSource,
  syncSource,
} from "assay-core";

import { mapCliError } from "./errors.js";
import {
  formatAdoptionResult,
  formatAdrList,
  formatAdrRecord,
  formatAttachResult,
  formatCheckResult,
  formatInitResult,
  formatMigrationResult,
  formatProjectList,
  formatProjectRecord,
  formatSourceDiffResult,
  formatSourceLogResult,
  formatSourceStatusResult,
  formatSourceSyncResult,
  formatStatusResult,
  formatSystemList,
  formatSystemRecord,
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

interface AdrListOptions {
  readonly json?: boolean;
  readonly root: string;
  readonly status?: string;
}

const PROJECT_STATUSES: readonly AssayProjectRegistryStatus[] = [
  "active",
  "missing",
  "uninstalled",
];

const ADR_STATUSES: readonly AdrStatus[] = ["proposed", "accepted", "superseded", "deprecated"];
const ABSORPTION_OUTLETS: readonly AbsorptionOutlet[] = ["problem", "intake"];

type AbsorptionOutlet = "problem" | "intake";

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

async function archetypeListRoot(root: string): Promise<string> {
  try {
    return await discoverFrameworkRoot(root);
  } catch {
    return path.resolve(root);
  }
}

function writeJson(output: { readonly stdout: CliOutput["stdout"] }, value: unknown): void {
  output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseStatusFilter(status?: string): AssayProjectRegistryStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (PROJECT_STATUSES.includes(status as AssayProjectRegistryStatus)) {
    return status as AssayProjectRegistryStatus;
  }
  throw new Error(`--status must be one of: ${PROJECT_STATUSES.join(", ")}`);
}

function parseAdrStatusFilter(status?: string): AdrStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (ADR_STATUSES.includes(status as AdrStatus)) {
    return status as AdrStatus;
  }
  throw new Error(`--status must be one of: ${ADR_STATUSES.join(", ")}`);
}

async function writeArchetypeCommandResult(
  output: Pick<CliOutput, "stdout" | "stderr">,
  options: { readonly root: string; readonly json?: boolean },
): Promise<void> {
  const root = await discoveredRoot(options.root);
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new Error("No framework manifest found");
  }
  const payload = {
    project: manifest.project.name,
    archetype: manifest.project.archetype,
    mode: manifest.project.mode,
  };
  if (options.json) {
    writeJson(output, payload);
    return;
  }
  writeLine(output, "stdout", `Project: ${payload.project}`);
  writeLine(output, "stdout", `Archetype: ${payload.archetype}`);
  writeLine(output, "stdout", `Mode: ${payload.mode}`);
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("assay")
    .description("Bootstrap and update an Assay evidence workbench.")
    .version("0.2.0")
    .configureOutput({
      writeOut: (text) => output.stdout(text),
      writeErr: (text) => output.stderr(text),
    });

  program
    .command("init")
    .description("Initialize an Assay workspace without overwriting by default")
    .argument("[target-dir]", "target workspace directory", process.cwd())
    .option("--name <project-name>", "project name")
    .option("--git", "initialize a git repository in the workspace root")
    .option("--force", "overwrite existing files and track them as managed")
    .option("--create-new", "write .new copies when files already exist")
    .option("--no-track", "do not update the Assay project registry")
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .addOption(
      new Option("--archetype <archetype>", "project archetype name (run `assay archetype list`)"),
    )
    .action(async (targetDir, commandOptions) => {
      const archetype = commandOptions.archetype ?? "study";
      const initOptions = {
        target: targetDir,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        git: commandOptions.git ?? false,
        force: commandOptions.force ?? false,
        createNew: commandOptions.createNew ?? false,
        agents: commandOptions.agents !== false,
        archetype,
      };
      const result = await initFramework(initOptions);
      await recordProjectLifecycleBestEffort(result.root, "init", {
        noTrack: commandOptions.track === false,
      });
      writeLine(output, "stdout", formatInitResult(result));
    });

  program
    .command("adopt")
    .description("Archive an existing project into .old and initialize a clean Assay scaffold")
    .option("--root <target-dir>", "existing project root to adopt", process.cwd())
    .option("--name <project-name>", "project name")
    .addOption(new Option("--dry-run", "plan adoption without applying writes").conflicts("apply"))
    .addOption(
      new Option("--apply", "move existing root entries and initialize the scaffold").conflicts(
        "dryRun",
      ),
    )
    .option("--no-track", "do not update the Assay project registry")
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .option("--analyze", "after apply, generate an adoption inventory and open an analysis for it")
    .action(async (commandOptions) => {
      const result = await adoptExistingProject({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        dryRun: commandOptions.dryRun ?? false,
        apply: commandOptions.apply ?? false,
        agents: commandOptions.agents !== false,
        noTrack: commandOptions.track === false,
        analyze: commandOptions.analyze ?? false,
      });
      writeLine(output, "stdout", formatAdoptionResult(result));
      if (result.adoptionAnalysisPath) {
        writeLine(output, "stdout", `Adoption analysis: ${result.adoptionAnalysisPath}`);
        writeLine(
          output,
          "stdout",
          "Next: review the inventory, move archived entries into the new structure, then close the analysis.",
        );
      }
      if (!result.dryRun && result.failures.length > 0) {
        output.setExitCode(1);
      }
    });

  program
    .command("attach")
    .description("Attach Assay privately to an existing product repository (overlay mode)")
    .option("--root <target-dir>", "existing repository root to attach", process.cwd())
    .option("--name <project-name>", "project name (defaults to directory basename)")
    .addOption(
      new Option("--archetype <archetype>", "project archetype name (run `assay archetype list`)"),
    )
    .addOption(
      new Option(
        "--privacy <privacy>",
        "overlay Git privacy: private (default), private-git, tracked",
      )
        .choices(["private", "private-git", "tracked"])
        .default("private"),
    )
    .option("--no-track", "do not update the Assay project registry")
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .action(async (commandOptions) => {
      const result = await attachExistingRepo({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.archetype === undefined ? {} : { archetype: commandOptions.archetype }),
        privacy: commandOptions.privacy as WorkspacePrivacy,
      });
      writeLine(output, "stdout", formatAttachResult(result));
    });

  program
    .command("check")
    .description("Check required workspace structure")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
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
    .description("Print workspace status")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      writeLine(output, "stdout", formatStatusResult(await getFrameworkStatus({ root })));
    });

  program
    .command("update")
    .description("Update managed workspace files using manifest hashes")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--dry-run", "plan update without applying writes")
    .option("--agents", "install or refresh the Assay managed block in root AGENTS.md")
    .option("--no-track", "do not update the Assay project registry")
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
        ...(commandOptions.agents === true ? { agents: true } : {}),
      });
      await recordProjectLifecycleBestEffort(root, "update", {
        noTrack: commandOptions.track === false,
      });
      writeLine(output, "stdout", formatUpdateResult(result));
    });

  const projects = program
    .command("projects")
    .description("List and manage Assay scaffolded projects")
    .action(async () => {
      const records = (await listProjectRecords()).filter(
        (record) => record.status !== "uninstalled",
      );
      writeLine(output, "stdout", formatProjectList("tracked Assay projects", records));
    });

  projects
    .command("list")
    .description("List tracked Assay projects")
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
      writeLine(output, "stdout", formatProjectList("tracked Assay projects", records));
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
    .description("Scan directories for .assay/manifest.json projects and register them")
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
          ? "No Assay projects found."
          : formatProjectList(`registered ${records.length} Assay project(s)`, records),
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
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(new Option("--dry-run", "plan migration without applying writes").conflicts("apply"))
    .addOption(new Option("--apply", "apply copy-first migration steps").conflicts("dryRun"))
    .option("--backup", "with --apply, back up pre-existing files overwritten by migration")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const shouldApply = commandOptions.apply === true;
      const result = await migrateLayout({
        root,
        dryRun: !shouldApply,
        apply: shouldApply,
        backup: commandOptions.backup === true,
      });
      writeLine(output, "stdout", formatMigrationResult(result));
    });

  const archetypeCommand = program
    .command("archetype")
    .description("Show the current manifest archetype and mode")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      await writeArchetypeCommandResult(output, commandOptions);
    });

  archetypeCommand
    .command("list")
    .description("List built-in and custom archetypes")
    .option("--root <target-dir>", "project root for local archetypes", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const parentOptions = archetypeCommand.opts() as { json?: boolean; root?: string };
      const rootOption =
        commandOptions.root === process.cwd()
          ? (parentOptions.root ?? commandOptions.root)
          : commandOptions.root;
      const root = await archetypeListRoot(rootOption);
      const archetypes = await listAvailableArchetypes({ root });
      if (commandOptions.json || parentOptions.json) {
        writeJson(output, archetypes);
        return;
      }
      writeLine(output, "stdout", "Available archetypes:");
      for (const archetype of archetypes) {
        writeLine(output, "stdout", `- ${archetype.name} (${archetype.source}): ${archetype.path}`);
      }
    });

  const reference = program.command("reference").description("Reference operations");
  reference
    .command("add")
    .description("Copy a local source directory into references/frozen/YYYYMM")
    .argument("<source-dir>", "local source directory to freeze")
    .argument("<name>", "reference name")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (sourceDir, name, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addReference({ root, source: sourceDir, name });
      writeLine(output, "stdout", `Frozen reference: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  const source = program.command("source").description("Living external source operations");
  source
    .command("add")
    .description("Add a living external source under references/<alias>/")
    .argument("<repo-or-dir>", "local source directory or git repository URL")
    .argument("[alias]", "short filesystem-safe source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--branch <branch>", "branch to check out for Git-backed sources")
    .addOption(
      new Option("--capture <mode>", `capture mode (${SOURCE_CAPTURE_MODES.join("|")})`)
        .choices([...SOURCE_CAPTURE_MODES])
        .default("checkout"),
    )
    .action(async (repoOrDir, alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addSource({
        root,
        source: repoOrDir,
        ...(alias === undefined ? {} : { alias }),
        ...(commandOptions.branch === undefined ? {} : { branch: commandOptions.branch }),
        capture: commandOptions.capture as SourceCaptureMode,
      });
      writeLine(output, "stdout", `Added source: ${result.path}`);
      writeLine(output, "stdout", `Observation: ${result.observationFile}`);
      writeLine(output, "stdout", `Manifest: ${result.manifestFile}`);
      if (result.checkoutPath) {
        writeLine(output, "stdout", `Checkout: ${result.checkoutPath}`);
      }
      writeLine(output, "stdout", `Materials: ${result.materialsPath}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  source
    .command("sync")
    .description("Observe an existing source again and update current materials")
    .argument("[alias]", "source alias; optional when exactly one source exists")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--branch <branch>", "Git branch to check out before observing")
    .option("--ref <ref>", "Git ref to check out before observing")
    .addOption(
      new Option("--class <change-class>", "override advisory change class").choices([
        ...SOURCE_CHANGE_CLASSES,
      ]),
    )
    .action(async (alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await syncSource({
        root,
        ...(alias === undefined ? {} : { alias }),
        ...(commandOptions.branch === undefined ? {} : { branch: commandOptions.branch }),
        ...(commandOptions.ref === undefined ? {} : { ref: commandOptions.ref }),
        ...(commandOptions.class === undefined
          ? {}
          : { changeClass: commandOptions.class as SourceChangeClass }),
      });
      writeLine(output, "stdout", formatSourceSyncResult(result));
    });

  source
    .command("switch")
    .description("Switch a Git-backed source checkout to a branch or ref")
    .argument("<alias>", "source alias")
    .argument("<branch-or-ref>", "branch, tag, or commit")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--sync", "record an observation after switching")
    .action(async (alias, target, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await switchSource({
        root,
        alias,
        target,
        sync: commandOptions.sync ?? false,
      });
      writeLine(output, "stdout", `Switched source: ${result.path}`);
      writeLine(output, "stdout", `Ref: ${result.vcs.ref}`);
      writeLine(output, "stdout", `Commit: ${result.vcs.commit}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      if (result.sync) {
        writeLine(output, "stdout", formatSourceSyncResult(result.sync));
      }
    });

  source
    .command("status")
    .description("Show living source status")
    .argument("[alias]", "source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      writeLine(
        output,
        "stdout",
        formatSourceStatusResult(
          await getSourceStatus({ root, ...(alias === undefined ? {} : { alias }) }),
        ),
      );
    });

  source
    .command("log")
    .description("Show a source observation log")
    .argument("<alias>", "source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      writeLine(output, "stdout", formatSourceLogResult(await getSourceLog({ root, alias })));
    });

  source
    .command("diff")
    .description("Show file-level differences for the latest source observation")
    .argument("<alias>", "source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--since <observation>", "observation id or observations/<id>.yaml path")
    .action(async (alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      writeLine(
        output,
        "stdout",
        formatSourceDiffResult(
          await diffSource({
            root,
            alias,
            ...(commandOptions.since === undefined ? {} : { since: commandOptions.since }),
          }),
        ),
      );
    });

  program
    .command("absorb")
    .description("Absorb a source using the workspace manifest mode and open a pre-filled analysis")
    .argument("<source-dir>", "local source directory to absorb")
    .option("--name <name>", "reference name (defaults to source directory basename)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(
      new Option("--as <outlet>", "absorption-mode outlet: problem (default) or intake").choices([
        ...ABSORPTION_OUTLETS,
      ]),
    )
    .action(async (sourceDir, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await absorbReference({
        root,
        source: sourceDir,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.as === undefined ? {} : { outlet: commandOptions.as }),
      });
      writeLine(output, "stdout", `Absorbed source: ${result.referencePath}`);
      writeLine(output, "stdout", `Opened analysis: ${result.analysisPath}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(
        output,
        "stdout",
        "Next: fill ## Key observations in the analysis, then `assay analysis close <path> --exit ...`.",
      );
    });

  const analysis = program.command("analysis").description("Analysis operations");
  analysis
    .command("new")
    .description("Create a reference analysis draft")
    .argument("<title>", "analysis title")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option(
      "--for-reference <path>",
      "frozen reference path to bind (pre-fills Reference/Source/Freeze path)",
    )
    .option("--for-source <alias>", "living source alias to bind")
    .option("--observation <id-or-path>", "source observation id/path; defaults to latest")
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await createAnalysis({
        root,
        title,
        ...(commandOptions.forReference === undefined
          ? {}
          : { forReference: commandOptions.forReference }),
        ...(commandOptions.forSource === undefined ? {} : { forSource: commandOptions.forSource }),
        ...(commandOptions.observation === undefined
          ? {}
          : { observation: commandOptions.observation }),
      });
      writeLine(output, "stdout", `Created analysis: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  analysis
    .command("close")
    .description("Close an analysis with a decision exit")
    .argument("<path>", "analysis file path relative to workspace root")
    .addOption(
      new Option("--exit <exit>", "decision exit")
        .choices(["adopt", "reject", "experiment", "adr"])
        .makeOptionMandatory(),
    )
    .option("--note <note>", "closing note")
    .option("--allow-empty", "allow closing an analysis without required content gates")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (analysisPath, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await closeAnalysis({
        root,
        path: analysisPath,
        exit: commandOptions.exit as AnalysisExit,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
        ...(commandOptions.allowEmpty === undefined
          ? {}
          : { allowEmpty: commandOptions.allowEmpty }),
      });
      writeLine(output, "stdout", `Closed analysis: ${result.path}`);
      writeLine(output, "stdout", `Exit: ${commandOptions.exit}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  const iteration = program.command("iteration").description("Iteration operations");
  iteration
    .command("start")
    .description("Start an iteration against your own systems")
    .argument("<title>", "iteration title")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await startIteration({ root, title });
      writeLine(output, "stdout", `Started iteration: ${result.path}`);
      writeLine(output, "stdout", `Plan: ${result.planPath}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  iteration
    .command("close")
    .description("Close an iteration with a result")
    .argument("<selector>", "iteration path or directory name prefix")
    .addOption(
      new Option("--result <result>", "iteration outcome")
        .choices(["applied", "rejected", "retest"])
        .makeOptionMandatory(),
    )
    .option("--note <note>", "closing note")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await closeIteration({
        root,
        selector,
        result: commandOptions.result as IterationResult,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
      });
      writeLine(output, "stdout", `Closed iteration: ${result.path}`);
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
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await captureEvent({
        root,
        kind: commandOptions.kind,
        text: commandOptions.text,
      });
      writeLine(output, "stdout", `Captured event: ${result.eventFile}`);
    });

  const adr = program.command("adr").description("Architecture decision record operations");

  adr
    .command("new")
    .description("Create a proposed ADR under knowledge/decisions")
    .argument("<title>", "ADR title")
    .option("--from-analysis <path>", "originating analysis path")
    .option("--from-iteration <path>", "originating iteration path")
    .option(
      "--force",
      "create even if a blocking external governance system (trellis or .superpowers/) is detected",
    )
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await createAdr(
        root,
        {
          title,
          ...(commandOptions.fromAnalysis === undefined
            ? {}
            : { relatedAnalysis: commandOptions.fromAnalysis }),
          ...(commandOptions.fromIteration === undefined
            ? {}
            : { relatedIteration: commandOptions.fromIteration }),
        },
        {
          force: commandOptions.force ?? false,
          onWarning: (message) => writeLine(output, "stderr", message),
        },
      );
      writeLine(output, "stdout", `Created ADR: ${result.adr.id}`);
      writeLine(output, "stdout", `Path: ${result.adr.path}`);
      writeLine(output, "stdout", `Status: ${result.adr.status}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  adr
    .command("accept")
    .description("Accept a proposed ADR")
    .argument("<selector>", "ADR id, number, or unique id prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await acceptAdr(root, selector);
      writeLine(output, "stdout", `Accepted ADR: ${result.adr.id}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  adr
    .command("supersede")
    .description("Mark an accepted ADR as superseded by another accepted ADR")
    .argument("<old-selector>", "ADR being superseded")
    .argument("<new-selector>", "accepted replacement ADR")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (oldSelector, newSelector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await supersedeAdr(root, oldSelector, newSelector);
      writeLine(output, "stdout", `Superseded ADR: ${result.oldAdr.id}`);
      writeLine(output, "stdout", `Replacement: ${result.newAdr.id}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  adr
    .command("deprecate")
    .description("Deprecate a proposed or accepted ADR without replacing it")
    .argument("<selector>", "ADR id, number, or unique id prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await deprecateAdr(root, selector);
      writeLine(output, "stdout", `Deprecated ADR: ${result.adr.id}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  adr
    .command("list")
    .description("List indexed ADRs")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .addOption(new Option("--status <status>", "filter by status").choices([...ADR_STATUSES]))
    .action(async (commandOptions: AdrListOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const status = parseAdrStatusFilter(commandOptions.status);
      const { adrs } = await listAdrs(root, status);
      if (commandOptions.json) {
        writeJson(output, { adrs });
        return;
      }
      writeLine(output, "stdout", formatAdrList("Architecture decision records", adrs));
    });

  adr
    .command("show")
    .description("Show one ADR by id, number, or unique id prefix")
    .argument("<selector>", "ADR id, number, or unique id prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const index = await requireAdrIndex(root);
      const record = findAdr(index, selector);
      if (commandOptions.json) {
        writeJson(output, record);
        return;
      }
      writeLine(output, "stdout", formatAdrRecord(record));
    });

  const system = program.command("system").description("System registry operations");

  system
    .command("register")
    .description("Register a system directory in the systems registry")
    .argument("<path>", "system directory (relative to workspace root)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--name <name>", "system name (defaults to directory basename)")
    .addOption(
      new Option("--vcs <vcs>", "version control mode").choices([
        "independent-git",
        "embedded",
        "none",
      ]),
    )
    .option("--vcs-ref <ref>", "branch, commit, or tag")
    .option("--system-version <version>", "system semantic version")
    .option("--primary", "set this system as the primary system")
    .option("--supersedes <names>", "comma-separated superseded system names")
    .action(async (systemPath, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const vcs = commandOptions.vcs as SystemVcs | undefined;
      const supersedes = commandOptions.supersedes
        ? commandOptions.supersedes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const result = await registerSystem(root, {
        path: systemPath,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(vcs === undefined ? {} : { vcs }),
        ...(commandOptions.vcsRef === undefined ? {} : { vcsRef: commandOptions.vcsRef }),
        ...(commandOptions.systemVersion === undefined
          ? {}
          : { version: commandOptions.systemVersion }),
        primary: commandOptions.primary ?? false,
        supersedes,
      });
      writeLine(output, "stdout", `Registered system: ${result.system.name}`);
      writeLine(output, "stdout", `Status: ${result.system.status}`);
      writeLine(output, "stdout", "Registry: .assay/systems-registry.json");
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  system
    .command("promote")
    .description("Promote a system to primary; demotes the previous primary")
    .argument("<selector>", "system name or unique name prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await promoteSystem(root, selector);
      writeLine(output, "stdout", `Promoted: ${result.system.name}`);
      if (result.previousPrimary) {
        writeLine(
          output,
          "stdout",
          `Previous primary: ${result.previousPrimary.name} (now superseded)`,
        );
      }
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  system
    .command("archive")
    .description("Archive a non-primary system into systems/archive/")
    .argument("<selector>", "system name or unique name prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(new Option("--dry-run", "plan archive without moving files").conflicts("apply"))
    .addOption(new Option("--apply", "move the system into the archive").conflicts("dryRun"))
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const dryRun = commandOptions.dryRun ?? !commandOptions.apply;
      const result = await archiveSystem(root, selector, { dryRun });
      writeLine(output, "stdout", `System archive: ${result.dryRun ? "dry-run" : "applied"}`);
      writeLine(output, "stdout", `System: ${result.system.name}`);
      if (result.movedTo) {
        writeLine(
          output,
          "stdout",
          `${result.dryRun ? "Would move to" : "Moved to"}: ${result.movedTo}`,
        );
      }
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
    });

  system
    .command("list")
    .description("List all registered systems")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .addOption(
      new Option("--status <status>", "filter by status").choices([
        "primary",
        "active",
        "superseded",
        "archived",
      ]),
    )
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const { registry, systems } = await listSystems(root);
      const filtered = commandOptions.status
        ? systems.filter((sys) => sys.status === commandOptions.status)
        : systems;
      if (commandOptions.json) {
        writeJson(output, { primary: registry.primary, systems: filtered });
        return;
      }
      writeLine(
        output,
        "stdout",
        formatSystemList("Registered systems", registry.primary, filtered),
      );
    });

  system
    .command("show")
    .description("Show one registered system by name or unique prefix")
    .argument("<selector>", "system name or unique name prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const registry = await requireSystemsRegistry(root);
      const record = await findSystem(registry, selector);
      if (commandOptions.json) {
        writeJson(output, record);
        return;
      }
      writeLine(output, "stdout", formatSystemRecord(record));
    });

  const knowledge = program.command("knowledge").description("Knowledge operations");
  knowledge
    .command("add")
    .description("Add a knowledge entry")
    .argument("<type>", "knowledge type: decision, pattern, guide, troubleshooting")
    .argument("<title>", "knowledge entry title")
    .option("--from-analysis <path>", "originating analysis path")
    .option("--from-iteration <path>", "originating iteration path")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (type, title, commandOptions) => {
      const validTypes = ["decision", "pattern", "guide", "troubleshooting"];
      if (!validTypes.includes(type)) {
        output.stderr(`Invalid type '${type}'. Must be one of: ${validTypes.join(", ")}\n`);
        output.setExitCode(1);
        return;
      }
      const root = await discoveredRoot(commandOptions.root);
      const result = await addKnowledge({
        root,
        type: type as KnowledgeType,
        title,
        ...(commandOptions.fromAnalysis === undefined
          ? {}
          : { fromAnalysis: commandOptions.fromAnalysis }),
        ...(commandOptions.fromIteration === undefined
          ? {}
          : { fromIteration: commandOptions.fromIteration }),
      });
      writeLine(output, "stdout", `Added knowledge: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
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
