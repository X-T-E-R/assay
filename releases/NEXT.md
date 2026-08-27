# Unreleased

Unreleased changes after Assay 0.13.0 are recorded below. This set carries the
0.14.0 envelope bump, so it breaks record formats on purpose. `assay update`
migrates a 0.13.0 workspace in place; there are no compatibility shims behind it.

## Breaking

- The workspace envelope is now `0.14.0+s4+l8`. A `0.13.0+s4+l8` workspace is
  refused by every command except `assay update`, which migrates it and says what
  it rewrote. Anything older still requires the external cutover tool. The refusal
  for a migratable workspace now names `assay update` and carries an
  `assay-update:<observed>-><required>` locator instead of the cutover locator.
- `source add --mode living|frozen` and `source add --capture checkout|archive`
  are gone, along with the `living`, `frozen`, and `archive` concepts. A source's
  shape follows the material: a Git repository or URL is checkout-backed, and
  anything else is copied once into `content/`. Scripts passing either flag will
  fail on an unknown option.
- `source.yaml` replaces `mode` and `default_capture_mode` with a single
  `content_mode` of `checkout` or `copy`. Both retired fields are rejected on read.
- Source observations are now cheap append records: `{observation_id, observed_on,
  lineage_id, source_path, previous_observation, kind, change_class, note,
  advisories}` plus `vcs` for a Git source and `capture` for an observation that
  preserved bytes. The `fingerprint`, `manifest`, `capture_mode`, `materials_path`,
  `checkout_path`, and `capture_path` fields are gone, and a record still carrying
  them is rejected on read. No default path computes a `sha256-tree` any more.
- Per-observation manifests under `sources/<alias>/manifests/` are no longer
  written or read. A capture keeps its integrity manifest beside its bytes, at
  `captures/<id>/manifest.json`.
- `source sync` and `source switch` apply only to checkout-backed sources. Calling
  either on copied content is a teaching error that names `source import` and
  `source capture` instead.
- `sync` and `switch` no longer refuse a dirty checkout, an unrecorded local
  commit, or checkout bytes that differ from the last observation. They proceed and
  record an `observed with local modifications` advisory on the observation. Refresh
  is non-destructive: `git fetch` plus `merge --ff-only`, never `reset --hard` or
  `clean -fd`. An upstream that cannot fast-forward is recorded and left alone.
  Byte-loss protection is delegated to Git, which already declines to overwrite
  uncommitted work.
- `SourceObservationResolution` returns `contentMode`, `contentPath`, and
  `capturePath` in place of `manifestFile`, `materialsPath` as observation state,
  and `checkoutPath`.
- `SourceStatusEntry` returns `contentMode`, `latestAdvisories`, and `captures` in
  place of `mode` and `captureMode`. `assay status` counts sources as `checkouts`
  and `copies` rather than `living` and `frozen`.
- `assay source add` no longer prints a `Manifest:` line; it prints `Checkout:` or
  `Content:` depending on the content mode.
- The `frozen` source alias is no longer reserved, since there is no `sources/frozen`
  namespace to protect.
- The Source adoption command surface is `take`, `list`, `show`, `remove`. The
  `register`, `update`, `status`, `inspect`, `evidence add`, `verify`, `decide`,
  `history`, and `rollback record` subcommands are gone, along with the whole
  inspection, evidence, decision, and rollback workflow behind them: its storage,
  its schemas, the `SOURCE_ADOPTION_POLICY_BLOCKED`, `SOURCE_ADOPTION_STALE`, and
  `SOURCE_ADOPTION_BUSY` error codes, and its tests. A single-user workbench
  records decisions in `analysis close --exit` and in the adoption's note; the
  adoption record's job is traceability — where did this material land — not an
  approval pipeline.
- A Source adoption is now one mapping: source alias and path, target system and
  path, an optional note, an optional tier-1 identity pin, and `mode`. An intent
  that moved several paths is several records. The `assay.source-adoption/v1`
  schema replaces the `assay.source-adoption-definition/v1`,
  `-state/v1`, `-inspection/v1`, `-evidence/v1`, and `-decision/v1` family, and
  each record is a single file at `.assay/source-adoptions/<id>.json` rather than
  a per-adoption directory. `--mode adapt|copy` stays, as descriptive metadata for
  upstream-drift review.
- Per-adoption `.lock` files are gone. One record is one atomic file write, so
  there is nothing to serialize; adoption writes still pass through the workspace
  mutation gate that fences a conversion.
- `assay status` reports Source adoptions as `adoptions`, `systems`, and `pinned`
  in place of `targets`, `acceptedTargets`, and `draftTargets`. `FrameworkStatus`
  and `--json` output change with it.
- `assay check` reports Source adoption structure only: whether each record parses
  and validates, whether its filename still matches its id, and whether the system
  it names is still registered.

## Added

- `assay source capture <alias> [--note <text>]` preserves a source's current
  bytes at `captures/<id>/source` with a `sha256-tree-v1` integrity manifest. It
  works for either content mode and is the only routine command that hashes a tree.
- `assay source import <alias> <dir-or-archive> [--note <text>]` replaces a copied
  source's content. The bytes it is about to replace are captured first, so an
  import adds a record rather than destroying one.
- Evidence tiers are named in the semantics registry and the bundled skill: tier 0
  is the default record (alias, date, commit when there is one), tier 1 is identity
  (commit and origin, or a tree hash computed on demand for copied content), tier 2
  is an explicit capture. `analysis close --exit adopt|reject` suggests recording a
  tier-1 pin; it never requires one.
- `assay source adoption remove <adoption>` forgets a mapping. It deletes the
  record and nothing else; the material in the target system is the target
  project's and was never Assay's to write.
- `assay source adoption take` gained `--note <text>` for the rationale worth
  re-reading, and records a tier-1 identity pin without being asked: the commit
  and origin for a checkout-backed source, a `sha256-tree-v1` content hash for
  copied material. A target path that escapes the registered system through a
  symbolic link is refused, including one that does not exist yet.
- `assay update` gained a one-shot record migration from the previous version. It
  runs before the template analysis, reports every record it rewrote, and stamps the
  new version last so a failed step leaves the workspace re-runnable rather than
  stranded. `assay update --dry-run` on an unmigrated workspace lists what the
  migration would do without touching anything.

## Changed

- Source file listings are computed when something needs them rather than stored
  with every observation. A capture answers from its manifest; anything else is
  hashed at the moment an adoption or a decision asks for a content pin.
- `source diff` reads a checkout-backed source's changes straight from Git
  (`diff --name-status` between the recorded commits) and compares stored capture
  manifests for copied content.
- `assay check` verifies that each source has readable content and that every
  capture still has both its bytes and its manifest, instead of requiring a
  fingerprint and a per-observation manifest.
- `assay source log` shows each entry's kind, note, and advisories.
- The `Upstream` block in `assay status` offers `assay source sync <alias>` whenever
  the remote actually moved, including for a checkout that also holds local work.
  It used to withhold the command there because `sync` would have refused; now
  `sync` records the local modification and proceeds, so the command is the one
  action worth taking. The summary for local work says the next sync will record
  it instead of telling the reader to preserve or discard it first.
- Ordinary `assay update` now uses recoverable compare-and-swap writes for managed
  files and the Assay AGENTS block, refuses occupied exact `.new` sidecars before
  mutation, reconciles stale managed receipts after crash recovery, and no longer
  recreates deleted Project guide files.

## Migration notes

`assay update` on a 0.13.0 workspace rewrites source records as follows:

- A living checkout source becomes `content_mode: checkout`; its `checkout/` stays
  where it is.
- A frozen source, and a living source that used archive capture, becomes
  `content_mode: copy`. Its `content/` is filled from the newest capture on disk,
  or from the original source path when that is still present. If neither is
  available the directory is created empty and the migration says so on that line.
- An observation that preserved bytes becomes a `capture` entry, keeping its
  fingerprint as the capture's integrity value; its manifest is copied to
  `captures/<id>/manifest.json`.
- Any other observation becomes an `add` or `sync` append record. Its retired
  `sha256-tree` value is written into the note rather than dropped.
- `sources/<alias>/manifests/` is left on disk untouched. No command reads it any
  more; it is safe to delete once the migrated ledger looks right.

It rewrites Source adoption records as follows:

- Each mapping of each adoption becomes its own record. A single-mapping adoption
  keeps its old id; anything else is suffixed with the mapping id.
- The last committed decision for that mapping's target survives as a sentence in
  the note: `last 0.13.0 decision: <outcome> — <reason>`. The old title and the
  adoption and mapping it came from are named in the note as well.
- An accepted baseline's source identity becomes the record's tier-1 pin — the
  commit it accepted, or the tree hash when there was no commit. 0.13 never
  recorded which origin a commit came from, so that stays null rather than being
  guessed. A target that was never decided migrates without a pin, which is what
  it always was.
- Inspections, evidence records, decision chains, and rollback records are
  dropped. The migration line counts each kind it dropped.
- `.assay/source-adoptions/<adoption-id>/` is left on disk untouched. No command
  reads it any more; it is safe to delete once the migrated records look right.
- A mapping this step cannot rewrite into a valid record is reported by name and
  left in the old directory rather than written out half-understood.

## Fixed

- None.

## Removed

- Ordinary `assay update` no longer creates or reports retained timestamp backups;
  existing `.assay/backups/` content is left untouched.
