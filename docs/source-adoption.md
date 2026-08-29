# Source Adoption

> **Not in 0.15.** The `source adoption` command group is not mounted by the
> thin layer; it stayed with the 0.14 monolith, preserved by the `v0.14.0` tag.
> This page describes the records those commands wrote. See
> [releases/NEXT.md](../releases/NEXT.md).

A Source adoption records that specific material from a Source ended up in a
specific place in a registered system. That is the whole job: months later, when
the upstream moves, the record is what says which of your files the change
reaches.

One record is one mapping:

```text
source alias + path in the source  ->  system + path in the system
```

Plus, optionally, a note saying why, and a tier-1 identity pin saying what the
source was at the time.

Assay never writes the target material. It does not edit a target, run target
commands, create commits, merge, or restore. Those belong to the target project,
and the record does not pretend to govern them.

## Recording a mapping

```bash
assay source adoption take readseek:packages/pi-readseek/src/hashline.ts \
  --into pipi:packages/pipi-readseek/src/anchor.ts \
  --mode adapt \
  --note "Took the anchor verification shape, not the IO layer."
```

Both locators are `<name>:<path>`. The name is everything before the **first**
colon; the path is relative to the source's readable content on the left, and to
the registered system on the right. A path that is absolute or drive-prefixed is
refused by name rather than being split somewhere unexpected.

Everything else is read off the workspace:

- **Match shape.** A source path naming one file is `exact`; a directory is
  `prefix`, meaning the directory and everything beneath it.
- **Observation.** The latest observation of that source, unless `--to
  <observation>` names another one.
- **Identity pin.** See below.
- **Record id.** `<alias>-<system>-<source-path-slug>`, or `--id` to choose one.
  Adopting the same source path into a second place in the same system collides,
  and the error says to pass `--id`.

`--mode adapt|copy` is yours to state, and defaults to `adapt`. Nothing branches
on it; it is there because reviewing an upstream change is a different job for
material copied verbatim than for material already reworked.

The target path does not have to exist yet. The mapping is recorded either way,
and `take` says which case it was — declaring where material will land is
legitimate, and a file that was later renamed does not make the record a lie.

A target path is refused if it leaves the registered system: `..`, an absolute
path, or a symbolic link anywhere along the way. The check applies to the closest
existing ancestor, so a path that does not exist yet cannot slip past it.

## Identity pins

A pin is the tier-1 evidence for what the source was when the material was
taken. It is optional, and `take` records the best one available for free:

- A **checkout-backed source** already has one: the commit, plus the origin it
  came from. The commit alone would not say which repository it is a commit of.
- **Copied content** has no commit to cite, so its identity is a
  `sha256-tree-v1` hash of the content. This is the one routine path that hashes
  a copied tree; everywhere else that cost is reserved for an explicit
  `assay source capture`.

A pin is a statement about the past. A later observation of the same source does
not rewrite it, and does not make the record stale.

## Several paths, several records

An intent that moved three paths is three records. There is no container above
them, because there is nothing shared for a container to hold:

```bash
assay source adoption take readseek:packages/pi-readseek/src/hashline.ts \
  --into pipi:packages/pipi-readseek/src/anchor.ts
assay source adoption take readseek:packages/pi-readseek/prompts \
  --into pipi:packages/pipi-readseek/prompts --mode copy
assay source adoption take readseek:README.md \
  --into docs:upstream/readseek.md --id readseek-docs-readme
```

Each one is independently listed, shown, and removed, and each one is separately
named when an upstream change reaches it.

## Reading the records back

```bash
assay source adoption list
assay source adoption show readseek-pipi-packages-pi-readseek-src-hashline-ts
```

`list` gives one line per mapping: id, both endpoints, mode, and whether it
carries a pin. `show` adds the observation, the pin, where the target resolves
right now, the note, and the record file.

Workspace-level `assay status` is where movement is reported. Its `Upstream`
section compares each checkout-backed source against its recorded observation
and then names the adoption records the changed paths reach — that is the
question the records exist to answer. A mapping is matched by its source
locator, so a `prefix` mapping is reached by a change to anything beneath it.

## Forgetting a mapping

```bash
assay source adoption remove readseek-docs-readme
```

This deletes the record and nothing else. The material in the target system is
the target project's, and Assay did not put it there.

## Storage and integrity

One record is one file:

```text
.assay/source-adoptions/<adoption-id>.json
```

Records use the `assay.source-adoption/v1` schema. Writes go through a temporary
file and a rename, so an interrupted command leaves either the previous content
or a complete record — there is no read-modify-write to serialize, and therefore
no per-record lock. A workspace conversion still fences adoption writes, so a
record cannot land in a tree that has already been moved.

`assay check` reports structure only: whether each record file parses and
validates, whether its filename still matches its id, and whether the system it
names is still registered. Upstream movement, a target that was renamed, and a
missing note are not check findings — the first is `assay status`'s answer, and
the others are not defects. Each finding names the record file that failed, so an
unreadable record does not implicate the ones beside it.

`assay status` counts adoptions, the distinct systems they reach, and how many
carry a pin.

## Source checkout safety

Refreshing a checkout-backed source never rewrites local work. `sync` fetches and
fast-forwards; `switch` moves the checkout. Neither resets or cleans, and neither
refuses because the checkout is dirty. What Assay does instead is record it: the
observation carries an `observed with local modifications` advisory when the
working tree is dirty, and a note that the upstream could not be fast-forwarded
when it could not. Git itself is what declines to overwrite uncommitted bytes,
and that is the data-loss boundary — Assay does not add a second one on top.

## Migrating a 0.13 workspace

0.13 modelled an adoption as a definition plus a target-keyed state, with
inspections, evidence records, decision chains, and rollback records accumulating
beside it. `assay update` collapses each of those into the records above: one
record per mapping, the last decision's outcome and reason kept as a sentence in
the note, and the workflow chain dropped. The update output names every record it
wrote and counts what it dropped.

The retired `.assay/source-adoptions/<adoption-id>/` directory is left on disk.
Nothing reads it any more; delete it once the migrated records look right.

## Command reference

```text
assay source adoption take <source-alias>:<path> --into <system>:<path>
  [--mode adapt|copy] [--note <text>] [--to <observation>] [--id <adoption-id>] [--json]
assay source adoption list [--json]
assay source adoption show <adoption> [--json]
assay source adoption remove <adoption> [--json]
```
