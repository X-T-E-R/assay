# Layout modes

Layout version 8 supports two exact modes. Assay's default is `standalone`; the
study half's default is `overlay`, and both are reachable from either tool.

- `standalone` (assay's `init` default): state is under the envelope directory;
  Project, Systems, Knowledge, Sources, Analyses, Tasks, and Template-expanded
  work areas live at the workspace root; privacy is `tracked`.
- `overlay` (`assay init --overlay`): all state and work areas live under the
  envelope directory; the product root stays the primary independent System,
  registered by the build half at init.

```bash
assay init                 # standalone, .assay/ envelope
assay init --overlay       # overlay, .assay/ envelope
absorb init                # overlay, .absorb/ envelope
```

## Physical envelope

The mode and the envelope name are separate choices. The manifest's `layout.paths`
spell the logical `.assay` prefix, and every path is projected onto whichever
physical directory the workspace actually has: `.absorb` when present, `.assay`
otherwise. That is why one workspace serves both halves without a migration
step, and why `absorb migrate-envelope` can rename `.assay` to `.absorb` without
rewriting a single record.

Converting between standalone and overlay is not part of 0.15. The 0.14 monolith
owned `assay convert`; a workspace that needs it stays on 0.14.
