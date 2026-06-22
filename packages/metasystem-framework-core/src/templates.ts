import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";

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

export function desiredTemplates(
  project: string,
  core: string,
  mode: "learning" | "absorption" = "learning",
): TemplateFile[] {
  return [
    templateFile({
      path: "README.md",
      templateId: "root.readme",
      content: rootReadme(project, core),
    }),
    templateFile({ path: ".gitignore", templateId: "root.gitignore", content: rootGitignore() }),
    templateFile({
      path: ".framework/README.md",
      templateId: "framework.readme",
      content: frameworkReadme(),
    }),
    templateFile({
      path: ".framework/VERSION",
      templateId: "framework.version",
      content: `${CURRENT_VERSION}\n`,
    }),
    templateFile({
      path: ".framework/config.yaml",
      templateId: "framework.config",
      content: configYaml(project, core, mode),
    }),
    templateFile({
      path: ".framework/migrations/README.md",
      templateId: "framework.migrations.readme",
      content: migrationsReadme(),
    }),
    templateFile({
      path: ".framework/events/.gitkeep",
      templateId: "framework.events.gitkeep",
      content: "",
    }),
    templateFile({
      path: ".framework/backups/.gitkeep",
      templateId: "framework.backups.gitkeep",
      content: "",
    }),
    templateFile({
      path: "references/README.md",
      templateId: "references.readme",
      content: referencesReadme(),
    }),
    templateFile({
      path: "references/intake/README.md",
      templateId: "references.intake.readme",
      content: referencesIntakeReadme(),
    }),
    templateFile({
      path: "references/frozen/README.md",
      templateId: "references.frozen.readme",
      content: referencesFrozenReadme(),
    }),
    templateFile({
      path: "analyses/README.md",
      templateId: "analyses.readme",
      content: analysesReadme(),
    }),
    templateFile({
      path: "analyses/references/.gitkeep",
      templateId: "analyses.references.gitkeep",
      content: "",
    }),
    templateFile({
      path: "analyses/gaps/.gitkeep",
      templateId: "analyses.gaps.gitkeep",
      content: "",
    }),
    templateFile({
      path: "analyses/patterns/.gitkeep",
      templateId: "analyses.patterns.gitkeep",
      content: "",
    }),
    templateFile({
      path: "analyses/templates/reference-analysis-card.md",
      templateId: "analysis.template.reference",
      content: referenceAnalysisTemplate(),
    }),
    templateFile({
      path: "analyses/templates/gap-analysis.md",
      templateId: "analysis.template.gap",
      content: gapAnalysisTemplate(),
    }),
    templateFile({
      path: "analyses/templates/pattern-card.md",
      templateId: "analysis.template.pattern",
      content: patternCardTemplate(),
    }),
    templateFile({
      path: "systems/README.md",
      templateId: "systems.readme",
      content: systemsReadme(),
    }),
    templateFile({
      path: `systems/${core}/system.yaml`,
      templateId: "system.core.contract",
      content: systemContract(project, core),
    }),
    templateFile({
      path: "iterations/README.md",
      templateId: "iterations.readme",
      content: iterationsReadme(),
    }),
    templateFile({
      path: "iterations/templates/iteration-plan.md",
      templateId: "iterations.template.plan",
      content: iterationPlanTemplate(),
    }),
    templateFile({
      path: "knowledge/README.md",
      templateId: "knowledge.readme",
      content: knowledgeReadme(),
    }),
    templateFile({
      path: "knowledge/decisions/README.md",
      templateId: "knowledge.decisions.readme",
      content: "# decisions/\n\nAccepted decisions and ADRs.\n",
    }),
    templateFile({
      path: "knowledge/decisions/ADR-TEMPLATE.md",
      templateId: "knowledge.decisions.adr_template",
      content: adrTemplate(),
    }),
    templateFile({
      path: "knowledge/guides/README.md",
      templateId: "knowledge.guides.readme",
      content: "# guides/\n\nReusable operational guides.\n",
    }),
    templateFile({
      path: "knowledge/patterns/README.md",
      templateId: "knowledge.patterns.readme",
      content: "# patterns/\n\nValidated reusable patterns only.\n",
    }),
    templateFile({
      path: "knowledge/troubleshooting/README.md",
      templateId: "knowledge.troubleshooting.readme",
      content: "# troubleshooting/\n\nReusable failure modes and fixes.\n",
    }),
    templateFile({ path: "data/README.md", templateId: "data.readme", content: dataReadme() }),
    templateFile({
      path: "releases/README.md",
      templateId: "releases.readme",
      content: releasesReadme(),
    }),
  ];
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
