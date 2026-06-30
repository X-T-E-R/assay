import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { type Archetype, loadArchetype } from "./profile.js";

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
 * The archetype YAML declares which templates to write and at
 * what path; this function resolves each templateId to its content generator.
 * Mode overrides the archetype's default mode when supplied (e.g. `init --mode absorption`).
 *
 * To evolve the default structure, edit profiles/research.yaml — not this
 * function (see ADR-0005).
 */
export async function desiredTemplates(
  project: string,
  mode: "learning" | "absorption" = "learning",
  archetypeName = "research",
): Promise<TemplateFile[]> {
  const archetype = await loadArchetype(archetypeName);
  return archetypeTemplates(project, mode, archetype);
}

/**
 * Synchronous variant for tests/callers that already hold an Archetype. Resolves
 * template entries to content via the dispatcher.
 */
export function archetypeTemplates(
  project: string,
  mode: "learning" | "absorption",
  archetype: Archetype,
): TemplateFile[] {
  const result: TemplateFile[] = [];
  for (const entry of archetype.templates) {
    const content = templateContentById(entry.templateId, project, mode, archetype);
    if (content === null) continue; // unknown templateId: skip (archetype can reference future templates)
    result.push(templateFile({ path: entry.path, templateId: entry.templateId, content }));
  }
  return result;
}

export const profileTemplates = archetypeTemplates;

/**
 * Dispatcher: map a templateId to its content generator. Content functions
 * remain in TS because some templates interpolate project state. Adding a new
 * template means adding a case here AND an entry in the archetype YAML.
 */
function templateContentById(
  templateId: string,
  project: string,
  mode: "learning" | "absorption",
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
    // Contest profile v2 (ADR-0006)
    case "contest.manifest":
      return contestManifest(project);
    case "contest.selection":
      return contestSelection();
    case "contest.runs.jsonl":
      return contestRunsJsonl();
    case "contest.intake.readme":
      return contestIntakeReadme();
    case "contest.benchmarks.readme":
      return contestBenchmarksReadme();
    case "contest.submissions.readme":
      return contestSubmissionsReadme();
    case "contest.tools.readme":
      return contestToolsReadme();
    default:
      return null;
  }
}

export function rootReadme(project: string): string {
  return dedent(`
    # ${project}

    A versioned external-system-learning framework.

    Core loop:

    \`\`\`text
    source material → analyses or implementation → systems → knowledge
    \`\`\`

    | Path | Purpose |
    | --- | --- |
    | \`.framework/\` | Runtime metadata: version, manifest, events, migrations, backups |
    | \`references/\` | Frozen external snapshots when the archetype uses learning mode |
    | \`analyses/\` | Analysis layer when research output is first-class |
    | \`systems/\` | Registered active systems; use the systems registry for primary status |
    | \`iterations/\` | Optional implementation experiments when enabled by the archetype |
    | \`knowledge/\` | Accepted reusable knowledge |

    ## First workflow

    1. Register active systems with \`system register\`.
    2. Use the archetype-specific intake or reference outlet for source material.
    3. Promote durable learning to \`knowledge/\`.
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

    Current template release is ${CURRENT_VERSION}; layout release is ${LAYOUT_VERSION}.
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

    All notable changes to this framework should be documented here.

    ## [${CURRENT_VERSION}] - 2026-06-13

    ### Added

    - Versioned framework layout.
    - Manifest-based managed file tracking.
    - Four-zone core workflow: references, analyses, systems, iterations.
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
    | System change | registered \`systems/<name>/\` | release / rollback |
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

// ---------------------------------------------------------------------------
// Contest profile v2 templates (ADR-0006).
// These are scoped to the `contest` profile; the metasystem default profile
// does not reference them. Keep generators small and explicit — these files
// hold contest-specific manifest semantics (spec/env/selection pointers,
// runs.jsonl, intake/benchmarks/submissions READMEs).
// ---------------------------------------------------------------------------

export function contestManifest(project: string): string {
  return dedent(`
    {
      "kind": "contest",
      "schema_version": 1,
      "contest_id": "${slugifyForJson(project)}",
      "title": "${project}",
      "status": "template",
      "current_spec_id": null,
      "current_environment_ids": [],
      "current_selection_path": "systems/current.json",
      "artifact_store": {
        "type": "local-content-addressed",
        "root": "intake/objects/sha256"
      }
    }
  `);
}

/**
 * Q1+Q2 selection pointer (v2 ADR-0006). Deprecated in v3 — use
 * contestSelectionV3 instead once migration completes. The new form
 * uses a generic `questions: []` list where each entry carries an id,
 * route path,  and an optional sealed_tree_hash. This handles any
 * number of questions (not just 2).
 */
export function contestSelection(): string {
  // v2 backward-compatible fallback — delegates to the new schema.
  return contestSelectionV3();
}

/**
 * Selection pointer v3: generic `questions: []` list.
 *
 * Example usage:
 *   { "kind": "selection", "questions": [
 *       { "id": "q1", "base_path": "systems/wireless-solution-systems/question-1-ai-forecasting", "route": "v6-main-gap-floor" },
 *       { "id": "q2", "base_path": "systems/wireless-solution-systems/question-2-scheduler", "route": "v6-o3-52-main" }
 *   ]}
 *
 * `base_path` is the absolute question directory under the registered system,
 * `route` is the folder name under that base_path. The sealed tree hash
 * is null by default; it gets stamped when a submission is assembled.
 */
export function contestSelectionV3(): string {
  return dedent(`
    {
      "kind": "selection",
      "schema_version": "v3-1",
      "questions": [],
      "spec_id": null,
      "environment_id": null,
      "updated_at": null
    }
  `);
}

export function contestRunsJsonl(): string {
  // Append-only run ledger. Each line is one run record. Empty by default —
  // the file exists so absorb/check can detect the contest profile in use.
  // Recommended row schema (kept minimal on purpose; add fields as needed):
  //   {"ts": "...", "q": "q1|q2", "route": "...", "benchmark": "...", "spec": "...", "env": "...", "score": "...", "kind": "exploratory|formal"}
  return "";
}

export function contestIntakeReadme(): string {
  return dedent(`
    # intake/

    Raw external deliveries. Immutable layer (ADR-0006).

    Every delivery lives at \`intake/<delivery-id>/\` and contains:
    - the original artifact (ZIP, directory dump, etc.)
    - \`sha256.txt\` recording the raw bytes hash
    - \`source.md\` recording where it came from, when, and the prompt/context

    Once written, a delivery is **not modified**. Mistakes create a new
    delivery; the original stays as evidence of what was actually delivered.

    This is the only place where Web AI ZIP packages or third-party deliveries
    enter the project before any normalization. The normalized form (if any)
    lives under \`systems/qN/<route>/\` with a back-reference to the delivery.
  `);
}

export function contestBenchmarksReadme(): string {
  return dedent(`
    # benchmarks/

    Versioned test sets with explicit applicability scope.

    Each benchmark lives at \`benchmarks/<benchmark-id>/\` and should declare:
    - what it tests (public samples / random / stress / regression / hidden)
    - generator version and seed (if synthetic)
    - leakage risk and interpretive scope

    A run records its \`benchmark_id\` in \`runs.jsonl\`. Scores on a benchmark
    are scoped to that benchmark — they do not auto-generalize to others.
  `);
}

export function contestSubmissionsReadme(): string {
  return dedent(`
    # submissions/

    Immutable submission packages (ADR-0006).

    Each submission lives at \`submissions/<submission-id>/\` and contains:
    - \`package.zip\` — the final upload bytes
    - \`staging.sha256\` — file-tree hash of the staging directory the ZIP was built from
    - \`package.sha256\` — hash of the ZIP bytes themselves
    - \`manifest.md\` — references to the q1/q2 routes, spec, environment, and validation report

    A submission is **assembled from sealed routes** referenced by a snapshot
    of \`systems/current.json\`. Once sealed, the package is not edited; a new
    submission gets a new id.

    Double hashing matters: \`staging.sha256\` proves what content was packaged,
    \`package.sha256\` proves what bytes were uploaded. Compression-tool
    metadata differences (timestamps, file order) can change ZIP bytes without
    changing content; both hashes together close that gap.
  `);
}

export function contestToolsReadme(): string {
  return dedent(`
    # tools/

    Contest-specific tooling. Conventional sub-locations:

    - \`tools/judge/\` — local evaluator/judge (Dockerfile, runner, scoring config).
      The judge is the local replica of the contest's official scoring environment.
    - \`tools/pack/\` — submission packagers (assembles q1+q2 into the contest's
      required ZIP layout, stamps both staging-tree and ZIP-byte SHA-256).
    - \`tools/import/\` — importers for external deliveries (intake/<id>/ → a
      normalized form usable as a candidate route).
    - \`tools/handoff/\` — handoff helpers if any contest-specific glue is needed
      (general handoff lives under \`.framework/handoffs/\`).

    Tools that are not contest-specific belong elsewhere (handoff generators in
    \`.framework/handoffs/\`, generic build scripts under each route's source).
  `);
}

// Helper for contestManifest: produce a JSON-safe lowercase slug.
function slugifyForJson(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 64);
}
