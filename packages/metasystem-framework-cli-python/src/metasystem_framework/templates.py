from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from textwrap import dedent

from .constants import CURRENT_VERSION, LAYOUT_VERSION


@dataclass(frozen=True)
class TemplateFile:
    path: str
    template_id: str
    content: str
    executable: bool = False
    protected: bool = False


def desired_templates(project: str, core: str, month: str | None = None) -> list[TemplateFile]:
    # Keep desired templates deterministic. Time-based artifacts are created by explicit commands.
    month = month or "YYYYMM"
    files = [
        TemplateFile("README.md", "root.readme", root_readme(project, core)),
        TemplateFile(".gitignore", "root.gitignore", root_gitignore()),
        TemplateFile(".framework/README.md", "framework.readme", framework_readme()),
        TemplateFile(".framework/VERSION", "framework.version", CURRENT_VERSION + "\n"),
        TemplateFile(".framework/config.yaml", "framework.config", config_yaml(project, core)),
        TemplateFile(".framework/migrations/README.md", "framework.migrations.readme", migrations_readme()),
        TemplateFile(".framework/events/.gitkeep", "framework.events.gitkeep", ""),
        TemplateFile(".framework/backups/.gitkeep", "framework.backups.gitkeep", ""),
        TemplateFile("references/README.md", "references.readme", references_readme()),
        TemplateFile("references/intake/README.md", "references.intake.readme", references_intake_readme()),
        TemplateFile("references/frozen/README.md", "references.frozen.readme", references_frozen_readme()),
        TemplateFile("analyses/README.md", "analyses.readme", analyses_readme()),
        TemplateFile("analyses/references/.gitkeep", "analyses.references.gitkeep", ""),
        TemplateFile("analyses/gaps/.gitkeep", "analyses.gaps.gitkeep", ""),
        TemplateFile("analyses/patterns/.gitkeep", "analyses.patterns.gitkeep", ""),
        TemplateFile("analyses/templates/reference-analysis-card.md", "analysis.template.reference", reference_analysis_template()),
        TemplateFile("analyses/templates/gap-analysis.md", "analysis.template.gap", gap_analysis_template()),
        TemplateFile("analyses/templates/pattern-card.md", "analysis.template.pattern", pattern_card_template()),
        TemplateFile("systems/README.md", "systems.readme", systems_readme()),
        TemplateFile(f"systems/{core}/README.md", "system.core.readme", core_readme(core)),
        TemplateFile(f"systems/{core}/framework.yaml", "system.core.framework_yaml", core_framework_yaml(project, core)),
        TemplateFile(f"systems/{core}/CHANGELOG.md", "system.core.changelog", changelog()),
        TemplateFile(f"systems/{core}/docs/architecture.md", "system.core.architecture", architecture_doc(project, core)),
        TemplateFile(f"systems/{core}/docs/artifact-model.md", "system.core.artifact_model", artifact_model_doc()),
        TemplateFile(f"systems/{core}/docs/workflows.md", "system.core.workflows", workflows_doc()),
        TemplateFile(f"systems/{core}/docs/update-mechanism.md", "system.core.update_mechanism", update_mechanism_doc()),
        TemplateFile(f"systems/{core}/docs/roadmap.md", "system.core.roadmap", roadmap_doc()),
        TemplateFile("iterations/README.md", "iterations.readme", iterations_readme()),
        TemplateFile("iterations/templates/iteration-plan.md", "iterations.template.plan", iteration_plan_template()),
        TemplateFile("knowledge/README.md", "knowledge.readme", knowledge_readme()),
        TemplateFile("knowledge/decisions/README.md", "knowledge.decisions.readme", "# decisions/\n\nAccepted decisions and ADRs.\n"),
        TemplateFile("knowledge/guides/README.md", "knowledge.guides.readme", "# guides/\n\nReusable operational guides.\n"),
        TemplateFile("knowledge/patterns/README.md", "knowledge.patterns.readme", "# patterns/\n\nValidated reusable patterns only.\n"),
        TemplateFile("knowledge/troubleshooting/README.md", "knowledge.troubleshooting.readme", "# troubleshooting/\n\nReusable failure modes and fixes.\n"),
        TemplateFile("data/README.md", "data.readme", data_readme()),
        TemplateFile("releases/README.md", "releases.readme", releases_readme()),
    ]
    return files


def root_readme(project: str, core: str) -> str:
    return dedent(f"""
    # {project}

    A versioned external-system-learning framework.

    Core loop:

    ```text
    references → analyses → systems → iterations → knowledge
    ```

    | Path | Purpose |
    | --- | --- |
    | `.framework/` | Runtime metadata: version, manifest, events, migrations, backups |
    | `references/` | External systems and frozen snapshots |
    | `analyses/` | Analysis layer that turns external systems into decisions |
    | `systems/` | Our active framework implementation; `{core}/` is the current core |
    | `iterations/` | Iterations against our own framework |
    | `knowledge/` | Accepted reusable knowledge |
    | `data/` | Research samples and evaluation data |
    | `releases/` | Release notes and upgrade packages |

    ## First workflow

    1. Freeze one external project under `references/frozen/YYYYMM/<name>/`.
    2. Write a reference analysis in `analyses/references/`.
    3. Convert a promising mechanism to `analyses/patterns/`.
    4. Start an iteration in `iterations/YYYY-MM-DD-<topic>/`.
    5. Land the validated change in `systems/{core}/`.
    6. Promote durable learning to `knowledge/`.
    """)


def root_gitignore() -> str:
    return dedent("""
    .DS_Store
    Thumbs.db
    __pycache__/
    *.pyc
    .venv/
    .secrets/
    *.log
    .framework/backups/*
    !.framework/backups/.gitkeep
    """)


def framework_readme() -> str:
    return dedent(f"""
    # .framework/

    Framework runtime metadata. Do not store external research or long-lived user knowledge here.

    - `VERSION`: installed framework template version.
    - `manifest.json`: managed file hashes and template IDs.
    - `events/`: JSONL event ledger.
    - `migrations/`: migration notes and plans.
    - `backups/`: timestamped backups before update/migration.

    Current template version: {CURRENT_VERSION}; layout version: {LAYOUT_VERSION}.
    """)


def config_yaml(project: str, core: str) -> str:
    return dedent(f"""
    framework:
      name: {project}
      core: {core}
      version: {CURRENT_VERSION}
      layout_version: {LAYOUT_VERSION}

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
    """)


def migrations_readme() -> str:
    return "# migrations/\n\nHuman-readable migration plans and generated migration logs.\n"


def references_readme() -> str:
    return dedent("""
    # references/

    Store external systems here. References are inputs, not local implementations.

    - `intake/`: candidate lists and search coverage notes.
    - `frozen/YYYYMM/<name>/`: frozen snapshots, default read-only.
    """)


def references_intake_readme() -> str:
    return "# references/intake/\n\nCandidate references, search coverage, and intake decisions.\n"


def references_frozen_readme() -> str:
    return "# references/frozen/\n\nFrozen external systems by month. Treat these as read-only evidence.\n"


def month_reference_index(month: str) -> str:
    return f"# references/frozen/{month}\n\n| Name | Source | Commit/version | Freeze mode | Analysis |\n| --- | --- | --- | --- | --- |\n"


def analyses_readme() -> str:
    return dedent("""
    # analyses/

    Analysis is the conversion layer from external references to local decisions.

    | Subdir | Purpose |
    | --- | --- |
    | `references/` | Analysis cards for external systems |
    | `gaps/` | Gaps between an external system and our current framework |
    | `patterns/` | Candidate patterns that need validation |
    | `templates/` | Analysis templates |
    """)


def reference_analysis_template() -> str:
    return dedent("""
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
    """)


def gap_analysis_template() -> str:
    return dedent("""
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
    """)


def pattern_card_template() -> str:
    return dedent("""
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
    """)


def systems_readme() -> str:
    return "# systems/\n\nOur active framework/system implementations. Do not place external project snapshots here.\n"


def core_readme(core: str) -> str:
    return dedent(f"""
    # {core}

    This is our active framework core. External references inform this system only after analysis and iteration.

    ## Docs

    - `docs/architecture.md`
    - `docs/artifact-model.md`
    - `docs/workflows.md`
    - `docs/update-mechanism.md`
    - `docs/roadmap.md`
    """)


def core_framework_yaml(project: str, core: str) -> str:
    return dedent(f"""
    system:
      project: {project}
      name: {core}
      version: 0.1.0
      status: bootstrap

    modules:
      reference_intake: documented
      analysis: documented
      iteration_loop: documented
      update_mechanism: documented
    """)


def changelog() -> str:
    return dedent(f"""
    # Changelog

    All notable changes to this framework core should be documented here.

    ## [{CURRENT_VERSION}] - 2026-06-13

    ### Added

    - Versioned framework layout.
    - Manifest-based managed file tracking.
    - Four-zone core workflow: references, analyses, systems, iterations.
    """)


def architecture_doc(project: str, core: str) -> str:
    return dedent(f"""
    # Architecture

    `{project}` is an external-system-learning framework.

    ## Core loop

    ```text
    references → analyses → systems/{core} → iterations → knowledge
    ```

    ## Boundaries

    - `references/`: external evidence, read-only by default.
    - `analyses/`: conversion from evidence to local decisions.
    - `systems/`: our active implementation.
    - `iterations/`: controlled changes to our implementation.
    - `knowledge/`: accepted reusable knowledge.
    - `.framework/`: runtime metadata, not content knowledge.
    """)


def artifact_model_doc() -> str:
    return dedent("""
    # Artifact Model

    | Artifact | Path | Exit |
    | --- | --- | --- |
    | Reference candidate | `references/intake/` | freeze / reject |
    | Frozen reference | `references/frozen/YYYYMM/<name>/` | analyze |
    | Reference analysis | `analyses/references/` | reject / pattern / ADR |
    | Gap analysis | `analyses/gaps/` | iteration / roadmap |
    | Candidate pattern | `analyses/patterns/` | iteration / reject |
    | Iteration | `iterations/YYYY-MM-DD-<topic>/` | adopt / reject / retest |
    | System change | `systems/<core>/` | release / rollback |
    | Knowledge entry | `knowledge/` | future reuse |
    """)


def workflows_doc() -> str:
    return dedent("""
    # Workflows

    ## Reference intake

    1. Define the search theme and acceptance criteria.
    2. Capture candidate links and coverage notes in `references/intake/`.
    3. Freeze useful references under `references/frozen/YYYYMM/`.
    4. Write a reference analysis; do not stop at collecting source code.

    ## Analysis to pattern

    1. Identify the problem solved by the external system.
    2. Extract a mechanism, not just surface file names.
    3. Record applicability and anti-applicability.
    4. Choose an exit: reject, ADR, or iteration.

    ## Local iteration

    1. Start an iteration with a hypothesis and rollback plan.
    2. Change only our `systems/` implementation.
    3. Verify the result.
    4. Promote validated learning to `knowledge/` or changelog.
    """)


def update_mechanism_doc() -> str:
    return dedent("""
    # Update Mechanism

    ## State files

    - `.framework/VERSION`: installed framework version.
    - `.framework/manifest.json`: managed files, template IDs, hashes, and installed versions.
    - `.framework/backups/`: backups before writes.

    ## Classification

    | Classification | Meaning | Default |
    | --- | --- | --- |
    | new | desired template does not exist and is not user-deleted | create |
    | auto-update | manifest hash equals current hash | update |
    | modified | current hash differs from manifest hash | skip |
    | user-deleted | manifest tracked it but path is absent | respect deletion |
    | untracked-existing | path exists but not in manifest | skip / `.new` |

    ## Migration

    Layout migrations are explicit. Run dry-run first, then apply copy-first migrations only after review.
    """)


def roadmap_doc() -> str:
    return dedent("""
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
    """)


def iterations_readme() -> str:
    return dedent("""
    # iterations/

    Iterations are controlled changes to our own framework. Each iteration should contain a hypothesis, scope, verification, result, and rollback plan.
    """)


def iteration_plan_template() -> str:
    return dedent("""
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
    """)


def bootstrap_iteration_plan(today: str) -> str:
    return dedent(f"""
    # Bootstrap Framework Iteration

    - Date: {today}
    - Status: open

    ## Hypothesis

    A versioned four-zone framework structure will reduce ambiguity and make updates safer than a notes-first layout.

    ## Verification

    - `metasystem check --root .` passes.
    - `.framework/manifest.json` exists.
    - First external reference receives an analysis card.
    """)


def knowledge_readme() -> str:
    return dedent("""
    # knowledge/

    Store accepted reusable knowledge only. Work-in-progress analysis belongs in `analyses/`; experiments on our own system belong in `iterations/`.
    """)


def data_readme() -> str:
    return "# data/\n\nResearch samples, evaluation datasets, and generated outputs.\n"


def releases_readme() -> str:
    return "# releases/\n\nRelease notes, packages, and migration guides.\n"
