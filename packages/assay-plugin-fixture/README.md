# Assay external plugin fixture

This repository fixture contains only `assay-plugin.json`. It declares a
namespaced, read-only host-command surface so Assay can prove its generic
external descriptor path without using Ponytail-specific behavior. The package
is private and is not a published npm artifact; its intended immutable source
and license anchors are the Assay v0.13.0 repository tag.

The package has no executable entry point, hooks, network access, secrets,
workspace writes, subagent injection, or persistent state. Assay records and
checks the descriptor but never imports, installs, activates, or executes it.
The descriptor demonstrates a multi-host declaration without fabricating host
versions and carries explicit MIT SPDX/license-source metadata. It owns no
Assay or host state.
The payload reference is an inert host-command contract identity; its SRI is
the SHA-512 digest of the exact UTF-8 ref text
`urn:assay-fixture:readonly-command-contract@1.0.0`, not a claim that the package
tarball is executable payload.
