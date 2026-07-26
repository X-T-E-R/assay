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

This matters most for `assay intent capture`, which exists to store text
verbatim. Chat transcripts, ticket exports, and meeting notes routinely contain
API keys, customer names, internal URLs, and other material that should not be
committed. Before capturing:

- remove credentials, tokens, and connection strings;
- remove personal data that the workspace has no reason to keep;
- keep the wording that carries the intent, not the whole transcript.

Captures are append-only by design: `intent capture` refuses to rewrite a
recorded file, and the file's own SHA-256 makes an after-the-fact edit visible.
That protects the record's integrity, not its contents — a secret captured by
mistake stays in the file and in the workspace's history until it is removed
deliberately. Treat a leaked capture the same way as any other committed
secret: rotate the credential, then remove the record.

Agents acting on a user's behalf should ask before capturing material the user
has not reviewed, rather than passing a whole conversation through.
