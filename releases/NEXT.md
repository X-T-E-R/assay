# Unreleased

Unreleased changes after Assay 0.13.0 are recorded below.

## Added

- None.

## Changed

- Ordinary `assay update` now uses recoverable compare-and-swap writes for managed files and the Assay AGENTS block, refuses occupied exact `.new` sidecars before mutation, reconciles stale managed receipts after crash recovery, and no longer recreates deleted Project guide files.

## Fixed

- None.

## Removed

- Ordinary `assay update` no longer creates or reports retained timestamp backups; existing `.assay/backups/` content is left untouched.
