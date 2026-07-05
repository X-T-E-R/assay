# Assay layout modes

Assay fits the way your code already lives. It supports two layout modes, both built on a single Assay-owned state directory: `.assay/`.

## Two modes

| Mode | Root meaning | Work folders | Primary system | Default Git behavior |
| --- | --- | --- | --- | --- |
| `standalone` | The root is an Assay workbench. | `references/`, `analyses/`, `iterations/`, `knowledge/`, `systems/` at root; state in `.assay/`. | Registered under `systems/` or an external independent path. | Outer workbench Git is optional. |
| `overlay` | The root is an existing product repo. | All Assay-owned work folders live under `.assay/`. | `path: "."`, `vcs: "independent-git"`, contract in `.assay/systems/root.yaml`. | Product Git ignores `.assay/` by default. |

Do not call overlay "monorepo mode". `overlay` and `attach` describe what happens: Assay attaches private evidence and decisions to a repo whose root remains the system.

## Path map

The manifest carries a `layout` block so runtime code asks "where is `references` in this layout?" instead of hard-coding root-relative strings.

```json
{
  "layout": {
    "version": 4,
    "mode": "standalone",
    "state_root": ".assay",
    "work_root": ".",
    "privacy": "tracked",
    "paths": {
      "manifest": ".assay/manifest.json",
      "events": ".assay/events",
      "backups": ".assay/backups",
      "systems_registry": ".assay/systems-registry.json",
      "adrs_index": ".assay/adrs.json",
      "references": "references",
      "analyses": "analyses",
      "iterations": "iterations",
      "knowledge": "knowledge",
      "systems_contracts": "systems"
    }
  }
}
```

In overlay mode, `references`, `analyses`, `iterations`, `knowledge`, and `systems_contracts` all resolve under `.assay/`.

### Standalone

```text
assay-workbench/
  .assay/
    VERSION
    manifest.json
    systems-registry.json
    adrs.json
    events/
    backups/
    archetypes/
  references/
  analyses/
  iterations/
  knowledge/
  systems/
```

Standalone exists because the Assay workbench itself is the project. It is the right shape for cross-project research, evaluation, science, and solve-style work that should not live inside one product repo.

### Overlay

```text
product-repo/
  .git/
  src/
  package.json
  .assay/
    VERSION
    manifest.json
    systems-registry.json
    adrs.json
    events/
    backups/
    archetypes/
    systems/
      root.yaml
    references/
    analyses/
    iterations/
    knowledge/
```

Overlay exists because the repo root is already the system. Assay must not move product files, rewrite the root README, or create top-level `references/` or `analyses/` folders in a product repo unless explicitly asked.

## Git policy

### Standalone Git

The outer Git repository is optional. Use it when the team wants to review and share evidence, analyses, ADRs, observation summaries, and knowledge.

Recommended tracked content:

```text
.assay/manifest.json
.assay/VERSION
.assay/systems-registry.json
.assay/adrs.json
.assay/events/
references/**/source.yaml
references/**/history.md
references/**/materials/
references/**/observations/
analyses/
iterations/
knowledge/
```

Recommended ignored content:

```text
.assay/backups/*
references/*/checkout/
references/*/captures/
```

For independent systems, prefer sidecar contracts under `.assay/systems/<name>.yaml` or system-owned contracts inside the system repo. Do not rely on an outer repo ignoring `systems/<name>/` while trying to re-include `systems/<name>/system.yaml`; that pattern breaks once the parent directory is ignored or the child is an independent Git repository.

### Overlay Git

Overlay default is private:

1. `assay attach --private` creates `.assay/`.
2. It appends `/.assay/` to `.git/info/exclude`, not `.gitignore`.
3. It does not change root `README.md`, root `.gitignore`, or root `AGENTS.md` unless you opt in.
4. `assay check` verifies that `.assay/` is not tracked by the product repo when privacy is `private` or `private-git`.

If you want versioned Assay memory without product commits, initialize Git inside `.assay/`:

```bash
cd .assay
git init
git add manifest.json systems-registry.json adrs.json events analyses knowledge references
```

This makes Assay state independently versioned while the product repo still ignores `.assay/`.

A team may explicitly choose `privacy: tracked`, but that is never the default. It requires an explicit command because it changes product repo review noise and can leak local research material.

## Source ledger naming

Each living source stores its observation ledger flat under `references/<alias>/`:

```text
references/foo/
  source.yaml
  observations/
  manifests/
  captures/
  comparisons/
```

Older v3 workspaces nested these under `references/foo/.assay/`. Once the workspace state dir became `.assay/`, that nesting would produce `.assay/references/foo/.assay/observations/` in overlay, so layout v4 flattens the ledger. Readers support the legacy `references/foo/.assay/` path during migration.

## Overlay attach workflow

```bash
cd /path/to/product-repo
assay attach --name Product --archetype study --privacy private
```

Behavior:

1. Refuse if the current root is not inside a Git worktree.
2. Create `.assay/` with manifest, registries, events, backups, and archetype work folders.
3. Register the root system:

```json
{
  "name": "Product",
  "path": ".",
  "status": "primary",
  "vcs": "independent-git",
  "contract_file": ".assay/systems/root.yaml"
}
```

4. Add `/.assay/` to `.git/info/exclude` when privacy is `private` or `private-git`.
5. Do not write root managed templates by default. In overlay, root templates are opt-in.

## Overlay to standalone conversion

Preferred conversion is detach-copy, not in-place reshaping:

```bash
cd /path/to/product-repo
assay convert --to standalone --target ../product-assay
```

It should:

1. Create `../product-assay` as a standalone workspace.
2. Copy `.assay/references` to `../product-assay/references`.
3. Copy `.assay/analyses` to `../product-assay/analyses`.
4. Copy `.assay/iterations` to `../product-assay/iterations`.
5. Copy `.assay/knowledge` to `../product-assay/knowledge`.
6. Keep Assay state under `../product-assay/.assay`.
7. Register the original product repo as the primary independent system by relative path, such as `../product-repo`, with a sidecar contract under `../product-assay/.assay/systems/product.yaml`.
8. Leave the product repo and its `.git/` untouched.

In-place conversion is allowed only with an explicit destructive flag, because it would have to move product root files into `systems/<name>/` or otherwise change the meaning of the product Git repository.

## Validation loop

`assay check` validates the selected layout, not a fixed directory list.

For both modes:

- `.assay/manifest.json` exists and has `layout.mode`.
- The path map resolves all archetype folders.
- The systems registry has at most one primary system.
- Registered independent Git systems actually have Git metadata.
- Analyses, observations, ADRs, and iterations still close the loop.

For overlay privacy:

- If `privacy` is `private` or `private-git`, `git ls-files -- .assay` must be empty from the product repo root.
- `.git/info/exclude` should contain `/.assay/` unless a stronger ignore is already present.
- If `.assay/.git` exists, `assay check` may report the nested Assay Git dirty/clean state as advisory information.

For standalone Git hygiene:

- Warn when a `references/*/checkout/` directory is staged or tracked.
- Warn when an independent system stored under `systems/` is tracked by the outer workbench Git as source files rather than as a sidecar contract or explicit submodule.
