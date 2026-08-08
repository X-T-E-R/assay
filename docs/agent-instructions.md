# Agent Instructions

Assay can maintain a small managed block in the workspace root `AGENTS.md`.
The block tells coding agents how to treat an Assay workspace without owning the
whole file.

- `assay init` and successful `assay adopt --apply` add or refresh the block by
  default.
- Add `--no-agents` to `init` or `adopt --apply` to skip the block.
- Ordinary `assay update` refreshes the block only when `AGENTS.md` already
  contains the Assay markers.
- `assay update --agents` creates `AGENTS.md`, appends the block to an existing
  file, or refreshes the existing block.
- If the markers are incomplete, Assay leaves `AGENTS.md` unchanged and reports
  the malformed block instead of guessing how to rewrite it.

Assay preserves all content outside:

```markdown
<!-- ASSAY:START -->
...
<!-- ASSAY:END -->
```

## What the block contains

Beyond the standing rules, the block carries a workspace layout section
generated from the installed archetype: its one-line description and a table of
every directory the archetype declares with what belongs in it. This is the
only channel that reaches a coding agent before it does anything, so directory
semantics live here rather than only in per-directory READMEs.

The table is generated, never hand-maintained. After an archetype's directories
or purposes change, run `assay update --agents` to regenerate it;
`assay check --advisories` reports a block that no longer matches the
archetype. A workspace with no readable manifest or archetype keeps the standing
rules and gets no table.

Do not add `AGENTS.md` to archetype templates or manifest managed-file tracking.
The block is intentionally marker-based so local repository instructions remain
owned by the workspace.

## What Assay does not filter

Assay stores what it is handed. It does not scan, redact, or classify content,
and no command inspects text for credentials or personal data. Deciding what is
safe to record belongs to whoever runs the command.

Chat transcripts, ticket exports, and meeting notes routinely contain API keys,
customer names, internal URLs, and other material that should not be committed.
Before copying source material into the workspace:

- remove credentials, tokens, and connection strings;
- remove personal data that the workspace has no reason to keep;
- keep only the wording the work needs, not the whole transcript.

The same rule applies to native Task documents. Keep `prd.md` focused on the
Task contract, and keep `handoff.md` to the current continuation state. Neither
file is a transcript dump or credential store.

Integrity checks do not make sensitive content safe. Treat a leaked value like
any other committed secret: rotate the credential, then remove the value from
the workspace and its history as required by the repository's policy.
