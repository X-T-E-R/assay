import { Command, Option } from "@commander-js/extra-typings";
import {
  type AdrStatus,
  type AnalysisExit,
  type AssayProjectRegistryStatus,
  type IterationResult,
  type KnowledgeType,
  type SystemVcs,
  absorbReference,
  acceptAdr,
  addKnowledge,
  addReference,
  adoptExistingProject,
  applyUpdate,
  archiveSystem,
  captureEvent,
  checkFramework,
  closeAnalysis,
  closeIteration,
  createAdr,
  createAnalysis,
  deprecateAdr,
  discoverFrameworkRoot,
  findAdr,
  findProjectRecord,
  findSystem,
  forgetProject,
  getFrameworkStatus,
  initFramework,
  listAdrs,
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
} from "assay-core";

import { mapCliError } from "./errors.js";
import {
  formatAdoptionResult,
  formatAdrList,
  formatAdrRecord,
  formatCheckResult,
  formatInitResult,
  formatMigrationResult,
  formatProjectList,
  formatProjectRecord,
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
type ProjectArchetype = "research" | "contest" | "library";
type ProjectMode = "learning" | "absorption";

const PROJECT_ARCHETYPES: readonly ProjectArchetype[] = ["research", "contest", "library"];
const PROJECT_MODES: readonly ProjectMode[] = ["learning", "absorption"];
const ABSORPTION_OUTLETS: readonly AbsorptionOutlet[] = ["problem", "intake"];

type LegacyProfile = "assay" | "contest" | "library";
type AbsorptionOutlet = "problem" | "intake";

function archetypeFromLegacyProfile(profile: LegacyProfile): ProjectArchetype {
  return profile === "assay" ? "research" : profile;
}

function profileForCoreCompatibility(archetype: ProjectArchetype): ProjectArchetype {
  return archetype;
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

function selectedArchetype(options: {
  readonly archetype?: string;
  readonly profile?: string;
}): { readonly archetype: ProjectArchetype; readonly usedLegacyProfile?: LegacyProfile } {
  if (options.profile) {
    const profile = options.profile as LegacyProfile;
    return {
      archetype: archetypeFromLegacyProfile(profile),
      usedLegacyProfile: profile,
    };
  }
  return {
    archetype: (options.archetype ?? "research") as ProjectArchetype,
  };
}

async function writeArchetypeCommandResult(
  output: Pick<CliOutput, "stdout" | "stderr">,
  options: { readonly root: string; readonly json?: boolean },
  commandName: "archetype" | "profile",
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
    writeJson(output, commandName === "profile" ? { ...payload, deprecated_alias: true } : payload);
    return;
  }
  writeLine(output, "stdout", `Project: ${payload.project}`);
  writeLine(output, "stdout", `Archetype: ${payload.archetype}`);
  writeLine(output, "stdout", `Mode: ${payload.mode}`);
  if (commandName === "profile") {
    writeLine(
      output,
      "stdout",
      "Note: `profile` is a deprecated compatibility alias; use manifest project.archetype/project.mode and `assay init --archetype ...`.",
    );
  }
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("assay")
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
    .option("--git", "initialize a git repository in the framework root")
    .option("--force", "overwrite existing files and track them as managed")
    .option("--create-new", "write .new copies when files already exist")
    .addOption(
      new Option(
        "--mode <mode>",
        "project mode: learning (external refs) or absorption (source IS the project)",
      ).choices([...PROJECT_MODES]),
    )
    .addOption(
      new Option("--archetype <archetype>", "project archetype: research, contest, library")
        .choices([...PROJECT_ARCHETYPES])
        .conflicts("profile"),
    )
    .addOption(
      new Option("--profile <name>", "deprecated alias for --archetype (assay maps to research)")
        .choices(["assay", "library", "contest"])
        .conflicts("archetype"),
    )
    .action(async (targetDir, commandOptions) => {
      const { archetype, usedLegacyProfile } = selectedArchetype(commandOptions);
      const coreCompatibilityProfile = profileForCoreCompatibility(archetype);
      const initOptions = {
        target: targetDir,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        git: commandOptions.git ?? false,
        force: commandOptions.force ?? false,
        createNew: commandOptions.createNew ?? false,
        ...(commandOptions.mode === undefined ? {} : { mode: commandOptions.mode as ProjectMode }),
        archetype,
        profile: coreCompatibilityProfile,
      };
      const result = await initFramework(initOptions);
      await recordProjectLifecycleBestEffort(result.root, "init");
      writeLine(output, "stdout", formatInitResult(result));
      if (usedLegacyProfile) {
        writeLine(
          output,
          "stdout",
          `Deprecated: --profile ${usedLegacyProfile} maps to --archetype ${archetype}.`,
        );
      }
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
    .option("--analyze", "after apply, generate an adoption inventory and open an analysis for it")
    .action(async (commandOptions) => {
      const result = await adoptExistingProject({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        dryRun: commandOptions.dryRun ?? false,
        apply: commandOptions.apply ?? false,
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

  program
    .command("archetype")
    .description("Show the current manifest archetype and mode")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      await writeArchetypeCommandResult(output, commandOptions, "archetype");
    });

  program
    .command("profile")
    .description("Deprecated compatibility alias for `archetype`")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      await writeArchetypeCommandResult(output, commandOptions, "profile");
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

  program
    .command("absorb")
    .description("Absorb a source using the workspace manifest mode and open a pre-filled analysis")
    .argument("<source-dir>", "local source directory to absorb")
    .option("--name <name>", "reference name (defaults to source directory basename)")
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .option(
      "--for-reference <path>",
      "frozen reference path to bind (pre-fills Reference/Source/Freeze path)",
    )
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await createAnalysis({
        root,
        title,
        ...(commandOptions.forReference === undefined
          ? {}
          : { forReference: commandOptions.forReference }),
      });
      writeLine(output, "stdout", `Created analysis: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  analysis
    .command("close")
    .description("Close an analysis with a decision exit")
    .argument("<path>", "analysis file path relative to framework root")
    .addOption(
      new Option("--exit <exit>", "decision exit")
        .choices(["adopt", "reject", "experiment", "adr"])
        .makeOptionMandatory(),
    )
    .option("--note <note>", "closing note")
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (analysisPath, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await closeAnalysis({
        root,
        path: analysisPath,
        exit: commandOptions.exit as AnalysisExit,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
      });
      writeLine(output, "stdout", `Closed analysis: ${result.path}`);
      writeLine(output, "stdout", `Exit: ${commandOptions.exit}`);
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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

  const adr = program.command("adr").description("Architecture decision record operations");

  adr
    .command("new")
    .description("Create a proposed ADR under knowledge/decisions")
    .argument("<title>", "ADR title")
    .option("--from-analysis <path>", "originating analysis path")
    .option("--from-iteration <path>", "originating iteration path")
    .option(
      "--force",
      "create even if an external governance system (trellis, superpowers, docs/adr/) is detected",
    )
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
        { force: commandOptions.force ?? false },
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await deprecateAdr(root, selector);
      writeLine(output, "stdout", `Deprecated ADR: ${result.adr.id}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  adr
    .command("list")
    .description("List indexed ADRs")
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .argument("<path>", "system directory (relative to framework root)")
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
      writeLine(output, "stdout", "Registry: .framework/systems-registry.json");
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  system
    .command("promote")
    .description("Promote a system to primary; demotes the previous primary")
    .argument("<selector>", "system name or unique name prefix")
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
    .option("--root <target-dir>", "target framework directory", process.cwd())
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
