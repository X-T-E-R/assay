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
  SourceAdoptionDecisionResult,
  SourceAdoptionHistoryResult,
  SourceAdoptionInspection,
  SourceAdoptionListResult,
  SourceAdoptionResult,
  SourceAdoptionStatusResult,
  SourceAdoptionVerificationResult,
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
 * The Upstream block answers the question a living source exists to raise —
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
        `  - living: ${result.sources.living}`,
        `  - frozen: ${result.sources.frozen}`,
        `  - major changes: ${result.sources.majorChanges}`,
        "  - details: assay source status",
      ]
    : [];

  const sourceAdoptions = result.sourceAdoptions
    ? [
        "Source adoptions",
        `  - adoptions: ${result.sourceAdoptions.adoptions}`,
        `  - targets: ${result.sourceAdoptions.targets}`,
        `  - accepted baselines: ${result.sourceAdoptions.acceptedTargets}`,
        `  - draft targets: ${result.sourceAdoptions.draftTargets}`,
        "  - details: assay source adoption status <adoption>",
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
    ...result.sources.map((source) => {
      const commit = source.vcs?.commit ? ` ${source.vcs.commit.slice(0, 12)}` : "";
      const latest = source.latestObservation ?? "-";
      const change = source.latestChangeClass ?? "-";
      return `${source.alias.padEnd(24)} ${source.mode.padEnd(7)} ${source.kind.padEnd(9)} ${source.captureMode.padEnd(8)} ${change.padEnd(11)} ${latest}${commit}`;
    }),
  ].join("\n");
}

export function formatSourceLogResult(result: SourceLogResult): string {
  if (result.entries.length === 0) {
    return [`Source log: ${result.alias}`, "(none)"].join("\n");
  }
  return [
    `Source log: ${result.alias}`,
    ...result.entries.map(({ observation }) => {
      const commit = observation.vcs?.commit ? ` ${observation.vcs.commit.slice(0, 12)}` : "";
      return `${observation.observed_on} ${observation.change_class.padEnd(11)} ${observation.observation_id}${commit}`;
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
  if (!result.observation) {
    return [
      `Source sync: ${result.alias}`,
      `Path: ${result.path}`,
      `Change: ${result.changeClass}`,
      "Observation: unchanged",
      `Event: ${result.eventFile}`,
      ...revalidationSuggestionForChange(result.changeClass),
    ].join("\n");
  }
  return [
    `Source sync: ${result.alias}`,
    `Path: ${result.path}`,
    `Change: ${result.changeClass}`,
    `Observation: ${result.observationFile ?? result.observation.observation_id}`,
    `Manifest: ${result.manifestFile ?? result.observation.manifest}`,
    `Event: ${result.eventFile}`,
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

export function formatSourceAdoptionList(result: SourceAdoptionListResult): string {
  if (result.adoptions.length === 0) {
    return ["Source adoptions", `Root: ${result.root}`, "(none)"].join("\n");
  }
  return [
    "Source adoptions",
    `Root: ${result.root}`,
    ...result.adoptions.map((adoption) => {
      const accepted = adoption.targets.filter((target) => target.baselineDecision).length;
      return `${adoption.id.padEnd(28)} source=${adoption.sourceAlias} targets=${adoption.targets.length} accepted=${accepted}`;
    }),
  ].join("\n");
}

export function formatSourceAdoption(result: SourceAdoptionResult): string {
  return [
    `Source adoption: ${result.definition.id}`,
    `Title: ${result.definition.title ?? "-"}`,
    `Definition: ${result.definitionDigest}`,
    `Source: ${result.definition.source.alias}@${result.definition.source.observation}`,
    "Targets:",
    ...result.definition.targets.map((target) => {
      const baseline = result.state.targets[target.id]?.baseline?.decision_id ?? "draft";
      return `  - ${target.id}: system=${target.system}, baseline=${baseline}`;
    }),
    "Mappings:",
    ...result.definition.mappings.map(
      (mapping) =>
        `  - ${mapping.id}: ${mapping.source.path} -> ${mapping.target.target_id}:${mapping.target.path}`,
    ),
    "Evidence policy:",
    ...(result.definition.evidence.length > 0
      ? result.definition.evidence.map(
          (requirement) => `  - ${requirement.id}: ${requirement.policy}`,
        )
      : ["  - (none)"]),
  ].join("\n");
}

function sourceAdoptionInspectionLines(
  inspection: SourceAdoptionInspection,
  indentation = "",
): string[] {
  const lines = [
    `${indentation}Inspection: ${inspection.id}`,
    `${indentation}Source: ${inspection.source.alias}@${inspection.source.observation_id}`,
    `${indentation}Target: ${inspection.target_id} (${inspection.target.working_tree})`,
    `${indentation}Baseline: ${inspection.baseline_decision_id ?? "draft"}`,
    `${indentation}Mappings:`,
    ...inspection.mappings.map((mapping) => {
      const facts = mapping.facts.length > 0 ? ` [${mapping.facts.join(", ")}]` : "";
      return `${indentation}  - ${mapping.id}: source=${mapping.source.change}, target=${mapping.target.change}${facts}`;
    }),
    `${indentation}Evidence: required=${inspection.required_evidence.length}, advisory=${inspection.advisory_evidence.length}`,
  ];
  if (inspection.diagnostics.length > 0) {
    lines.push(
      `${indentation}Diagnostics:`,
      ...inspection.diagnostics.map(
        (diagnostic) =>
          `${indentation}  - [${diagnostic.severity}] ${diagnostic.code}${diagnostic.mapping_id ? ` (${diagnostic.mapping_id})` : ""}: ${diagnostic.message}`,
      ),
    );
  }
  return lines;
}

export function formatSourceAdoptionInspection(result: {
  readonly inspection: SourceAdoptionInspection;
  readonly path: string | null;
}): string {
  return [
    ...sourceAdoptionInspectionLines(result.inspection),
    ...(result.path ? [`Record: ${result.path}`] : []),
  ].join("\n");
}

export function formatSourceAdoptionStatus(result: SourceAdoptionStatusResult): string {
  return [
    `Source adoption status: ${result.adoptionId}`,
    `Definition: ${result.definitionDigest}`,
    ...result.targets.flatMap((target) => [
      "",
      `Target: ${target.id} (system: ${target.system})`,
      ...sourceAdoptionInspectionLines(target.inspection, "  "),
    ]),
  ].join("\n");
}

export function formatSourceAdoptionVerification(result: SourceAdoptionVerificationResult): string {
  return [
    `Source adoption verification: ${result.inspection.id}`,
    `Current: ${result.current ? "yes" : "no"}`,
    `Required policy: ${result.policy.required_missing.length === 0 ? "satisfied" : "missing"}`,
    `Evidence records: ${result.evidence.length}`,
    `Required missing: ${result.policy.required_missing.join(", ") || "-"}`,
    `Advisory missing: ${result.policy.advisory_missing.join(", ") || "-"}`,
    `Failed or inconclusive: ${result.policy.failed.join(", ") || "-"}`,
    ...result.diagnostics.map(
      (diagnostic) => `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`,
    ),
  ].join("\n");
}

export function formatSourceAdoptionDecision(result: SourceAdoptionDecisionResult): string {
  return [
    `Source adoption decision: ${result.decision.outcome}`,
    `Decision: ${result.decision.id}`,
    `Adoption: ${result.decision.adoption_id}`,
    `Target: ${result.decision.target_id}`,
    `Inspection: ${result.decision.inspection_id}`,
    `Baseline: ${result.decision.baseline_after?.decision_id ?? "unchanged"}`,
    `Record: ${result.path}`,
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatSourceAdoptionHistory(result: SourceAdoptionHistoryResult): string {
  if (result.decisions.length === 0) {
    return [`Source adoption history: ${result.adoptionId}`, "(none)"].join("\n");
  }
  return [
    `Source adoption history: ${result.adoptionId}`,
    ...result.decisions.map(
      (decision) =>
        `${decision.decided_at} ${decision.outcome.padEnd(8)} ${decision.target_id.padEnd(20)} ${decision.id}${decision.reason ? ` - ${decision.reason}` : ""}`,
    ),
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
    "Summary:",
    ...updateCounts(result.analysis).map((line) => `  - ${line}`),
    ...formatUpdatePlan(result.plan),
    formatReport(result.report),
    ...(result.backup ? [`Backup: ${result.backup.relativePath}`] : []),
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
