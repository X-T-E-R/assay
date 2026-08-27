# Commands

Every workspace command discovers `.assay/manifest.json` and accepts only the exact `0.13.0+s4+l8` workspace envelope. System commands additionally require systems registry schema 3 (`0.13.0+s4+l8+r3`).

## Orientation

```text
assay prime [--root <dir>] [--json]
assay explain <workspace|project|task|roadmap|spec|source|adoption|analysis|knowledge|system> [--json]
```

`prime` is the session-start read: what each native object is for, the rule most often broken for each, and the current workspace state (layout, zones, active Tasks, sources, primary system, counts). It works outside a workspace too, printing the object semantics and saying no workspace was found. `explain` answers why one object exists, when not to use it, and how it is usually misused; the flag list stays in `--help`.

Both read the same semantics registry that supplies the point-of-use hints on mutating commands, the correct-model sentences in high-misuse errors, and the object semantics in the `AGENTS.md` managed block, so those four channels cannot drift apart.

## Lifecycle

```text
assay init [target-dir] [--name <project>] [--template study|solve|explore|<file.yaml>] [--git] [--force] [--create-new] [--no-agents]
assay adopt --root <dir> [--name <project>] [--dry-run | --apply] [--analyze] [--no-agents]
assay attach --root <dir> [--name <project>] [--template <selection>] [--privacy private|private-git|tracked] [--no-agents]
assay convert --root <overlay> --to standalone --target <dir> [--copy | --move] [--no-keep-overlay]
assay status [--root <dir>] [--json] [--fetch]
assay check [--root <dir>] [--advisories]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --skip-all | --create-new]
```

`init` and `attach` resolve a Template exactly once. Later commands use custom `layout.entries` plus native resolvers; they never reload or persist Template identity. `update` changes only fixed core assets recorded in `.assay/managed-files.json` plus an existing or explicitly requested Assay block in `AGENTS.md`. Default update preserves user edits, user deletions, and untracked files; `--force` still skips protected conflicts and user-deleted files. `--create-new` writes only the exact `<target>.new` path and refuses the whole update if any planned sidecar already exists. Ordinary update uses recoverable compare-and-swap writes, creates no retained backup, leaves existing `.assay/backups/` entries untouched, and does not recreate deleted Project guide files.

## Templates

```text
assay template list [--json]
assay template show <study|solve|explore|file.yaml> [--json]
```

Built-ins are exactly `study`, `solve`, and `explore`. Custom Templates require an explicit YAML path and closed schema 1. There is no project-local or user-global lookup.

## Explicit workspace index

```text
assay workspace track [root] [--rebind <old>] [--json]
assay workspace discover <roots...> [--json]
assay workspace list [--json]
assay workspace forget <path|hash|filename> [--json]
```

Only these commands write `~/.assay/workspaces` (override `ASSAY_WORKSPACES_ROOT`). `list` reports `current`, `missing`, `cutover_required`, or `invalid` without repairing or rewriting records. If it reports `cutover_required`, or another command emits an `assay-cutover:<observed>-><required>` locator, stop normal Assay mutation and follow [Major workspace cutovers](legacy-cutover.md).

## Native product objects

```text
assay task ...
assay roadmap ...
assay spec ...
assay system register|update|promote|archive|list|show ...
```

Task, Roadmap, Spec, and System authority remain independent. Systems registry schema 3 is canonical for Project-local System membership and selectors. `system update --path` only rebinds the locator. `system archive --apply` is a logical registry transition and never moves or deletes System bytes. A file named `system.yaml` is ordinary user content, not an Assay contract.

## Sources and adoptions

```text
assay source add|capture|import|sync|switch|status|log|diff ...
assay source adoption register|take|list|show|status|inspect|evidence|verify|decide|history|rollback|update ...
```

A source's shape follows what the material is, not a flag. A Git repository or
URL is checkout-backed, and `sync`/`switch` move it; a plain directory or archive
is copied in once, and `import` replaces that content. Either kind can be
captured at any time: `capture` preserves the current bytes with an integrity
hash, which is the only routine command that hashes a tree.

`sync` and `switch` record what they find rather than refusing it. A checkout
holding uncommitted work is observed with an `observed with local modifications`
advisory on the observation; an upstream that cannot fast-forward is recorded the
same way and left where it is. Git itself remains the thing that refuses to
overwrite uncommitted bytes.

Source adoption definitions and receipts use the `assay.source-adoption-*/v1`
schema family and lazy `.assay/source-adoptions/` storage. The command namespace
remains `assay source adoption ...`; there is no separate product object or
compatibility reader for earlier unpublished record names.

## Analysis and Knowledge

```text
assay analysis new|close ...
assay knowledge add ...
```

Mutation commands append their automatic structured events internally. There is no manual/freeform event command.

## External plugins

```text
assay plugin register|observe|list|disable|enable|remove|check ...
```

External Plugin descriptor schema 1 remains metadata-only. Assay records and verifies descriptors but does not install, activate, execute, or remove host payloads.
