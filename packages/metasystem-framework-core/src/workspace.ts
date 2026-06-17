import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import { loadAdrIndex } from "./adrs.js";
import { ADRS_FILE, MANIFEST_FILE, PRIMARY_DIRS } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { fileHash } from "./hashing.js";
import { defaultManifest, loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "./results.js";
import type { AdrIndex, AdrRecord, FrameworkManifest } from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";
import { loadSystemsRegistry } from "./systems-registry.js";
import { desiredTemplates } from "./templates.js";

const GENERATED_REFERENCE_DIRS = new Set([
  ".venv",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".next",
]);

export interface InitFrameworkOptions {
  readonly target: string;
  readonly name?: string;
  readonly core?: string;
  readonly git?: boolean;
  readonly force?: boolean;
  readonly createNew?: boolean;
}

export interface InitFrameworkResult {
  readonly root: string;
  readonly project: string;
  readonly core: string;
  readonly report: OperationReport;
}

export interface CheckFrameworkOptions {
  readonly root: string;
}

export interface CheckFrameworkResult {
  readonly root: string;
  readonly ok: boolean;
  readonly rows: CheckRow[];
  readonly manifest?: {
    readonly schema: number;
    readonly frameworkVersion: string;
    readonly managedFiles: number;
  };
  readonly systems?: {
    readonly primary: string | null;
    readonly total: number;
    readonly openIterations: number;
  };
}

export interface FrameworkZoneCount {
  readonly path: string;
  readonly files: number;
}

export interface FrameworkStatusSystem {
  readonly name: string;
  readonly status: string;
  readonly vcs: string;
  readonly version: string;
  readonly supersedes: readonly string[];
}

export interface FrameworkStatusResult {
  readonly root: string;
  readonly hasManifest: boolean;
  readonly installedVersion?: string;
  readonly layoutVersion?: number;
  readonly project?: string;
  readonly core?: string;
  readonly managedFiles: number;
  readonly zones: FrameworkZoneCount[];
  readonly systems?: readonly FrameworkStatusSystem[];
  readonly openIterations?: number;
  readonly knowledgeEntries?: number;
}

export interface AddReferenceOptions {
  readonly root: string;
  readonly source: string;
  readonly name: string;
  readonly now?: Date;
}

export interface AddReferenceResult {
  readonly root: string;
  readonly source: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface CreateAnalysisOptions {
  readonly root: string;
  readonly title: string;
  readonly now?: Date;
}

export interface CreateAnalysisResult {
  readonly root: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface StartIterationOptions {
  readonly root: string;
  readonly title: string;
  readonly now?: Date;
}

export interface StartIterationResult {
  readonly root: string;
  readonly path: string;
  readonly planPath: string;
  readonly absolutePath: string;
  readonly eventFile: string;
}

export interface CaptureEventOptions {
  readonly root: string;
  readonly kind: string;
  readonly text: string;
  readonly now?: Date;
}

export interface CaptureEventResult {
  readonly root: string;
  readonly eventFile: string;
}

export type IterationResult = "applied" | "rejected" | "retest";

export interface CloseIterationOptions {
  readonly root: string;
  readonly selector: string;
  readonly result: IterationResult;
  readonly note?: string;
  readonly now?: Date;
}

export interface CloseIterationResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

export type AnalysisExit = "adopt" | "reject" | "experiment" | "adr";

export interface CloseAnalysisOptions {
  readonly root: string;
  readonly path: string;
  readonly exit: AnalysisExit;
  readonly note?: string;
  readonly now?: Date;
}

export interface CloseAnalysisResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

export type KnowledgeType = "decision" | "pattern" | "guide" | "troubleshooting";

export interface AddKnowledgeOptions {
  readonly root: string;
  readonly type: KnowledgeType;
  readonly title: string;
  readonly fromAnalysis?: string;
  readonly fromIteration?: string;
  readonly now?: Date;
}

export interface AddKnowledgeResult {
  readonly root: string;
  readonly path: string;
  readonly eventFile: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureDir(target: string, root: string, report: OperationReport): Promise<void> {
  const display = relativeDisplayPath(target, root);
  if (await exists(target)) {
    report.existing_dirs.push(display);
    return;
  }

  await mkdir(target, { recursive: true });
  report.created_dirs.push(display);
}

function dateStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function monthStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function requireManifest(manifest: FrameworkManifest | null, root: string): FrameworkManifest {
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}.`,
    );
  }
  return manifest;
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  if (!(await exists(root))) {
    return count;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(child);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

const OPEN_STATUS_PATTERN = /(?<![a-z])Status:\s*open\b/i;

async function countOpenIterations(root: string): Promise<number> {
  const iterationsDir = path.join(root, "iterations");
  if (!(await exists(iterationsDir))) {
    return 0;
  }

  let count = 0;
  const entries = await readdir(iterationsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const planPath = path.join(iterationsDir, entry.name, "plan.md");
    if (!(await exists(planPath))) continue;
    try {
      const content = await readFile(planPath, "utf8");
      if (OPEN_STATUS_PATTERN.test(content)) {
        count += 1;
      }
    } catch {
      // skip unreadable plans
    }
  }
  return count;
}

const REQUIRED_ADR_FRONTMATTER_FIELDS = [
  "adr",
  "title",
  "status",
  "date",
  "supersedes",
  "superseded_by",
  "related_analysis",
  "related_iteration",
] as const;

function missingAdrFrontmatterFields(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return [...REQUIRED_ADR_FRONTMATTER_FIELDS];
  }
  const frontmatter = match[1];
  return REQUIRED_ADR_FRONTMATTER_FIELDS.filter((field) => {
    const pattern = new RegExp(`^${field}:`, "m");
    return !pattern.test(frontmatter);
  });
}

function recordAdrChainErrors(rows: CheckRow[], index: AdrIndex): void {
  for (const adr of Object.values(index.adrs)) {
    for (const oldId of adr.supersedes) {
      const oldAdr = index.adrs[oldId];
      if (!oldAdr) {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR '${adr.id}' supersedes missing ADR '${oldId}'`,
        });
        continue;
      }
      if (oldAdr.superseded_by !== adr.id) {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR supersedes link is not bidirectional: '${adr.id}' -> '${oldId}'`,
        });
      }
      if (oldAdr.status !== "superseded") {
        rows.push({
          path: ADRS_FILE,
          status: "error",
          message: `ADR '${oldId}' is superseded by '${adr.id}' but status is '${oldAdr.status}'`,
        });
      }
    }

    if (!adr.superseded_by) {
      continue;
    }
    const replacement = index.adrs[adr.superseded_by];
    if (!replacement) {
      rows.push({
        path: ADRS_FILE,
        status: "error",
        message: `ADR '${adr.id}' points to missing superseded_by '${adr.superseded_by}'`,
      });
      continue;
    }
    if (!replacement.supersedes.includes(adr.id)) {
      rows.push({
        path: ADRS_FILE,
        status: "error",
        message: `ADR superseded_by link is not bidirectional: '${adr.id}' -> '${replacement.id}'`,
      });
    }
  }
}

function recordAdrCycleErrors(rows: CheckRow[], index: AdrIndex): void {
  const reported = new Set<string>();
  for (const start of Object.keys(index.adrs)) {
    const seen = new Set<string>();
    const order: string[] = [];
    let current: string | null = start;

    while (current) {
      if (seen.has(current)) {
        const cycleStart = order.indexOf(current);
        const cycle = [...order.slice(cycleStart), current].join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          rows.push({
            path: ADRS_FILE,
            status: "error",
            message: `ADR supersede chain has a cycle: ${cycle}`,
          });
        }
        break;
      }
      seen.add(current);
      order.push(current);
      const record: AdrRecord | undefined = index.adrs[current];
      if (!record?.superseded_by || !index.adrs[record.superseded_by]) {
        break;
      }
      current = record.superseded_by;
    }
  }
}

async function writeTemplateFile(
  root: string,
  templatePath: string,
  content: string,
  report: OperationReport,
  options: { readonly force: boolean; readonly createNew: boolean; readonly executable: boolean },
): Promise<"written" | "skipped" | "new-copy"> {
  const absolutePath = path.join(root, templatePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  if ((await exists(absolutePath)) && !options.force) {
    if (options.createNew) {
      const newPath = `${absolutePath}.new`;
      await writeFile(newPath, content, "utf8");
      report.new_copies.push(relativeDisplayPath(newPath, root));
      return "new-copy";
    }

    report.skipped_files.push(templatePath);
    return "skipped";
  }

  const existed = await exists(absolutePath);
  await writeFile(absolutePath, content, "utf8");
  if (options.executable) {
    const mode = (await stat(absolutePath)).mode;
    await chmod(absolutePath, mode | 0o755);
  }

  (existed ? report.updated_files : report.created_files).push(templatePath);
  return "written";
}

export async function initFramework(options: InitFrameworkOptions): Promise<InitFrameworkResult> {
  const root = path.resolve(options.target);
  const project = options.name ?? path.basename(root);
  const core = options.core ?? `${slugify(project)}-core`;
  const report = createEmptyReport();

  await ensureDir(root, root, report);
  for (const directory of PRIMARY_DIRS) {
    await ensureDir(path.join(root, directory), root, report);
  }

  let manifest = (await loadManifest(root)) ?? defaultManifest(project, core);
  for (const template of desiredTemplates(project, core)) {
    const result = await writeTemplateFile(root, template.path, template.content, report, {
      force: options.force ?? false,
      createNew: options.createNew ?? false,
      executable: template.executable,
    });
    if (result === "written") {
      recordTemplate(manifest, template);
    }
  }

  const manifestExisted = await exists(path.join(root, MANIFEST_FILE));
  manifest = await saveManifest(root, manifest);
  (manifestExisted ? report.updated_files : report.created_files).push(MANIFEST_FILE);

  await appendEvent(root, {
    core,
    event: "framework.initialized",
    project,
    version: manifest.framework_version,
  });

  if (options.git && !(await exists(path.join(root, ".git")))) {
    const result = await execa("git", ["init"], { cwd: root, reject: false });
    if (result.exitCode === 0) {
      report.notes.push("initialized root git repository");
    } else {
      report.notes.push(`git init failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  return { root, project, core, report };
}

export async function checkFramework(
  options: CheckFrameworkOptions,
): Promise<CheckFrameworkResult> {
  const root = path.resolve(options.root);
  const checkTargets = [
    [".framework directory", ".framework"],
    [".framework/VERSION", ".framework/VERSION"],
    [".framework/manifest.json", ".framework/manifest.json"],
    ["references directory", "references"],
    ["analyses directory", "analyses"],
    ["systems directory", "systems"],
    ["iterations directory", "iterations"],
    ["knowledge directory", "knowledge"],
  ] as const;
  const rows: CheckRow[] = [];

  for (const [label, target] of checkTargets) {
    rows.push({
      path: target,
      status: (await exists(path.join(root, target))) ? "ok" : "missing",
      message: label,
    });
  }

  let manifest: FrameworkManifest | null = null;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    rows.push({
      path: MANIFEST_FILE,
      status: "error",
      message: error instanceof Error ? error.message : "manifest failed validation",
    });
  }

  if (manifest) {
    rows.push({ path: MANIFEST_FILE, status: "ok", message: "manifest schema readable" });

    // Semantic check 1: managed file existence + hash consistency
    for (const [filePath, record] of Object.entries(manifest.managed_files)) {
      const absolutePath = path.join(root, filePath);
      if (!(await exists(absolutePath))) {
        rows.push({
          path: filePath,
          status: "error",
          message: `managed file missing (template: ${record.template_id})`,
        });
        continue;
      }
      try {
        const currentHash = await fileHash(absolutePath);
        if (currentHash !== record.hash) {
          rows.push({
            path: filePath,
            status: "warning",
            message: "modified by user (hash differs from manifest)",
          });
        }
      } catch {
        rows.push({
          path: filePath,
          status: "warning",
          message: "could not read file for hash check",
        });
      }
    }
  } else if (!rows.some((row) => row.path === MANIFEST_FILE && row.status === "error")) {
    rows.push({ path: MANIFEST_FILE, status: "missing", message: "readable manifest" });
  }

  // Semantic check 2: systems registry consistency
  let primaryName: string | null = null;
  let systemCount = 0;
  let openIterations = 0;
  try {
    const registry = await loadSystemsRegistry(root);
    if (registry) {
      primaryName = registry.primary;
      systemCount = Object.keys(registry.systems).length;

      // Check primary uniqueness
      const primaries = Object.values(registry.systems).filter((s) => s.status === "primary");
      if (primaries.length === 0 && registry.primary !== null) {
        rows.push({
          path: ".framework/systems-registry.json",
          status: "error",
          message: `registry primary is '${registry.primary}' but no system has status: primary`,
        });
      } else if (primaries.length > 1) {
        rows.push({
          path: ".framework/systems-registry.json",
          status: "error",
          message: `expected exactly one primary system, found ${primaries.length}: ${primaries.map((s) => s.name).join(", ")}`,
        });
      }

      // Check each active/primary system exists on disk
      for (const system of Object.values(registry.systems)) {
        if (system.status === "archived") continue;
        const systemPath = path.join(root, system.path);
        if (!(await exists(systemPath))) {
          rows.push({
            path: system.path,
            status: "error",
            message: `registered system '${system.name}' missing on disk`,
          });
        }
        if (system.contract_file) {
          const contractPath = path.join(root, system.contract_file);
          if (!(await exists(contractPath))) {
            rows.push({
              path: system.contract_file,
              status: "warning",
              message: `contract file missing for system '${system.name}'`,
            });
          }
        }
        if (system.vcs === "independent-git") {
          if (!(await exists(path.join(systemPath, ".git")))) {
            rows.push({
              path: system.path,
              status: "warning",
              message: `system '${system.name}' declared independent-git but no .git found`,
            });
          }
        }
      }
    }
  } catch (error) {
    rows.push({
      path: ".framework/systems-registry.json",
      status: "error",
      message: error instanceof Error ? error.message : "systems registry error",
    });
  }

  // Semantic check 3: open iterations
  try {
    openIterations = await countOpenIterations(root);
    if (openIterations > 0) {
      rows.push({
        path: "iterations/",
        status: "warning",
        message: `${openIterations} iteration(s) not closed (Status: open)`,
      });
    }
  } catch {
    // iterations directory may not exist; skip
  }

  // Semantic check 4: ADR index and supersede chain consistency
  try {
    const adrIndex = await loadAdrIndex(root);
    if (adrIndex) {
      for (const adr of Object.values(adrIndex.adrs)) {
        const adrPath = path.join(root, adr.path);
        if (!(await exists(adrPath))) {
          rows.push({
            path: adr.path,
            status: "error",
            message: `indexed ADR '${adr.id}' missing on disk`,
          });
          continue;
        }
        try {
          const content = await readFile(adrPath, "utf8");
          const missingFields = missingAdrFrontmatterFields(content);
          if (missingFields.length > 0) {
            rows.push({
              path: adr.path,
              status: "warning",
              message: `ADR frontmatter missing: ${missingFields.join(", ")}`,
            });
          }
        } catch {
          rows.push({
            path: adr.path,
            status: "warning",
            message: `could not read ADR '${adr.id}' for frontmatter check`,
          });
        }
      }
      recordAdrChainErrors(rows, adrIndex);
      recordAdrCycleErrors(rows, adrIndex);
    }
  } catch (error) {
    rows.push({
      path: ADRS_FILE,
      status: "error",
      message: error instanceof Error ? error.message : "ADR index error",
    });
  }

  return {
    root,
    ok: rows.every((row) => row.status === "ok" || row.status === "warning"),
    rows,
    ...(manifest
      ? {
          manifest: {
            schema: manifest.__schema,
            frameworkVersion: manifest.framework_version,
            managedFiles: Object.keys(manifest.managed_files).length,
          },
        }
      : {}),
    ...(systemCount > 0 || primaryName !== null || openIterations > 0
      ? { systems: { primary: primaryName, total: systemCount, openIterations } }
      : {}),
  };
}

export async function getFrameworkStatus(
  options: CheckFrameworkOptions,
): Promise<FrameworkStatusResult> {
  const root = path.resolve(options.root);
  const manifest = await loadManifest(root);
  const zones = await Promise.all(
    [
      "references/frozen",
      "analyses/references",
      "analyses/patterns",
      "iterations",
      "knowledge",
    ].map(async (zone) => ({ path: zone, files: await countFiles(path.join(root, zone)) })),
  );

  // Systems section from registry
  let systems: readonly FrameworkStatusSystem[] | undefined;
  let openIterations: number | undefined;
  try {
    const registry = await loadSystemsRegistry(root);
    if (registry) {
      systems = Object.values(registry.systems)
        .sort((a, b) => {
          const order: Record<string, number> = {
            primary: 0,
            active: 1,
            superseded: 2,
            archived: 3,
          };
          return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name);
        })
        .map((s) => ({
          name: s.name,
          status: s.status,
          vcs: s.vcs,
          version: s.version,
          supersedes: s.supersedes,
        }));
    }
  } catch {
    // registry missing or invalid; status omits systems section
  }

  try {
    openIterations = await countOpenIterations(root);
  } catch {
    // iterations dir may not exist
  }

  const knowledgeEntries = await countFiles(path.join(root, "knowledge"));
  // subtract README stubs (4 subdirs + 1 root) and the ADR authoring template
  const knowledgeCount = Math.max(0, knowledgeEntries - 6);

  if (!manifest) {
    return {
      root,
      hasManifest: false,
      managedFiles: 0,
      zones,
      ...(systems ? { systems } : {}),
      ...(openIterations !== undefined ? { openIterations } : {}),
      knowledgeEntries: knowledgeCount,
    };
  }

  return {
    root,
    hasManifest: true,
    installedVersion: manifest.framework_version,
    layoutVersion: manifest.layout_version,
    project: manifest.project.name,
    core: manifest.project.core,
    managedFiles: Object.keys(manifest.managed_files).length,
    zones,
    ...(systems ? { systems } : {}),
    ...(openIterations !== undefined ? { openIterations } : {}),
    knowledgeEntries: knowledgeCount,
  };
}

function shouldCopyReference(source: string, destination: string): boolean {
  const relative = toPosixPath(path.relative(source, destination));
  if (relative === "") {
    return true;
  }

  return !relative.split("/").some((part) => GENERATED_REFERENCE_DIRS.has(part));
}

export async function addReference(options: AddReferenceOptions): Promise<AddReferenceResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const source = path.resolve(options.source);
  const now = options.now ?? new Date();
  const relativePath = `references/frozen/${monthStamp(now)}/${slugify(options.name)}`;
  const destination = path.join(root, relativePath);

  if (await exists(destination)) {
    throw new FrameworkAlreadyExistsError(`reference already exists: ${relativePath}`);
  }

  await cp(source, destination, {
    recursive: true,
    filter: (_source, dest) => shouldCopyReference(destination, dest),
  });
  const eventFile = await appendEvent(
    root,
    {
      event: "reference.frozen",
      name: options.name,
      path: relativePath,
      source,
    },
    now,
  );

  return {
    root,
    source,
    path: relativePath,
    absolutePath: destination,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function createAnalysis(
  options: CreateAnalysisOptions,
): Promise<CreateAnalysisResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = `analyses/references/${date}-${slugify(options.title)}.md`;
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`analysis already exists: ${relativePath}`);
  }

  const content = `# ${options.title}\n\n- Date: ${date}\n- Status: draft\n\n## Reference\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Next iteration\n\n## Decision exit\n\n- [ ] adopt\n- [ ] reject\n- [ ] experiment\n- [ ] ADR\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const eventFile = await appendEvent(
    root,
    { event: "analysis.created", path: relativePath, title: options.title },
    now,
  );

  return {
    root,
    path: relativePath,
    absolutePath,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function startIteration(
  options: StartIterationOptions,
): Promise<StartIterationResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);
  const relativePath = `iterations/${date}-${slugify(options.title)}`;
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`iteration already exists: ${relativePath}`);
  }

  await mkdir(absolutePath, { recursive: true });
  const planPath = path.join(absolutePath, "plan.md");
  await writeFile(
    planPath,
    `# ${options.title}\n\n- Date: ${date}\n- Status: open\n\n## Hypothesis\n\n## Scope\n\n## Verification\n\n## Rollback\n\n## Result\n`,
    "utf8",
  );
  const eventFile = await appendEvent(
    root,
    { event: "iteration.started", path: relativePath, title: options.title },
    now,
  );

  return {
    root,
    path: relativePath,
    planPath: `${relativePath}/plan.md`,
    absolutePath,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function captureEvent(options: CaptureEventOptions): Promise<CaptureEventResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const eventFile = await appendEvent(
    root,
    { event: "capture.created", kind: options.kind, text: options.text },
    options.now ?? new Date(),
  );

  return { root, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function closeIteration(
  options: CloseIterationOptions,
): Promise<CloseIterationResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  // Resolve iteration directory from selector (path or date-slug prefix)
  const iterationsDir = path.join(root, "iterations");
  let iterPath: string | null = null;
  const selectorNormalized = options.selector.replace(/\\/g, "/");

  // Try as direct path
  const directPath = path.join(root, selectorNormalized);
  if (await exists(directPath)) {
    iterPath = selectorNormalized;
  } else {
    // Search by prefix match
    if (await exists(iterationsDir)) {
      const entries = await readdir(iterationsDir, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(options.selector))
        .map((e) => e.name);
      if (matches.length === 1 && matches[0]) {
        iterPath = `iterations/${matches[0]}`;
      } else if (matches.length > 1) {
        throw new FrameworkNotFoundError(
          `iteration selector '${options.selector}' is ambiguous (${matches.join(", ")})`,
        );
      }
    }
  }

  if (!iterPath) {
    throw new FrameworkNotFoundError(`iteration not found: ${options.selector}`);
  }

  const planPath = path.join(root, iterPath, "plan.md");
  if (!(await exists(planPath))) {
    throw new FrameworkNotFoundError(`iteration plan not found: ${iterPath}/plan.md`);
  }

  // Update plan.md: set Status to closed, add Result
  let content = await readFile(planPath, "utf8");
  content = content.replace(/(?<![a-z])Status:\s*open\b/i, "Status: closed");
  content = content.replace(
    /## Result\s*\n/,
    `## Result\n\n- ${options.result} on ${date}${options.note ? ` — ${options.note}` : ""}\n`,
  );
  if (!/## Result/.test(content)) {
    content += `\n## Result\n\n- ${options.result} on ${date}${options.note ? ` — ${options.note}` : ""}\n`;
  }
  await writeFile(planPath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "iteration.closed",
      path: iterPath,
      result: options.result,
      note: options.note ?? null,
    },
    now,
  );

  return { root, path: iterPath, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function closeAnalysis(options: CloseAnalysisOptions): Promise<CloseAnalysisResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const analysisPath = options.path.replace(/\\/g, "/");
  const absolutePath = path.join(root, analysisPath);
  if (!(await exists(absolutePath))) {
    throw new FrameworkNotFoundError(`analysis not found: ${analysisPath}`);
  }

  let content = await readFile(absolutePath, "utf8");
  // Set status
  const statusMap: Record<AnalysisExit, string> = {
    adopt: "applied",
    reject: "rejected",
    experiment: "experiment",
    adr: "adr",
  };
  const statusValue = statusMap[options.exit];
  if (/- Status:\s*\S+/i.test(content)) {
    content = content.replace(/- Status:\s*\S+/i, `- Status: ${statusValue}`);
  } else {
    content = `# Analysis\n\n- Status: ${statusValue}\n${content}`;
  }
  // Check the decision exit checkbox
  const exitLabel = options.exit === "adr" ? "ADR" : options.exit;
  const checkboxPattern = new RegExp(/- \[[\s]?\] /.source + exitLabel + /\b/.source, "i");
  content = content.replace(checkboxPattern, `- [x] ${exitLabel}`);
  if (options.note) {
    content += `\n> Closed on ${date}: ${options.note}\n`;
  }
  await writeFile(absolutePath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "analysis.closed",
      path: analysisPath,
      exit: options.exit,
      note: options.note ?? null,
    },
    now,
  );

  return { root, path: analysisPath, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function addKnowledge(options: AddKnowledgeOptions): Promise<AddKnowledgeResult> {
  const root = path.resolve(options.root);
  requireManifest(await loadManifest(root), root);
  const now = options.now ?? new Date();
  const date = dateStamp(now);

  const typeDir = `knowledge/${options.type}s`;
  const fileName = `${date}-${slugify(options.title)}.md`;
  const relativePath = `${typeDir}/${fileName}`;
  const absolutePath = path.join(root, relativePath);

  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`knowledge entry already exists: ${relativePath}`);
  }

  const refs: string[] = [];
  if (options.fromAnalysis) {
    refs.push(`- from analysis: ${options.fromAnalysis}`);
  }
  if (options.fromIteration) {
    refs.push(`- from iteration: ${options.fromIteration}`);
  }
  const refBlock = refs.length > 0 ? `\n${refs.join("\n")}\n` : "\n";

  const content = `# ${options.title}\n\n- Type: ${options.type}\n- Date: ${date}\n- Status: accepted${refBlock}\n## Summary\n\n## Detail\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");

  const eventFile = await appendEvent(
    root,
    {
      event: "knowledge.added",
      path: relativePath,
      type: options.type,
      title: options.title,
      from_analysis: options.fromAnalysis ?? null,
      from_iteration: options.fromIteration ?? null,
    },
    now,
  );

  return { root, path: relativePath, eventFile: relativeDisplayPath(eventFile, root) };
}
