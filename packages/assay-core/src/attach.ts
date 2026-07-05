import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stringify as stringifyYaml } from "yaml";

import { CURRENT_VERSION, MANAGED_DIR, MANIFEST_FILE, VERSION_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError } from "./errors.js";
import { appendEvent } from "./events.js";
import { defaultOverlayLayout, workspacePath } from "./layout.js";
import { defaultManifest, saveManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import type {
  SystemRecord,
  SystemsRegistry,
  WorkspaceLayout,
  WorkspacePrivacy,
} from "./schemas/index.js";
import { defaultSystemsRegistry, saveSystemsRegistry } from "./systems-registry.js";
import { nowIso } from "./time.js";

export interface AttachExistingRepoOptions {
  readonly root: string;
  readonly name?: string;
  readonly archetype?: string;
  readonly privacy?: WorkspacePrivacy;
  readonly noTrack?: boolean;
  readonly now?: Date;
}

export interface AttachResult {
  readonly root: string;
  readonly project: string;
  readonly privacy: WorkspacePrivacy;
  readonly layout: WorkspaceLayout;
  readonly system: SystemRecord;
  readonly registry: SystemsRegistry;
  readonly excludeUpdated: boolean;
  readonly eventFile: string;
}

const EXCLUDE_MARKER = "/.assay/";

async function exists(target: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isGitWorktree(root: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function gitTopLevel(root: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    reject: false,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Idempotently append `/.assay/` to the repo-local `.git/info/exclude` so the
 * overlay state directory stays out of product Git. Returns true when the
 * marker was added, false when it was already present.
 */
async function ensureGitInfoExclude(root: string): Promise<boolean> {
  const topLevel = await gitTopLevel(root);
  if (!topLevel) return false;
  const excludeFile = path.join(topLevel, ".git", "info", "exclude");
  let content = "";
  if (await exists(excludeFile)) {
    content = await readFile(excludeFile, "utf8");
    if (content.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_MARKER)) {
      return false;
    }
  }
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await mkdir(path.dirname(excludeFile), { recursive: true });
  await writeFile(
    excludeFile,
    `${content}${prefix}# Assay overlay state\n${EXCLUDE_MARKER}\n`,
    "utf8",
  );
  return true;
}

function rootSystemContract(): Record<string, unknown> {
  return {
    name: "root",
    kind: "primary-system",
    path: ".",
    vcs: "independent-git",
    notes: "The product repository root is the primary system in overlay mode.",
  };
}

/**
 * Attach Assay privately to an existing product repository. The repo root
 * becomes the primary system; all Assay-owned state and work folders live
 * under a single `.assay/` directory that product Git ignores by default.
 *
 * Unlike `assay init`, attach does not write root README, root .gitignore, or
 * root AGENTS.md. Tracked product files stay untouched.
 */
export async function attachExistingRepo(
  options: AttachExistingRepoOptions,
): Promise<AttachResult> {
  const root = path.resolve(options.root);
  const now = options.now ?? new Date();
  const privacy: WorkspacePrivacy = options.privacy ?? "private";

  if (await exists(path.join(root, MANIFEST_FILE))) {
    throw new FrameworkAlreadyExistsError(
      `Assay manifest already exists at ${path.join(root, MANIFEST_FILE)}. Use \`assay update\` or remove it first.`,
    );
  }
  if (await exists(path.join(root, ".framework", "manifest.json"))) {
    throw new FrameworkAlreadyExistsError(
      `Legacy .framework/manifest.json found at ${root}. Run \`assay migrate-layout --apply\` to migrate it to .assay/ before attaching.`,
    );
  }

  const isGit = await isGitWorktree(root);
  if (!isGit) {
    throw new FrameworkError(
      `attach expects a Git worktree; ${root} is not inside one. Initialize Git first or use \`assay init\` for a standalone workspace.`,
    );
  }

  const project = options.name ?? path.basename(root);
  const layout = defaultOverlayLayout(privacy);

  // Scaffold .assay/ state dirs.
  await mkdir(path.join(root, MANAGED_DIR), { recursive: true });
  for (const area of [
    "events",
    "backups",
    "references",
    "analyses",
    "iterations",
    "knowledge",
    "systemsContracts",
  ] as const) {
    await mkdir(workspacePath(root, layout, area), { recursive: true });
  }
  await writeFile(path.join(root, VERSION_FILE), CURRENT_VERSION, "utf8");

  // Manifest with overlay layout.
  const manifest = defaultManifest(project, {
    archetype: (options.archetype as never) ?? "study",
  });
  manifest.layout = layout;
  manifest.layout_version = 4;
  await saveManifest(root, manifest);

  // Systems registry: register the repo root as the primary system.
  const registry = defaultSystemsRegistry();
  const systemName = slugify(project);
  const systemRecord: SystemRecord = {
    name: systemName,
    path: ".",
    status: "primary",
    vcs: "independent-git",
    vcs_ref: "",
    version: "0.1.0",
    contract_file: `${MANAGED_DIR}/systems/root.yaml`,
    supersedes: [],
    absorbed_on: nowIso(now).slice(0, 10),
    archived_on: null,
    archive_path: null,
  };
  registry.systems[systemName] = systemRecord;
  registry.primary = systemName;
  await saveSystemsRegistry(root, registry);

  // Root system sidecar contract.
  const contractPath = path.join(root, MANAGED_DIR, "systems", "root.yaml");
  await mkdir(path.dirname(contractPath), { recursive: true });
  await writeFile(contractPath, stringifyYaml(rootSystemContract()), "utf8");

  // Privacy: keep .assay/ out of product Git.
  let excludeUpdated = false;
  if (privacy === "private" || privacy === "private-git") {
    excludeUpdated = await ensureGitInfoExclude(root);
  }
  if (privacy === "private-git") {
    const assayGit = path.join(root, MANAGED_DIR, ".git");
    if (!(await exists(assayGit))) {
      const result = await execa("git", ["init"], {
        cwd: path.join(root, MANAGED_DIR),
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new FrameworkError(
          `failed to initialize Git inside ${MANAGED_DIR}: ${(result.stderr || result.stdout).trim()}`,
        );
      }
    }
  }

  const eventFile = await appendEvent(
    root,
    {
      event: "workspace.attached",
      project,
      mode: "overlay",
      privacy,
      system: systemName,
      contract: relativeDisplayPath(contractPath, root),
    },
    now,
  );

  return {
    root,
    project,
    privacy,
    layout,
    system: systemRecord,
    registry,
    excludeUpdated,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}
