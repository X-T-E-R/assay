# Task records

`assay task` keeps one bounded outcome identifiable across sessions, agents,
context compaction, and repeated implementation attempts. Create a Task when
the outcome needs a durable boundary. Keep using that Task while the outcome is
the same; a new attempt is not a new product object in v0.1.

A Task is not a permission token, an acceptance decision, or an agent job. It
is a file-based contract and continuation anchor that other tools can address
by a stable id. Tasks use `task-0001-<slug>`.

## Files in a Task

Standalone workspaces store Tasks under `tasks/`. Overlay workspaces store them
under `.assay/tasks/`.

```text
tasks/
  task-0001-<slug>/
    task.json        required machine envelope and compatibility metadata
    prd.md           required reader-editable Task contract
    handoff.md       optional replaceable continuation checkpoint
    design.md        optional Task-local design
    research/        optional Task-local research
  archive/
    <stable-id>/     explicitly archived terminal Tasks
```

`task.json` lets the CLI identify and validate the Task. Keep contract prose out
of it. Write the bounded goal, scope, task-level success checks, and references
to governing acceptance in `prd.md`; both people and models edit that file
directly. Project acceptance itself remains with the native Project.

`create` starts `prd.md` with this clean-room template, using the description as
the Goal when one was supplied and the title otherwise:

```markdown
# <title>

## Goal

<description or title>

## Acceptance Criteria

- [ ] The intended outcome is complete and backed by recorded verification evidence.
```

This is a starting Task contract, not project acceptance. Edit it directly when
the bounded scope or success checks need to become more precise.

`handoff.md` is optional. Add or replace it only at a real continuation
boundary, such as handing the Task to another agent or ending a session before
the outcome is complete. It describes completed outcomes, working state,
verification evidence, the next action, and open blockers or decisions. It is
not a diary and must not become a second PRD. The next useful checkpoint
replaces the previous one.

`checkpoint` reads the UTF-8 Markdown file passed to `--from` and preserves its
contents. The file must contain these headings in order:

```markdown
# Current State
## Completed Outcomes
## Working State
## Verification Evidence
## Next Action
## Open Blockers and Decisions
```

Use `design.md` and `research/` for material that belongs only to this Task.
Put project-wide facts, specifications, decisions, and reusable knowledge in
their project-owned locations instead.

When a current normative contract should outlive the Task, promote it explicitly
with `assay spec promote --from-task <id> --task-file <allowed-file> --body
<clean-specification>`. Promotion records exact provenance but does not edit,
finish, archive, or add a back-reference to the Task. Task lifecycle never
activates, retires, replaces, or archives a Spec; Phase 1 adds no `spec_refs` to
Task records.

## Create the durable boundary, not every attempt

Create a Task when all of these are true:

- the requested result is bounded enough to describe and verify;
- its identity must survive a session, agent, compaction, or attempt boundary;
- a stable id will help another reader or tool resume the same result.

Do not create another Task merely because implementation restarted, ownership
changed, or a checkpoint reported partial progress. Continue the existing Task
when the intended outcome is unchanged. Create a separate Task when the outcome
itself has become independently addressable, then record a relationship if the
lineage matters.

Titles are labels, not identifiers. Multiple active Tasks and duplicate titles
are valid. Use the full stable id returned by `create` in commands, links, and host
bindings.

The optional `name`, `creator`, `assignee`, and `priority` values are display or
compatibility metadata. They do not replace the stable id, choose a host owner, or
grant execution permission.

## Lifecycle

| Status | Meaning |
| --- | --- |
| `active` | The Task is open and may be worked on. |
| `paused` | The Task remains open but is not currently advancing. |
| `done` | The bounded outcome has been marked finished. |
| `cancelled` | The outcome will not be pursued as this Task. |
| `superseded` | Another Task has replaced this Task's outcome. |

`blocked` and `partial` are continuation facts, not lifecycle statuses. Record
them in `handoff.md` when they affect the next step. They do not automatically
finish or cancel the Task.

`finish` marks a Task `done`. It does not move the directory to `archive/`,
commit or push Git changes, accept the result for the project, realize a Roadmap item,
change a Relay activation, or complete related Tasks. Archive a terminal Task
with the separate `archive` command when moving it out of the live Task tree is
actually useful.

Once a Task reaches `done`, `cancelled`, or `superseded`, `status` does not
reopen it. If work continues after the bounded outcome was terminal, create a
new Task and record `continues` or `supersedes` when that lineage matters.

## Select current Task without guessing

Assay resolves a current Task in this order:

1. an explicit stable Task id supplied by the caller;
2. an exact binding for the caller's host context;
3. no current Task.

Bindings are stored in `.assay/task-contexts.json`. `bind` creates or changes an
exact context-to-Task mapping; `clear` removes it. `current` resolves the Task,
while `context` reads the selected binding and Task record. A caller must choose
the context key; Task does not inspect or own host sessions.

Assay never chooses a current Task from the number of active Tasks, the newest
Task, or a title match. This remains true when exactly one Task is active. The
rule makes parallel Tasks and repeated titles safe instead of turning storage
order into hidden control flow.

## Relationships do not propagate state

A Task can record these directed relationships to another stable Task id:

- `contributes_to` — this Task contributes to the target Task;
- `continues` — this Task continues the target Task's lineage;
- `supersedes` — this Task replaces the target Task.

Relationships preserve navigation and lineage only. They do not grant
authority, bind host context, assign an owner, dispatch an agent, copy status,
finish another Task, or accept its result. Update each Task and each host
binding explicitly. The `relations` command replaces the complete relation set;
use `--clear` when the intended set is empty. Self-relations, duplicate pairs,
missing targets, and directed cycles are rejected.

Roadmap membership is not a fourth Task relation and is never stored as a Task
back-reference. A native Roadmap item owns its canonical `task_refs`; use
`assay roadmap link-task` and `unlink-task` to change those links. One Task may
appear in several items, and neither Task nor Roadmap lifecycle state
propagates through the link.

## Command surface

```bash
assay task create --title <text> [--description <text>] [--name <display-slug>] [--creator <name>] [--assignee <name>] [--priority <priority>] [--relation <type:id...>] [--context <key>] [--root <dir>] [--json]
assay task show <id> [--root <dir>] [--json]
assay task list [--status active|paused|done|cancelled|superseded] [--archived live|archived|all] [--limit <n>] [--cursor <cursor>] [--root <dir>] [--json]
assay task status <id> <active|paused|done|cancelled|superseded> [--expected-revision <n>] [--root <dir>] [--json]
assay task checkpoint <id> --from <handoff.md> [--expected-revision <n>] [--root <dir>] [--json]
assay task finish <id> [--expected-revision <n>] [--root <dir>] [--json]
assay task archive <id> [--root <dir>] [--json]
assay task bind <id> --context <key> [--rebind] [--root <dir>] [--json]
assay task clear --context <key> [--root <dir>] [--json]
assay task current [--id <id>] [--context <key>] [--root <dir>] [--json]
assay task context [id] [--context <key>] [--root <dir>] [--json]
assay task relations <id> (--relation <type:id...> | --clear) [--expected-revision <n>] [--root <dir>] [--json]
assay task validate [id] [--root <dir>] [--json]
```

The command group provides:

| Command | Purpose |
| --- | --- |
| `create` | Create a Task from scalar command options and return its stable id. |
| `show` | Read one Task by stable id. |
| `list` | List Tasks, with explicit filters when needed. |
| `status` | Change a Task lifecycle status. |
| `checkpoint` | Replace `handoff.md` with Markdown read from `--from`. |
| `finish` | Mark a Task `done` without archiving or accepting it. |
| `archive` | Move a terminal Task to `tasks/archive/<id>/`. |
| `bind` / `clear` | Set or remove an exact host-context binding. |
| `current` / `context` | Resolve a selected Task or inspect its binding without guessing. |
| `relations` | Replace the Task's explicit typed relationships. |
| `validate` | Validate Task files, relationships, and context bindings without changing them. |

`list` has partial-health behavior. A damaged or duplicated storage entry does
not suppress valid siblings: valid rows still appear in their filtered,
paginated order. JSON output adds top-level `issues` with each `TASK_*` code,
path, and live/archive location; human output appends `Task storage issues:`.

The command exits with status 1 when issues are present even though it wrote
valid rows to stdout. Treat the rows as usable discovery results and the issues
as an integrity failure that still needs repair.

`create` does not accept a prose JSON payload. `checkpoint --from` reads the
Markdown checkpoint itself, not a JSON wrapper. Use
`assay task <command> --help` for the installed CLI's complete option list.
Repeat `--relation <type:id>` to set several relationships. Use
`--expected-revision <n>` on lifecycle, checkpoint, or relationship mutations
when a stale writer must fail rather than overwrite newer state.

## Authority stays with its owner

| Concern | Owner |
| --- | --- |
| Task contract and continuation identity | native Task files |
| Roadmap, project specifications, and acceptance | native Project |
| Agent DAG, dispatch, owner, and execution permissions | host runtime |
| Fork, activation, and promotion semantics | Relay |
| Durable product decisions and reusable learning | ADRs, analyses, and `knowledge/` |

Task files can cite or summarize the context needed to perform the Task, but
they do not take ownership from these systems. Creating, binding, relating, or
finishing a Task never expands the caller's permission or proves project
acceptance.

`assay.trellis` remains a legacy compatibility surface with state under
`.assay/trellis/`. Native Tasks do not delete, rewrite, import, or automatically
migrate that state. An existing workspace may keep using the legacy surface
while new durable Task identities use `assay task`.
