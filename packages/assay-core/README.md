# assay-core

Core library for Assay 0.13 workspaces.

- exact manifest schema 4 / layout 8 loading and fail-closed authority writes;
- one-shot Template parsing and expansion;
- native Project schema 1 identity;
- separate managed-files schema 1 three-way no-clobber receipt;
- explicit workspace index commands;
- unchanged Source, Analysis, Knowledge, Task, Roadmap, Spec, and external Plugin schema 1 behavior;
- schema-3 registry-canonical Project-local System authority with logical-only archive.

Mutation modules append structured audit events internally. Event append/capture APIs are not part of the public package surface.
