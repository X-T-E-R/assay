# Assay 0.13.0

Assay 0.13.0 establishes the exact `0.13.0+s4+l8+r3` System-authority contract. Manifest schema 4 and layout 8 remain unchanged; systems registry schema 3 is a breaking external-cutover boundary.

## Breaking changes

- The systems-registry map key is the canonical Project-local selector. Closed records no longer duplicate `name` or carry `contract_file`.
- Complete pre-semantic validation enforces one primary, unique normalized live locators, lifecycle pairing, a known acyclic supersedes graph, and redirect-safe workspace/external boundaries.
- Registry r2 fails closed with a non-executing exact-pair cutover locator before semantic reads, recovery, locator dereference, or writes. Core has no migration writer or compatibility fallback.
- Assay no longer owns a System sidecar. Registration, attach, check, status, update, and conversion do not create, parse, validate, refresh, or delete `system.yaml`.
- Archive is a logical registry transition only. Internal and absolute external System bytes remain untouched, and registry/CLI output contains no physical archive path.
- `system update --path` is registry rebind only. System bytes are never moved.
- System selectors are exact; prefix fallback was removed.

## Preserved contracts

Native Project schema 1, workspace index schema 1, external Plugin state schema 1, manifest schema 4/layout 8, Task, Roadmap, Spec, Source, Source adoption, Analysis, Knowledge, and host-only Plugin boundaries are unchanged.
