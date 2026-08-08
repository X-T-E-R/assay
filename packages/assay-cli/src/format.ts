import type {
  AddCapabilityResult,
  AddPluginResult,
  AdoptExistingProjectResult,
  ApplyUpdateResult,
  AssayProjectRecord,
  AttachResult,
  CaptureIntentResult,
  CheckFrameworkResult,
  CheckPluginsResult,
  ConvertOverlayResult,
  DonorAdoptionListResult,
  DonorAdoptionResult,
  DonorDecisionResult,
  DonorHistoryResult,
  DonorInspection,
  DonorStatusResult,
  FrameworkStatusResult,
  InitFrameworkResult,
  ListCapabilitiesResult,
  ListIntentResult,
  ListPluginsResult,
  OperationReport,
  PromoteIntentResult,
  ReconcilePluginsResult,
  SourceDiffResult,
  SourceLogResult,
  SourceStatusResult,
  SourceSyncResult,
  SystemRecord,
  TrellisContextResult,
  TrellisHookInstallResult,
  TrellisTaskResult,
  UpdateAnalysis,
  UpdatePlan,
  VerifyDonorInspectionResult,
} from "assay-core";
import { describeIntentAuthority } from "assay-core";

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
  readonly archetypeDescription?: string;
  readonly mode?: string;
};

function manifestSemanticsLines(value: OptionalManifestSemantics): string[] {
  const archetype = value.archetypeDescription
    ? `${value.archetype} - ${value.archetypeDescription}`
    : value.archetype;
  return [
    ...(value.archetype ? [`Archetype: ${archetype}`] : []),
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
    `Primary system: ${result.system.name} (path: ${result.system.path}, vcs: ${result.system.vcs})`,
    `Contract: ${result.system.contract_file}`,
    `Manifest: ${result.targetManifestPath}`,
    `Event: ${result.eventFile}`,
  ].join("\n");
}

export function formatCapabilityAdd(result: AddCapabilityResult): string {
  const enabled = `Enabled capabilities: ${result.capabilities.join(", ") || "(none)"}`;
  if (result.alreadyEnabled) {
    const origin =
      result.source === "archetype"
        ? "provided by archetype"
        : result.source === "plugin"
          ? "provided by plugin"
          : "already added to this workspace";
    return [`Capability already enabled: ${result.module} (${origin})`, enabled].join("\n");
  }
  return [
    `Added capability: ${result.module}`,
    enabled,
    formatReport(result.report),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatCapabilityList(result: ListCapabilitiesResult): string {
  const lines = result.capabilities.map((entry) => {
    if (!entry.supported) {
      return `${entry.module}: recorded in the manifest, not supported by this build`;
    }
    return `${entry.module}: ${entry.enabled ? `enabled (${entry.source})` : "not enabled"}`;
  });
  return [
    `Capability modules for ${result.project} (archetype ${result.archetype}):`,
    ...lines.map((line) => `  - ${line}`),
  ].join("\n");
}

function formatPluginActions(result: ReconcilePluginsResult): string[] {
  if (result.plugins.length === 0) {
    return ["  - (no desired plugins)"];
  }
  return result.plugins.flatMap((plugin) => {
    const sources =
      plugin.desiredSources.length > 0 ? `; desired by ${plugin.desiredSources.join(", ")}` : "";
    const missing =
      plugin.missingPaths.length > 0
        ? plugin.missingPaths.map((file) => `      missing: ${file}`)
        : [];
    return [
      `  - [${plugin.action}] ${plugin.id} (${plugin.kind}${sources}; health ${plugin.health}) - ${plugin.message}`,
      ...missing,
    ];
  });
}

export function formatPluginAdd(result: AddPluginResult): string {
  return [
    result.alreadyDeclared
      ? `Plugin already declared: ${result.plugin}`
      : `Added plugin: ${result.plugin}`,
    "Reconcile:",
    ...formatPluginActions(result),
    formatReport(result.report),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatPluginList(result: ListPluginsResult): string {
  return [
    `Plugins for ${result.project}:`,
    ...result.plugins.map((plugin) => {
      if (plugin.external) {
        const external = plugin.external;
        const observedHost =
          external.observedHost && external.observedHostVersion
            ? `${external.observedHost}@${external.observedHostVersion}`
            : "(none)";
        return `  - ${plugin.id} (external descriptor): descriptor ${external.descriptorVerification}; payload ${external.payload.ref} referenced; Assay ${external.assayEnabled ? "enabled" : "disabled"}; observed host ${observedHost}; host installation ${external.hostInstallation}; host activation ${external.hostActivation}; health ${external.health}; execution ${external.executionOwner}; Assay executes nothing`;
      }
      const desired = plugin.desired
        ? `desired by ${plugin.desiredSources.join(", ")}`
        : "not desired";
      const installed = plugin.installed ? "installed" : "not installed";
      const versions = `${plugin.protocolVersion === null ? "" : `; protocol v${plugin.protocolVersion}`}; state v${plugin.stateVersion ?? "unknown"}`;
      const support = plugin.supported ? "" : "; unsupported";
      const contributions =
        plugin.contributedCapabilities.length > 0
          ? `; contributes ${plugin.contributedCapabilities.join(", ")}`
          : "";
      const runtime =
        plugin.runtimeCapabilities.length > 0
          ? `; runtime ${plugin.runtimeCapabilities.join(", ")}`
          : "";
      const operations =
        plugin.operationalResponsibilities.length > 0
          ? `; operates ${plugin.operationalResponsibilities.join(", ")}`
          : "";
      const responsibilities =
        plugin.providedResponsibilities.length > 0
          ? `; provides ${plugin.providedResponsibilities.join(", ")}`
          : "";
      const active =
        plugin.activeResponsibilities.length > 0
          ? `; active for ${plugin.activeResponsibilities.join(", ")}`
          : "";
      return `  - ${plugin.id} (${plugin.kind}): ${desired}; ${installed}${versions}; ${plugin.action}; health ${plugin.health}${contributions}${runtime}${operations}${responsibilities}${active}${support}`;
    }),
    "Responsibilities:",
    ...result.responsibilities.map(
      (responsibility) =>
        `  - ${responsibility.id}: desired ${responsibility.desiredProvider}; active ${responsibility.activeProvider ?? "(none)"}; ${responsibility.state}`,
    ),
  ].join("\n");
}

export function formatTrellisTask(result: TrellisTaskResult): string {
  if (!result.task) return "Current Trellis task: (none)";
  return [
    `Trellis task: ${result.task.id}`,
    `Title: ${result.task.title}`,
    `Status: ${result.task.status}`,
    `Session: ${result.session_id ?? "(workspace)"}`,
  ].join("\n");
}

export function formatTrellisContext(result: TrellisContextResult): string {
  return [
    `Trellis context for ${result.host}:`,
    `Root: ${result.workspace_root}`,
    formatTrellisTask(result),
  ].join("\n");
}

export function formatTrellisHookInstall(result: TrellisHookInstallResult): string {
  return [
    `Trellis ${result.host} hook: ${result.action}`,
    `Target: ${result.target}`,
    `Command: ${result.command}`,
    `Applied: ${result.applied ? "yes" : "no"}`,
  ].join("\n");
}

export function formatPluginCheck(result: CheckPluginsResult): string {
  const rows =
    result.rows.length > 0
      ? result.rows.map(
          (row) => `[${row.status}] ${row.path}${row.message ? ` - ${row.message}` : ""}`,
        )
      : ["[ok] no desired or installed plugins"];
  return [`Plugin check: ${result.ok ? "ok" : "failed"}`, `Root: ${result.root}`, ...rows].join(
    "\n",
  );
}

export function formatPluginReconcile(result: ReconcilePluginsResult): string {
  return [
    `Plugin reconcile: ${result.dryRun ? "dry-run" : "applied"}`,
    `Root: ${result.root}`,
    "Plan:",
    ...formatPluginActions(result),
    formatReport(result.report),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatIntentCapture(result: CaptureIntentResult): string {
  const { capture } = result;
  return [
    result.created
      ? `Captured intent: ${capture.id}`
      : `Intent already captured: ${capture.id} (identical text; nothing written)`,
    `Path: ${capture.path}`,
    `System: ${capture.system}`,
    `SHA-256: ${capture.sha256}`,
    ...(capture.supersedes.length > 0 ? [`Supersedes: ${capture.supersedes.join(", ")}`] : []),
    ...(capture.shadow
      ? ["Shadow: yes (the authoritative record for this system lives elsewhere)"]
      : []),
    // Captures are append-only, so metadata passed to a repeat capture cannot
    // be applied. Say so instead of exiting 0 as if it had been.
    ...(result.ignoredOptions.length > 0
      ? [
          `Ignored: ${result.ignoredOptions.join(", ")} (the recorded capture keeps the metadata it was written with; record a correction with --supersedes ${capture.id})`,
        ]
      : []),
    ...(result.eventFile ? [`Event: ${result.eventFile}`] : []),
  ].join("\n");
}

export function formatIntentPromotion(result: PromoteIntentResult): string {
  return [
    `Promoted intent ${result.capture.id} to ${result.to}`,
    `Title: ${result.title}`,
    `Path: ${result.path}`,
    `System: ${result.capture.system}`,
    `Event: ${result.eventFile}`,
  ].join("\n");
}

export function formatIntentList(result: ListIntentResult): string {
  const scope =
    result.system === null
      ? "all systems"
      : result.systems.length > 1
        ? `system ${result.system} (lineage: ${result.systems.join(", ")})`
        : `system ${result.system}`;
  if (result.captures.length === 0) {
    return [`Intent captures for ${scope}`, "(none)"].join("\n");
  }
  return [
    `Intent captures for ${scope}`,
    ...result.captures.map((capture) => {
      const markers = [
        ...(capture.integrity === "modified" ? ["modified after recording"] : []),
        ...(capture.integrity === "unreadable" ? ["unreadable record"] : []),
        ...(capture.shadow ? ["shadow"] : []),
        ...(capture.supersedes.length > 0 ? [`supersedes ${capture.supersedes.join(",")}`] : []),
        ...(capture.requirements.length > 0
          ? [`${capture.requirements.length} requirement(s)`]
          : []),
      ];
      const suffix = markers.length > 0 ? ` [${markers.join("; ")}]` : "";
      // A record damaged past parsing has no frontmatter left to report.
      const system = capture.system || "(unknown)";
      const capturedAt = capture.capturedAt || "(unknown)";
      return `  - ${capture.id}  ${system.padEnd(20)} ${capturedAt}${suffix}`;
    }),
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

/**
 * Zone lines carry the archetype's purpose text next to the count. An agent
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
          ? `   affects ${source.impact.mappings} donor mapping${source.impact.mappings === 1 ? "" : "s"}`
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
  const semantics = manifestSemanticsLines(
    result as FrameworkStatusResult & OptionalManifestSemantics,
  );
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
        ...semantics,
        `Managed files: ${result.managedFiles}`,
      ]
    : ["Manifest: missing", "Managed files: 0"];
  const archetypeNotice = result.archetypeNotice ? [`Archetype: ${result.archetypeNotice}`] : [];
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
  if (result.knowledgeEntries !== undefined) {
    summary.push(`Knowledge entries: ${result.knowledgeEntries}`);
  }
  if (result.runRecords !== undefined) {
    summary.push(`Run records (runs.jsonl): ${result.runRecords}`);
  }

  return [
    ...header,
    ...manifest,
    ...archetypeNotice,
    ...zones,
    ...systems,
    ...livingSources,
    ...upstreamLines(result.upstream),
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
    `  intent:         ${describeIntentAuthority(system.intent_authority) ?? "inline (default)"}`,
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
