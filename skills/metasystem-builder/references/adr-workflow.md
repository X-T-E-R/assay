# ADR workflow

MetaSystem ADRs are numbered architecture decision records stored as markdown under `knowledge/decisions/` and indexed in `.framework/adrs.json`. Use ADRs for durable decisions that need status, replacement history, and validation. Use `knowledge add decision` only for reusable decision notes that do not need an ADR lifecycle.

## Files

- `.framework/adrs.json` — managed ADR index with `__schema: 1`, `next_number`, ADR status, supersede links, and markdown paths.
- `knowledge/decisions/ADR-NNNN-<slug>.md` — human-readable ADR body with required frontmatter.
- `knowledge/decisions/ADR-TEMPLATE.md` — authoring template for manual drafting.

Do not hand-edit `.framework/adrs.json`. Use the CLI so numbering, status changes, and event records stay consistent.

## Frontmatter

Every indexed ADR markdown file should include:

```yaml
---
adr: ADR-0001-example
title: "Example decision"
status: proposed
date: 2026-06-17
supersedes: []
superseded_by: null
related_analysis: null
related_iteration: null
---
```

`metasystem check` reports missing frontmatter fields as warnings. It reports broken supersede chains as errors.

## State machine

| Status | Meaning | Transitions |
| --- | --- | --- |
| `proposed` | Draft decision under review. | `adr accept` → `accepted`; `adr deprecate` → `deprecated` |
| `accepted` | Active accepted decision. | `adr supersede` → `superseded`; `adr deprecate` → `deprecated` |
| `superseded` | Replaced by another accepted ADR. | Terminal |
| `deprecated` | Closed without replacement. | Terminal |

`adr supersede <old> <new>` requires both ADRs to exist and the replacement ADR to already be `accepted`.

## Commands

Create a draft:

```bash
metasystem adr new "Use registry-backed ADRs" \
  [--from-analysis analyses/references/example.md] \
  [--from-iteration iterations/2026-06-17-example]
```

Accept a draft:

```bash
metasystem adr accept ADR-0001-use-registry-backed-adrs
```

Supersede an accepted ADR:

```bash
metasystem adr supersede ADR-0001-use-registry-backed-adrs ADR-0002-revised-registry-backed-adrs
```

Deprecate without replacement:

```bash
metasystem adr deprecate ADR-0001-use-registry-backed-adrs
```

Inspect:

```bash
metasystem adr list [--status accepted] [--json]
metasystem adr show ADR-0001 [--json]
```

Selectors can be the full ADR id, a unique id prefix, or the ADR number.

## Analysis exit

When an analysis closes with an ADR exit:

```bash
metasystem analysis close analyses/references/example.md --exit adr
metasystem adr new "Decision title" --from-analysis analyses/references/example.md
```

The close command records that the analysis needs an ADR. It does not create the ADR automatically.

## Validation

Run:

```bash
metasystem check
```

`check` reports errors for:

- `supersedes` entries that point to missing ADRs;
- `superseded_by` entries that point to missing ADRs;
- non-bidirectional supersede links;
- supersede cycles;
- indexed ADR markdown files missing on disk.

Warnings do not fail the check and are used for incomplete ADR frontmatter.
