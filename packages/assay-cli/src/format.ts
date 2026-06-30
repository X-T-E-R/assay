import type {
  AdoptExistingProjectResult,
  AdrRecord,
  ApplyUpdateResult,
  AssayProjectRecord,
  CheckFrameworkResult,
  FrameworkStatusResult,
  InitFrameworkResult,
  MigrateLayoutResult,
  OperationReport,
  SystemRecord,
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

  const summary: string[] = [];
  if (result.openIterations !== undefined) {
    summary.push(`Open iterations: ${result.openIterations}`);
  }
  if (result.knowledgeEntries !== undefined) {
    summary.push(`Knowledge entries: ${result.knowledgeEntries}`);
  }

  return [...header, ...manifest, ...zones, ...systems, ...summary].join("\n");
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
