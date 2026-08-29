# Assay framework structure

Every current workspace has a fixed core plus one-shot Template output. The Template is selected only by `init` or `attach`, expanded to actual `layout.entries`, and never persisted or reloaded.

## Fixed core

- `.assay/manifest.json` — schema 4 framework/layout authority; only non-native Template output appears in `layout.entries`.
- `.assay/managed-files.json` — schema 1 core no-clobber receipt.
- `<work-root>/project/project.yaml` — schema 1 Project id/name authority.
- `<work-root>/project/README.md` and `roadmap/README.md`.
- Systems and Knowledge roots.

## Templates

```bash
assay init . --template study
assay init . --template ./custom.yaml
```

`template list` and `template show` are not in 0.15; `--template` on `init`
still selects and expands one.

Built-ins are study, solve, and explore. Custom descriptors use closed schema 1:

```yaml
__schema: 1
description: Purpose.
directories:
  - path: notes
    purpose: User-owned notes
files:
  - path: notes/README.md
    content: "# Notes\n"
```

A file declares exactly one of inline `content` or a descriptor-relative `file`; `executable` is optional. Core is always included. Template outputs do not enter the managed receipt.

## Runtime views

Status, check, AGENTS generation, placement advisories, and conversion combine `layout.entries` with fixed native resolvers. Deleting a custom descriptor after init has no runtime effect.

## Workspace index

The machine-global workspace index (`assay workspace ...` over
`~/.assay/workspaces`) is not in 0.15. No 0.15 command reads or writes it.
