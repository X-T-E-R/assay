# Show HN: Assay – Study many. Build your own.

When building with AI, I often follow the same loop: find a promising framework, skim it, copy a useful pattern, and move on. Three months later, the rationale is gone. I no longer know what I evaluated, why I adopted one part, or why I rejected another.

Assay is an open-source CLI workbench for keeping that chain intact. The name comes from *assay* /əˈseɪ/: to analyze an ore and determine what it is made of.

External frameworks, libraries, patterns, and ideas are recorded as Sources. Analyses capture the evaluation and close with an explicit adopt, reject, or experiment decision backed by evidence. When something proves useful, an adoption record connects it to your own Systems or Knowledge, so copied material does not lose its origin or rationale.

Assay also provides Tasks, Roadmaps, and Specs with stable identities. They are intended for projects that continue across AI sessions, assistant changes, and context compaction without requiring you to reconstruct the current work from chat history.

It is advisory rather than a process gate. There is no server or account; the work lives in your repository under your version control. Assay is MIT-licensed and currently installed by cloning the repository and running `pnpm install && pnpm build` with Node.js >=22.13. It is not published on npm.

Repo: https://github.com/X-T-E-R/assay  
Intro site: https://x-t-e-r.github.io/assay/
