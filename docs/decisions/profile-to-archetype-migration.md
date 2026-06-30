# Profile to archetype migration

MetaSystem Kit now models workspace shape with `project.archetype` and `project.mode` in `.framework/manifest.json`.

## New model

| Field | Values | Purpose |
| --- | --- | --- |
| `project.archetype` | `research`, `contest`, `library` | Selects the self-contained workspace shape. |
| `project.mode` | `learning`, `absorption` | Selects where `metasystem absorb` lands source material. |

Archetypes are peers, not derived profiles:

- `research`: shared core plus frozen references and four analysis lanes.
- `contest`: problem/intake/submissions/benchmarks/tools, with iteration enabled by default.
- `library`: shared core only; no default absorb outlets or optional capability modules.

## Compatibility

- `--profile metasystem` remains a deprecated CLI alias for `--archetype research`.
- `.framework/config.yaml` is no longer generated or read.
- `profile_version` is no longer part of runtime identity.
- Legacy `manifest.project.core` is optional and is only used by the v2→v3 layout migration. New workspaces do not write it.
- Active system identity belongs in `.framework/systems-registry.json`; the primary system is `registry.primary`.

## Migration checklist

1. Run `metasystem migrate-layout --root <workspace> --dry-run`.
2. Review any v2→v3 steps that create `.framework/systems-registry.json` or generate `systems/<name>/system.yaml`.
3. Apply with `metasystem migrate-layout --root <workspace> --apply` only after reviewing the plan.
4. Confirm `.framework/manifest.json` contains `project.archetype` and `project.mode`.
5. Remove any remaining workflow dependency on `.framework/config.yaml`.
6. Register or promote the current active system with `metasystem system register ... --primary` or `metasystem system promote ...`.
7. Run `metasystem check --root <workspace>`.

## Dogfood verification

Verified on 2026-06-30 with the built CLI (`packages/metasystem-framework-cli/dist/cli.js`) in a temporary workspace root.

| Archetype | Manifest mode | Command path | Check exit | Structural result |
| --- | --- | --- | --- | --- |
| `research` | `learning` | `init` → `absorb` → `check` | `0` | Absorbed source landed at `references/frozen/202606/dogfood-source`; no `problem/`, `intake/`, or `submissions/` directory was scaffolded. |
| `contest` | `absorption` | `init` → `absorb --as intake` → `check` | `0` | Absorbed source landed at `intake/dogfood-source`; `problem/`, `intake/`, `submissions/`, `benchmarks/`, and `tools/` were present. |
| `library` | `learning` | `init` → `check` | `0` | No `references/`, `analyses/`, `problem/`, `intake/`, or `iterations/` directory was scaffolded. |

