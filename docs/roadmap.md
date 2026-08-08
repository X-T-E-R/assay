# Roadmap items

`assay roadmap` records intended Project outcomes without turning Tasks into a
planning authority. Use a Roadmap item for a durable direction or outcome. Use
a Task for bounded work that contributes to it.

Roadmap and Spec are separate authorities. Roadmap records milestones and
ordering; Spec records current normative constraints and acceptance contracts.
Realizing or retiring a Roadmap item never changes a Spec, and Roadmap
envelopes have no Spec references.

## Files and identity

Standalone workspaces store items in `project/roadmap/`; overlays use
`.assay/project/roadmap/`.

```text
project/roadmap/
  README.md                         explanation only; never a generated index
  roadmap-0001-<slug>/
    item.yaml                       closed machine envelope
    outcome.md                      reader-editable outcome prose
  archive/
    roadmap-0002-<slug>/            explicitly archived terminal item
```

New ids use `roadmap-<sequence>-<slug>`, with at least four sequence digits.
The allocator scans live and archived items under one create lock, so archived
history still advances the sequence. A title can be renamed and duplicate
titles are valid; the id never changes. When a title has no safe ASCII slug,
the id ends after the sequence.

`outcome.md` starts with these headings:

```markdown
# User Problem
# Intended Outcome
# Success Signals
# Context And Constraints
# Realization Notes
```

Edit that prose directly. Roadmap lifecycle commands update only `item.yaml`.
Workspace checks, updates, status reads, and overlay conversion do not rewrite
the outcome file.

## State and horizon are separate

State answers how firmly the Project treats the outcome:

| State | Meaning |
| --- | --- |
| `candidate` | Worth considering, but not committed. |
| `committed` | The Project intends to achieve this outcome. |
| `realized` | The intended outcome has been realized. |
| `retired` | The item will no longer be pursued in this form. |

Horizon answers when the Project wants to consider it: `now`, `next`, `later`,
or `unscheduled`. Changing a horizon does not change state. `realized` and
`retired` are terminal and cannot reopen. `archive` moves only a terminal item
to `roadmap/archive/<id>/`; repeating archive is safe.

`superseded_by` is valid only on a retired item. Set the retired state and its
successor ids in the same `update` call when replacement lineage matters.

## Link Tasks without synchronizing lifecycle

`link-task` stores `{kind: assay.task, id: <task-id>}` in the Roadmap item's
`task_refs`. This is the only canonical Roadmap–Task link. It does not write a
Task back-reference or add another Task relation type.

Linking requires an exact native Task id from the same workspace. Live and
archived Tasks are both valid targets. One item may link several Tasks, and a
Task may be linked from several items. If a Task later disappears, the dangling
reference stays visible. `unlink-task` can remove it without requiring the Task
to exist.

Lifecycle remains independent in both directions:

- finishing, cancelling, superseding, or archiving Tasks does not realize or
  retire a Roadmap item;
- realizing, retiring, or archiving a Roadmap item does not update linked
  Tasks.

`show` and `list` project each linked Task's current title, status, archive
location, or unresolved state at read time.

## Keep the graph valid

`depends_on` and `superseded_by` contain exact Roadmap item ids. Self-links,
duplicates, missing targets, and directed cycles are rejected. Graph writes
share a global lock, so two concurrent updates cannot both introduce a cycle.
Relations do not propagate state.

Every item write uses a per-item lock, revision check, and atomic replacement.
Pass `--expected-revision` when a caller must reject a stale read. Assay also
rechecks the file identity and bytes before replacement, so an external edit
that bypassed the lock fails instead of being overwritten.

## Inspect partial health

`list` returns healthy rows and top-level issues together. It exits nonzero
when any malformed item, live/archive conflict, graph error, invalid UTF-8
file, or unresolved Task reference exists. `validate [id]` provides the same
integrity view without writing. `assay check` includes these results in the
workspace report.

Use full ids for `show`, `update`, links, and filters. Assay does not guess by
title, prefix, or suffix.
