import type {
  AdoptExistingProjectResult,
  AdrRecord,
  ApplyUpdateResult,
  AssayProjectRecord,
  AttachResult,
  CheckFrameworkResult,
  ConvertOverlayResult,
  DonorAdoptionListResult,
  DonorAdoptionResult,
  DonorDecisionResult,
  DonorHistoryResult,
  DonorInspection,
  DonorStatusResult,
  FrameworkStatusResult,
  InitFrameworkResult,
  MigrateLayoutResult,
  OperationReport,
  SourceDiffResult,
  SourceLogResult,
  SourceStatusResult,
  SourceSyncResult,
  SystemRecord,
  UpdateAnalysis,
  UpdatePlan,
  VerifyDonorInspectionResult,
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

type OptionalManifestSemantics = {
  readonly archetype?: string;
  readonly mode?: string;
};

function manifestSemanticsLines(value: OptionalManifestSemantics): string[] {
  return [
    ...(value.archetype ? [`Archetype: ${value.archetype}`] : []),
    ...(value.mode ? [`Mode: ${value.mode}`] : []),
  ];
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
  const semantics = manifestSemanticsLines(
    result as InitFrameworkResult & OptionalManifestSemantics,
  );
  return [
    `Initialized framework: ${result.root}`,
    `Project: ${result.project}`,
    ...semantics,
    formatReport(result.report),
  ].join("\n");
}

export function formatAttachResult(result: AttachResult): string {
  return [
    `Attached Assay overlay: ${result.root}`,
    `Project: ${result.project}`,
    "Mode: overlay",
    `Privacy: ${result.privacy}`,
    `Primary system: ${result.system.name} (path: ${result.system.path}, vcs: ${result.system.vcs})`,
    `Contract: ${result.system.contract_file}`,
    result.excludeUpdated
      ? "Git: added /.assay/ to .git/info/exclude"
      : "Git: .assay/ already ignored",
    `Event: ${result.eventFile}`,
  ].join("\n");
}

export function formatConvertResult(result: ConvertOverlayResult): string {
  return [
    `Converted overlay to standalone: ${result.targetRoot}`,
    `Source: ${result.sourceRoot}`,
    "Mode: standalone",
    `Transfer: ${result.moved ? "move" : "copy"}`,
    `Overlay: ${result.keepOverlay ? "kept" : "removed"}`,
    `Primary system: ${result.system.name} (path: ${result.system.path}, vcs: ${result.system.vcs})`,
    `Contract: ${result.system.contract_file}`,
    `Manifest: ${result.targetManifestPath}`,
    `Event: ${result.eventFile}`,
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
        ...manifestSemanticsLines(
          result.manifest as typeof result.manifest & OptionalManifestSemantics,
        ).map((line) => `  - ${line.charAt(0).toLowerCase()}${line.slice(1)}`),
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

export function formatStatusResult(result: FrameworkStatusResult): string {
  const header = ["Framework status", `Root: ${result.root}`];
  const semantics = manifestSemanticsLines(
    result as FrameworkStatusResult & OptionalManifestSemantics,
  );
  const manifest = result.hasManifest
    ? [
        `Installed version: ${result.installedVersion ?? "unknown"}`,
        `Layout version: ${result.layoutVersion ?? "unknown"}`,
        `Project: ${result.project ?? "unknown"}`,
        ...semantics,
        `Managed files: ${result.managedFiles}`,
      ]
    : ["Manifest: missing", "Managed files: 0"];
  const zones = ["Zones", ...result.zones.map((zone) => `  - ${zone.path}: ${zone.files} files`)];

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

  const livingSources = result.livingSources
    ? [
        "Living sources",
        `  - total: ${result.livingSources.total}`,
        `  - open observations: ${result.livingSources.openObservations}`,
        `  - suggested analyses: ${result.livingSources.suggestedAnalyses}`,
        `  - closed observations: ${result.livingSources.closedObservations}`,
        `  - major revalidations: ${result.livingSources.majorRevalidations}`,
        "  - details: assay source status",
      ]
    : [];

  const donors = result.donors
    ? [
        "Donor adoptions",
        `  - adoptions: ${result.donors.adoptions}`,
        `  - targets: ${result.donors.targets}`,
        `  - accepted baselines: ${result.donors.acceptedTargets}`,
        `  - draft targets: ${result.donors.draftTargets}`,
        "  - details: assay donor status <adoption>",
      ]
    : [];

  const summary: string[] = [];
  if (result.openIterations !== undefined) {
    summary.push(`Open iterations: ${result.openIterations}`);
  }
  if (result.knowledgeEntries !== undefined) {
    summary.push(`Knowledge entries: ${result.knowledgeEntries}`);
  }

  return [
    ...header,
    ...manifest,
    ...zones,
    ...systems,
    ...livingSources,
    ...donors,
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
      return `${source.alias.padEnd(24)} ${source.kind.padEnd(9)} ${source.captureMode.padEnd(8)} ${change.padEnd(11)} ${latest}${commit}`;
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

export function formatSourceSyncResult(result: SourceSyncResult): string {
  if (!result.observation) {
    return [
      `Source sync: ${result.alias}`,
      `Path: ${result.path}`,
      `Change: ${result.changeClass}`,
      "Observation: unchanged",
      `Event: ${result.eventFile}`,
    ].join("\n");
  }
  return [
    `Source sync: ${result.alias}`,
    `Path: ${result.path}`,
    `Change: ${result.changeClass}`,
    `Observation: ${result.observationFile ?? result.observation.observation_id}`,
    `Manifest: ${result.manifestFile ?? result.observation.manifest}`,
    `Event: ${result.eventFile}`,
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

export function formatDonorList(result: DonorAdoptionListResult): string {
  if (result.adoptions.length === 0) {
    return ["Donor adoptions", `Root: ${result.root}`, "(none)"].join("\n");
  }
  return [
    "Donor adoptions",
    `Root: ${result.root}`,
    ...result.adoptions.map((adoption) => {
      const accepted = adoption.targets.filter((target) => target.baselineDecision).length;
      return `${adoption.id.padEnd(28)} source=${adoption.sourceAlias} targets=${adoption.targets.length} accepted=${accepted}`;
    }),
  ].join("\n");
}

export function formatDonorAdoption(result: DonorAdoptionResult): string {
  return [
    `Donor adoption: ${result.definition.id}`,
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

function donorInspectionLines(inspection: DonorInspection, indentation = ""): string[] {
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

export function formatDonorInspection(result: {
  readonly inspection: DonorInspection;
  readonly path: string | null;
}): string {
  return [
    ...donorInspectionLines(result.inspection),
    ...(result.path ? [`Record: ${result.path}`] : []),
  ].join("\n");
}

export function formatDonorStatus(result: DonorStatusResult): string {
  return [
    `Donor status: ${result.adoptionId}`,
    `Definition: ${result.definitionDigest}`,
    ...result.targets.flatMap((target) => [
      "",
      `Target: ${target.id} (system: ${target.system})`,
      ...donorInspectionLines(target.inspection, "  "),
    ]),
  ].join("\n");
}

export function formatDonorVerification(result: VerifyDonorInspectionResult): string {
  return [
    `Donor verification: ${result.inspection.id}`,
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

export function formatDonorDecision(result: DonorDecisionResult): string {
  return [
    `Donor decision: ${result.decision.outcome}`,
    `Decision: ${result.decision.id}`,
    `Adoption: ${result.decision.adoption_id}`,
    `Target: ${result.decision.target_id}`,
    `Inspection: ${result.decision.inspection_id}`,
    `Baseline: ${result.decision.baseline_after?.decision_id ?? "unchanged"}`,
    `Record: ${result.path}`,
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatDonorHistory(result: DonorHistoryResult): string {
  if (result.decisions.length === 0) {
    return [`Donor history: ${result.adoptionId}`, "(none)"].join("\n");
  }
  return [
    `Donor history: ${result.adoptionId}`,
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

export function formatMigrationResult(result: MigrateLayoutResult): string {
  const steps = result.plan.steps.length
    ? result.plan.steps.map((step) => {
        const reason = step.reason ? ` - ${step.reason}` : "";
        return `  - [${step.action ?? step.type}] ${step.from} -> ${step.to}${reason}`;
      })
    : ["  - no legacy layout changes detected"];

  return [
    `Layout migration: ${result.apply && !result.dryRun ? "applied" : "dry-run"}`,
    `Root: ${result.root}`,
    "Plan:",
    ...steps,
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
        const semantics = manifestSemanticsLines(
          result.scaffold as typeof result.scaffold & OptionalManifestSemantics,
        ).map((line) => `  - ${line.charAt(0).toLowerCase()}${line.slice(1)}`);
        return [
          "Scaffold:",
          `  - project: ${result.scaffold.project}`,
          ...semantics,
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

export function formatProjectList(title: string, records: readonly AssayProjectRecord[]): string {
  if (records.length === 0) {
    return `${title}\n(none)`;
  }

  return [
    title,
    ...records.map(
      (record) =>
        `${record.status.padEnd(11)} ${formatProjectDate(record.lastSeenAt)}  ${record.id}  ${projectLabel(record).padEnd(28)} ${record.path}`,
    ),
    "",
    `${records.length} project(s)`,
  ].join("\n");
}

export function formatProjectRecord(record: AssayProjectRecord): string {
  return [
    `${record.name} (${record.id})`,
    `  status:            ${record.status}`,
    `  path:              ${record.path}`,
    `  realpath:          ${record.realpath}`,
    `  project:           ${record.name}`,
    `  created:           ${record.createdAt}`,
    `  last seen:         ${record.lastSeenAt}`,
    `  created by:        ${record.createdBy}`,
    `  last command:      ${record.lastCommand}`,
    `  framework version: ${record.frameworkVersion ?? "unknown"}`,
    `  layout version:    ${record.layoutVersion ?? "unknown"}`,
    `  managed files:     ${record.managedFiles}`,
  ].join("\n");
}

function formatProjectDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function projectLabel(record: AssayProjectRecord): string {
  return record.name;
}

function supersedesLine(system: SystemRecord): string {
  return system.supersedes.length > 0 ? system.supersedes.join(", ") : "-";
}

export function formatSystemRecord(system: SystemRecord): string {
  return [
    `${system.name} (${system.status})`,
    `  path:           ${system.path}`,
    `  vcs:            ${system.vcs}${system.vcs_ref ? `@${system.vcs_ref}` : ""}`,
    `  version:        ${system.version}`,
    `  contract:       ${system.contract_file ?? "-"}`,
    `  supersedes:     ${supersedesLine(system)}`,
    `  absorbed on:    ${system.absorbed_on ?? "-"}`,
    `  archived on:    ${system.archived_on ?? "-"}`,
    `  archive path:   ${system.archive_path ?? "-"}`,
  ].join("\n");
}

export function formatSystemList(
  title: string,
  primary: string | null,
  systems: readonly SystemRecord[],
): string {
  if (systems.length === 0) {
    return `${title}\n(none)`;
  }
  const lines = systems.map((system) => {
    const marker = system.name === primary ? "*" : " ";
    const vcs = `${system.vcs}${system.vcs_ref ? `@${system.vcs_ref}` : ""}`;
    const supersedes =
      system.supersedes.length > 0 ? ` supersedes ${system.supersedes.join(",")}` : "";
    return `${marker} ${system.status.padEnd(11)} ${system.name.padEnd(28)} ${vcs.padEnd(20)} v${system.version}${supersedes}`;
  });
  return [title, ...lines, "", `${systems.length} system(s), primary: ${primary ?? "(none)"}`].join(
    "\n",
  );
}

function adrRelationLine(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

export function formatAdrRecord(adr: AdrRecord): string {
  return [
    `${adr.id} (${adr.status})`,
    `  title:             ${adr.title}`,
    `  date:              ${adr.date}`,
    `  path:              ${adr.path}`,
    `  supersedes:        ${adrRelationLine(adr.supersedes)}`,
    `  superseded by:     ${adr.superseded_by ?? "-"}`,
    `  related analysis:  ${adr.related_analysis ?? "-"}`,
    `  related iteration: ${adr.related_iteration ?? "-"}`,
  ].join("\n");
}

export function formatAdrList(title: string, adrs: readonly AdrRecord[]): string {
  if (adrs.length === 0) {
    return `${title}\n(none)`;
  }
  return [
    title,
    ...adrs.map((adr) => `${adr.id.padEnd(32)} ${adr.status.padEnd(10)} ${adr.date}  ${adr.title}`),
    "",
    `${adrs.length} ADR(s)`,
  ].join("\n");
}
