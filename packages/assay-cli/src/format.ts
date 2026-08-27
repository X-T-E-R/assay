import type {
  AdoptExistingProjectResult,
  ApplyUpdateResult,
  AttachResult,
  CheckExternalPluginsResult,
  CheckFrameworkResult,
  ConvertOverlayResult,
  ExternalPluginStatus,
  FrameworkStatusResult,
  InitFrameworkResult,
  OperationReport,
  SourceAdoptionListResult,
  SourceAdoptionPin,
  SourceAdoptionResult,
  SourceAdoptionTakeResult,
  SourceDiffResult,
  SourceLogResult,
  SourceStatusResult,
  SourceSyncResult,
  SystemEntry,
  UpdateAnalysis,
  UpdatePlan,
} from "assay-core";

function section(title: string, lines: readonly string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return [title, ...lines.map((line) => `  - ${line}`)];
}

function countLine(label: string, count: number): string {
  return `${label}: ${count}`;
}

export function formatReport(report: OperationReport): string {
  const lines = [
    ...section("Created directories", report.created_dirs),
    ...section("Existing directories", report.existing_dirs),
    ...section("Created files", report.created_files),
    ...section("Updated files", report.updated_files),
    ...section("Skipped files", report.skipped_files),
    ...section("Conflicted files", report.conflicted_files),
    ...section("New copies", report.new_copies),
    ...section("Notes", report.notes),
  ];

  return lines.length > 0 ? lines.join("\n") : "No changes.";
}

export function formatInitResult(result: InitFrameworkResult): string {
  return [
    `Initialized framework: ${result.root}`,
    `Project: ${result.project}`,
    `Template: ${result.template}`,
    formatReport(result.report),
  ].join("\n");
}

export function formatAttachResult(result: AttachResult): string {
  return [
    `Attached Assay overlay: ${result.root}`,
    `Project: ${result.project}`,
    "Mode: overlay",
    `Privacy: ${result.privacy}`,
    `Primary system: ${result.systemSelector} (path: ${result.system.path}, vcs: ${result.system.vcs})`,
    result.excludeUpdated
      ? "Git: added /.assay/ to .git/info/exclude"
      : "Git: .assay/ already ignored",
    `Event: ${result.eventFile}`,
  ].join("\n");
}

function overlayDisposition(result: ConvertOverlayResult): string {
  if (result.keepOverlay) {
    return "kept";
  }
  return result.overlayStateRemoved
    ? "removed"
    : "kept (state directory still holds files that were not moved)";
}

export function formatConvertResult(result: ConvertOverlayResult): string {
  return [
    `Converted overlay to standalone: ${result.targetRoot}`,
    `Source: ${result.sourceRoot}`,
    "Mode: standalone",
    `Transfer: ${result.moved ? "move" : "copy"}`,
    `Overlay: ${overlayDisposition(result)}`,
    `Primary system: ${result.systemSelector} (path: ${result.system.path}, vcs: ${result.system.vcs})`,
    `Manifest: ${result.targetManifestPath}`,
    `Event: ${result.eventFile}`,
  ].join("\n");
}

export function formatPluginList(result: {
  readonly root: string;
  readonly plugins: readonly ExternalPluginStatus[];
}): string {
  return [
    `External plugins for ${result.root}:`,
    ...(result.plugins.length === 0
      ? ["  - (none registered)"]
      : result.plugins.map((plugin) => {
          const observedHost =
            plugin.observedHost && plugin.observedHostVersion
              ? `${plugin.observedHost}@${plugin.observedHostVersion}`
              : "(none)";
          return `  - ${plugin.id}: descriptor ${plugin.descriptorVerification}; payload ${plugin.payload.ref} referenced; Assay ${plugin.assayEnabled ? "enabled" : "disabled"}; observed host ${observedHost}; host installation ${plugin.hostInstallation}; host activation ${plugin.hostActivation}; health ${plugin.health}; execution ${plugin.executionOwner}; Assay executes nothing`;
        })),
  ].join("\n");
}

export function formatPluginCheck(result: CheckExternalPluginsResult): string {
  const rows =
    result.rows.length > 0
      ? result.rows.map(
          (row) => `[${row.status}] ${row.path}${row.message ? ` - ${row.message}` : ""}`,
        )
      : ["[ok] no external plugins registered"];
  return [
    `External plugin check: ${result.ok ? "ok" : "failed"}`,
    `Root: ${result.root}`,
    ...rows,
  ].join("\n");
}

export function formatCheckResult(result: CheckFrameworkResult): string {
  const rows = result.rows.map((row) => {
    const suffix = row.message ? ` - ${row.message}` : "";
    return `[${row.status}] ${row.path}${suffix}`;
  });
  const manifest = result.manifest
    ? [
        "Manifest:",
        `  - schema: ${result.manifest.schema}`,
        `  - framework version: ${result.manifest.frameworkVersion}`,
        `  - format: ${result.manifest.format}`,
        `  - managed files: ${result.manifest.managedFiles}`,
      ]
    : [];

  return [
    `Framework check: ${result.ok ? "ok" : "failed"}`,
    `Root: ${result.root}`,
    ...rows,
    ...manifest,
  ].join("\n");
}

/**
 * Zone lines carry the manifest entries's purpose text next to the count. An agent
 * entering a workspace has no history, so what a directory is for is directed
 * information rather than noise, and it is the only placement signal that
 * reaches the command agents actually run.
 */
function zoneLines(zones: FrameworkStatusResult["zones"]): string[] {
  if (zones.length === 0) {
    return ["Zones", "  (none declared)"];
  }
  const pathWidth = Math.max(...zones.map((zone) => zone.path.length + 1));
  const countWidth = Math.max(...zones.map((zone) => String(zone.files).length));
  return [
    "Zones",
    ...zones.map((zone) => {
      const label = `${zone.path}/`.padEnd(pathWidth);
      const count = String(zone.files).padStart(countWidth);
      return `  - ${label}  ${count}  ${zone.purpose}`.trimEnd();
    }),
  ];
}

/**
 * The Upstream block answers the question a tracked source exists to raise —
 * did it move, and does that reach anything we adopted — in the command that
 * actually gets run. The `Next:` line names the command that resolves it, and
 * appears only when one exists.
 */
function upstreamLines(upstream: FrameworkStatusResult["upstream"]): string[] {
  if (!upstream || upstream.sources.length === 0) {
    return [];
  }
  const aliasWidth = Math.max(...upstream.sources.map((source) => source.alias.length));
  const lines = [
    "Upstream",
    ...upstream.sources.map((source) => {
      const impact =
        source.impact && source.impact.mappings > 0
          ? `   affects ${source.impact.mappings} source adoption mapping${source.impact.mappings === 1 ? "" : "s"}`
          : "";
      return `  - ${source.alias.padEnd(aliasWidth)}   ${source.summary}${impact}`;
    }),
  ];
  if (upstream.nextCommand) {
    lines.push(`Next: ${upstream.nextCommand}`);
  }
  return lines;
}

export function formatStatusResult(result: FrameworkStatusResult): string {
  const header = ["Framework status", `Root: ${result.root}`];
  const manifest = result.hasManifest
    ? [
        `Installed version: ${result.installedVersion ?? "unknown"}`,
        `Layout version: ${result.layoutVersion ?? "unknown"}`,
        `Project: ${result.project ?? "unknown"}`,
        ...(result.nativeProject
          ? [
              `Native Project: ${result.nativeProject.name} (${result.nativeProject.id})`,
              `Project envelope: ${result.nativeProject.path}`,
              `Project authority: ${result.nativeProject.authority}`,
            ]
          : []),
        `Managed files: ${result.managedFiles}`,
      ]
    : ["Manifest: missing", "Managed files: 0"];
  const zones = zoneLines(result.zones);

  const systems =
    result.systems && result.systems.length > 0
      ? [
          "Systems",
          ...result.systems.map((sys) => {
            const marker = sys.status === "primary" ? "*" : " ";
            const supersedes =
              sys.supersedes.length > 0 ? ` supersedes ${sys.supersedes.join(",")}` : "";
            return `  ${marker} ${sys.status.padEnd(11)} ${sys.name.padEnd(28)} ${sys.vcs} v${sys.version}${supersedes}`;
          }),
        ]
      : [];

  const sources = result.sources
    ? [
        "Sources",
        `  - total: ${result.sources.total}`,
        `  - checkouts: ${result.sources.checkouts}`,
        `  - copies: ${result.sources.copies}`,
        `  - major changes: ${result.sources.majorChanges}`,
        "  - details: assay source status",
      ]
    : [];

  const sourceAdoptions = result.sourceAdoptions
    ? [
        "Source adoptions",
        `  - mappings: ${result.sourceAdoptions.adoptions}`,
        `  - systems reached: ${result.sourceAdoptions.systems}`,
        `  - identity pins: ${result.sourceAdoptions.pinned}`,
        "  - details: assay source adoption list",
      ]
    : [];

  const summary: string[] = [];
  if (result.knowledgeEntries !== undefined) {
    summary.push(`Knowledge entries: ${result.knowledgeEntries}`);
  }
  if (result.runRecords !== undefined) {
    summary.push(`Run records (runs.jsonl): ${result.runRecords}`);
  }

  return [
    ...header,
    ...manifest,
    ...zones,
    ...systems,
    ...sources,
    ...upstreamLines(result.upstream),
    ...sourceAdoptions,
    ...summary,
  ].join("\n");
}

export function formatSourceStatusResult(result: SourceStatusResult): string {
  if (result.sources.length === 0) {
    return ["Sources", `Root: ${result.root}`, "(none)"].join("\n");
  }
  return [
    "Sources",
    `Root: ${result.root}`,
    ...result.sources.flatMap((source) => {
      const commit = source.vcs?.commit ? ` ${source.vcs.commit.slice(0, 12)}` : "";
      const latest = source.latestObservation ?? "-";
      const change = source.latestChangeClass ?? "-";
      const captures = source.captures > 0 ? ` captures=${source.captures}` : "";
      return [
        `${source.alias.padEnd(24)} ${source.contentMode.padEnd(8)} ${source.kind.padEnd(9)} ${change.padEnd(11)} ${latest}${commit}${captures}`,
        ...source.latestAdvisories.map((advisory) => `${" ".repeat(24)} ! ${advisory}`),
      ];
    }),
  ].join("\n");
}

export function formatSourceLogResult(result: SourceLogResult): string {
  if (result.entries.length === 0) {
    return [`Source log: ${result.alias}`, "(none)"].join("\n");
  }
  return [
    `Source log: ${result.alias}`,
    ...result.entries.flatMap(({ observation }) => {
      const commit = observation.vcs?.commit ? ` ${observation.vcs.commit.slice(0, 12)}` : "";
      const capture = observation.capture ? " [capture]" : "";
      return [
        `${observation.observed_on} ${observation.kind.padEnd(7)} ${observation.change_class.padEnd(11)} ${observation.observation_id}${commit}${capture}`,
        `${" ".repeat(20)} ${observation.note}`,
        ...observation.advisories.map((advisory) => `${" ".repeat(20)} ! ${advisory}`),
      ];
    }),
  ].join("\n");
}

function revalidationSuggestionForChange(changeClass: SourceSyncResult["changeClass"]): string[] {
  if (changeClass !== "major" && changeClass !== "replacement") {
    return [];
  }
  return [
    `Advisory: graded '${changeClass}'. Revalidate affected analyses and current Specs before reuse.`,
  ];
}

export function formatSourceSyncResult(result: SourceSyncResult): string {
  const advisories = result.advisories.map((advisory) => `Advisory: ${advisory}`);
  if (!result.observation) {
    return [
      `Source sync: ${result.alias}`,
      `Path: ${result.path}`,
      `Change: ${result.changeClass}`,
      "Observation: unchanged",
      `Event: ${result.eventFile}`,
      ...advisories,
      ...revalidationSuggestionForChange(result.changeClass),
    ].join("\n");
  }
  return [
    `Source sync: ${result.alias}`,
    `Path: ${result.path}`,
    `Change: ${result.changeClass}`,
    `Observation: ${result.observationFile ?? result.observation.observation_id}`,
    `Note: ${result.observation.note}`,
    `Event: ${result.eventFile}`,
    ...advisories,
    ...revalidationSuggestionForChange(result.changeClass),
  ].join("\n");
}

export function formatSourceDiffResult(result: SourceDiffResult): string {
  return [
    `Source diff: ${result.alias}`,
    `From: ${result.from ?? "none"}`,
    `To: ${result.to ?? "none"}`,
    `Added: ${result.added.length}`,
    ...result.added.map((file) => `  + ${file}`),
    `Removed: ${result.removed.length}`,
    ...result.removed.map((file) => `  - ${file}`),
    `Changed: ${result.changed.length}`,
    ...result.changed.map((file) => `  * ${file}`),
  ].join("\n");
}

/** One line naming the identity the mapping rests on, or that it rests on none. */
function pinLine(pin: SourceAdoptionPin | undefined): string {
  if (!pin) {
    return "Pin: none (alias and date only)";
  }
  if (pin.kind === "git-commit") {
    return `Pin: commit ${pin.commit.slice(0, 12)}${pin.origin ? ` from ${pin.origin}` : ""}`;
  }
  return `Pin: ${pin.algorithm}:${pin.value.slice(0, 16)}...`;
}

export function formatSourceAdoptionList(result: SourceAdoptionListResult): string {
  if (result.adoptions.length === 0) {
    return ["Source adoptions", `Root: ${result.root}`, "(none)"].join("\n");
  }
  const idWidth = Math.max(...result.adoptions.map((record) => record.id.length), 12);
  return [
    "Source adoptions",
    `Root: ${result.root}`,
    ...result.adoptions.map(
      (record) =>
        `${record.id.padEnd(idWidth)}  ${record.source.alias}:${record.source.path} -> ${record.target.system}:${record.target.path}  ${record.mode}${record.source.pin ? "  pinned" : ""}`,
    ),
  ].join("\n");
}

export function formatSourceAdoption(result: SourceAdoptionResult): string {
  const record = result.record;
  return [
    `Source adoption: ${record.id}`,
    `Source: ${record.source.alias}:${record.source.path} (${record.source.match})`,
    `Observation: ${record.source.observation}`,
    pinLine(record.source.pin),
    `Target: ${record.target.system}:${record.target.path} (${record.target.match})`,
    `Resolves: ${result.targetPath ?? "system is not registered"}${result.targetPath && !result.targetPresent ? " (not present)" : ""}`,
    `Mode: ${record.mode}`,
    `Note: ${record.note ?? "-"}`,
    `Recorded: ${record.recorded_on}`,
    `Record: ${result.path}`,
  ].join("\n");
}

export function formatSourceAdoptionTake(result: SourceAdoptionTakeResult): string {
  const record = result.record;
  return [
    `Recorded source adoption: ${result.adoptionId}`,
    `Mapping: ${record.source.alias}:${record.source.path} -> ${record.target.system}:${record.target.path} (${record.mode}, match ${record.source.match})`,
    `Observation: ${record.source.observation}`,
    pinLine(record.source.pin),
    ...(result.targetPresent
      ? []
      : [`Target: not present in ${record.target.system} yet; the mapping is recorded anyway`]),
    `Record: ${result.path}`,
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

function updateCounts(analysis: UpdateAnalysis): string[] {
  return [
    countLine("new", analysis.changes.new.length),
    countLine("auto-update", analysis.changes.auto_update.length),
    countLine("modified-by-user", analysis.changes.modified_by_user.length),
    countLine("user-deleted", analysis.changes.user_deleted.length),
    countLine("untracked-existing", analysis.changes.untracked_existing.length),
    countLine("unchanged", analysis.changes.unchanged.length),
  ];
}

function formatUpdatePlan(plan: UpdatePlan): string[] {
  if (plan.changes.length === 0) {
    return ["Plan: no template changes."];
  }

  return [
    "Plan:",
    ...plan.changes.map((change) => {
      const action = change.action ?? "skip";
      const reason = change.reason ? ` - ${change.reason}` : "";
      return `  - [${change.kind} -> ${action}] ${change.path}${reason}`;
    }),
  ];
}

export function formatUpdateResult(result: ApplyUpdateResult): string {
  return [
    `Framework update: ${result.dryRun ? "dry-run" : "applied"}`,
    `Root: ${result.root}`,
    `Conflict action: ${result.action}`,
    ...(result.migration
      ? [
          `Records migrated: ${result.migration.from} -> ${result.migration.to}`,
          ...result.migration.changes.map((line) => `  - ${line}`),
        ]
      : []),
    "Summary:",
    ...updateCounts(result.analysis).map((line) => `  - ${line}`),
    ...formatUpdatePlan(result.plan),
    formatReport(result.report),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatAdoptionResult(result: AdoptExistingProjectResult): string {
  const moves =
    result.moves.length === 0
      ? ["  - no root entries planned for archive"]
      : result.moves.map((move) => `  - [${move.status}] ${move.source} -> ${move.destination}`);
  const skipped = result.skipped.map((entry) => `  - ${entry.path} (${entry.reason})`);
  const failures = result.failures.map((failure) => {
    const destination = failure.destination ? ` -> ${failure.destination}` : "";
    return `  - ${failure.source}${destination}: ${failure.message}`;
  });
  const scaffold = result.scaffold
    ? (() => {
        return [
          "Scaffold:",
          `  - project: ${result.scaffold.project}`,
          `  - template: ${result.scaffold.template}`,
          `  - created directories: ${result.scaffold.createdDirectories}`,
          `  - created files: ${result.scaffold.createdFiles}`,
          `  - skipped files: ${result.scaffold.skippedFiles}`,
        ];
      })()
    : [];

  return [
    `Existing project adoption: ${result.dryRun ? "dry-run" : result.failures.length > 0 ? "failed" : "applied"}`,
    `Root: ${result.root}`,
    `Archive: ${result.archiveDir}`,
    "Moves:",
    ...moves,
    ...(skipped.length ? ["Skipped:", ...skipped] : []),
    ...(failures.length ? ["Failures:", ...failures] : []),
    ...scaffold,
    ...(result.manifestPath ? [`Adoption manifest: ${result.manifestPath}`] : []),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

function supersedesLine(system: SystemEntry["system"]): string {
  return system.supersedes.length > 0 ? system.supersedes.join(", ") : "-";
}

export function formatSystemRecord(entry: SystemEntry): string {
  const { selector, system } = entry;
  return [
    `${selector} (${system.status})`,
    `  path:           ${system.path}`,
    `  vcs:            ${system.vcs}${system.vcs_ref ? `@${system.vcs_ref}` : ""}`,
    `  version:        ${system.version}`,
    `  supersedes:     ${supersedesLine(system)}`,
    `  absorbed on:    ${system.absorbed_on ?? "-"}`,
    `  archived on:    ${system.archived_on ?? "-"}`,
  ].join("\n");
}

export function formatSystemList(
  title: string,
  primary: string,
  systems: readonly SystemEntry[],
): string {
  if (systems.length === 0) {
    return `${title}\n(none)`;
  }
  const lines = systems.map(({ selector, system }) => {
    const marker = selector === primary ? "*" : " ";
    const vcs = `${system.vcs}${system.vcs_ref ? `@${system.vcs_ref}` : ""}`;
    const supersedes =
      system.supersedes.length > 0 ? ` supersedes ${system.supersedes.join(",")}` : "";
    return `${marker} ${system.status.padEnd(11)} ${selector.padEnd(28)} ${vcs.padEnd(20)} v${system.version}${supersedes}`;
  });
  return [title, ...lines, "", `${systems.length} system(s), primary: ${primary}`].join("\n");
}
