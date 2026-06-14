import { chmod, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import { MANIFEST_FILE, PRIMARY_DIRS } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { defaultManifest, loadManifest, recordTemplate, saveManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { type CheckRow, type OperationReport, createEmptyReport } from "./results.js";
import type { FrameworkManifest } from "./schemas/index.js";
import { toPosixPath } from "./serialization.js";
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
}

export interface FrameworkZoneCount {
  readonly path: string;
  readonly files: number;
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
  await ensureDir(path.join(root, "systems", core, "docs"), root, report);

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
  } else if (!rows.some((row) => row.path === MANIFEST_FILE && row.status === "error")) {
    rows.push({ path: MANIFEST_FILE, status: "missing", message: "readable manifest" });
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

  if (!manifest) {
    return { root, hasManifest: false, managedFiles: 0, zones };
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

  const content = `# ${options.title}\n\n- Date: ${date}\n- Status: draft\n\n## Reference\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Next iteration\n`;
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
