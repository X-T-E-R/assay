# Lifecycle commands

The common Assay evidence loop is `evidence in → structured checks → decisions → knowledge growth`. Analysis, Knowledge, native Task, and Roadmap each keep their own authority; no lifecycle command propagates state between them.

## Analyses

Start an analysis:

```bash
assay analysis new "Review STS card-eval system"
# creates: analyses/references/<date>-review-sts-card-eval-system.md  (Status: draft)
# event:   analysis.created
```

Close an analysis:

```bash
assay analysis close <path> --exit adopt|reject|experiment [--note "..."]
```

`analysis close` reads the workspace-relative path, records the selected decision exit, appends an optional closing note, and emits `analysis.closed`. It trusts the explicit `--exit`; it does not infer prose quality or create another product entity. Use `assay check --advisories` first when unfinished-draft reminders are useful.

## Native Tasks

Use `assay task create` for future bounded work that needs a durable identity across sessions or agents. A Task requires a complete Goal and Acceptance Criteria in its reader-owned `prd.md`; lifecycle commands never derive a Task from Analysis metadata or any retired work record.

Task and Roadmap remain independent. Task status, context, relations, assignments, and completion do not update a Roadmap, and Roadmap changes do not update a Task. Use explicit `roadmap link-task` and `unlink-task` only for canonical Roadmap membership.

## Knowledge

Promote durable findings into reusable knowledge:

```bash
assay knowledge add <type> "Title" [--from-analysis <path>]
```

`knowledge add` creates `knowledge/<type>s/<date>-<slug>.md`, records an optional Analysis back-reference, emits `knowledge.added`, and refuses to overwrite an existing same-date/same-title entry. `assay status` reports the entry count separately from README stubs.

## Event vocabulary

| Event | Emitted by | Key fields |
| --- | --- | --- |
| `analysis.created` | `analysis new` | `path`, `title` |
| `analysis.closed` | `analysis close` | `path`, `exit`, `note` |
| `knowledge.added` | `knowledge add` | `path`, `type`, `title`, `from_analysis` |

These events flow into `.assay/events/<YYYY-MM>.jsonl` and are machine-readable for audits or dashboards.

## Anti-patterns

- Do not check Analysis decision-exit checkboxes by hand. Use `analysis close --exit ...`.
- Do not create `knowledge/<type>/<file>.md` by hand. Use `knowledge add` so the back-reference and event are recorded.
- Do not treat an Analysis exit, Task relation, Task finish, or Roadmap link as authority to change another entity's status.
