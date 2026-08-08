# Assay layout modes

Assay fits the way your code already lives. It supports two layout modes, both built on a single Assay-owned state directory: `.assay/`.

## Two modes

| Mode | Root meaning | Work folders | Primary system | Default Git behavior |
| --- | --- | --- | --- | --- |
| `standalone` | The root is an Assay workbench. | `references/`, `analyses/`, `knowledge/`, `tasks/`, `systems/` at root; state in `.assay/`. | Registered under `systems/` or an external independent path. | Outer workbench Git is optional. |
| `overlay` | The root is an existing product repo. | All Assay-owned work folders live under `.assay/`. | `path: "."`, `vcs: "independent-git"`, contract in `.assay/systems/root.yaml`. | Product Git ignores `.assay/` by default. |

Do not call overlay "monorepo mode". `overlay` and `attach` describe what happens: Assay attaches private evidence and decisions to a repo whose root remains the system.

## Path map

The manifest carries a `layout` block so runtime code asks "where is `references` in this layout?" instead of hard-coding root-relative strings.

```json
{
  "layout": {
    "version": 6,
    "mode": "standalone",
    "state_root": ".assay",
    "work_root": ".",
    "privacy": "tracked",
    "paths": {
      "manifest": ".assay/manifest.json",
      "events": ".assay/events",
      "backups": ".assay/backups",
      "systems_registry": ".assay/systems-registry.json",
      "references": "references",
      "analyses": "analyses",
      "knowledge": "knowledge",
      "systems_contracts": "systems"
    }
  }
}
```

In overlay mode, `references`, `analyses`, `knowledge`, native
`tasks`, native `project`, and `systems_contracts` all resolve under
`.assay/`. Native Task storage follows `work_root` directly, so it does not need a
separate entry in `layout.paths`.

### Standalone

```text
assay-workbench/
  .assay/
    VERSION
    manifest.json
    task-contexts.json
    systems-registry.json
    events/
    backups/
    archetypes/
  references/
  analyses/
  knowledge/
  tasks/
  systems/
```

Standalone exists because the Assay workbench itself is the project. It is the right shape for cross-project study, exploration, and solve-style work that should not live inside one product repo.

### Overlay

```text
product-repo/
  .git/
  src/
  package.json
  .assay/
    VERSION
    manifest.json
    task-contexts.json
    systems-registry.json
    events/
    backups/
    archetypes/
    systems/
      root.yaml
    references/
    analyses/
    knowledge/
    tasks/
```

Overlay exists because the repo root is already the system. Assay must not move product files, rewrite the root README, or create top-level `references/` or `analyses/` folders in a product repo unless explicitly asked.

## Git policy

### Standalone Git


Recommended tracked content:

```text
.assay/manifest.json
.assay/VERSION
.assay/task-contexts.json
.assay/systems-registry.json
.assay/events/
references/**/source.yaml
references/**/history.md
references/**/materials/
references/**/observations/
analyses/
knowledge/
tasks/
systems/**/system.yaml
.assay/systems/*.yaml
```

Recommended ignored content:

```text
.assay/backups/*
references/*/checkout/
references/*/captures/
```

For independent systems that live under the workbench `systems/` tree, keep the contract at `systems/<name>/system.yaml` and avoid tracking the rest of that system's source tree in the outer workbench Git unless you intentionally treat it as embedded or a submodule. When the primary system lives outside the workbench root (for example after `assay convert --to standalone`), Assay keeps the sidecar contract under `.assay/systems/<name>.yaml`.

### Overlay Git

Overlay default is private:

1. `assay attach --privacy private` creates `.assay/`.
2. It appends `/.assay/` to `.git/info/exclude`, not `.gitignore`.
3. It does not change root `README.md`, root `.gitignore`, or root `AGENTS.md` unless you opt in.
4. `assay check` verifies that `.assay/` is not tracked by the product repo when privacy is `private` or `private-git`.

If you want versioned Assay memory without product commits, initialize Git inside `.assay/`:

```bash
cd .assay
git init
```

This makes Assay state independently versioned while the product repo still
ignores `.assay/`. After creating or binding the first native Task, also add
`tasks/` and `task-contexts.json`.

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
4. Copy `.assay/knowledge` to `../product-assay/knowledge`.
5. Copy `.assay/tasks` to `../product-assay/tasks` without merging or overwriting a non-empty target.
6. Copy `.assay/project` to `../product-assay/project` without changing bytes or merging a non-empty target.
7. Carry `.assay/task-contexts.json` with the rest of Assay state under `../product-assay/.assay`.
8. Register the original product repo as the primary independent system by relative path, such as `../product-repo`, with a sidecar contract under `../product-assay/.assay/systems/product.yaml`.
9. Leave the product repo and its `.git/` untouched.

In-place conversion is allowed only with an explicit destructive flag, because it would have to move product root files into `systems/<name>/` or otherwise change the meaning of the product Git repository.

`--no-keep-overlay` removes the source `.assay/` once its contents have been relocated, so it requires `--move`. With a copy, the overlay still holds the only copy of that state and the request is refused.

## Update in overlay mode

`assay update` resolves managed template paths through the layout path map. In overlay mode every managed template is written under `.assay/`, and the root files `attach` promises not to touch — `README.md`, `.gitignore`, `AGENTS.md` — are never created or overwritten, including with `--force`.

The native Project lives under `.assay/project/` for every overlay privacy mode and is hoisted to `project/` on conversion. The product root is never an implicit Project writer.

## Validation loop

`assay check` validates the selected layout, not a fixed directory list.

For both modes:

- `.assay/manifest.json` exists and has `layout.mode`.
- The path map resolves all archetype folders.
- The systems registry has at most one primary system.
- Registered independent Git systems actually have Git metadata.

For overlay privacy:

- If `privacy` is `private` or `private-git`, `git ls-files -- .assay` must be empty from the product repo root.
- `.git/info/exclude` should contain `/.assay/` unless a stronger ignore is already present.
- If `.assay/.git` exists, `assay check` may report the nested Assay Git dirty/clean state as advisory information.

For standalone Git hygiene:

- Warn when a `references/*/checkout/` directory is staged or tracked.
- Warn when an independent system stored under `systems/` is tracked by the outer workbench Git as source files rather than just `systems/<name>/system.yaml`, unless the repo intentionally treats that system as embedded or as a submodule.
