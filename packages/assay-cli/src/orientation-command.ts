import type { Command } from "@commander-js/extra-typings";
import {
  type ObjectSemantics,
  type PrimeResult,
  type PrimeWorkspaceState,
  SEMANTIC_TOPICS,
  primeWorkspace,
  requireObjectSemantics,
  semanticDigestSentence,
} from "assay-core";

interface Output {
  readonly stdout: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

interface Dependencies {
  readonly output: Output;
  readonly resolveRoot: (root: string) => Promise<string>;
}

/** Zones and Tasks are lists of unknown length; prime stays one screen. */
const MAX_PRIME_ZONES = 10;
const MAX_PRIME_TASKS = 5;

function write(output: Output, value: string): void {
  output.stdout(`${value}\n`);
}

function emit(output: Output, value: unknown, json: boolean | undefined, formatted: string): void {
  write(output, json ? JSON.stringify(value, null, 2) : formatted);
}

function truncated<T>(items: readonly T[], limit: number): { shown: readonly T[]; hidden: number } {
  return { shown: items.slice(0, limit), hidden: Math.max(0, items.length - limit) };
}

function field(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(17)}${value}`;
}

function zoneLines(workspace: PrimeWorkspaceState): string[] {
  if (workspace.zones.length === 0) {
    return [field("Zones", "none declared")];
  }
  const { shown, hidden } = truncated(workspace.zones, MAX_PRIME_ZONES);
  const pathWidth = Math.max(...shown.map((zone) => zone.path.length + 1));
  return [
    field("Zones", String(workspace.zones.length)),
    ...shown.map((zone) =>
      `    - ${`${zone.path}/`.padEnd(pathWidth)}  ${String(zone.files).padStart(4)}  ${zone.purpose}`.trimEnd(),
    ),
    ...(hidden > 0 ? [`    - ... ${hidden} more (assay status)`] : []),
  ];
}

function taskLines(workspace: PrimeWorkspaceState): string[] {
  if (workspace.activeTaskCount === 0) {
    return [field("Active tasks", "none")];
  }
  const { shown, hidden } = truncated(workspace.activeTasks, MAX_PRIME_TASKS);
  const idWidth = Math.max(...shown.map((task) => task.id.length));
  return [
    field("Active tasks", String(workspace.activeTaskCount)),
    ...shown.map((task) => `    - ${task.id.padEnd(idWidth)}  ${task.title}`.trimEnd()),
    ...(hidden > 0 ? [`    - ... ${hidden} more (assay task list)`] : []),
  ];
}

function sourceLine(workspace: PrimeWorkspaceState): string {
  const sources = workspace.sources;
  if (!sources) {
    return field("Sources", "none");
  }
  return field(
    "Sources",
    `${sources.total} total, ${sources.checkouts} tracked checkouts, ${sources.copies} copied, ${sources.majorChanges} graded major (assay source status)`,
  );
}

function workspaceLines(workspace: PrimeWorkspaceState): string[] {
  const layout = [
    `${workspace.layoutMode} (layout ${workspace.layoutVersion ?? "unknown"})`,
    `installed ${workspace.installedVersion ?? "unknown"}`,
    `cli ${workspace.cliVersion}`,
  ].join(", ");
  const project = workspace.projectId
    ? `${workspace.project ?? "unknown"} (${workspace.projectId})`
    : (workspace.project ?? "unknown");
  const primary = workspace.primarySystem
    ? `${workspace.primarySystem} (${workspace.systemCount} registered)`
    : "none registered";
  return [
    "Workspace",
    field("Layout", layout),
    field("Project", project),
    ...zoneLines(workspace),
    ...taskLines(workspace),
    sourceLine(workspace),
    field("Primary system", primary),
    field(
      "Counts",
      `knowledge ${workspace.counts.knowledgeEntries}, source adoptions ${workspace.counts.sourceAdoptions}, managed files ${workspace.counts.managedFiles}, run records ${workspace.counts.runRecords}`,
    ),
  ];
}

export function formatPrimeResult(result: PrimeResult): string {
  const lines = [
    "Assay prime",
    `Root: ${result.root}`,
    "",
    "Object semantics — what each object is for, and the rule most often broken",
    ...result.semantics.map((entry) => `  - ${semanticDigestSentence(entry)}`),
    "",
    ...(result.workspace
      ? workspaceLines(result.workspace)
      : [
          "Workspace",
          field("State", "no Assay workspace found here"),
          field("Start one", "assay init [target-dir] --name <project-name>"),
          field("Attach one", "assay attach --root <existing-repo>"),
        ]),
  ];
  if (result.notes.length > 0) {
    lines.push("", "Notes", ...result.notes.map((note) => `  - ${note}`));
  }
  lines.push("", `details: ${result.detailsCommand}`, `topics: ${result.topics.join(", ")}`);
  return lines.join("\n");
}

/** Where the flag list for a topic actually lives, since `explain` is not one. */
const TOPIC_HELP_COMMANDS: Record<ObjectSemantics["topic"], string> = {
  workspace: "assay --help",
  project: "assay status --help",
  task: "assay task --help",
  roadmap: "assay roadmap --help",
  spec: "assay spec --help",
  source: "assay source --help",
  adoption: "assay source adoption --help",
  analysis: "assay analysis --help",
  knowledge: "assay knowledge --help",
  system: "assay system --help",
};

export function formatObjectSemantics(entry: ObjectSemantics): string {
  return [
    `${entry.label} — ${entry.purpose}`,
    `Most-broken rule: ${entry.antiRule}`,
    "",
    "Why it exists",
    ...entry.whyItExists.map((line) => `  - ${line}`),
    "",
    "When not to use it",
    ...entry.whenNotToUse.map((line) => `  - ${line}`),
    "",
    "Common misuses",
    ...entry.commonMisuses.map((line) => `  - ${line}`),
    "",
    "Commands",
    ...entry.commands.map((line) => `  - ${line}`),
    "",
    `Flags and options: ${TOPIC_HELP_COMMANDS[entry.topic]}`,
  ].join("\n");
}

export function addOrientationCommands(program: Command, dependencies: Dependencies): void {
  const { output, resolveRoot } = dependencies;

  program
    .command("prime")
    .description("Orient a session: the object semantics, then this workspace's state")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await primeWorkspace({ root: await resolveRoot(commandOptions.root) });
      emit(output, result, commandOptions.json, formatPrimeResult(result));
    });

  program
    .command("explain")
    .description(`Explain what a native object is for (${SEMANTIC_TOPICS.join(", ")})`)
    .argument("<topic>", "object topic")
    .option("--json", "emit JSON")
    .action(async (topic, commandOptions) => {
      const entry = requireObjectSemantics(topic);
      emit(output, entry, commandOptions.json, formatObjectSemantics(entry));
    });
}
