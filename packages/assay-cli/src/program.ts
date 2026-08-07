import path from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type AdrStatus,
  type AnalysisExit,
  type AssayProjectRegistryStatus,
  CURRENT_VERSION,
  DONOR_TAKE_MODES,
  type DonorDecisionOutcome,
  type DonorTakeMode,
  type IntentPromotionTarget,
  type IterationResult,
  type KnowledgeType,
  SOURCE_CAPTURE_MODES,
  SOURCE_CHANGE_CLASSES,
  SUPPORTED_CAPABILITY_MODULES,
  type SourceCaptureMode,
  type SourceChangeClass,
  type SystemIntentAuthority,
  type SystemIntentAuthorityMode,
  type SystemVcs,
  type WorkspacePrivacy,
  absorbReference,
  acceptAdr,
  addCapability,
  addKnowledge,
  addPlugin,
  addReference,
  addSource,
  adoptExistingProject,
  appendTrellisJournal,
  applyTrellisLegacyHookScrub,
  applyTrellisLegacyMigration,
  applyUpdate,
  archiveSystem,
  archiveTrellisTask,
  attachExistingRepo,
  backfillReferenceCaseFile,
  captureEvent,
  captureIntent,
  checkFramework,
  checkPlugins,
  claimTrellisWorker,
  cleanupTrellisLegacyMigration,
  closeAnalysis,
  closeIteration,
  contextTrellisMemory,
  convertOverlayToStandalone,
  createAdr,
  createAnalysis,
  createTrellisChannel,
  createTrellisTask,
  currentTrellisSession,
  decideDonorAdoption,
  deprecateAdr,
  diffSource,
  discoverFrameworkRoot,
  endTrellisSession,
  findAdr,
  findProjectRecord,
  findSystem,
  finishTrellisWorker,
  forgetProject,
  getCurrentTrellisTask,
  getDecisionGovernanceStatus,
  getDonorAdoption,
  getDonorHistory,
  getDonorStatus,
  getFrameworkStatus,
  getSourceLog,
  getSourceStatus,
  getTrellisContext,
  getTrellisProtocol,
  heartbeatTrellisWorker,
  initFramework,
  inspectDonorAdoption,
  installTrellisHook,
  listAdrs,
  listAvailableArchetypes,
  listCapabilities,
  listDonorAdoptions,
  listIntent,
  listPlugins,
  listProjectRecords,
  listSystems,
  listTrellisJournal,
  listTrellisMemory,
  listTrellisTasks,
  listTrellisWorkers,
  loadManifest,
  migrateLayout,
  mutateTrellisLease,
  observeExternalPluginFromFile,
  parseTrellisJson,
  planTrellisLegacyHookScrub,
  planTrellisLegacyMigration,
  pluginDeclarationFor,
  preflightFederatedPlugin,
  promoteIntent,
  promoteSystem,
  pruneProjects,
  readTrellisChannel,
  readTrellisSessionIdFromStdin,
  rebindTrellisSession,
  reconcilePlugins,
  recordDonorEvidenceFromFile,
  recordDonorRollback,
  registerDonorAdoptionFromFile,
  registerExternalPluginFromFile,
  registerSystem,
  registerTrellisWorker,
  removeExternalPlugin,
  removePlugin,
  renderCodexSessionStartHook,
  repairTrellisChannel,
  requireAdrIndex,
  requireSystemsRegistry,
  restoreTrellisLegacyHookScrub,
  rollbackTrellisLegacyMigration,
  scanForProjects,
  searchTrellisMemory,
  sendTrellisChannel,
  setExternalPluginEnabled,
  setTrellisChannelCursor,
  setTrellisConfig,
  showTrellisConfig,
  showTrellisJournal,
  showTrellisMemory,
  showTrellisTask,
  startIteration,
  startTrellisSession,
  supersedeAdr,
  switchSource,
  syncSource,
  takeDonorMaterial,
  transitionTrellisTask,
  updateDonorAdoptionFromFile,
  updateSystem,
  verifyDonorInspection,
} from "assay-core";

import { recordCommandProjectLifecycle } from "./command-lifecycle.js";
import { mapCliError } from "./errors.js";
import {
  formatAdoptionResult,
  formatAdrList,
  formatAdrRecord,
  formatAttachResult,
  formatCapabilityAdd,
  formatCapabilityList,
  formatCheckResult,
  formatConvertResult,
  formatDonorAdoption,
  formatDonorDecision,
  formatDonorHistory,
  formatDonorInspection,
  formatDonorList,
  formatDonorStatus,
  formatDonorVerification,
  formatInitResult,
  formatIntentCapture,
  formatIntentList,
  formatIntentPromotion,
  formatMigrationResult,
  formatPluginAdd,
  formatPluginCheck,
  formatPluginList,
  formatPluginReconcile,
  formatProjectList,
  formatProjectRecord,
  formatSourceDiffResult,
  formatSourceLogResult,
  formatSourceStatusResult,
  formatSourceSyncResult,
  formatStatusResult,
  formatSystemList,
  formatSystemRecord,
  formatTrellisContext,
  formatTrellisHookInstall,
  formatTrellisTask,
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
  readonly native?: boolean;
  readonly root: string;
  readonly status?: string;
}

const PROJECT_STATUSES: readonly AssayProjectRegistryStatus[] = [
  "active",
  "missing",
  "uninstalled",
];

const ADR_STATUSES: readonly AdrStatus[] = ["proposed", "accepted", "superseded", "deprecated"];
const INTENT_AUTHORITY_MODES: readonly SystemIntentAuthorityMode[] = ["inline", "external", "none"];
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

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
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

/**
 * Build the registry's intent-authority value from the two CLI options that
 * describe it. The pointer is meaningless without a mode, so passing it alone
 * is a usage error rather than a silently dropped argument.
 */
function parseIntentAuthority(
  mode: string | undefined,
  pointer: string | undefined,
): SystemIntentAuthority | undefined {
  if (mode === undefined) {
    if (pointer !== undefined) {
      throw new Error("--intent-pointer requires --intent-authority <mode>");
    }
    return undefined;
  }
  if (!INTENT_AUTHORITY_MODES.includes(mode as SystemIntentAuthorityMode)) {
    throw new Error(`--intent-authority must be one of: ${INTENT_AUTHORITY_MODES.join(", ")}`);
  }
  return {
    mode: mode as SystemIntentAuthorityMode,
    ...(pointer === undefined ? {} : { pointer }),
  };
}

/**
 * Split a `<name>:<path>` pair.
 *
 * The name is everything before the **first** colon, so the remainder keeps a
 * Windows-style path intact instead of being cut at its drive colon. A path
 * like that is not a valid donor locator — locators are relative to the source
 * observation or the registered system — and it is refused by name below or by
 * the path schema, rather than being silently rewritten into something else.
 */
function splitDonorLocatorArgument(
  value: string,
  label: string,
): { readonly name: string; readonly path: string } {
  const separator = value.indexOf(":");
  const name = separator < 0 ? "" : value.slice(0, separator);
  const locatorPath = separator < 0 ? "" : value.slice(separator + 1);
  if (name === "" || locatorPath === "") {
    throw new Error(`${label} must be <name>:<path>; got '${value}'`);
  }
  if (/^[a-zA-Z]$/.test(name) && /^[\\/]/.test(locatorPath)) {
    throw new Error(
      `${label} must be <name>:<path> with a path relative to the source or system root; '${value}' looks like a Windows absolute path`,
    );
  }
  return { name, path: locatorPath };
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

/**
 * Where an analysis goes after it closes depends on how it closed: an adopted
 * pattern becomes knowledge, a decision becomes an ADR, an experiment becomes
 * an iteration. Naming the one command that fits the exit is the whole point of
 * the hint — a generic "record the outcome" line would be prose.
 */
function analysisCloseNextLine(
  analysisPath: string,
  exit: string,
  decisionProvider = "assay.native",
): string {
  switch (exit) {
    case "adopt":
      return `Next: \`assay knowledge add pattern "<title>" --from-analysis ${analysisPath}\` to keep what survived.`;
    case "adr":
      return decisionProvider === "assay.native"
        ? 'Next: `assay adr new "<decision title>"` to record the decision this analysis reached.'
        : "Next: restore the configured decision provider before recording this decision.";
    case "experiment":
      return 'Next: `assay iteration start "<what you are trying>"` to run the experiment this analysis proposed.';
    default:
      return "Next: `assay status` shows what is still open in this workspace.";
  }
}

/**
 * What follows registering a system. A non-primary one has an obvious next
 * step; for the primary one the freshly generated contract carries metadata and
 * no description yet. Both hold in every archetype, unlike `iteration start`,
 * which only exists where the iteration module is enabled.
 */
function systemRegisterNextLine(system: {
  readonly name: string;
  readonly status: string;
  readonly contract_file: string | null;
}): string {
  if (system.status !== "primary") {
    return `Next: \`assay system promote ${system.name}\` when it becomes the primary system.`;
  }
  return system.contract_file
    ? `Next: describe what ${system.name} does in ${system.contract_file}.`
    : `Next: \`assay system show ${system.name}\` to confirm what was recorded.`;
}

/** The first command a freshly scaffolded capability module makes available. */
function capabilityAddNextLine(module: string): string {
  switch (module) {
    case "adr":
      return 'Next: `assay adr new "<decision title>"`.';
    case "intent":
      return 'Next: `assay intent capture --text "<what the product is for>"`.';
    case "iteration":
      return 'Next: `assay iteration start "<what you are changing>"`.';
    case "project-authority":
      return "Next: add project-owned facts, policies, norms, specs, or Relay records in the scaffolded Project Authority directory.";
    default:
      return "Next: `assay capability list` shows what this workspace now has.";
  }
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("assay")
    .description("Bootstrap and update an Assay evidence workbench.")
    .version(CURRENT_VERSION)
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
    .option("--plugin <plugin...>", "install built-in plugins after initialization")
    .option("--no-track", "do not update the Assay project registry")
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .addOption(
      new Option("--archetype <archetype>", "project archetype name (run `assay archetype list`)"),
    )
    .action(async (targetDir, commandOptions) => {
      for (const plugin of commandOptions.plugin ?? []) {
        pluginDeclarationFor(plugin);
        await preflightFederatedPlugin(targetDir, plugin);
      }
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
      await recordCommandProjectLifecycle(result.root, "init", {
        noTrack: commandOptions.track === false,
      });
      writeLine(output, "stdout", formatInitResult(result));
      for (const plugin of commandOptions.plugin ?? []) {
        writeLine(
          output,
          "stdout",
          formatPluginAdd(await addPlugin({ root: result.root, plugin })),
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
    .option("--plugin <plugin...>", "install built-in plugins after attaching")
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
      for (const plugin of commandOptions.plugin ?? []) {
        pluginDeclarationFor(plugin);
        await preflightFederatedPlugin(commandOptions.root, plugin);
      }
      // attachExistingRepo records the project lifecycle itself (like
      // adoptExistingProject), honoring its own noTrack option.
      const result = await attachExistingRepo({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.archetype === undefined ? {} : { archetype: commandOptions.archetype }),
        privacy: commandOptions.privacy as WorkspacePrivacy,
        noTrack: commandOptions.track === false,
      });
      writeLine(output, "stdout", formatAttachResult(result));
      for (const plugin of commandOptions.plugin ?? []) {
        writeLine(
          output,
          "stdout",
          formatPluginAdd(await addPlugin({ root: result.root, plugin })),
        );
      }
    });

  program
    .command("convert")
    .description("Convert an overlay workspace to a sibling standalone workbench (detach-copy)")
    .option("--root <target-dir>", "overlay workspace root to convert", process.cwd())
    .requiredOption("--to <mode>", "target layout mode (standalone)")
    .requiredOption("--target <dir>", "target directory for the new standalone workspace")
    .addOption(
      new Option("--move", "move overlay work folders instead of copying").conflicts("copy"),
    )
    .addOption(new Option("--copy", "copy overlay work folders (default)").conflicts("move"))
    .option("--no-keep-overlay", "remove the source overlay work folders after a successful move")
    .action(async (commandOptions) => {
      if (commandOptions.to !== "standalone") {
        throw new Error(`--to currently only supports 'standalone'; got '${commandOptions.to}'`);
      }
      const result = await convertOverlayToStandalone({
        root: commandOptions.root,
        target: commandOptions.target,
        move: commandOptions.move === true,
        keepOverlay: commandOptions.keepOverlay !== false,
      });
      writeLine(output, "stdout", formatConvertResult(result));
    });

  program
    .command("check")
    .description("Check workspace structure and persisted record integrity")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--advisories", "also report non-blocking workflow and content reminders")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await checkFramework({
        root,
        includeAdvisories: commandOptions.advisories === true,
      });
      writeLine(output, "stdout", formatCheckResult(result));
      if (!result.ok) {
        output.setExitCode(1);
      }
    });

  program
    .command("status")
    .description("Print workspace status")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .option("--fetch", "also compare Git-backed sources against their remotes (network)")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await getFrameworkStatus({ root, fetch: commandOptions.fetch === true });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatStatusResult(result));
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
      await recordCommandProjectLifecycle(root, "update", {
        dryRun: commandOptions.dryRun === true,
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

  const capability = program
    .command("capability")
    .description("Enable and inspect optional capability modules");

  capability
    .command("add")
    .description("Enable a capability module in an existing workspace")
    .argument("<module>", `capability module: ${SUPPORTED_CAPABILITY_MODULES.join(", ")}`)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (module, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addCapability({ root, module });
      writeLine(output, "stdout", formatCapabilityAdd(result));
      if (!result.alreadyEnabled) {
        writeLine(output, "stdout", capabilityAddNextLine(result.module));
      }
    });

  capability
    .command("list")
    .description("List capability modules and how each one was enabled")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await listCapabilities({ root });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatCapabilityList(result));
    });

  const plugin = program
    .command("plugin")
    .description("Declare, install, and inspect Assay workspace plugins");

  plugin
    .command("add")
    .description("Declare and install a built-in plugin in an existing workspace")
    .argument("<plugin>", "plugin id or built-in alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--system <name>", "bind a federated provider to a registered system")
    .action(async (pluginId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addPlugin({
        root,
        plugin: pluginId,
        ...(commandOptions.system === undefined
          ? {}
          : { target: { kind: "system" as const, name: commandOptions.system } }),
      });
      writeLine(output, "stdout", formatPluginAdd(result));
    });

  plugin
    .command("register")
    .description("Register and lock an independently packaged external plugin descriptor")
    .argument("<descriptor-file>", "JSON descriptor file")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (descriptorFile, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await registerExternalPluginFromFile({ root, file: descriptorFile });
      if (commandOptions.json) writeJson(output, result);
      else {
        writeLine(
          output,
          "stdout",
          `${result.alreadyRegistered ? "External plugin already registered" : "Registered external plugin"}: ${result.plugin.id}`,
        );
        writeLine(output, "stdout", result.plugin.message);
      }
    });

  plugin
    .command("observe")
    .description("Import a host-reported observation without invoking the external plugin")
    .argument("<observation-file>", "JSON host observation file")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (observationFile, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await observeExternalPluginFromFile({ root, file: observationFile });
      if (commandOptions.json) writeJson(output, result);
      else
        writeLine(
          output,
          "stdout",
          `Recorded external observation: ${result.plugin.id}\n${result.plugin.message}`,
        );
    });

  plugin
    .command("list")
    .description("List desired, installed, and available plugins")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await listPlugins(root);
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatPluginList(result));
    });

  for (const mode of ["disable", "uninstall"] as const) {
    plugin
      .command(mode)
      .description(
        mode === "disable"
          ? "Disable a built-in runtime or an external descriptor's Assay contribution"
          : "Uninstall a built-in workspace plugin",
      )
      .argument("<plugin>", "plugin id or built-in alias")
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--purge", "after backup, remove plugin-owned durable data")
      .option("--yes", "confirm purge")
      .option("--json", "emit JSON")
      .action(async (pluginId, commandOptions) => {
        const root = await discoveredRoot(commandOptions.root);
        const result = await removePlugin({
          root,
          plugin: pluginId,
          mode,
          ...(commandOptions.purge === undefined ? {} : { purge: commandOptions.purge }),
          ...(commandOptions.yes === undefined ? {} : { yes: commandOptions.yes }),
        });
        if (commandOptions.json) writeJson(output, result);
        else
          writeLine(
            output,
            "stdout",
            `${mode} ${result.plugin}: ${result.changed ? "applied" : "already absent"}; data ${result.dataPreserved ? "preserved" : "purged after backup"}`,
          );
      });
  }

  plugin
    .command("enable")
    .description("Re-enable an external descriptor's Assay-side contribution")
    .argument("<plugin>", "qualified external plugin id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (pluginId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await setExternalPluginEnabled({ root, plugin: pluginId, enabled: true });
      if (commandOptions.json) writeJson(output, result);
      else
        writeLine(
          output,
          "stdout",
          `enable ${result.plugin.id}: ${result.changed ? "applied" : "already enabled"}; host state unchanged`,
        );
    });

  plugin
    .command("remove")
    .description("Remove an external descriptor record without deleting host or package state")
    .argument("<plugin>", "qualified external plugin id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (pluginId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await removeExternalPlugin({ root, plugin: pluginId });
      if (commandOptions.json) writeJson(output, result);
      else
        writeLine(
          output,
          "stdout",
          `remove ${result.plugin}: ${result.changed ? "Assay record removed" : "already absent"}; host/package state preserved`,
        );
    });

  plugin
    .command("check")
    .description("Check plugin declarations, receipts, and workspace scaffolds")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await checkPlugins(root);
      if (commandOptions.json) {
        writeJson(output, result);
      } else {
        writeLine(output, "stdout", formatPluginCheck(result));
      }
      if (!result.ok) {
        output.setExitCode(1);
      }
    });

  const trellis = program
    .command("trellis")
    .description("Operate the built-in assay.trellis workspace runtime");

  const trellisTask = trellis.command("task").description("Manage assay.trellis tasks");

  trellisTask
    .command("create")
    .description("Create a task and make it current")
    .requiredOption("--title <title>", "task title")
    .option("--session-id <id>", "session-specific current task")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const sessionId =
        commandOptions.sessionId ??
        process.env.ASSAY_TRELLIS_SESSION_ID ??
        process.env.CODEX_SESSION_ID;
      const result = await createTrellisTask({
        root,
        title: commandOptions.title,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatTrellisTask(result));
    });

  trellisTask
    .command("current")
    .description("Show the current task without guessing across ambiguous sessions")
    .option("--session-id <id>", "session-specific current task")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const sessionId =
        commandOptions.sessionId ??
        process.env.ASSAY_TRELLIS_SESSION_ID ??
        process.env.CODEX_SESSION_ID;
      const result = await getCurrentTrellisTask({
        root,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatTrellisTask(result));
    });

  for (const [commandName, status] of [
    ["complete", "completed"],
    ["cancel", "cancelled"],
  ] as const) {
    trellisTask
      .command(commandName)
      .description(
        `${commandName === "complete" ? "Complete" : "Cancel"} a task and close its pointers`,
      )
      .argument("[task-id]", "task id; defaults to current")
      .option("--session-id <id>", "session-specific current task")
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--json", "emit JSON")
      .action(async (taskId, commandOptions) => {
        const root = await discoveredRoot(commandOptions.root);
        const result = await transitionTrellisTask({
          root,
          status,
          ...(taskId === undefined ? {} : { taskId }),
          ...(commandOptions.sessionId === undefined
            ? {}
            : { sessionId: commandOptions.sessionId }),
        });
        if (commandOptions.json) writeJson(output, result);
        else
          writeLine(
            output,
            "stdout",
            formatTrellisTask({
              protocol_version: 1,
              plugin: "assay.trellis",
              session_id: commandOptions.sessionId ?? null,
              task: result.task,
            }),
          );
      });
  }

  trellisTask
    .command("show")
    .description("Show one task")
    .argument("<task-id>", "task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (taskId, commandOptions) => {
      const result = await showTrellisTask({
        root: await discoveredRoot(commandOptions.root),
        taskId,
      });
      if (commandOptions.json) writeJson(output, result);
      else writeLine(output, "stdout", JSON.stringify(result, null, 2));
    });

  trellisTask
    .command("list")
    .description("List tasks with bounded pagination")
    .option("--status <status>", "open|completed|cancelled")
    .option("--limit <number>", "maximum records", Number)
    .option("--after <cursor>", "task id cursor")
    .option("--archived", "list archived tasks")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      if (
        commandOptions.status &&
        !["open", "completed", "cancelled"].includes(commandOptions.status)
      )
        throw new Error("--status must be open, completed, or cancelled");
      const result = await listTrellisTasks({
        root: await discoveredRoot(commandOptions.root),
        ...(commandOptions.status === undefined
          ? {}
          : { status: commandOptions.status as "open" | "completed" | "cancelled" }),
        ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        ...(commandOptions.after === undefined ? {} : { after: commandOptions.after }),
        ...(commandOptions.archived === undefined ? {} : { archived: commandOptions.archived }),
      });
      writeJson(output, result);
    });

  trellisTask
    .command("archive")
    .description("Archive a terminal task")
    .argument("<task-id>", "terminal task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (taskId, commandOptions) => {
      const result = await archiveTrellisTask({
        root: await discoveredRoot(commandOptions.root),
        taskId,
      });
      writeJson(output, result);
    });

  trellis
    .command("protocol")
    .description("Report the built-in Trellis compatibility contract")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(output, await getTrellisProtocol(await discoveredRoot(commandOptions.root)));
    });

  const trellisSession = trellis
    .command("session")
    .description("Manage durable external session identities");
  trellisSession
    .command("start")
    .description("Start or resume a session")
    .option("--session-id <id>", "explicit identity (wins over stdin and env)")
    .option("--task-id <id>", "initial task binding")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const sessionId = await readTrellisSessionIdFromStdin(
        await readStdinText(),
        process.env,
        commandOptions.sessionId,
      );
      if (!sessionId)
        throw new Error("session identity is required via --session-id, stdin, or environment");
      writeJson(
        output,
        await startTrellisSession({
          root: await discoveredRoot(commandOptions.root),
          sessionId,
          ...(commandOptions.taskId === undefined ? {} : { taskId: commandOptions.taskId }),
        }),
      );
    });
  trellisSession
    .command("current")
    .description("Show the current session; ambiguity fails closed")
    .option("--session-id <id>", "explicit identity")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const sessionId = await readTrellisSessionIdFromStdin(
        await readStdinText(),
        process.env,
        commandOptions.sessionId,
      );
      writeJson(
        output,
        await currentTrellisSession({
          root: await discoveredRoot(commandOptions.root),
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  trellisSession
    .command("end")
    .description("End a session and atomically close its pointer")
    .option("--session-id <id>", "explicit identity")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const sessionId = await readTrellisSessionIdFromStdin(
        await readStdinText(),
        process.env,
        commandOptions.sessionId,
      );
      writeJson(
        output,
        await endTrellisSession({
          root: await discoveredRoot(commandOptions.root),
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  trellisSession
    .command("rebind")
    .description("Bind an active session to an open task")
    .requiredOption("--session-id <id>", "session identity")
    .requiredOption("--task-id <id>", "open task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await rebindTrellisSession({
          root: await discoveredRoot(commandOptions.root),
          sessionId: commandOptions.sessionId,
          taskId: commandOptions.taskId,
        }),
      );
    });

  const trellisJournal = trellis
    .command("journal")
    .description("Append and inspect structured journal records");
  trellisJournal
    .command("append")
    .requiredOption("--kind <kind>", "record kind")
    .requiredOption("--message <message>", "record message")
    .option("--task-id <id>")
    .option("--session-id <id>")
    .option("--data <json>", "structured JSON data")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const data =
        commandOptions.data === undefined ? undefined : parseTrellisJson(commandOptions.data);
      if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data)))
        throw new Error("--data must be a JSON object");
      writeJson(
        output,
        await appendTrellisJournal({
          root: await discoveredRoot(commandOptions.root),
          kind: commandOptions.kind,
          message: commandOptions.message,
          ...(commandOptions.taskId === undefined ? {} : { taskId: commandOptions.taskId }),
          ...(commandOptions.sessionId === undefined
            ? {}
            : { sessionId: commandOptions.sessionId }),
          ...(data == null ? {} : { data: data as Record<string, unknown> }),
        }),
      );
    });
  trellisJournal
    .command("list")
    .option("--kind <kind>")
    .option("--after <cursor>")
    .option("--limit <number>", "maximum records", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await listTrellisJournal({
          root: await discoveredRoot(commandOptions.root),
          ...(commandOptions.kind === undefined ? {} : { kind: commandOptions.kind }),
          ...(commandOptions.after === undefined ? {} : { after: commandOptions.after }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        }),
      );
    });
  trellisJournal
    .command("show")
    .argument("<id>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      writeJson(
        output,
        await showTrellisJournal({ root: await discoveredRoot(commandOptions.root), id }),
      );
    });

  const trellisConfig = trellis
    .command("config")
    .description("Inspect or update strict Trellis configuration");
  trellisConfig
    .command("show")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await showTrellisConfig({ root: await discoveredRoot(commandOptions.root) }),
      );
    });
  trellisConfig
    .command("set")
    .argument("<key>")
    .argument("<value>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (key, value, commandOptions) => {
      writeJson(
        output,
        await setTrellisConfig({
          root: await discoveredRoot(commandOptions.root),
          key,
          value: Number(value),
        }),
      );
    });

  const trellisChannel = trellis
    .command("channel")
    .description("Operate durable project-local channels");
  trellisChannel
    .command("create")
    .argument("<name>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (name, commandOptions) => {
      writeJson(
        output,
        await createTrellisChannel({ root: await discoveredRoot(commandOptions.root), name }),
      );
    });
  trellisChannel
    .command("send")
    .argument("<channel>")
    .requiredOption("--type <type>")
    .requiredOption("--payload <json>")
    .option("--sender <id>")
    .option("--idempotency-key <key>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (channel, commandOptions) => {
      writeJson(
        output,
        await sendTrellisChannel({
          root: await discoveredRoot(commandOptions.root),
          channel,
          type: commandOptions.type,
          payload: parseTrellisJson(commandOptions.payload),
          ...(commandOptions.sender === undefined ? {} : { sender: commandOptions.sender }),
          ...(commandOptions.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: commandOptions.idempotencyKey }),
        }),
      );
    });
  for (const commandName of ["read", "watch-once"] as const) {
    trellisChannel
      .command(commandName)
      .argument("<channel>")
      .option("--consumer <id>")
      .option("--after <seq>", "sequence cursor", Number)
      .option("--limit <number>", "maximum records", Number)
      .option("--advance", "advance named consumer cursor")
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--json", "emit JSON")
      .action(async (channel, commandOptions) => {
        writeJson(
          output,
          await readTrellisChannel({
            root: await discoveredRoot(commandOptions.root),
            channel,
            ...(commandOptions.consumer === undefined ? {} : { consumer: commandOptions.consumer }),
            ...(commandOptions.after === undefined ? {} : { after: commandOptions.after }),
            ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
            ...(commandOptions.advance === undefined ? {} : { advance: commandOptions.advance }),
          }),
        );
      });
  }
  trellisChannel
    .command("cursor")
    .argument("<channel>")
    .requiredOption("--consumer <id>")
    .requiredOption("--seq <number>", "monotonic sequence", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (channel, commandOptions) => {
      writeJson(
        output,
        await setTrellisChannelCursor({
          root: await discoveredRoot(commandOptions.root),
          channel,
          consumer: commandOptions.consumer,
          seq: commandOptions.seq,
        }),
      );
    });
  trellisChannel
    .command("repair")
    .argument("<channel>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (channel, commandOptions) => {
      writeJson(
        output,
        await repairTrellisChannel({ root: await discoveredRoot(commandOptions.root), channel }),
      );
    });
  const trellisLease = trellisChannel
    .command("lease")
    .description("Manage expiring channel leases");
  for (const action of ["acquire", "renew", "release"] as const) {
    trellisLease
      .command(action)
      .argument("<channel>")
      .argument("<lease>")
      .requiredOption("--owner <id>")
      .option("--token <token>")
      .option("--ttl-ms <number>", "lease duration", Number)
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--json", "emit JSON")
      .action(async (channel, lease, commandOptions) => {
        writeJson(
          output,
          await mutateTrellisLease({
            root: await discoveredRoot(commandOptions.root),
            channel,
            lease,
            action,
            owner: commandOptions.owner,
            ...(commandOptions.token === undefined ? {} : { token: commandOptions.token }),
            ...(commandOptions.ttlMs === undefined ? {} : { ttlMs: commandOptions.ttlMs }),
          }),
        );
      });
  }

  const trellisWorker = trellis
    .command("worker")
    .description("External worker registration and claim state machine");
  trellisWorker
    .command("register")
    .argument("<worker-id>")
    .requiredOption("--channel <channel>")
    .option("--lease <name>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (workerId, commandOptions) => {
      writeJson(
        output,
        await registerTrellisWorker({
          root: await discoveredRoot(commandOptions.root),
          workerId,
          channel: commandOptions.channel,
          ...(commandOptions.lease === undefined ? {} : { lease: commandOptions.lease }),
        }),
      );
    });
  trellisWorker
    .command("claim")
    .argument("<worker-id>")
    .option("--ttl-ms <number>", "lease duration", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (workerId, commandOptions) => {
      writeJson(
        output,
        await claimTrellisWorker({
          root: await discoveredRoot(commandOptions.root),
          workerId,
          ...(commandOptions.ttlMs === undefined ? {} : { ttlMs: commandOptions.ttlMs }),
        }),
      );
    });
  trellisWorker
    .command("heartbeat")
    .argument("<worker-id>")
    .requiredOption("--token <token>", "claim token")
    .option("--ttl-ms <number>", "lease duration", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (workerId, commandOptions) => {
      writeJson(
        output,
        await heartbeatTrellisWorker({
          root: await discoveredRoot(commandOptions.root),
          workerId,
          token: commandOptions.token,
          ...(commandOptions.ttlMs === undefined ? {} : { ttlMs: commandOptions.ttlMs }),
        }),
      );
    });
  trellisWorker
    .command("complete")
    .argument("<worker-id>")
    .requiredOption("--token <token>", "claim token")
    .option("--result <json>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (workerId, commandOptions) => {
      writeJson(
        output,
        await finishTrellisWorker({
          root: await discoveredRoot(commandOptions.root),
          workerId,
          status: "completed",
          token: commandOptions.token,
          ...(commandOptions.result === undefined
            ? {}
            : { result: parseTrellisJson(commandOptions.result) }),
        }),
      );
    });
  trellisWorker
    .command("stop")
    .argument("<worker-id>")
    .requiredOption("--token <token>", "claim token")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (workerId, commandOptions) => {
      writeJson(
        output,
        await finishTrellisWorker({
          root: await discoveredRoot(commandOptions.root),
          workerId,
          status: "stopped",
          token: commandOptions.token,
        }),
      );
    });
  trellisWorker
    .command("list")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await listTrellisWorkers({ root: await discoveredRoot(commandOptions.root) }),
      );
    });

  const trellisMem = trellis.command("mem").description("Read-only Codex host session adapter");
  trellisMem
    .command("list")
    .option("--memory-root <path>", "explicit fixture/session root")
    .option("--limit <number>", "maximum records", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await listTrellisMemory({
          workspaceRoot: await discoveredRoot(commandOptions.root),
          ...(commandOptions.memoryRoot === undefined
            ? {}
            : { memoryRoot: commandOptions.memoryRoot }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        }),
      );
    });
  trellisMem
    .command("show")
    .argument("<id>")
    .option("--memory-root <path>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      writeJson(
        output,
        await showTrellisMemory({
          workspaceRoot: await discoveredRoot(commandOptions.root),
          id,
          ...(commandOptions.memoryRoot === undefined
            ? {}
            : { memoryRoot: commandOptions.memoryRoot }),
        }),
      );
    });
  trellisMem
    .command("search")
    .argument("<query>")
    .option("--memory-root <path>")
    .option("--limit <number>", "maximum records", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (query, commandOptions) => {
      writeJson(
        output,
        await searchTrellisMemory({
          workspaceRoot: await discoveredRoot(commandOptions.root),
          query,
          ...(commandOptions.memoryRoot === undefined
            ? {}
            : { memoryRoot: commandOptions.memoryRoot }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        }),
      );
    });
  trellisMem
    .command("context")
    .option("--query <query>")
    .option("--memory-root <path>")
    .option("--limit <number>", "maximum records", Number)
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await contextTrellisMemory({
          workspaceRoot: await discoveredRoot(commandOptions.root),
          ...(commandOptions.query === undefined ? {} : { query: commandOptions.query }),
          ...(commandOptions.memoryRoot === undefined
            ? {}
            : { memoryRoot: commandOptions.memoryRoot }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        }),
      );
    });

  const trellisMigrateLegacy = trellis
    .command("migrate")
    .description("Migrate explicitly selected legacy state")
    .command("legacy");
  trellisMigrateLegacy
    .command("plan")
    .option("--legacy-root <path>")
    .option("--channel-root <path>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await planTrellisLegacyMigration({
          root: await discoveredRoot(commandOptions.root),
          ...(commandOptions.legacyRoot === undefined
            ? {}
            : { legacyRoot: commandOptions.legacyRoot }),
          ...(commandOptions.channelRoot === undefined
            ? {}
            : { channelRoot: commandOptions.channelRoot }),
        }),
      );
    });
  trellisMigrateLegacy
    .command("apply")
    .option("--legacy-root <path>")
    .option("--channel-root <path>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await applyTrellisLegacyMigration({
          root: await discoveredRoot(commandOptions.root),
          ...(commandOptions.legacyRoot === undefined
            ? {}
            : { legacyRoot: commandOptions.legacyRoot }),
          ...(commandOptions.channelRoot === undefined
            ? {}
            : { channelRoot: commandOptions.channelRoot }),
        }),
      );
    });
  trellisMigrateLegacy
    .command("rollback")
    .option("--generation <uuid>")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await rollbackTrellisLegacyMigration({
          root: await discoveredRoot(commandOptions.root),
          ...(commandOptions.generation === undefined
            ? {}
            : { generation: commandOptions.generation }),
        }),
      );
    });
  trellisMigrateLegacy
    .command("cleanup")
    .requiredOption("--generation <uuid>")
    .option("--yes", "confirm cleanup")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await cleanupTrellisLegacyMigration({
          root: await discoveredRoot(commandOptions.root),
          generation: commandOptions.generation,
          ...(commandOptions.yes === undefined ? {} : { yes: commandOptions.yes }),
        }),
      );
    });

  trellis
    .command("context")
    .description("Render structured workspace context for a supported host")
    .requiredOption("--host <host>", "context host (codex)")
    .option("--session-id <id>", "session-specific current task")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(new Option("--json", "emit JSON").conflicts("hookAdapter"))
    .addOption(
      new Option(
        "--hook-adapter",
        "emit Codex SessionStart hook output from stdin/environment",
      ).conflicts("json"),
    )
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      if (commandOptions.hookAdapter) {
        writeJson(
          output,
          await renderCodexSessionStartHook({
            root,
            stdin: await readStdinText(),
            env: process.env,
          }),
        );
        return;
      }
      const sessionId =
        commandOptions.sessionId ??
        process.env.ASSAY_TRELLIS_SESSION_ID ??
        process.env.CODEX_SESSION_ID;
      const result = await getTrellisContext({
        root,
        host: commandOptions.host,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatTrellisContext(result));
    });

  const trellisHook = trellis
    .command("hook")
    .description("Manage current and legacy assay.trellis host hooks");

  trellisHook
    .command("install")
    .description("Plan or apply a marker-owned host hook registration")
    .requiredOption("--host <host>", "hook host (codex)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(new Option("--dry-run", "preview without writing (default)").conflicts("apply"))
    .addOption(new Option("--apply", "write the registration").conflicts("dryRun"))
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await installTrellisHook({
        root,
        host: commandOptions.host,
        apply: commandOptions.apply === true,
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatTrellisHookInstall(result));
    });

  const trellisHookLegacy = trellisHook
    .command("legacy")
    .description("Remove exact allowlisted legacy Trellis Codex writer hooks");
  trellisHookLegacy
    .command("plan")
    .description("Read-only plan for removing exact legacy writer hook groups")
    .requiredOption("--host <host>", "hook host (codex)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await planTrellisLegacyHookScrub({
          root: await discoveredRoot(commandOptions.root),
          host: commandOptions.host,
        }),
      );
    });
  trellisHookLegacy
    .command("apply")
    .description("Transactionally remove exact legacy writer hook groups")
    .requiredOption("--host <host>", "hook host (codex)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await applyTrellisLegacyHookScrub({
          root: await discoveredRoot(commandOptions.root),
          host: commandOptions.host,
        }),
      );
    });
  trellisHookLegacy
    .command("restore")
    .description("Explicitly restore the exact receipt-governed pre-scrub hook file")
    .requiredOption("--host <host>", "hook host (codex)")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      writeJson(
        output,
        await restoreTrellisLegacyHookScrub({
          root: await discoveredRoot(commandOptions.root),
          host: commandOptions.host,
        }),
      );
    });

  program
    .command("reconcile")
    .description("Preview or apply convergence of desired plugins in an existing workspace")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--plugin <plugin...>", "limit reconciliation to already desired plugins")
    .addOption(new Option("--dry-run", "preview without writing (default)").conflicts("apply"))
    .addOption(new Option("--apply", "apply the reconciliation plan").conflicts("dryRun"))
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await reconcilePlugins({
        root,
        apply: commandOptions.apply === true,
        ...(commandOptions.plugin === undefined ? {} : { plugins: commandOptions.plugin }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
      } else {
        writeLine(output, "stdout", formatPluginReconcile(result));
      }
      if (result.plugins.some((entry) => entry.action === "blocked")) {
        output.setExitCode(1);
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

  reference
    .command("backfill")
    .description("Write the missing reference.yaml for an existing frozen reference")
    .argument("<path>", "frozen reference directory, relative to the workspace root")
    .option("--source <origin>", "where the material came from, when it is known")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (referencePath, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await backfillReferenceCaseFile({
        root,
        path: referencePath,
        ...(commandOptions.source === undefined ? {} : { source: commandOptions.source }),
      });
      if (!result.created) {
        writeLine(output, "stdout", `Reference already has a case file: ${result.referenceFile}`);
        return;
      }
      writeLine(output, "stdout", `Wrote reference case file: ${result.referenceFile}`);
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
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
      writeLine(
        output,
        "stdout",
        "Next: `assay status` reports when this source moves upstream and which adopted mappings it reaches.",
      );
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

  const donor = program
    .command("donor")
    .description("Track adopted donor material, evidence, and decisions");

  donor
    .command("register")
    .description("Register a complete donor adoption definition")
    .requiredOption("--file <path>", "JSON or YAML donor definition")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await registerDonorAdoptionFromFile({
        root,
        file: commandOptions.file,
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Registered donor adoption: ${result.adoptionId}`);
      writeLine(output, "stdout", `Definition: ${result.definitionDigest}`);
      writeLine(
        output,
        "stdout",
        `Targets: ${result.definition.targets.map((target) => target.id).join(", ")}`,
      );
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
    });

  donor
    .command("take")
    .description("Register a single-source, single-target adoption without a definition file")
    .argument("<source>", "<source-alias>:<path-in-source>")
    .requiredOption("--into <target>", "<target-system>:<path-in-system>")
    .addOption(
      new Option("--mode <mode>", "how the material was carried over")
        .choices([...DONOR_TAKE_MODES])
        .default("adapt"),
    )
    .addOption(
      new Option("--match <match>", "locator shape; inferred from the observation by default")
        .choices(["exact", "prefix"])
        .hideHelp(),
    )
    .option("--to <observation>", "source observation id; defaults to latest")
    .option("--id <adoption-id>", "adoption id; derived from source, system, and path by default")
    .option("--title <title>", "human-readable adoption title")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (sourceArgument, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const from = splitDonorLocatorArgument(sourceArgument, "donor source");
      const into = splitDonorLocatorArgument(commandOptions.into, "--into");
      const result = await takeDonorMaterial({
        root,
        sourceAlias: from.name,
        sourcePath: from.path,
        targetSystem: into.name,
        targetPath: into.path,
        mode: commandOptions.mode as DonorTakeMode,
        ...(commandOptions.match === undefined
          ? {}
          : { match: commandOptions.match as "exact" | "prefix" }),
        ...(commandOptions.to === undefined ? {} : { observation: commandOptions.to }),
        ...(commandOptions.id === undefined ? {} : { adoptionId: commandOptions.id }),
        ...(commandOptions.title === undefined ? {} : { title: commandOptions.title }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Registered donor adoption: ${result.adoptionId}`);
      writeLine(output, "stdout", `Definition: ${result.definitionDigest}`);
      writeLine(
        output,
        "stdout",
        `Mapping: ${from.name}:${from.path} -> ${result.targetId}:${into.path} (${commandOptions.mode}, match ${result.match})`,
      );
      writeLine(output, "stdout", `Observation: ${result.observation}`);
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
      writeLine(
        output,
        "stdout",
        `Next: assay status reports when ${from.name} changes under this mapping.`,
      );
    });

  donor
    .command("update")
    .description("Install a new immutable definition revision")
    .argument("<adoption>", "donor adoption id")
    .requiredOption("--file <path>", "JSON or YAML donor definition")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await updateDonorAdoptionFromFile({
        root,
        adoptionId,
        file: commandOptions.file,
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Updated donor adoption: ${result.adoptionId}`);
      writeLine(output, "stdout", `Definition: ${result.definitionDigest}`);
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
    });

  donor
    .command("list")
    .description("List donor adoption definitions without inspecting targets")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await listDonorAdoptions({ root });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorList(result));
    });

  donor
    .command("show")
    .description("Show a donor definition and its target baselines")
    .argument("<adoption>", "donor adoption id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await getDonorAdoption({ root, adoptionId });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorAdoption(result));
    });

  donor
    .command("status")
    .description("Inspect current source and target facts, or list adoptions")
    .argument("[adoption]", "donor adoption id")
    .option("--target <id>", "inspect one target")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      if (!adoptionId) {
        const result = await listDonorAdoptions({ root });
        if (commandOptions.json) {
          writeJson(output, result);
          return;
        }
        writeLine(output, "stdout", formatDonorList(result));
        return;
      }
      const result = await getDonorStatus({
        root,
        adoptionId,
        ...(commandOptions.target === undefined ? {} : { targetId: commandOptions.target }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorStatus(result));
    });

  donor
    .command("inspect")
    .description("Capture current direct-change facts for one target")
    .argument("<adoption>", "donor adoption id")
    .requiredOption("--target <id>", "target id")
    .option("--to <observation>", "source observation id; defaults to latest")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await inspectDonorAdoption({
        root,
        adoptionId,
        targetId: commandOptions.target,
        ...(commandOptions.to === undefined ? {} : { observation: commandOptions.to }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorInspection(result));
    });

  const donorEvidence = donor.command("evidence").description("Attach version-bound evidence");
  donorEvidence
    .command("add")
    .description("Attach evidence to a donor inspection")
    .argument("<adoption>", "donor adoption id")
    .argument("<inspection>", "inspection id")
    .requiredOption("--file <path>", "JSON or YAML evidence input")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, inspectionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await recordDonorEvidenceFromFile({
        root,
        adoptionId,
        inspectionId,
        file: commandOptions.file,
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Recorded donor evidence: ${result.evidence.id}`);
      writeLine(output, "stdout", `Check: ${result.evidence.check_id}`);
      writeLine(output, "stdout", `Result: ${result.evidence.result}`);
      writeLine(output, "stdout", `Record: ${result.path}`);
    });

  donor
    .command("verify")
    .description("Evaluate explicit evidence policy and inspection freshness")
    .argument("<adoption>", "donor adoption id")
    .argument("<inspection>", "inspection id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, inspectionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await verifyDonorInspection({ root, adoptionId, inspectionId });
      if (commandOptions.json) {
        writeJson(output, result);
      } else {
        writeLine(output, "stdout", formatDonorVerification(result));
      }
      if (!result.ok) {
        output.setExitCode(1);
      }
    });

  donor
    .command("decide")
    .description("Record accept, reject, or defer against a current snapshot")
    .argument("<adoption>", "donor adoption id")
    .requiredOption("--target <id>", "target id")
    .addOption(
      new Option("--outcome <outcome>", "decision outcome")
        .choices(["accept", "reject", "defer"])
        .makeOptionMandatory(),
    )
    .option("--inspection <id>", "use an existing current inspection")
    .option("--to <observation>", "source observation id for a direct decision")
    .option("--reason <text>", "decision rationale")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await decideDonorAdoption({
        root,
        adoptionId,
        targetId: commandOptions.target,
        outcome: commandOptions.outcome as Exclude<DonorDecisionOutcome, "rollback">,
        ...(commandOptions.inspection === undefined
          ? {}
          : { inspectionId: commandOptions.inspection }),
        ...(commandOptions.to === undefined ? {} : { observation: commandOptions.to }),
        ...(commandOptions.reason === undefined ? {} : { reason: commandOptions.reason }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorDecision(result));
    });

  donor
    .command("history")
    .description("Show committed donor decisions")
    .argument("<adoption>", "donor adoption id")
    .option("--target <id>", "filter by target id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await getDonorHistory({
        root,
        adoptionId,
        ...(commandOptions.target === undefined ? {} : { targetId: commandOptions.target }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorHistory(result));
    });

  const donorRollback = donor.command("rollback").description("Record an external restoration");
  donorRollback
    .command("record")
    .description("Record that mapped artifacts match a prior accepted baseline")
    .argument("<adoption>", "donor adoption id")
    .requiredOption("--to-decision <id>", "accepted decision whose baseline was restored")
    .option("--reason <text>", "rollback rationale")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await recordDonorRollback({
        root,
        adoptionId,
        decisionId: commandOptions.toDecision,
        ...(commandOptions.reason === undefined ? {} : { reason: commandOptions.reason }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatDonorDecision(result));
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
      writeLine(
        output,
        "stdout",
        `Next: fill ## Key observations, then \`assay analysis close ${result.path} --exit adopt|reject|experiment|adr\`.`,
      );
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
    // Backward-compatible no-op: analysis close no longer applies mechanical
    // content gates, but older scripts may still pass --allow-empty.
    .addOption(new Option("--allow-empty").hideHelp())
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
      const decisionProvider =
        commandOptions.exit === "adr"
          ? await getDecisionGovernanceStatus(root).then(
              (status) => status.activeProvider ?? status.desiredProvider,
            )
          : "assay.native";
      writeLine(
        output,
        "stdout",
        analysisCloseNextLine(result.path, commandOptions.exit, decisionProvider),
      );
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
      writeLine(
        output,
        "stdout",
        `Next: fill ${result.planPath}, then \`assay iteration close ${result.path} --result applied|rejected|retest\`.`,
      );
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
      writeLine(
        output,
        "stdout",
        commandOptions.result === "applied"
          ? `Next: \`assay knowledge add pattern "<title>" --from-iteration ${result.path}\` if this produced something reusable.`
          : "Next: `assay status` shows what is still open in this workspace.",
      );
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
    .option("--force", "suppress the legacy external-governance advisory")
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
    .option("--native", "read the inactive Assay-native ADR archive")
    .option("--json", "emit JSON")
    .addOption(new Option("--status <status>", "filter by status").choices([...ADR_STATUSES]))
    .action(async (commandOptions: AdrListOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const status = parseAdrStatusFilter(commandOptions.status);
      const { adrs } = await listAdrs(root, status, { native: commandOptions.native ?? false });
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
    .option("--native", "read the inactive Assay-native ADR archive")
    .option("--json", "emit JSON")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const index = await requireAdrIndex(root, { native: commandOptions.native ?? false });
      const record = findAdr(index, selector);
      if (commandOptions.json) {
        writeJson(output, record);
        return;
      }
      writeLine(output, "stdout", formatAdrRecord(record));
    });

  const intent = program
    .command("intent")
    .description("Capture product intent verbatim and promote it into requirements or decisions");

  intent
    .command("capture")
    .description("Record product intent verbatim against a registered system")
    .option("--text <text>", "intent text to capture")
    .option("--file <path>", "workspace-relative file whose contents are the intent text")
    .option("--system <name>", "system name or unique prefix; defaults to the primary system")
    .option("--source <text>", "where the intent came from (conversation, ticket, meeting)")
    .option("--supersedes <ids>", "comma-separated capture ids this record corrects")
    .option("--force", "record a shadow copy when the system's intent authority is elsewhere")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const supersedes = splitList(commandOptions.supersedes);
      const result = await captureIntent({
        root,
        ...(commandOptions.text === undefined ? {} : { text: commandOptions.text }),
        ...(commandOptions.file === undefined ? {} : { file: commandOptions.file }),
        ...(commandOptions.system === undefined ? {} : { system: commandOptions.system }),
        ...(commandOptions.source === undefined ? {} : { source: commandOptions.source }),
        ...(supersedes === undefined ? {} : { supersedes }),
        force: commandOptions.force ?? false,
      });
      writeLine(output, "stdout", formatIntentCapture(result));
    });

  intent
    .command("promote")
    .description("Derive a requirement or an ADR from a recorded intent capture")
    .argument("<capture>", "intent capture id or unique id prefix")
    .addOption(
      new Option("--to <target>", "promotion target")
        .choices(["requirement", "decision"])
        .makeOptionMandatory(),
    )
    .option("--title <title>", "title for the requirement or ADR")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (capture, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await promoteIntent({
        root,
        capture,
        to: commandOptions.to as IntentPromotionTarget,
        ...(commandOptions.title === undefined ? {} : { title: commandOptions.title }),
      });
      writeLine(output, "stdout", formatIntentPromotion(result));
    });

  intent
    .command("list")
    .description("List recorded intent captures and what they became")
    .option("--system <name>", "system name or unique prefix to filter by")
    .option("--include-lineage", "also include systems the filtered system supersedes")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await listIntent({
        root,
        ...(commandOptions.system === undefined ? {} : { system: commandOptions.system }),
        includeLineage: commandOptions.includeLineage ?? false,
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatIntentList(result));
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
    .addOption(
      new Option(
        "--intent-authority <mode>",
        "where this system's product intent is authoritative",
      ).choices([...INTENT_AUTHORITY_MODES]),
    )
    .option("--intent-pointer <pointer>", "where the external intent authority lives")
    .action(async (systemPath, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const vcs = commandOptions.vcs as SystemVcs | undefined;
      const supersedes = splitList(commandOptions.supersedes) ?? [];
      const intentAuthority = parseIntentAuthority(
        commandOptions.intentAuthority,
        commandOptions.intentPointer,
      );
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
        ...(intentAuthority === undefined ? {} : { intentAuthority }),
      });
      writeLine(output, "stdout", `Registered system: ${result.system.name}`);
      writeLine(output, "stdout", `Status: ${result.system.status}`);
      writeLine(output, "stdout", `Contract: ${result.system.contract_file ?? "-"}`);
      writeLine(output, "stdout", "Registry: .assay/systems-registry.json");
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(output, "stdout", systemRegisterNextLine(result.system));
    });

  system
    .command("update")
    .description("Update metadata for an existing system registry record")
    .argument("<selector>", "system name or unique name prefix")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--path <path>", "system directory (relative to workspace root)")
    .addOption(
      new Option("--vcs <vcs>", "version control mode").choices([
        "independent-git",
        "embedded",
        "none",
      ]),
    )
    .option("--vcs-ref <ref>", "branch, commit, or tag")
    .option("--system-version <version>", "system semantic version")
    .option("--contract-file <path>", "contract file path")
    .option("--no-contract-file", "clear the contract file path")
    .option("--primary", "set this system as the primary system")
    .option("--supersedes <names>", "comma-separated superseded system names")
    .addOption(
      new Option(
        "--intent-authority <mode>",
        "where this system's product intent is authoritative",
      ).choices([...INTENT_AUTHORITY_MODES]),
    )
    .option("--no-intent-authority", "clear the recorded intent authority (back to inline)")
    .option("--intent-pointer <pointer>", "where the external intent authority lives")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const vcs = commandOptions.vcs as SystemVcs | undefined;
      const supersedes = splitList(commandOptions.supersedes);
      const intentAuthority =
        commandOptions.intentAuthority === false
          ? null
          : parseIntentAuthority(
              typeof commandOptions.intentAuthority === "string"
                ? commandOptions.intentAuthority
                : undefined,
              commandOptions.intentPointer,
            );
      const contractFile =
        commandOptions.contractFile === false
          ? null
          : typeof commandOptions.contractFile === "string"
            ? commandOptions.contractFile
            : undefined;
      const result = await updateSystem(root, selector, {
        ...(commandOptions.path === undefined ? {} : { path: commandOptions.path }),
        ...(vcs === undefined ? {} : { vcs }),
        ...(commandOptions.vcsRef === undefined ? {} : { vcsRef: commandOptions.vcsRef }),
        ...(commandOptions.systemVersion === undefined
          ? {}
          : { version: commandOptions.systemVersion }),
        ...(contractFile === undefined ? {} : { contractFile }),
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(intentAuthority === undefined ? {} : { intentAuthority }),
        ...(commandOptions.primary ? { primary: true } : {}),
      });
      const changedFields = result.changes.map((change) => change.field).join(", ");
      writeLine(output, "stdout", `Updated system: ${result.system.name}`);
      writeLine(output, "stdout", `Status: ${result.system.status}`);
      writeLine(output, "stdout", "Registry: .assay/systems-registry.json");
      writeLine(output, "stdout", `Changed fields: ${changedFields || "(none)"}`);
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
      writeLine(
        output,
        "stdout",
        `Next: write the entry in ${result.path}; \`assay check\` reports the workspace's knowledge structure.`,
      );
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
