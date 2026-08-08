import { CURRENT_VERSION, LAYOUT_VERSION } from "./constants.js";
import { workspaceTemplateRelativePath } from "./layout.js";
import type { ManifestEntry, WorkspaceLayout } from "./schemas/index.js";
import type { WorkspaceTemplate } from "./template.js";

export interface TemplateFile {
  readonly path: string;
  readonly generator?: string;
  readonly asset?: string;
  readonly content: string;
  readonly executable: boolean;
  readonly protected: boolean;
  readonly managed: boolean;
}

export interface ExpandedTemplate {
  readonly description: string;
  readonly directories: readonly ManifestEntry[];
  readonly files: readonly TemplateFile[];
}

function dedent(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const margin = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => (line.trim().length > 0 ? line.slice(margin) : "")).join("\n");
}

function render(content: string, project: string): string {
  return content.replaceAll("{{project}}", project);
}

function baseFile(
  layout: WorkspaceLayout,
  path: string,
  generator: string,
  content: string,
  protectedFile = false,
): TemplateFile {
  return {
    path: workspaceTemplateRelativePath(layout, path),
    generator,
    content,
    executable: false,
    protected: protectedFile,
    managed: true,
  };
}

export function baseCoreTemplates(project: string, layout: WorkspaceLayout): TemplateFile[] {
  const candidates = [
    baseFile(layout, "README.md", "root.readme", rootReadme(project), true),
    baseFile(layout, ".gitignore", "root.gitignore", rootGitignore(), true),
    baseFile(layout, ".assay/README.md", "framework.readme", frameworkReadme()),
    baseFile(layout, ".assay/backups/.gitkeep", "framework.backups.gitkeep", ""),
    baseFile(layout, "systems/README.md", "systems.readme", systemsReadme()),
    baseFile(layout, "knowledge/README.md", "knowledge.readme", knowledgeReadme()),
  ];
  return layout.mode === "overlay"
    ? candidates.filter(
        (file) => file.generator !== "root.readme" && file.generator !== "root.gitignore",
      )
    : candidates;
}

export function expandTemplate(
  project: string,
  template: WorkspaceTemplate,
  layout: WorkspaceLayout,
): ExpandedTemplate {
  const directories = template.directories.map((entry) => ({
    path: workspaceTemplateRelativePath(layout, entry.path),
    kind: "directory" as const,
    purpose: entry.purpose,
  }));
  const files: TemplateFile[] = template.files.map((entry) => ({
    path: workspaceTemplateRelativePath(layout, entry.path),
    ...(template.source === "file" && entry.file ? { asset: entry.file } : {}),
    content: render(entry.content ?? "", project),
    executable: entry.executable,
    protected: false,
    managed: false,
  }));
  return { description: template.description, directories, files };
}

export function manifestEntriesForScaffold(
  _layout: WorkspaceLayout,
  expanded: ExpandedTemplate,
  _coreFiles: readonly TemplateFile[],
): ManifestEntry[] {
  const entries = new Map<string, ManifestEntry>();
  for (const entry of expanded.directories) entries.set(entry.path, entry);
  for (const file of expanded.files) {
    entries.set(file.path, { path: file.path, kind: "file", purpose: "" });
  }
  return [...entries.values()];
}
export function rootReadme(project: string): string {
  return dedent(`
    # ${project}

    A versioned Assay workspace.

    Evidence loop:

    \`\`\`text
    evidence in -> structured checks -> decisions -> knowledge growth
    \`\`\`

    | Path | Purpose |
    | --- | --- |
    | \`.assay/\` | Runtime metadata: manifest, managed receipt, events, backups |
    | \`project/\` | Native Project identity, charter, and Roadmap items |
    | \`systems/\` | Registered active systems and local implementations |
    | \`knowledge/\` | Accepted reusable knowledge |

    One-shot Template working directories sit alongside this base. Use \`assay status\` to inspect open work and \`assay check\` to validate the workspace.
    `);
}

export function rootGitignore(): string {
  return dedent(`
    .DS_Store
    Thumbs.db
    __pycache__/
    *.pyc
    .venv/
    .secrets/
    *.log
    .assay/backups/*
    !.assay/backups/.gitkeep
    `);
}

export function frameworkReadme(): string {
  return dedent(`
    # .assay/

    Assay runtime metadata. Do not store external evidence or long-lived user knowledge here.

    - \`managed-files.json\`: fixed core asset baselines for no-clobber updates.
    - \`manifest.json\`: framework version, exact layout, and expanded path entries.
    - \`systems-registry.json\`: registered systems and the current primary system after \`assay system register\`.
    - \`events/\`: JSONL event ledger.

    - \`backups/\`: timestamped backups before managed updates.

    Current Assay release is ${CURRENT_VERSION}; layout release is ${LAYOUT_VERSION}.
    `);
}

export function systemsReadme(): string {
  return "# systems/\n\nYour active system implementations and registered system metadata. Assay manages each system's registry contract; system source and docs belong to the system itself.\n";
}

export function knowledgeReadme(): string {
  return "# knowledge/\n\nStore accepted reusable knowledge only. Work-in-progress analysis belongs in the manifest-declared working directories.\n";
}
