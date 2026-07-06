import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { type Archetype, type ArchetypeLookupOptions, loadArchetype } from "./profile.js";

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
 * Generate the list of template files for a new workspace, driven by an archetype.
 * The archetype YAML declares which templates to write and at what path; this
 * function resolves each templateId to its content generator.
 * To evolve the default structure, edit profiles/study.yaml or add a custom
 * archetype YAML — not this function.
 */
export async function desiredTemplates(
  project: string,
  mode: "learning" | "absorption" = "learning",
  archetypeName = "study",
  options: ArchetypeLookupOptions = {},
): Promise<TemplateFile[]> {
  const archetype = await loadArchetype(archetypeName, options);
  return archetypeTemplates(project, mode, archetype);
}

export function archetypeTemplates(
  project: string,
  mode: "learning" | "absorption",
  archetype: Archetype,
): TemplateFile[] {
  const result: TemplateFile[] = [];
  for (const entry of archetype.templates) {
    const content = templateContentById(entry.templateId, project, mode, archetype);
    if (content === null) continue;
    result.push(templateFile({ path: entry.path, templateId: entry.templateId, content }));
  }
  return result;
}

function templateContentById(
  templateId: string,
  project: string,
  _mode: "learning" | "absorption",
  _archetype: Archetype,
): string | null {
  switch (templateId) {
    case "root.readme":
      return rootReadme(project);
    case "root.gitignore":
      return rootGitignore();
    case "framework.readme":
      return frameworkReadme();
    case "framework.version":
      return `${CURRENT_VERSION}\n`;
    case "framework.migrations.readme":
      return migrationsReadme();
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
    case "iterations.readme":
      return iterationsReadme();
    case "iterations.template.plan":
      return iterationPlanTemplate();
    case "knowledge.readme":
      return knowledgeReadme();
    case "knowledge.decisions.readme":
      return knowledgeDecisionsReadme();
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
    case "solve.objective":
      return solveObjective(project);
    case "solve.current_attempt":
      return solveCurrentAttempt();
    case "solve.runs.jsonl":
      return solveRunsJsonl();
    case "solve.intake.readme":
      return solveIntakeReadme();
    case "solve.benchmarks.readme":
      return solveBenchmarksReadme();
    case "solve.attempts.readme":
      return solveAttemptsReadme();
    case "solve.tools.readme":
      return solveToolsReadme();
    case "science.hypotheses.readme":
      return scienceHypothesesReadme();
    case "science.experiments.readme":
      return scienceExperimentsReadme();
    case "science.datasets.readme":
      return scienceDatasetsReadme();
    case "science.findings.readme":
      return scienceFindingsReadme();
    case "science.papers.readme":
      return sciencePapersReadme();
    case "evaluation.candidates.readme":
      return evaluationCandidatesReadme();
    case "evaluation.criteria":
      return evaluationCriteria();
    case "evaluation.scorecards.readme":
      return evaluationScorecardsReadme();
    case "explore.approaches.readme":
      return exploreApproachesReadme();
    case "explore.trials.readme":
      return exploreTrialsReadme();
    case "explore.comparison":
      return exploreComparison();
    default:
      return null;
  }
}

export function rootReadme(project: string): string {
  return dedent(`
    # ${project}

    A versioned Assay workspace.

    Evidence loop:

    \`\`\`text
    evidence in -> structured checks -> decisions -> knowledge growth
    \`\`\`

    | Path | Purpose |
    | --- | --- |
    | \`.assay/\` | Runtime metadata: version, manifest, events, migrations, backups |
    | \`systems/\` | Registered active systems and local implementations |
    | \`knowledge/\` | Accepted reusable knowledge |

    Archetype-specific working directories sit alongside this base. Use \`assay status\` to inspect open work and \`assay check\` to validate the workspace.
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
    .assay/backups/*
    !.assay/backups/.gitkeep
    `);
}

export function frameworkReadme(): string {
  return dedent(`
    # .assay/

    Assay runtime metadata. Do not store external evidence or long-lived user knowledge here.

    - \`VERSION\`: installed template version.
    - \`manifest.json\`: managed file hashes and template IDs.
    - \`systems-registry.json\`: registered systems and the current primary system after \`assay system register\`.
    - \`adrs.json\`: ADR numbering and status index when the archetype enables ADRs.
    - \`events/\`: JSONL event ledger.
    - \`migrations/\`: migration notes and plans.
    - \`backups/\`: timestamped backups before update or migration.

    Current template release is ${CURRENT_VERSION}; layout release is ${LAYOUT_VERSION}.
    `);
}

export function migrationsReadme(): string {
  return "# migrations/\n\nHuman-readable migration plans and generated migration logs.\n";
}

export function referencesReadme(): string {
  return dedent(`
    # references/

    Store external systems here. References are evidence inputs, not local implementations.

    - \`<source>/\`: living source card with \`source.yaml\`, current \`checkout/\`, bounded \`materials/\`, \`history.md\`, and the observation ledger (\`observations/\`, \`manifests/\`, \`comparisons/\`, \`captures/\`).
    - \`frozen/YYYYMM/<name>/\`: legacy or explicit full-capture snapshots, default read-only.
    `);
}

export function referencesIntakeReadme(): string {
  return "# references/intake/\n\nCandidate references, search coverage, and intake decisions.\n";
}

export function referencesFrozenReadme(): string {
  return "# references/frozen/\n\nLegacy and explicit full-capture external systems by month. Prefer `assay source add` for living sources that should be synced over time.\n";
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
    | \`gaps/\` | Gaps between an external system and the current workspace |
    | \`patterns/\` | Candidate reusable patterns that need validation |
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
  return "# systems/\n\nYour active system implementations and registered system metadata. Assay manages each system's registry contract; system source and docs belong to the system itself.\n";
}

export function knowledgeReadme(): string {
  return "# knowledge/\n\nStore accepted reusable knowledge only. Work-in-progress analysis belongs in the archetype-specific working directories.\n";
}

export function knowledgeDecisionsReadme(): string {
  return "# decisions/\n\nAccepted decisions and ADRs.\n";
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

export function iterationsReadme(): string {
  return "# iterations/\n\nIterations are controlled changes to your own systems. Each iteration should contain a hypothesis, scope, verification, result, and rollback plan.\n";
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

    A versioned Assay structure will reduce ambiguity and make updates safer than a notes-first layout.

    ## Verification

    - \`assay check --root .\` passes.
    - \`.assay/manifest.json\` exists.
    `);
}

export function changelog(): string {
  return dedent(`
    # Changelog

    All notable changes to this framework should be documented here.

    ## [${CURRENT_VERSION}] - 2026-06-13

    ### Added

    - Versioned framework layout.
    - Manifest-based managed file tracking.
    `);
}

export function artifactModelDoc(): string {
  return dedent(`
    # Artifact Model

    | Artifact | Path | Exit |
    | --- | --- | --- |
    | Living source | \`references/<source>/\` | sync / delta analysis / revalidation |
    | Frozen reference | \`references/frozen/YYYYMM/<name>/\` | legacy/full-capture analysis |
    | Analysis | \`analyses/\` | reject / pattern / ADR |
    | Iteration | \`iterations/YYYY-MM-DD-<topic>/\` | adopt / reject / retest |
    | Knowledge entry | \`knowledge/\` | future reuse |
    `);
}

export function workflowsDoc(): string {
  return dedent(`
    # Workflows

    ## Source intake

    1. Define the theme and acceptance criteria.
    2. Add living sources with \`assay source add <repo-or-dir> [alias]\`.
    3. Use \`assay source sync\` when the external source changes.
    4. Write an analysis or start an iteration; do not stop at collecting files.

    ## Analysis to pattern

    1. Identify the problem solved by the external system.
    2. Extract a mechanism, not just surface file names.
    3. Record applicability and anti-applicability.
    4. Choose an exit: reject, ADR, or iteration.
    `);
}

export function updateMechanismDoc(): string {
  return dedent(`
    # Update Mechanism

    ## State files

    - \`.assay/VERSION\`: installed Assay version.
    - \`.assay/manifest.json\`: managed files, template IDs, hashes, and installed versions.
    - \`.assay/backups/\`: backups before writes.

    ## Classification

    | Classification | Meaning | Default |
    | --- | --- | --- |
    | new | desired template does not exist and is not user-deleted | create |
    | auto-update | manifest hash equals current hash | update |
    | modified | current hash differs from manifest hash | skip |
    | user-deleted | manifest tracked it but path is absent | respect deletion |
    | untracked-existing | path exists but not in manifest | skip / \`.new\` |
    `);
}

export function roadmapDoc(): string {
  return dedent(`
    # Roadmap

    ## P0 Bootstrap

    - [ ] Structure exists.
    - [ ] Manifest exists.
    - [ ] First evidence input captured.

    ## P1 Internalization

    - [ ] At least one external pattern validated through an iteration.
    - [ ] Update mechanism tested on a dirty project.
    - [ ] CLI packaged and smoke-tested.
    `);
}

export function dataReadme(): string {
  return "# data/\n\nResearch samples, evaluation datasets, and generated outputs.\n";
}

export function releasesReadme(): string {
  return "# releases/\n\nRelease notes, packages, and migration guides.\n";
}

export function solveObjective(project: string): string {
  return dedent(`
    {
      "kind": "objective",
      "schema_version": 1,
      "objective_id": "${slugifyForJson(project)}",
      "title": "${project}",
      "status": "template",
      "success_criteria": [],
      "current_attempt_path": "systems/current.json",
      "artifact_store": {
        "type": "local-content-addressed",
        "root": "intake/objects/sha256"
      }
    }
  `);
}

export function solveCurrentAttempt(): string {
  return dedent(`
    {
      "kind": "current_attempt",
      "schema_version": 1,
      "attempts": [],
      "objective_id": null,
      "benchmark_id": null,
      "updated_at": null
    }
  `);
}

export function solveRunsJsonl(): string {
  return "";
}

export function solveIntakeReadme(): string {
  return dedent(`
    # intake/

    Raw objective inputs and external evidence. Immutable layer.

    Every delivery lives at \`intake/<delivery-id>/\` and records the original artifact, a hash, and source context. Once written, a delivery is not modified; mistakes create a new delivery.

    This is the evidence boundary before normalization. The normalized form lives under the relevant system with a back-reference to the delivery.
  `);
}

export function solveBenchmarksReadme(): string {
  return dedent(`
    # benchmarks/

    Versioned checks with explicit applicability scope.

    Each benchmark should declare what it tests, how it was generated, leakage risk, and interpretive scope. Scores are scoped to the benchmark that produced them.
  `);
}

export function solveAttemptsReadme(): string {
  return dedent(`
    # attempts/

    Immutable attempt packages.

    Each attempt lives at \`attempts/<attempt-id>/\` and contains the preserved output, hashes, and a manifest referencing the objective, source inputs, benchmark, score, and validation report.

    An attempt is assembled from an explicit snapshot referenced by \`systems/current.json\`. Once recorded, it is not edited; a new attempt gets a new id.
  `);
}

export function solveToolsReadme(): string {
  return dedent(`
    # tools/

    Objective-specific tooling. Conventional sub-locations:

    - \`tools/evaluate/\` — local evaluator, runner, or scoring config. It should make benchmark scoring repeatable and inspectable.
    - \`tools/package/\` — attempt packagers that stamp both staging-tree and artifact/package SHA-256 values.
    - \`tools/import/\` — importers for external deliveries into a normalized form usable by a candidate approach.
    - \`tools/report/\` — objective-specific reporting helpers if benchmark output needs a repeatable publication format.

    Tools that are not objective-specific belong elsewhere, such as generic build scripts under the relevant system source.
  `);
}

export function scienceHypothesesReadme(): string {
  return dedent(`
    # hypotheses/

    Candidate claims before evidence is collected.

    Each hypothesis should name the claim, expected observation, falsification condition, and linked experiment plan.
  `);
}

export function scienceExperimentsReadme(): string {
  return dedent(`
    # experiments/

    Experiment plans and execution notes.

    Keep protocol, variables, environment, and result links together so evidence can be audited later.
  `);
}

export function scienceDatasetsReadme(): string {
  return dedent(`
    # datasets/

    Dataset cards, provenance, licenses, transformations, and quality notes.

    Preserve enough detail for another run to understand what evidence was used.
  `);
}

export function scienceFindingsReadme(): string {
  return dedent(`
    # findings/

    Evidence-backed findings.

    A finding should link to hypotheses, experiments, datasets, and limitations. Separate observed evidence from interpretation.
  `);
}

export function sciencePapersReadme(): string {
  return dedent(`
    # papers/

    Drafts, outlines, figures, and publication notes.

    Keep claims traceable to findings and evidence instead of prose-only memory.
  `);
}

export function evaluationCandidatesReadme(): string {
  return dedent(`
    # candidates/

    External candidates under review.

    Give each candidate a source, version, evaluation scope, and known constraints before scoring.
  `);
}

export function evaluationCriteria(): string {
  return dedent(`
    # Evaluation Criteria

    This file defines the decision matrix before scoring starts.

    | Criterion | Weight | Measurement | Notes |
    | --- | ---: | --- | --- |
    | Fit | 1 | | |
    | Risk | 1 | | |
    | Operability | 1 | | |

    ## Final selection

    Record the final selection only after scorecards are complete and an ADR captures the decision.
  `);
}

export function evaluationScorecardsReadme(): string {
  return dedent(`
    # scorecards/

    Scorecards apply the decision matrix to each candidate.

    Keep raw observations, criterion scores, weighting notes, and final selection rationale separate so tradeoffs stay visible.
  `);
}

export function exploreApproachesReadme(): string {
  return dedent(`
    # approaches/

    Parallel local approaches.

    Give each approach a short premise, owner, expected upside, risk, and trial plan. Keep approaches comparable enough for converging later.
  `);
}

export function exploreTrialsReadme(): string {
  return dedent(`
    # trials/

    Trial notes for local approaches.

    Record setup, observed behavior, costs, surprises, and whether the approach should continue, merge, or stop.
  `);
}

export function exploreComparison(): string {
  return dedent(`
    # Approach Comparison

    Use this as the horse-race board for approaches that are still being shaped.

    | Approach | Evidence | Strength | Weakness | Next move |
    | --- | --- | --- | --- | --- |

    ## Convergence decision

    State what is converging, what remains uncertain, and which approach should become the next concrete direction.
  `);
}

function slugifyForJson(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 64);
}
