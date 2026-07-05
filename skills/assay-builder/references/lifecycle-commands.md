# Lifecycle commands

The common Assay evidence loop is `evidence in → structured checks → decisions → knowledge growth`. Study-style work often materializes that as `references → analyses → systems → iterations → knowledge`. Every close-capable step writes a structured event to the JSONL ledger so the workflow stays auditable.

## Why explicit close

In layout v2, iterations and analyses were created freely but never closed. `knowledge/` stayed empty across many real projects: the analysis cards held the decisions, but the framework had no way to surface "this work is open" or to flag work that should have been promoted into reusable knowledge. Layout v3 makes close explicit and `assay check` flags open iterations as warnings.

## Iterations

Start an iteration:

```bash
assay iteration start "Adopt config-driven design"
# creates: iterations/<date>-adopt-config-driven-design/plan.md  (Status: open)
# event:   iteration.started
```

The plan template includes `Status: open` and a `## Result` section. Edit the plan during the iteration; do not edit the `Status:` line by hand — let `iteration close` set it.

Close an iteration:

```bash
assay iteration close <selector> --result applied|rejected|retest [--note "..."]
```

What `close` does:

1. Resolves the selector — either the full path (`iterations/<date>-<slug>`), the directory name, or a unique name prefix.
2. Updates `plan.md`: replaces `Status: open` with `Status: closed`, fills the `## Result` block with `- <result> on <today>` and the optional note.
3. Writes an `iteration.closed` event with `path`, `result`, and `note`.

Choose the result carefully:

- `applied` — the change landed in the active system and is being kept.
- `rejected` — the hypothesis failed; the change was rolled back or never applied.
- `retest` — inconclusive; the iteration will be reopened or re-run later. Use sparingly; prefer creating a follow-up iteration.

## Analyses

Start an analysis:

```bash
assay analysis new "Review STS card-eval system"
# creates: analyses/references/<date>-review-sts-card-eval-system.md  (Status: draft)
# event:   analysis.created
```

The template now includes a Decision exit checkbox block (`- [ ] adopt`, `- [ ] reject`, `- [ ] experiment`, `- [ ] ADR`). Fill in the analysis body during work; let `analysis close` flip the checkbox and Status.

Close an analysis:

```bash
assay analysis close <path> --exit adopt|reject|experiment|adr [--note "..."]
```

What `close` does:

1. Reads the analysis at `<path>` (relative to the workspace root).
2. Replaces `- Status: draft` with `- Status: applied|rejected|experiment|adr` (mapping from `--exit`).
3. Replaces the matching unchecked checkbox with `[x]` (e.g. `- [x] adopt`).
4. Appends an optional `> Closed on <date>: <note>` line.
5. Writes an `analysis.closed` event with `path`, `exit`, and `note`.

The `adopt` exit signals "we are adopting the analyzed pattern as-is". The `adr` exit signals "this decision deserves a separate ADR entry under `knowledge/decisions/`" — follow up with `assay adr new --from-analysis <path>`.

## Knowledge

Promote durable findings into reusable knowledge:

```bash
assay knowledge add <type> "Title" \
  [--from-analysis <path>] \
  [--from-iteration <path>]
```

`<type>` is one of `decision`, `pattern`, `guide`, or `troubleshooting` (creates files under `knowledge/decisions/`, `knowledge/patterns/`, etc.).

What `add` does:

1. Generates `knowledge/<type>s/<date>-<slug>.md` with frontmatter (Type, Date, Status: accepted) and back-references to the originating analysis and/or iteration.
2. Writes a `knowledge.added` event with `path`, `type`, `title`, `from_analysis`, `from_iteration`.
3. Refuses to overwrite an existing entry with the same date/title.

`assay status` reports the knowledge entry count separately from README stubs, so promotions are visible in workspace summaries.

## Event vocabulary

The structured events emitted by these commands:

| Event | Emitted by | Key fields |
| --- | --- | --- |
| `iteration.started` | `iteration start` | `path`, `title` |
| `iteration.closed` | `iteration close` | `path`, `result`, `note` |
| `analysis.created` | `analysis new` | `path`, `title` |
| `analysis.closed` | `analysis close` | `path`, `exit`, `note` |
| `adr.created` | `adr new` | `id`, `path`, `status`, `title` |
| `adr.accepted` | `adr accept` | `id`, `path` |
| `adr.superseded` | `adr supersede` | `old_id`, `new_id` |
| `adr.deprecated` | `adr deprecate` | `id`, `path` |
| `knowledge.added` | `knowledge add` | `path`, `type`, `title`, `from_analysis`, `from_iteration` |

These events flow into `.assay/events/<YYYY-MM>.jsonl` and are intended to be machine-readable for future audits, dashboards, or migrations.

## Anti-patterns

- Do not hand-edit `Status: open` to `Status: closed` in `plan.md`. Use `iteration close` so the event ledger stays consistent.
- Do not check decision-exit checkboxes by hand. Use `analysis close --exit ...`.
- Do not hand-edit `.assay/adrs.json`. Use `adr new`, `adr accept`, `adr supersede`, and `adr deprecate` so the index, markdown frontmatter, and event ledger stay consistent.
- Do not create `knowledge/<type>/<file>.md` by hand. Use `knowledge add` so the back-references and event are recorded.
- Do not leave iterations open across long pauses. If you need to pause, close with `--result retest` and create a follow-up iteration when work resumes.
