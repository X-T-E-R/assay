# Donor Adoption

Assay can remember how selected material from a living source became part of
one or more registered systems. The donor lifecycle connects source
observations, target artifacts, evidence, and decisions without taking control
of target code or its release process.

This is a decision workbench, not a universal compliance gate:

```text
declare a relationship
  -> inspect direct changes when useful
  -> attach evidence when useful or explicitly required
  -> accept, reject, or defer
  -> retain the exact snapshots and decision history
```

Target projects still own editing, tests, Git commits, releases, and restoration.
Assay records what was inspected and decided so later agents and maintainers do
not have to reconstruct the relationship from prose.

## Complete V1 Boundary

Donor Adoption v1 supports:

- one living source per adoption definition;
- one or more independently accepted target systems;
- source and target locators for code, prompts, schemas, workflows,
  documentation, UI assets, license files, and other artifacts;
- exact-file and directory-prefix locators;
- direct byte-change inspection on both sides;
- advisory or explicitly required evidence;
- accept, reject, defer, and externally performed rollback records;
- immutable definition revisions, inspections, evidence records, and decisions;
- compact global status and structural integrity checks.

It deliberately does not edit a target, run target commands, create commits,
merge changes, or restore revisions. Those are target-side operations, not
unfinished Assay lifecycle steps.

## One source path into one system path

Most adoptions are a single file or folder that landed in a single place. State
that in one command, without writing a definition file first:

```bash
assay donor take readseek:packages/pi-readseek/src/hashline.ts \
  --into pipi:packages/pipi-readseek/src/anchor.ts --mode adapt
```

`take` synthesizes the definition below and registers it, so the result is an
ordinary adoption: `donor show`, `donor inspect`, `donor decide`, and the
`Upstream` section of `assay status` all read it the same way.

- Both arguments are `<name>:<path>`. The name is everything before the **first**
  colon, and paths are relative to the source observation and to the registered
  system. A path that is absolute or drive-prefixed is refused by name rather
  than being split somewhere else.
- The source locator's shape is read off the observation: a path naming one
  recorded file becomes `exact`, a path with files beneath it becomes `prefix`.
- `--mode` records how the material was carried over (`adapt` or `copy`).
- The adoption id defaults to `<alias>-<system>-<source-path-slug>`; pass `--id`
  to choose your own. `--to <observation>` pins a source observation other than
  the latest.

Use `--file` for anything larger: several mappings, several target systems, or
required evidence.

## Definition

Register a complete JSON or YAML definition:

```yaml
schema: assay.donor-adoption/v1
id: readseek-pipi
title: ReadSeek capabilities adopted by Pipi

source:
  alias: readseek
  observation: 20260725-b0d10262b10d

targets:
  - id: pipi
    system: pipi

mappings:
  - id: anchor-verification
    kind: source-code
    mode: adapt
    source:
      path: packages/pi-readseek/src/hashline.ts
      match: exact
    target:
      target_id: pipi
      path: packages/pipi-readseek/src/anchor.ts
      match: exact
    evidence:
      - anchor-contract

  - id: prompt-contract
    kind: prompt
    mode: adapt
    source:
      path: packages/pi-readseek/prompts
      match: prefix
    target:
      target_id: pipi
      path: packages/pipi-readseek/prompts
      match: prefix
    evidence: []

evidence:
  - id: anchor-contract
    description: Focused target contract test
    policy: advisory
```

IDs and paths are normalized and validated. Paths must remain relative and
contained: absolute paths and `..` are rejected, and a target locator is
canonicalized before it is read, so one that reaches outside the registered
system through a symbolic link anywhere in its path is rejected as well. This
holds for a locator that does not exist yet, because the check applies to its
closest existing ancestor. A locator that is itself a symbolic link, or a
prefix locator containing one, is reported as unresolvable rather than
followed. Target IDs refer to systems already registered with
`assay system register`.

Registration requires source locators to exist in the declared source
observation. Target locators may still be absent, allowing the relationship to
be declared before target implementation begins.

Install a later immutable definition revision with:

```bash
assay donor update readseek-pipi --file donor.yaml
```

Changing the source lineage requires a new adoption ID. Prior definitions and
decisions are never rewritten.

## Per-Target Baselines

The unit of acceptance is one target inside one adoption. Each target keeps its
own accepted source observation and mapped-target fingerprint.

Accepting an update for target A does not advance target B. All active mappings
for one target are captured together so the baseline remains internally
consistent.

A target snapshot records:

- registered system name and path;
- mapped artifact paths, sizes, and SHA-256 values;
- an aggregate mapped-artifact fingerprint;
- Git commit and working-tree state when available.

A dirty Git working tree is reported as evidence, not treated as a universal
block. The mapped artifact fingerprint remains the portable baseline for Git,
non-Git, and in-progress targets alike.

## Inspection Facts

`assay donor inspect` captures an immutable inspection. `assay donor status`
computes the same facts without writing a record.

Each mapping reports source and target facts independently:

- source: `activation`, `no-direct-change`, `direct-change`, or `missing`;
- target: `activation`, `unchanged`, `drifted`, `missing`, or `unresolvable`;
- combined factual labels such as `both-changed`.

`no-direct-change` means only that the declared file or prefix has the same
bytes. It does not claim semantic compatibility. Likewise, `both-changed` does
not claim a merge conflict.

Exact locators select one regular file. Prefix locators select all regular
files at or below the prefix in stable path order. V1 does not accept symbol,
line-range, or AST locators because source observations currently retain
whole-file hashes.

## Evidence Policy

Evidence inputs use a small shape:

```yaml
schema: assay.donor-evidence-input/v1
check_id: anchor-contract
result: passed
producer:
  id: vitest
  version: "2"
summary: Anchor behavior matches the declared contract.
artifacts:
  - ref: artifacts/anchor-test.txt
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    redacted: false
```

Assay binds the input to the exact adoption definition, inspection, source
observation, target fingerprint, and target ID. An imported evidence record is
an operator or producer attestation; v1 does not claim cryptographic producer
identity.

Evidence policy is explicit:

- `advisory` is the default. Missing, failed, or inconclusive evidence remains
  visible but does not block a decision.
- `required` blocks `accept` until a matching passed record exists.

Reject and defer decisions are never blocked by missing evidence.

## Decisions Without Ceremony

Inspection and verification are useful tools, not mandatory steps.

```bash
# Capture an inspection for review or evidence attachment.
assay donor inspect readseek-pipi --target pipi

# Attach evidence to that inspection.
assay donor evidence add readseek-pipi <inspection-id> --file evidence.yaml

# Evaluate freshness and explicitly declared required policy.
assay donor verify readseek-pipi <inspection-id>

# Decide against an existing inspection.
assay donor decide readseek-pipi \
  --target pipi \
  --outcome accept \
  --inspection <inspection-id> \
  --reason "Reviewed upstream delta and target behavior"
```

For low-ceremony work, decide directly:

```bash
assay donor decide readseek-pipi --target pipi --outcome accept
assay donor decide readseek-pipi --target pipi --outcome reject --reason "Not applicable"
assay donor decide readseek-pipi --target pipi --outcome defer --reason "Review next cycle"
```

A direct decision captures a fresh inspection inside the decision operation.
Accept rechecks an existing inspection before advancing the baseline. It
refuses only when the selected subject changed, the target cannot be inspected
safely, persisted state is invalid, or an explicitly required policy is not
satisfied.

## Rollback Records

Assay does not restore target files. After a target project restores mapped
artifacts outside Assay, record the result:

```bash
assay donor rollback record readseek-pipi \
  --to-decision <prior-accepted-decision> \
  --reason "External rollback completed"
```

Assay compares the current mapped artifacts with the historical accepted
snapshot before recording the rollback. Earlier decisions and evidence remain
unchanged.

## Storage And Integrity

State is created lazily:

```text
.assay/donors/<adoption-id>/
  definitions/<digest>.json
  inspections/<inspection-id>.json
  evidence/<evidence-id>.json
  decisions/<decision-id>.json
  state.json
```

Definitions, inspections, evidence, and decisions are immutable,
content-addressed records. `state.json` is the small current pointer: active
definition, per-target baselines, committed decision IDs, and a generation
number. Mutations use an adoption-local lock and atomic file replacement, so an
interrupted command leaves either the previous state or a complete record.

Records are keyed by a digest of their content. Re-running the command that
produced one is therefore safe: the identical record is recognized and reused.
If an interrupted run left a record behind that `state.json` never came to
reference, re-running replaces it. A record that committed history does point at
is never rewritten.

`assay check` validates only donor persistence integrity. Ordinary upstream
changes, target drift, dirty targets, and advisory evidence gaps do not become
global workspace warnings. Each reported problem names the record file that
failed, and a record outside committed history is reported without invalidating
the rest of the adoption. `assay status` shows only compact adoption and
baseline counts. Use `assay donor status <adoption>` for live relationship
details.

A donor command that dies mid-operation can leave its adoption lock in place.
The next command reclaims a lock whose holder is gone, and reclaims one whose
holder cannot be confirmed — an interrupted acquisition, another host, a
pre-reboot process ID — once it is a minute old. A lock whose holder is
verifiably alive is respected until it is clearly beyond any real operation's
duration, so a concurrent command is never interrupted.

## Source Checkout Safety

Living-source refresh may reset or replace Assay's managed checkout. Before any
refresh or branch switch, Assay refuses to continue when the managed checkout
contains:

- modified or untracked Git files;
- an unrecorded local Git commit;
- directory-checkout bytes that differ from the latest observation.

This is a data-loss boundary, not an adoption policy. Preserve or remove the
local changes explicitly, then run the source command again.

## Command Reference

```text
assay donor register --file <definition.json|yaml> [--json]
assay donor update <adoption> --file <definition.json|yaml> [--json]
assay donor list [--json]
assay donor show <adoption> [--json]
assay donor status [adoption] [--target <id>] [--json]
assay donor inspect <adoption> --target <id> [--to <observation>] [--json]
assay donor evidence add <adoption> <inspection> --file <evidence.json|yaml> [--json]
assay donor verify <adoption> <inspection> [--json]
assay donor decide <adoption> --target <id> --outcome accept|reject|defer
  [--inspection <id>] [--to <observation>] [--reason <text>] [--json]
assay donor history <adoption> [--target <id>] [--json]
assay donor rollback record <adoption> --to-decision <id>
  [--reason <text>] [--json]
```
