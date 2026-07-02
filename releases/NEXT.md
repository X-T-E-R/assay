# Next Release Draft

This draft tracks user-visible changes that should be reviewed before the next
Assay release version is chosen.

## Living Sources

- `source sync` refreshes managed Git checkouts before observing them, including
  local Git sources and remote/origin-backed checkouts.
- Source observations can be reviewed through `analysis new --for-source
  <alias> [--observation <id>]`; closing the analysis marks the observation as
  reviewed.
- `assay status` includes a compact living-source summary so users can see open
  or revalidation-needed source work without first discovering `source status`.

## Analysis Lifecycle

- `analysis close` rejects empty analysis shells by default. Analyses must have
  real `## Key observations` content and the relevant decision section before
  they can close, unless `--allow-empty` is explicitly used.
