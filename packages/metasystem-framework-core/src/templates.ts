import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { type Profile, loadProfile } from "./profile.js";

export interface TemplateFile {
  readonly path: string;
  readonly templateId: string;
  readonly template_id: string;
  readonly content: string;
  readonly executable: boolean;
  readonly protected: boolean;
}

export interface TemplateFileInput {
  readonly path: string;
  readonly templateId: string;
  readonly content: string;
  readonly executable?: boolean;
  readonly protected?: boolean;
}

function templateFile(input: TemplateFileInput): TemplateFile {
  return {
    path: input.path,
    templateId: input.templateId,
    template_id: input.templateId,
    content: input.content,
    executable: input.executable ?? false,
    protected: input.protected ?? false,
  };
}

function dedent(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const margin = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => (line.trim().length > 0 ? line.slice(margin) : "")).join("\n");
}

/**
 * Generate the list of template files for a new workspace, driven by a profile.
 * The profile (profiles/<name>.yaml) declares which templates to write and at
 * what path; this function resolves each templateId to its content generator.
 * Mode overrides the profile's default mode when supplied (e.g. `init --mode absorption`).
 *
 * To evolve the default structure, edit profiles/metasystem.yaml — not this
 * function (see ADR-0005).
 */
export async function desiredTemplates(
  project: string,
  core: string,
  mode: "learning" | "absorption" = "learning",
  profileName = "metasystem",
): Promise<TemplateFile[]> {
  const profile = await loadProfile(profileName);
  return profileTemplates(project, core, mode, profile);
}

/**
 * Synchronous variant for tests/callers that already hold a Profile. Resolves
 * template entries to content via the dispatcher.
 */
export function profileTemplates(
  project: string,
  core: string,
  mode: "learning" | "absorption",
  profile: Profile,
): TemplateFile[] {
  const result: TemplateFile[] = [];
  for (const entry of profile.templates) {
    const resolvedPath = entry.path.replace("{core}", core);
    const content = templateContentById(entry.templateId, project, core, mode);
    if (content === null) continue; // unknown templateId: skip (profile can reference future templates)
    result.push(templateFile({ path: resolvedPath, templateId: entry.templateId, content }));
  }
  return result;
}

/**
 * Dispatcher: map a templateId to its content generator. Content functions
 * remain in TS because of project/core/version interpolation. Adding a new
 * template means adding a case here AND an entry in the profile yaml.
 */
function templateContentById(
  templateId: string,
  project: string,
  core: string,
  mode: "learning" | "absorption",
): string | null {
  switch (templateId) {
    case "root.readme":
      return rootReadme(project, core);
    case "root.gitignore":
      return rootGitignore();
    case "framework.readme":
      return frameworkReadme();
    case "framework.version":
      return `${CURRENT_VERSION}\n`;
    case "framework.config":
      return configYaml(project, core, mode);
    case "framework.migrations.readme":
      return migrationsReadme();
    case "framework.events.gitkeep":
    case "framework.backups.gitkeep":
    case "analyses.references.gitkeep":
    case "analyses.gaps.gitkeep":
    case "analyses.patterns.gitkeep":
      return "";
    case "references.readme":
      return referencesReadme();
    case "references.intake.readme":
      return referencesIntakeReadme();
    case "references.frozen.readme":
      return referencesFrozenReadme();
    case "analyses.readme":
      return analysesReadme();
    case "analysis.template.reference":
      return referenceAnalysisTemplate();
    case "analysis.template.gap":
      return gapAnalysisTemplate();
    case "analysis.template.pattern":
      return patternCardTemplate();
    case "systems.readme":
      return systemsReadme();
    case "system.core.contract":
      return systemContract(project, core);
    case "iterations.readme":
      return iterationsReadme();
    case "iterations.template.plan":
      return iterationPlanTemplate();
    case "knowledge.readme":
      return knowledgeReadme();
    case "knowledge.decisions.readme":
      return "# decisions/\n\nAccepted decisions and ADRs.\n";
    case "knowledge.decisions.adr_template":
      return adrTemplate();
    case "knowledge.guides.readme":
      return "# guides/\n\nReusable operational guides.\n";
    case "knowledge.patterns.readme":
      return "# patterns/\n\nValidated reusable patterns only.\n";
    case "knowledge.troubleshooting.readme":
      return "# troubleshooting/\n\nReusable failure modes and fixes.\n";
    case "data.readme":
      return dataReadme();
    case "releases.readme":
      return releasesReadme();
    default:
      return null;
  }
}

export function rootReadme(project: string, core: string): string {
  return dedent(`
    # ${project}

    A versioned external-system-learning framework.

    Core loop:

    \`\`\`text
    references → analyses → systems → iterations → knowledge
    \`\`\`

    | Path | Purpose |
    | --- | --- |
    | \`.framework/\` | Runtime metadata: version, manifest, events, migrations, backups |
    | \`references/\` | External systems and frozen snapshots |
    | \`analyses/\` | Analysis layer that turns external systems into decisions |
    | \`systems/\` | Our active framework implementation; \`${core}/\` is the current core |
    | \`iterations/\` | Iterations against our own framework |
    | \`knowledge/\` | Accepted reusable knowledge |
    | \`data/\` | Research samples and evaluation data |
    | \`releases/\` | Release notes and upgrade packages |

    ## First workflow

    1. Freeze one external project under \`references/frozen/YYYYMM/<name>/\`.
    2. Write a reference analysis in \`analyses/references/\`.
    3. Convert a promising mechanism to \`analyses/patterns/\`.
    4. Start an iteration in \`iterations/YYYY-MM-DD-<topic>/\`.
    5. Land the validated change in \`systems/${core}/\`.
    6. Promote durable learning to \`knowledge/\`.
    `);
}

export function rootGitignore(): string {
  return dedent(`
    .DS_Store
    Thumbs.db
    __pycache__/
    *.pyc
    .venv/
    .secrets/
    *.log
    .framework/backups/*
    !.framework/backups/.gitkeep
    `);
}

export function frameworkReadme(): string {
  return dedent(`
    # .framework/

    Framework runtime metadata. Do not store external research or long-lived user knowledge here.

    - \`VERSION\`: installed framework template version.
    - \`manifest.json\`: managed file hashes and template IDs.
    - \`events/\`: JSONL event ledger.
    - \`migrations/\`: migration notes and plans.
    - \`backups/\`: timestamped backups before update/migration.

    Current template version: ${CURRENT_VERSION}; layout version: ${LAYOUT_VERSION}.
    `);
}

export function configYaml(
  project: string,
  core: string,
  mode: "learning" | "absorption" = "learning",
): string {
  return dedent(`
    framework:
      name: ${project}
      core: ${core}
      version: ${CURRENT_VERSION}
      layout_version: ${LAYOUT_VERSION}
      mode: ${mode}

    paths:
      runtime: .framework
      references: references
      analyses: analyses
      systems: systems
      iterations: iterations
      knowledge: knowledge
      data: data
      releases: releases

    update:
      default_conflict_action: skip
      backup_before_write: true
      protect_user_data: true
    `);
}

export function migrationsReadme(): string {
  return "# migrations/\n\nHuman-readable migration plans and generated migration logs.\n";
}

export function referencesReadme(): string {
  return dedent(`
    # references/

    Store external systems here. References are inputs, not local implementations.

    - \`intake/\`: candidate lists and search coverage notes.
    - \`frozen/YYYYMM/<name>/\`: frozen snapshots, default read-only.
    `);
}

export function referencesIntakeReadme(): string {
  return "# references/intake/\n\nCandidate references, search coverage, and intake decisions.\n";
}

export function referencesFrozenReadme(): string {
  return "# references/frozen/\n\nFrozen external systems by month. Treat these as read-only evidence.\n";
}

export function monthReferenceIndex(month: string): string {
  return `# references/frozen/${month}\n\n| Name | Source | Commit/version | Freeze mode | Analysis |\n| --- | --- | --- | --- | --- |\n`;
}

export function analysesReadme(): string {
  return dedent(`
    # analyses/

    Analysis is the conversion layer from external references to local decisions.

    | Subdir | Purpose |
    | --- | --- |
    | \`references/\` | Analysis cards for external systems |
    | \`gaps/\` | Gaps between an external system and our current framework |
    | \`patterns/\` | Candidate patterns that need validation |
    | \`templates/\` | Analysis templates |
    `);
}

export function referenceAnalysisTemplate(): string {
  return dedent(`
    # Reference Analysis Card

    - Reference:
    - Source:
    - Freeze path:
    - Date:

    ## Problem it solves

    ## Architecture / structure

    ## CLI and workflow mechanisms

    ## Version/update mechanisms

    ## What we should adopt

    ## What we should reject

    ## Decision exit

    - [ ] adopt
    - [ ] reject
    - [ ] experiment/iteration
    - [ ] ADR
    `);
}

export function gapAnalysisTemplate(): string {
  return dedent(`
    # Gap Analysis

    - Compared system:
    - Date:

    | Dimension | External approach | Our current approach | Gap | Action |
    | --- | --- | --- | --- | --- |
    | Structure | | | | |
    | CLI | | | | |
    | Version/update | | | | |
    | Knowledge capture | | | | |
    | Governance | | | | |
    `);
}

export function patternCardTemplate(): string {
  return dedent(`
    # Candidate Pattern

    - Name:
    - Evidence:
    - Status: candidate

    ## Problem

    ## Mechanism

    ## Applicability

    ## Anti-applicability

    ## Minimum local iteration

    ## Exit criteria
    `);
}

export function systemsReadme(): string {
  return "# systems/\n\nOur active framework/system implementations. The framework manages only each system's `system.yaml` contract; system source, README files, changelogs, and docs belong to the system itself.\n";
}

export function coreReadme(core: string): string {
  return dedent(`
    # ${core}

    This is our active framework core. External references inform this system only after analysis and iteration.

    ## Docs

    - \`docs/architecture.md\`
    - \`docs/artifact-model.md\`
    - \`docs/workflows.md\`
    - \`docs/update-mechanism.md\`
    - \`docs/roadmap.md\`
    `);
}

export function systemContract(project: string, core: string): string {
  return dedent(`
    system:
      project: ${project}
      name: ${core}
      version: 0.1.0
      status: primary
      vcs: embedded
      vcs_ref: ""
      supersedes: []
    contract_managed_by: metasystem
    `);
}

export function adrTemplate(): string {
  return dedent(`
    ---
    adr: ADR-0000-example
    title: "Example decision"
    status: proposed
    date: YYYY-MM-DD
    supersedes: []
    superseded_by: null
    related_analysis: null
    related_iteration: null
    ---

    # Example decision

    ## Context

    ## Decision

    ## Consequences
    `);
}

export function changelog(): string {
  return dedent(`
    # Changelog

    All notable changes to this framework core should be documented here.

    ## [${CURRENT_VERSION}] - 2026-06-13

    ### Added

    - Versioned framework layout.
    - Manifest-based managed file tracking.
    - Four-zone core workflow: references, analyses, systems, iterations.
    `);
}

export function architectureDoc(project: string, core: string): string {
  return dedent(`
    # Architecture

    \`${project}\` is an external-system-learning framework.

    ## Core loop

    \`\`\`text
    references → analyses → systems/${core} → iterations → knowledge
    \`\`\`

    ## Boundaries

    - \`references/\`: external evidence, read-only by default.
    - \`analyses/\`: conversion from evidence to local decisions.
    - \`systems/\`: our active implementation.
    - \`iterations/\`: controlled changes to our implementation.
    - \`knowledge/\`: accepted reusable knowledge.
    - \`.framework/\`: runtime metadata, not content knowledge.
    `);
}

export function artifactModelDoc(): string {
  return dedent(`
    # Artifact Model

    | Artifact | Path | Exit |
    | --- | --- | --- |
    | Reference candidate | \`references/intake/\` | freeze / reject |
    | Frozen reference | \`references/frozen/YYYYMM/<name>/\` | analyze |
    | Reference analysis | \`analyses/references/\` | reject / pattern / ADR |
    | Gap analysis | \`analyses/gaps/\` | iteration / roadmap |
    | Candidate pattern | \`analyses/patterns/\` | iteration / reject |
    | Iteration | \`iterations/YYYY-MM-DD-<topic>/\` | adopt / reject / retest |
    | System change | \`systems/<core>/\` | release / rollback |
    | Knowledge entry | \`knowledge/\` | future reuse |
    `);
}

export function workflowsDoc(): string {
  return dedent(`
    # Workflows

    ## Reference intake

    1. Define the search theme and acceptance criteria.
    2. Capture candidate links and coverage notes in \`references/intake/\`.
    3. Freeze useful references under \`references/frozen/YYYYMM/\`.
    4. Write a reference analysis; do not stop at collecting source code.

    ## Analysis to pattern

    1. Identify the problem solved by the external system.
    2. Extract a mechanism, not just surface file names.
    3. Record applicability and anti-applicability.
    4. Choose an exit: reject, ADR, or iteration.

    ## Local iteration

    1. Start an iteration with a hypothesis and rollback plan.
    2. Change only our \`systems/\` implementation.
    3. Verify the result.
    4. Promote validated learning to \`knowledge/\` or changelog.
    `);
}

export function updateMechanismDoc(): string {
  return dedent(`
    # Update Mechanism

    ## State files

    - \`.framework/VERSION\`: installed framework version.
    - \`.framework/manifest.json\`: managed files, template IDs, hashes, and installed versions.
    - \`.framework/backups/\`: backups before writes.

    ## Classification

    | Classification | Meaning | Default |
    | --- | --- | --- |
    | new | desired template does not exist and is not user-deleted | create |
    | auto-update | manifest hash equals current hash | update |
    | modified | current hash differs from manifest hash | skip |
    | user-deleted | manifest tracked it but path is absent | respect deletion |
    | untracked-existing | path exists but not in manifest | skip / \`.new\` |

    ## Migration

    Layout migrations are explicit. Run dry-run first, then apply copy-first migrations only after review.
    `);
}

export function roadmapDoc(): string {
  return dedent(`
    # Roadmap

    ## P0 Bootstrap

    - [ ] Structure exists.
    - [ ] Manifest exists.
    - [ ] First reference frozen.
    - [ ] First analysis completed.

    ## P1 Internalization

    - [ ] At least one external pattern validated through an iteration.
    - [ ] Update mechanism tested on a dirty project.
    - [ ] CLI packaged and smoke-tested.

    ## P2 Governance

    - [ ] Release notes and changelog cadence.
    - [ ] Contribution guide.
    - [ ] Reference security/license checklist.
    `);
}

export function iterationsReadme(): string {
  return dedent(`
    # iterations/

    Iterations are controlled changes to our own framework. Each iteration should contain a hypothesis, scope, verification, result, and rollback plan.
    `);
}

export function iterationPlanTemplate(): string {
  return dedent(`
    # Iteration Plan

    - Topic:
    - Date:
    - Related analysis/pattern:

    ## Hypothesis

    ## Scope

    ## Steps

    ## Verification

    ## Rollback

    ## Result
    `);
}

export function bootstrapIterationPlan(today: string): string {
  return dedent(`
    # Bootstrap Framework Iteration

    - Date: ${today}
    - Status: open

    ## Hypothesis

    A versioned four-zone framework structure will reduce ambiguity and make updates safer than a notes-first layout.

    ## Verification

    - \`metasystem check --root .\` passes.
    - \`.framework/manifest.json\` exists.
    - First external reference receives an analysis card.
    `);
}

export function knowledgeReadme(): string {
  return dedent(`
    # knowledge/

    Store accepted reusable knowledge only. Work-in-progress analysis belongs in \`analyses/\`; experiments on our own system belong in \`iterations/\`.
    `);
}

export function dataReadme(): string {
  return "# data/\n\nResearch samples, evaluation datasets, and generated outputs.\n";
}

export function releasesReadme(): string {
  return "# releases/\n\nRelease notes, packages, and migration guides.\n";
}
