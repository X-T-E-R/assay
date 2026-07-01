# Release Checklist

Use this checklist before distributing Assay outside the local development repo.

## Package Metadata

- Decide whether the repository is still private. If publishing to a registry, remove or change `private: true` deliberately in the root and package manifests.
- Replace `0.0.0` package versions with the intended release version across the root package, `assay-core`, and `assay-cli`.
- Confirm `package.json` `files` entries include only runtime assets needed by consumers.
- Keep build output such as `dist/` out of source control unless the distribution channel explicitly requires committed artifacts.

## Release Notes

- Write or update release notes under `releases/` before tagging. Use
  `releases/NEXT.md` for unreleased changes, then copy reviewed entries into a
  versioned note when the release version is chosen.
- Include user-visible CLI changes, workspace layout or migration changes, and any compatibility notes.
- Call out data or workspace migrations separately from ordinary feature changes.

## Install Paths

- Validate the repo-root installer:

  ```bash
  node scripts/install.mjs --help
  node scripts/install.mjs --dry-run
  ```

- Validate the skill-local launcher after install:

  ```bash
  node skills/assay-builder/scripts/assay.mjs --help
  ```

- Confirm documentation distinguishes the repo-root installer (`scripts/install.mjs`) from skill-local runtime scripts (`skills/assay-builder/scripts/*.mjs`).

## Verification

- Run the full repository check:

  ```bash
  pnpm check
  ```

- Run the platform check script used by the release environment:

  ```bash
  ./scripts/check.sh
  # or on Windows PowerShell:
  .\scripts\check.ps1
  ```

- Validate the sanitized example workspace with `assay check --root examples/framework-template`.

## Skill Quality

- Run Skill-Creator audit and classify warnings before release:

  ```bash
  node <skill-creator>/scripts/skill-creator-cli/dist/cli.js audit skills/assay-builder --strict
  ```

- Do not treat audit as utility proof. Run forward tests with fresh-context agents:
  - discoverability: a user asks to create or inspect an Assay workspace and the agent finds the right skill resources;
  - correctness: the agent completes the primary `init -> source add -> analysis -> check/status` path;
  - negative case: a generic note-taking or non-Assay scaffolding request does not trigger this skill.

## Publishing Gate

Release only after:

- package metadata matches the intended channel;
- release notes exist;
- install and launcher paths are verified;
- `pnpm check` passes;
- public docs contain no local absolute paths, private project names, or internal handoff instructions;
- skill audit findings are fixed or documented as intentional false positives with forward-test evidence.
