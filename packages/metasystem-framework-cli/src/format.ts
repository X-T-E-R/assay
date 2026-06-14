import type {
  ApplyUpdateResult,
  CheckFrameworkResult,
  FrameworkStatusResult,
  InitFrameworkResult,
  MigrateLayoutResult,
  OperationReport,
  UpdateAnalysis,
  UpdatePlan,
} from "metasystem-framework-core";

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
    `Core: ${result.core}`,
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
  const manifest = result.hasManifest
    ? [
        `Installed version: ${result.installedVersion ?? "unknown"}`,
        `Layout version: ${result.layoutVersion ?? "unknown"}`,
        `Project: ${result.project ?? "unknown"}`,
        `Core: ${result.core ?? "unknown"}`,
        `Managed files: ${result.managedFiles}`,
      ]
    : ["Manifest: missing", "Managed files: 0"];
  const zones = ["Zones", ...result.zones.map((zone) => `  - ${zone.path}: ${zone.files} files`)];

  return [...header, ...manifest, ...zones].join("\n");
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
