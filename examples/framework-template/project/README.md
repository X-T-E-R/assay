# Project

This is the workspace's single native Project authority. The Project owns its adopted charter, roadmap, specifications, Project-selected Relay records, and extensions.

Semantic locations such as `specs/`, `relay/`, and `extensions/` are created only when the Project adopts material that belongs there. Their absence is healthy.

Native Specs under `specs/<id>/{spec.yaml,specification.md}` own current normative constraints and acceptance contracts. They are not approvals, Roadmap state, Task state, System state, or ADR replacements; promotion and lifecycle commands do not propagate across those authorities.

Reference, Analysis, Task, System, ADR/knowledge, and `.assay/` runtime records remain independent authorities. Plugins and external tooling gain no Project writer authority from registration alone.
