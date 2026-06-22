import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { MANIFEST_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { recordProjectLifecycleBestEffort } from "./project-registry.js";
import { type InitFrameworkResult, createAnalysis, initFramework } from "./workspace.js";

const ADOPTION_ROOT = ".old";
const ADOPTION_MANIFEST_BASENAME = "adoption-manifest";
const ADOPTION_MANIFEST_EXTENSION = ".json";
const SKIPPED_ROOT_ENTRIES = new Set([".git", ADOPTION_ROOT]);

export interface AdoptExistingProjectOptions {
  readonly root: string;
  readonly name?: string;
  readonly core?: string;
  readonly dryRun?: boolean;
  readonly apply?: boolean;
  /** After a successful apply, generate an adoption inventory and open an adoption analysis so the archived content is tracked to completion. */
  readonly analyze?: boolean;
  readonly now?: Date;
}

export interface AdoptionMove {
  readonly source: string;
  readonly destination: string;
  readonly status: "planned" | "moved" | "failed";
}

export interface AdoptionSkippedEntry {
  readonly path: string;
  readonly reason: string;
}

export interface AdoptionFailure {
  readonly source: string;
  readonly destination?: string;
  readonly message: string;
}

export interface AdoptionScaffoldMetadata {
  readonly project: string;
  readonly core: string;
  readonly createdDirectories: number;
  readonly existingDirectories: number;
  readonly createdFiles: number;
  readonly updatedFiles: number;
  readonly skippedFiles: number;
}

export interface AdoptExistingProjectResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly archiveDir: string;
  readonly archivePath: string;
  readonly manifestPath?: string;
  readonly moves: AdoptionMove[];
  readonly skipped: AdoptionSkippedEntry[];
  readonly failures: AdoptionFailure[];
  readonly scaffold?: AdoptionScaffoldMetadata;
  readonly init?: InitFrameworkResult;
  readonly eventFile?: string;
  readonly adoptionAnalysisPath?: string;
}

interface AdoptionPlan {
  readonly root: string;
  readonly archiveDir: string;
  readonly archivePath: string;
  readonly manifestRelativePath: string;
  readonly moves: AdoptionMove[];
  readonly skipped: AdoptionSkippedEntry[];
}

interface DirectoryEntry {
  readonly name: string;
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

async function directoryEntries(root: string): Promise<DirectoryEntry[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function timestampStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}-${hour}${minute}${second}`;
}

async function uniqueArchive(
  root: string,
  now: Date,
): Promise<{
  readonly archiveDir: string;
  readonly archivePath: string;
}> {
  const base = timestampStamp(now);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${String(index).padStart(2, "0")}`;
    const archiveDir = `${ADOPTION_ROOT}/${base}${suffix}`;
    const archivePath = path.join(root, archiveDir);
    if (!(await exists(archivePath))) {
      return { archiveDir, archivePath };
    }
  }

  throw new FrameworkError(`could not find a free adoption archive under ${ADOPTION_ROOT}`);
}

function adoptionManifestRelativePath(
  archiveDir: string,
  plannedDestinations: readonly string[],
): string {
  const occupied = new Set(plannedDestinations.map((destination) => path.basename(destination)));
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const filename = `${ADOPTION_MANIFEST_BASENAME}${suffix}${ADOPTION_MANIFEST_EXTENSION}`;
    if (!occupied.has(filename)) {
      return `${archiveDir}/${filename}`;
    }
  }

  throw new FrameworkError(`could not find a free adoption manifest name in ${archiveDir}`);
}

async function assertCanAdopt(root: string): Promise<void> {
  let rootStats: Awaited<ReturnType<typeof stat>>;
  try {
    rootStats = await stat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new FrameworkNotFoundError(`Cannot adopt missing project root: ${root}`);
    }
    throw error;
  }

  if (!rootStats.isDirectory()) {
    throw new FrameworkError(`Cannot adopt non-directory project root: ${root}`, {
      code: "IO_ERROR",
    });
  }

  const manifestPath = path.join(root, MANIFEST_FILE);
  if (await exists(manifestPath)) {
    throw new FrameworkAlreadyExistsError(
      `MetaSystem framework manifest already exists at ${manifestPath}. Use status, update, or migrate-layout instead of adopt.`,
    );
  }
}

async function buildAdoptionPlan(rootInput: string, now: Date): Promise<AdoptionPlan> {
  const root = path.resolve(rootInput);
  await assertCanAdopt(root);
  const archive = await uniqueArchive(root, now);
  const moves: AdoptionMove[] = [];
  const skipped: AdoptionSkippedEntry[] = [];

  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (SKIPPED_ROOT_ENTRIES.has(entry.name)) {
      skipped.push({
        path: entry.name,
        reason:
          entry.name === ".git"
            ? "preserved at project root"
            : "existing adoption archives are never moved into a new archive",
      });
      continue;
    }

    const destination = `${archive.archiveDir}/${entry.name}`;
    moves.push({ source: entry.name, destination, status: "planned" });
  }

  return {
    root,
    archiveDir: archive.archiveDir,
    archivePath: archive.archivePath,
    manifestRelativePath: adoptionManifestRelativePath(
      archive.archiveDir,
      moves.map((move) => move.destination),
    ),
    moves,
    skipped,
  };
}

function scaffoldMetadata(init: InitFrameworkResult): AdoptionScaffoldMetadata {
  return {
    project: init.project,
    core: init.core,
    createdDirectories: init.report.created_dirs.length,
    existingDirectories: init.report.existing_dirs.length,
    createdFiles: init.report.created_files.length,
    updatedFiles: init.report.updated_files.length,
    skippedFiles: init.report.skipped_files.length,
  };
}

async function writeAdoptionManifest(result: AdoptExistingProjectResult): Promise<string> {
  const manifestPath = path.join(result.root, result.manifestPath ?? "");
  if (!result.manifestPath) {
    throw new FrameworkError("adoption manifest path is missing");
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        root: result.root,
        dryRun: result.dryRun,
        archiveDir: result.archiveDir,
        archivePath: result.archivePath,
        moves: result.moves,
        skipped: result.skipped,
        failures: result.failures,
        scaffold: result.scaffold,
        eventFile: result.eventFile,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return result.manifestPath;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Suggest a target directory for an archived root entry based on its name.
 * Heuristic only — the user confirms the actual placement. This is what makes
 * adoption "propose a direction" instead of leaving .old/ as an undifferentiated
 * pile.
 */
function suggestDestination(entryName: string): string {
  const lower = entryName.toLowerCase();
  if (lower === "readme.md" || lower.startsWith("readme")) return "references/ or problem/";
  if (lower.endsWith(".md") || lower === "docs" || lower === "documentation")
    return "references/ or knowledge/guides/";
  if (lower === "src" || lower === "source" || lower === "lib") return "systems/<core>/";
  if (lower === "test" || lower === "tests" || lower === "spec") return "systems/<core>/tests/";
  if (lower === "data" || lower === "datasets") return "data/";
  if (lower === "scripts" || lower === "tools") return "systems/<core>/ or releases/";
  if (lower === ".git") return "preserved at root";
  return "systems/<core>/ or references/";
}

/**
 * Create an open adoption analysis containing an inventory of every archived
 * entry and a suggested destination. Returns the analysis path. `check` will
 * flag this analysis as an empty draft until it is filled and closed, so the
 * adoption cannot be silently abandoned.
 */
async function writeAdoptionAnalysis(
  root: string,
  archiveDir: string,
  moves: readonly AdoptionMove[],
  now: Date,
): Promise<string> {
  const title = "Adoption inventory";
  const analysis = await createAnalysis({ root, title, now });

  // Build the inventory table and append it to the analysis.
  const { readFile, writeFile } = await import("node:fs/promises");
  let content = await readFile(analysis.absolutePath, "utf8");
  const inventoryLines = [
    "## Adoption inventory",
    "",
    `Archived under \`${archiveDir}/\`. For each entry, decide where it lands in the new structure, then move it (do not copy by default).`,
    "",
    "| Archived entry | Suggested destination | Decision |",
    "| --- | --- | --- |",
  ];
  for (const move of moves) {
    const entry = path.basename(move.source);
    const suggestion = suggestDestination(entry);
    inventoryLines.push(`| ${entry} | ${suggestion} | (fill) |`);
  }
  inventoryLines.push("");
  inventoryLines.push("## Key observations");
  inventoryLines.push("");
  inventoryLines.push("- (Record what each meaningful artifact is and where it should live.)");

  content = content.replace("## Key observations", inventoryLines.join("\n"));
  await writeFile(analysis.absolutePath, content, "utf8");
  return analysis.path;
}

export async function adoptExistingProject(
  options: AdoptExistingProjectOptions,
): Promise<AdoptExistingProjectResult> {
  const dryRun = options.apply !== true;
  const now = options.now ?? new Date();
  const plan = await buildAdoptionPlan(options.root, now);
  const project = options.name ?? path.basename(plan.root);
  const core = options.core ?? `${slugify(project)}-core`;

  if (dryRun || options.dryRun === true) {
    return {
      root: plan.root,
      dryRun: true,
      archiveDir: plan.archiveDir,
      archivePath: plan.archivePath,
      manifestPath: plan.manifestRelativePath,
      moves: plan.moves,
      skipped: plan.skipped,
      failures: [],
    };
  }

  await mkdir(path.join(plan.root, ADOPTION_ROOT), { recursive: true });
  await mkdir(plan.archivePath, { recursive: false });
  const moves: AdoptionMove[] = [];
  const failures: AdoptionFailure[] = [];
  for (const move of plan.moves) {
    try {
      await rename(path.join(plan.root, move.source), path.join(plan.root, move.destination));
      moves.push({ ...move, status: "moved" });
    } catch (error) {
      moves.push({ ...move, status: "failed" });
      failures.push({
        source: move.source,
        destination: move.destination,
        message: failureMessage(error),
      });
    }
  }

  let init: InitFrameworkResult | undefined;
  let eventFile: string | undefined;
  const baseResult = {
    root: plan.root,
    dryRun: false,
    archiveDir: plan.archiveDir,
    archivePath: plan.archivePath,
    manifestPath: plan.manifestRelativePath,
    moves,
    skipped: plan.skipped,
    failures,
  };

  let adoptionAnalysisPath: string | undefined;
  if (failures.length === 0) {
    try {
      init = await initFramework({ target: plan.root, name: project, core });
      const eventPath = await appendEvent(plan.root, {
        archive: plan.archiveDir,
        event: "framework.adopted",
        moved: moves.length,
        project,
        core,
      });
      eventFile = relativeDisplayPath(eventPath, plan.root);
      await recordProjectLifecycleBestEffort(plan.root, "adopt");

      // Optionally open an adoption analysis so the archived content is tracked
      // to completion instead of left in .old/ to be forgotten.
      if (options.analyze === true) {
        adoptionAnalysisPath = await writeAdoptionAnalysis(plan.root, plan.archiveDir, moves, now);
      }
    } catch (error) {
      failures.push({
        source: ".",
        message: `scaffold initialization failed: ${failureMessage(error)}`,
      });
    }
  }

  const result: AdoptExistingProjectResult = {
    ...baseResult,
    failures,
    ...(init ? { init, scaffold: scaffoldMetadata(init) } : {}),
    ...(eventFile ? { eventFile } : {}),
    ...(adoptionAnalysisPath ? { adoptionAnalysisPath } : {}),
  };
  await writeAdoptionManifest(result);
  return result;
}
