# Layout modes

Layout version 8 supports two exact modes.

- `standalone`: state is under `.assay/`; Project, Systems, Knowledge, Sources, Analyses, and Template-expanded work areas live at the workspace root; privacy is `tracked`.
- `overlay`: all Assay state and work areas live under `.assay/`; privacy is `private`, `private-git`, or `tracked`; the product root is the primary independent System.

```bash
assay attach --root ../product --name Product --template study --privacy private
assay convert --root ../product --to standalone --target ../product-workbench --copy
```

Conversion preflights the current manifest, managed receipt, native Project, Tasks, Roadmaps, Specs, Sources, Source adoptions, and systems registry before target creation. It rewrites every manifest entry and managed path through the exact resolver. Unknown destructive-move state blocks cleanup rather than being deleted.