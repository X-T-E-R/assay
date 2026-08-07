# Native specifications

`assay spec` stores current normative constraints and acceptance contracts in the native Project. A Spec is not an ADR, approval, Project acceptance, Roadmap milestone, Task assignment, or System lifecycle signal.

## Storage and identity

Storage is lazy. The first successful Spec write creates the explanatory, non-index `project/specs/README.md` (standalone) or `.assay/project/specs/README.md` (overlay). Records use:

```text
project/specs/
  README.md
  spec-0001-<slug>/
    spec.yaml
    specification.md
  archive/
    spec-0002-<slug>/
      spec.yaml
      specification.md
```

Ids are allocated across live and archived storage as `spec-<sequence>-<optional-slug>`, with at least four digits. Duplicate titles are valid; title edits never rename an id. Unknown pre-existing content under `specs/` makes the first write fail closed so it can be inventoried explicitly.

`spec.yaml` is a closed schema-1 envelope: `id`, `title`, `state`, `scope`, `strength`, `revision`, timestamps, immutable creation provenance in `derived_from`, and replacement edges in `superseded_by`. It has no owner, approver, deadline, percentage, or arbitrary extension fields.

## Reader-owned body

`specification.md` is copied or edited as reader-owned UTF-8 prose. Lifecycle commands never rewrite it. Its headings are exactly, in order:

```markdown
## Purpose
## Scope
## Requirements
## Constraints
## Acceptance Criteria
## Non-Goals
```

`activate` requires non-empty Purpose, Scope, Requirements, and Acceptance Criteria sections. This is literal structure validation, not semantic review or approval.

## Creation and explicit promotion

```text
assay spec create --title <text> --scope project|system:<id> --strength required|recommended
assay spec promote --title <text> --scope project|system:<id> --strength required|recommended --body <file> (--from-analysis <analyses/...> | --from-task <task-id> --task-file prd.md|handoff.md|design.md|research/*.md)
```

Both commands create a draft. `create` starts an empty body template and has no provenance. `promote` copies only the independent `--body` file; it never extracts or copies the Analysis or Task into the body. It hashes the exact source bytes into one `derived_from` entry and does not close, edit, activate, or write a back-reference to the source. Later source absence or digest drift is an integrity issue reported by `spec validate` and `assay check`; it never changes Spec state. Direct Source-to-Spec promotion is intentionally unsupported: analyze the Source first.

## Lifecycle

```text
draft -> active -> retired
   \--------------^
```

- `update` changes only a draft's title, scope, or strength. It never changes `derived_from` or the body.
- `activate` is not acceptance or approval.
- `retire` works from draft or active. Retired is terminal.
- `replace <old> --with <active-successor...>` atomically retires only the old Spec and records its active successors. It never changes successor bytes. Self, duplicate, missing, inactive, and cyclic successors are rejected.
- `archive` moves only retired records to `archive/<id>` and is idempotent. A live/archive duplicate is a conflict.

Multiple active Specs may coexist. Assay does not infer conflicts, priority, or a current winner.

## Authority boundaries

Analysis and Task own their source content. Spec owns the promoted current normative contract. Task finish, Roadmap realize, System promote, and every Spec lifecycle command leave the other authorities unchanged. Phase 1 adds no `spec_refs` to Task, Roadmap, or System and does not alter ADR behavior.

`list` and `validate` preserve partial health: malformed records produce issues without hiding healthy siblings. Exact healthy `show` is independent of unrelated broken history. Storage and promotion reject traversal, redirects/reparse points, non-regular files, invalid UTF-8, oversized files, stale revisions, and external byte changes at publication boundaries.
