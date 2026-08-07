# Assay community Ponytail metadata adapter

This directory is an unpublished, independently packageable Assay adapter for
referencing the external
[`@dietrichgebert/ponytail`](https://www.npmjs.com/package/@dietrichgebert/ponytail)
artifact. It is maintained as Assay-side community metadata and is not part of,
sponsored by, or endorsed by the Ponytail project or Dietrich Gebert.

The adapter contains only a descriptor and this documentation. It has no
dependency on Ponytail, no executable entry point, hooks, install scripts, or
runtime code. It does not copy Ponytail prompts, skills, hooks, or source.

## Locked upstream reference

`assay-plugin.json` references the canonical npm artifact
`@dietrichgebert/ponytail@4.8.4` with its exact npm SRI. Its provenance is the
upstream `v4.8.4` tag at commit
`bc9ee949d5f439e8b9f3bb92c6d6d3d1e6ebd324`, under the upstream
[MIT license](https://github.com/DietrichGebert/ponytail/blob/v4.8.4/LICENSE).
The host identifiers cover the OpenCode plugin and Pi extension documented by
that release. Their versions are intentionally omitted because upstream does
not declare exact compatible host versions.

An upstream update is a reviewed descriptor change, not an automatic version
range update. Recheck the npm registry version, tarball contents, SRI, exports,
release tag and commit, and license before changing the lock.

## Assay control-plane flow

Run these commands with a built or installed Assay CLI and an existing Assay
workspace:

```sh
assay plugin register ./assay-plugin.json --root <workspace> --json
assay plugin list --root <workspace> --json
assay plugin check --root <workspace> --json
```

Registration verifies and locks this descriptor only. It does not fetch or
install the referenced npm package. Install and configure Ponytail separately
in a supported external host by following upstream documentation.

Only the external host (or trusted host-integration tooling) can report whether
Ponytail is installed, active, and healthy. Import such a report separately;
Assay will reject identity, descriptor digest, payload integrity, host, scope,
surface, or state-ownership mismatches:

```sh
assay plugin observe <host-observation.json> --root <workspace> --json
```

Without that report, Assay correctly lists host installation and activation as
`unobserved` and health as `unverifiable`. Assay does not infer host state from
this descriptor or the npm locator.

The remaining lifecycle commands affect only Assay's record and contribution
state:

```sh
assay plugin disable assay-community.ponytail-metadata --root <workspace> --json
assay plugin enable assay-community.ponytail-metadata --root <workspace> --json
assay plugin remove assay-community.ponytail-metadata --root <workspace> --json
```

They do not activate or deactivate Ponytail, execute its hooks, alter its mode,
uninstall its npm package, or remove OpenCode-, Pi-, or Ponytail-owned files.
