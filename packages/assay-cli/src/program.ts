import path from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type AnalysisExit,
  CURRENT_VERSION,
  type KnowledgeType,
  SOURCE_ADOPTION_TAKE_MODES,
  SOURCE_CHANGE_CLASSES,
  type SourceAdoptionTakeMode,
  type SourceChangeClass,
  type SystemVcs,
  type WorkspacePrivacy,
  addKnowledge,
  addSource,
  adoptExistingProject,
  applyUpdate,
  archiveSystem,
  attachExistingRepo,
  captureSource,
  checkExternalPlugins,
  checkFramework,
  closeAnalysis,
  convertOverlayToStandalone,
  createAnalysis,
  diffSource,
  discoverFrameworkRoot,
  discoverWorkspaces,
  findSystemEntry,
  forgetWorkspace,
  getFrameworkStatus,
  getSourceAdoption,
  getSourceLog,
  getSourceStatus,
  importSourceContent,
  initFramework,
  listAvailableTemplates,
  listExternalPlugins,
  listSourceAdoptions,
  listSystems,
  listWorkspaces,
  loadTemplate,
  observeExternalPluginFromFile,
  promoteSystem,
  registerExternalPluginFromFile,
  registerSystem,
  removeExternalPlugin,
  removeSourceAdoption,
  requireSystemsRegistry,
  setExternalPluginEnabled,
  switchSource,
  syncSource,
  takeSourceAdoptionMaterial,
  trackWorkspace,
  updateSystem,
} from "assay-core";

import { mapCliError } from "./errors.js";
import {
  formatAdoptionResult,
  formatAttachResult,
  formatCheckResult,
  formatConvertResult,
  formatInitResult,
  formatPluginCheck,
  formatPluginList,
  formatSourceAdoption,
  formatSourceAdoptionList,
  formatSourceAdoptionTake,
  formatSourceDiffResult,
  formatSourceLogResult,
  formatSourceStatusResult,
  formatSourceSyncResult,
  formatStatusResult,
  formatSystemList,
  formatSystemRecord,
  formatUpdateResult,
} from "./format.js";
import { hintLines, hintedResult } from "./hints.js";
import { addOrientationCommands } from "./orientation-command.js";
import { addRoadmapCommand } from "./roadmap-command.js";
import { addSpecCommand } from "./spec-command.js";
import { addTaskCommand } from "./task-command.js";

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

/**
 * Split a `<name>:<path>` pair.
 *
 * The name is everything before the **first** colon, so the remainder keeps a
 * Windows-style path intact instead of being cut at its drive colon. A path
 * like that is not a valid Source adoption locator — locators are relative to the source
 * observation or the registered system — and it is refused by name below or by
 * the path schema, rather than being silently rewritten into something else.
 */
function splitSourceAdoptionLocatorArgument(
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

function systemRegisterNextLine(selector: string, status: string): string {
  if (status !== "primary") {
    return `Next: \`assay system promote ${selector}\` when it becomes the primary system.`;
  }
  return `Next: \`assay system show ${selector}\` to confirm what was recorded.`;
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
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .addOption(
      new Option("--template <template>", "built-in template name or explicit custom YAML path"),
    )
    .action(async (targetDir, commandOptions) => {
      const initOptions = {
        target: targetDir,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        git: commandOptions.git ?? false,
        force: commandOptions.force ?? false,
        createNew: commandOptions.createNew ?? false,
        agents: commandOptions.agents !== false,
        template: commandOptions.template ?? "study",
      };
      const result = await initFramework(initOptions);
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
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .option("--analyze", "after apply, generate an adoption inventory and open an analysis for it")
    .action(async (commandOptions) => {
      const result = await adoptExistingProject({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        dryRun: commandOptions.dryRun ?? false,
        apply: commandOptions.apply ?? false,
        agents: commandOptions.agents !== false,
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
      new Option("--template <template>", "built-in template name or explicit custom YAML path"),
    )
    .addOption(
      new Option(
        "--privacy <privacy>",
        "overlay Git privacy: private (default), private-git, tracked",
      )
        .choices(["private", "private-git", "tracked"])
        .default("private"),
    )
    .option("--no-agents", "do not write the Assay managed block to root AGENTS.md")
    .action(async (commandOptions) => {
      const result = await attachExistingRepo({
        root: commandOptions.root,
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.template === undefined ? {} : { template: commandOptions.template }),
        privacy: commandOptions.privacy as WorkspacePrivacy,
      });
      writeLine(output, "stdout", formatAttachResult(result));
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
    .description("Update fixed core files using managed-receipt baselines")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--dry-run", "plan update without applying writes")
    .option("--agents", "install or refresh the Assay managed block in root AGENTS.md")
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
      writeLine(output, "stdout", formatUpdateResult(result));
    });

  const workspaceCommand = program
    .command("workspace")
    .description("Track Assay workspace locations explicitly");

  workspaceCommand
    .command("track")
    .argument("[root]", "workspace root", process.cwd())
    .option("--rebind <old>", "replace one explicitly named old clone path for the same Project")
    .option("--json", "emit JSON")
    .action(async (root, commandOptions) => {
      const record = await trackWorkspace({
        root,
        ...(commandOptions.rebind === undefined ? {} : { rebind: commandOptions.rebind }),
      });
      if (commandOptions.json) writeJson(output, record);
      else writeLine(output, "stdout", `Tracked ${record.project_id}\n  ${record.path}`);
    });

  workspaceCommand
    .command("discover")
    .argument("<roots...>", "directories to scan")
    .option("--json", "emit JSON")
    .action(async (roots, commandOptions) => {
      const records = await discoverWorkspaces(roots);
      if (commandOptions.json) writeJson(output, records);
      else {
        writeLine(output, "stdout", `Tracked ${records.length} workspace(s).`);
        for (const record of records)
          writeLine(output, "stdout", `- ${record.project_id}: ${record.path}`);
      }
    });

  workspaceCommand
    .command("list")
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const records = await listWorkspaces();
      if (commandOptions.json) writeJson(output, records);
      else {
        if (records.length === 0) writeLine(output, "stdout", "No tracked workspaces.");
        for (const item of records) {
          const label = item.record ? `${item.record.project_id}: ${item.record.path}` : item.file;
          writeLine(
            output,
            "stdout",
            `- ${item.status}: ${label}${item.message ? ` (${item.message})` : ""}`,
          );
        }
      }
    });

  workspaceCommand
    .command("forget")
    .argument("<selector>", "record hash, filename, or workspace path")
    .option("--json", "emit JSON")
    .action(async (selector, commandOptions) => {
      const record = await forgetWorkspace(selector);
      if (commandOptions.json) writeJson(output, record);
      else writeLine(output, "stdout", `Forgot ${record.project_id}\n  ${record.path}`);
    });

  const templateCommand = program
    .command("template")
    .description("Inspect one-shot workspace templates");

  templateCommand
    .command("list")
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const templates = await listAvailableTemplates();
      if (commandOptions.json) writeJson(output, templates);
      else {
        writeLine(output, "stdout", "Available templates:");
        for (const template of templates)
          writeLine(output, "stdout", `- ${template.name}: ${template.description}`);
      }
    });

  templateCommand
    .command("show")
    .argument("<template>", "built-in name or explicit custom YAML path")
    .option("--json", "emit JSON")
    .action(async (template, commandOptions) => {
      const loaded = await loadTemplate(template);
      if (commandOptions.json) writeJson(output, loaded);
      else {
        writeLine(output, "stdout", `${loaded.name}: ${loaded.description}`);
        writeLine(output, "stdout", `Directories: ${loaded.directories.length}`);
        writeLine(output, "stdout", `Files: ${loaded.files.length}`);
      }
    });
  const plugin = program
    .command("plugin")
    .description("Register and inspect external plugin metadata");

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
    .description("List registered external plugins")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = { root, plugins: await listExternalPlugins(root) };
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatPluginList(result));
    });

  plugin
    .command("disable")
    .description("Disable an external descriptor's Assay-side contribution")
    .argument("<plugin>", "qualified external plugin id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (pluginId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await setExternalPluginEnabled({ root, plugin: pluginId, enabled: false });
      if (commandOptions.json) writeJson(output, result);
      else
        writeLine(
          output,
          "stdout",
          `disable ${result.plugin.id}: ${result.changed ? "applied" : "already disabled"}; host state unchanged`,
        );
    });

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
    .description("Check registered external plugin metadata and host observations")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await checkExternalPlugins(root);
      if (commandOptions.json) {
        writeJson(output, result);
      } else {
        writeLine(output, "stdout", formatPluginCheck(result));
      }
      if (!result.ok) {
        output.setExitCode(1);
      }
    });

  addOrientationCommands(program, { output, resolveRoot: discoveredRoot });
  addTaskCommand(program, { output, resolveRoot: discoveredRoot });
  addRoadmapCommand(program, { output, resolveRoot: discoveredRoot });
  addSpecCommand(program, { output, resolveRoot: discoveredRoot });

  const source = program.command("source").description("External Source operations");
  source
    .command("add")
    .description("Add an external Source under sources/<alias>/")
    .argument("<repo-or-dir>", "local source directory or git repository URL")
    .argument("[alias]", "short filesystem-safe source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--branch <branch>", "branch to check out for Git-backed sources")
    .option("--json", "emit JSON")
    .action(async (repoOrDir, alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await addSource({
        root,
        source: repoOrDir,
        ...(alias === undefined ? {} : { alias }),
        ...(commandOptions.branch === undefined ? {} : { branch: commandOptions.branch }),
      });
      if (commandOptions.json) {
        writeJson(output, hintedResult(result, "source add"));
        return;
      }
      writeLine(output, "stdout", `Added source: ${result.path}`);
      writeLine(output, "stdout", `Observation: ${result.observationFile}`);
      writeLine(
        output,
        "stdout",
        result.contentMode === "checkout"
          ? `Checkout: ${result.contentPath}`
          : `Content: ${result.contentPath}`,
      );
      writeLine(output, "stdout", `Materials: ${result.materialsPath}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(
        output,
        "stdout",
        result.contentMode === "checkout"
          ? "Next: `assay status` reports when this source moves upstream and which adopted mappings it reaches."
          : "Next: `assay source capture` preserves these bytes when a decision needs to point at them later.",
      );
      for (const hint of hintLines("source add")) {
        writeLine(output, "stdout", hint);
      }
    });

  source
    .command("capture")
    .description("Preserve a source's current bytes with an integrity hash")
    .argument("<alias>", "source alias")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--note <text>", "why these bytes are worth preserving")
    .option("--json", "emit JSON")
    .action(async (alias, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await captureSource({
        root,
        alias,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
      });
      if (commandOptions.json) {
        writeJson(output, hintedResult(result, "source capture"));
        return;
      }
      writeLine(output, "stdout", `Captured source: ${result.path}`);
      writeLine(output, "stdout", `Capture: ${result.capturePath}`);
      writeLine(
        output,
        "stdout",
        `Content: ${result.capture.file_count} files, ${result.capture.byte_count} bytes`,
      );
      writeLine(output, "stdout", `Integrity: ${result.capture.algorithm}:${result.capture.value}`);
      writeLine(output, "stdout", `Observation: ${result.observationFile}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      for (const hint of hintLines("source capture")) {
        writeLine(output, "stdout", hint);
      }
    });

  source
    .command("import")
    .description("Replace a copied source's content, preserving the bytes it replaces")
    .argument("<alias>", "source alias")
    .argument("<dir-or-archive>", "local directory or archive to copy in")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--note <text>", "what this import brings in")
    .option("--json", "emit JSON")
    .action(async (alias, from, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await importSourceContent({
        root,
        alias,
        from,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
      });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Imported content: ${result.contentPath}`);
      writeLine(output, "stdout", `Change class: ${result.changeClass}`);
      if (result.preservedCapture) {
        writeLine(output, "stdout", `Preserved: ${result.preservedCapture.path}`);
      }
      writeLine(output, "stdout", `Observation: ${result.observationFile}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  source
    .command("sync")
    .description("Observe a checkout-backed source again and update current materials")
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
    .description("Show Source status")
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

  const sourceAdoption = source
    .command("adoption")
    .description("Record where source material landed in a system");

  sourceAdoption
    .command("take")
    .description("Record that material moved from a source into a registered system")
    .argument("<source>", "<source-alias>:<path-in-source>")
    .requiredOption("--into <target>", "<target-system>:<path-in-system>")
    .addOption(
      new Option("--mode <mode>", "how the material was carried over")
        .choices([...SOURCE_ADOPTION_TAKE_MODES])
        .default("adapt"),
    )
    .option("--note <text>", "why this material was taken")
    .option("--to <observation>", "source observation id; defaults to latest")
    .option("--id <adoption-id>", "adoption id; derived from source, system, and path by default")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (sourceArgument, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const from = splitSourceAdoptionLocatorArgument(sourceArgument, "Source adoption input");
      const into = splitSourceAdoptionLocatorArgument(commandOptions.into, "--into");
      const result = await takeSourceAdoptionMaterial({
        root,
        sourceAlias: from.name,
        sourcePath: from.path,
        targetSystem: into.name,
        targetPath: into.path,
        mode: commandOptions.mode as SourceAdoptionTakeMode,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
        ...(commandOptions.to === undefined ? {} : { observation: commandOptions.to }),
        ...(commandOptions.id === undefined ? {} : { adoptionId: commandOptions.id }),
      });
      if (commandOptions.json) {
        writeJson(output, hintedResult(result, "source adoption take"));
        return;
      }
      writeLine(output, "stdout", formatSourceAdoptionTake(result));
      writeLine(
        output,
        "stdout",
        `Next: assay status reports when ${result.record.source.alias} changes under this mapping.`,
      );
      for (const hint of hintLines("source adoption take")) {
        writeLine(output, "stdout", hint);
      }
    });

  sourceAdoption
    .command("list")
    .description("List recorded mappings")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await listSourceAdoptions({ root });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatSourceAdoptionList(result));
    });

  sourceAdoption
    .command("show")
    .description("Show one mapping, its identity pin, and where the target resolves")
    .argument("<adoption>", "source adoption id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await getSourceAdoption({ root, adoptionId });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", formatSourceAdoption(result));
    });

  sourceAdoption
    .command("remove")
    .description("Forget a mapping; the material in the target system is untouched")
    .argument("<adoption>", "source adoption id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (adoptionId, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await removeSourceAdoption({ root, adoptionId });
      if (commandOptions.json) {
        writeJson(output, result);
        return;
      }
      writeLine(output, "stdout", `Removed source adoption: ${result.adoptionId}`);
      writeLine(
        output,
        "stdout",
        `Was: ${result.record.source.alias}:${result.record.source.path} -> ${result.record.target.system}:${result.record.target.path}`,
      );
      if (result.eventFile) {
        writeLine(output, "stdout", `Event: ${result.eventFile}`);
      }
      writeLine(
        output,
        "stdout",
        `Note: only the record was removed; ${result.record.target.system} still holds whatever is there.`,
      );
    });

  const analysis = program.command("analysis").description("Analysis operations");
  analysis
    .command("new")
    .description("Create an analysis draft")
    .argument("<title>", "analysis title")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--for-source <alias>", "Source alias to bind")
    .option("--observation <id-or-path>", "source observation id/path; defaults to latest")
    .option("--json", "emit JSON")
    .action(async (title, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await createAnalysis({
        root,
        title,
        ...(commandOptions.forSource === undefined ? {} : { forSource: commandOptions.forSource }),
        ...(commandOptions.observation === undefined
          ? {}
          : { observation: commandOptions.observation }),
      });
      if (commandOptions.json) {
        writeJson(output, hintedResult(result, "analysis new"));
        return;
      }
      writeLine(output, "stdout", `Created analysis: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(
        output,
        "stdout",
        `Next: fill ## Key observations, then \`assay analysis close ${result.path} --exit adopt|reject|experiment\`.`,
      );
      for (const hint of hintLines("analysis new")) {
        writeLine(output, "stdout", hint);
      }
    });

  analysis
    .command("close")
    .description("Close an analysis with a decision exit")
    .argument("<path>", "analysis file path relative to workspace root")
    .addOption(
      new Option("--exit <exit>", "decision exit")
        .choices(["adopt", "reject", "experiment"])
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
      if (result.pinSuggestion) {
        writeLine(output, "stdout", result.pinSuggestion);
      }
      writeLine(
        output,
        "stdout",
        commandOptions.exit === "adopt"
          ? `Next: \`assay knowledge add pattern "<title>" --from-analysis ${result.path}\` to keep what survived.`
          : "Next: `assay status` shows what is still open in this workspace.",
      );
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
      const supersedes = splitList(commandOptions.supersedes) ?? [];
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
      writeLine(output, "stdout", `Registered system: ${result.selector}`);
      writeLine(output, "stdout", `Status: ${result.system.status}`);
      writeLine(output, "stdout", "Registry: .assay/systems-registry.json");
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(output, "stdout", systemRegisterNextLine(result.selector, result.system.status));
    });

  system
    .command("update")
    .description("Update metadata for an existing system registry record")
    .argument("<selector>", "exact canonical system selector")
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
    .option("--primary", "set this system as the primary system")
    .option("--supersedes <names>", "comma-separated superseded system names")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const vcs = commandOptions.vcs as SystemVcs | undefined;
      const supersedes = splitList(commandOptions.supersedes);
      const result = await updateSystem(root, selector, {
        ...(commandOptions.path === undefined ? {} : { path: commandOptions.path }),
        ...(vcs === undefined ? {} : { vcs }),
        ...(commandOptions.vcsRef === undefined ? {} : { vcsRef: commandOptions.vcsRef }),
        ...(commandOptions.systemVersion === undefined
          ? {}
          : { version: commandOptions.systemVersion }),
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(commandOptions.primary ? { primary: true } : {}),
      });
      const changedFields = result.changes.map((change) => change.field).join(", ");
      writeLine(output, "stdout", `Updated system: ${result.selector}`);
      writeLine(output, "stdout", `Status: ${result.system.status}`);
      writeLine(output, "stdout", "Registry: .assay/systems-registry.json");
      writeLine(output, "stdout", `Changed fields: ${changedFields || "(none)"}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  system
    .command("promote")
    .description("Promote a system to primary; demotes the previous primary")
    .argument("<selector>", "exact canonical system selector")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const result = await promoteSystem(root, selector);
      writeLine(output, "stdout", `Promoted: ${result.selector}`);
      if (result.previousPrimary) {
        writeLine(
          output,
          "stdout",
          `Previous primary: ${result.previousPrimary.selector} (now superseded)`,
        );
      }
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
    });

  system
    .command("archive")
    .description("Logically archive a non-primary system without moving its files")
    .argument("<selector>", "exact canonical system selector")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .addOption(new Option("--dry-run", "plan the logical registry transition").conflicts("apply"))
    .addOption(new Option("--apply", "apply the logical registry transition").conflicts("dryRun"))
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const dryRun = commandOptions.dryRun ?? !commandOptions.apply;
      const result = await archiveSystem(root, selector, { dryRun });
      writeLine(output, "stdout", `System archive: ${result.dryRun ? "dry-run" : "applied"}`);
      writeLine(output, "stdout", `System: ${result.selector}`);
      writeLine(output, "stdout", "Archive mode: logical (locator unchanged; no files moved)");
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
        ? systems.filter((entry) => entry.system.status === commandOptions.status)
        : systems;
      if (commandOptions.json) {
        writeJson(output, {
          primary: registry.primary,
          systems: filtered.map(({ selector, system }) => ({ selector, ...system })),
        });
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
    .description("Show one registered system by exact canonical selector")
    .argument("<selector>", "exact canonical system selector")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (selector, commandOptions) => {
      const root = await discoveredRoot(commandOptions.root);
      const registry = await requireSystemsRegistry(root);
      const entry = await findSystemEntry(registry, selector);
      if (commandOptions.json) {
        writeJson(output, { selector: entry.selector, ...entry.system });
        return;
      }
      writeLine(output, "stdout", formatSystemRecord(entry));
    });

  const knowledge = program.command("knowledge").description("Knowledge operations");
  knowledge
    .command("add")
    .description("Add a knowledge entry")
    .argument("<type>", "knowledge type: pattern, guide, troubleshooting")
    .argument("<title>", "knowledge entry title")
    .option("--from-analysis <path>", "originating analysis path")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (type, title, commandOptions) => {
      const validTypes = ["pattern", "guide", "troubleshooting"];
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
      });
      if (commandOptions.json) {
        writeJson(output, hintedResult(result, "knowledge add"));
        return;
      }
      writeLine(output, "stdout", `Added knowledge: ${result.path}`);
      writeLine(output, "stdout", `Event: ${result.eventFile}`);
      writeLine(
        output,
        "stdout",
        `Next: write the entry in ${result.path}; \`assay check\` reports the workspace's knowledge structure.`,
      );
      for (const hint of hintLines("knowledge add")) {
        writeLine(output, "stdout", hint);
      }
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
