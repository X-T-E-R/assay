# Project

This is the workspace's single native Project authority. The Project owns its adopted charter, roadmap, specifications, Project-selected Relay records, and extensions.

Semantic locations such as `specs/`, `relay/`, and `extensions/` are created only when the Project adopts material that belongs there. Their absence is healthy.

Native Specs under `specs/<id>/{spec.yaml,specification.md}` own current normative constraints and acceptance contracts. They are not approvals, Roadmap state, Task state, or System lifecycle signals; promotion and lifecycle commands do not propagate across those authorities.

Authority remains separate elsewhere:

- `sources/` owns external material and the record of how it changed.
- `analyses/` owns analysis records.
- `tasks/` owns Assay-native Task records.
- `systems/` contains System implementations; schema-3 registry records own Project-local membership and locators.
- `.assay/` owns workspace layout, runtime state, receipts, and caches.

Project ownership does not grant plugins, Relay, Ponytail, or external tooling permission to write this area. Those tools act only through an explicit Project selection and their own declared authority.
