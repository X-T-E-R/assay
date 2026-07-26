import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { createAdr, loadAdrIndex } from "./adrs.js";
import { MANIFEST_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { computeHash, normalizeText } from "./hashing.js";
import { defaultStandaloneLayout, intentSubpath, resolveWorkspaceLayout } from "./layout.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, resolveContainedPath, slugify } from "./paths.js";
import { requireCapability } from "./profile.js";
import type { FrameworkManifest, SystemRecord, SystemsRegistry } from "./schemas/index.js";
import { findSystem, loadSystemsRegistry } from "./systems-registry.js";
import { nowIso } from "./time.js";
import { yamlArray, yamlString } from "./yaml.js";

/** Subdirectories of the intent work folder. */
const ORIGINAL_DIR = "original";
const REQUIREMENTS_DIR = "requirements";

/** Capture file stem: capture date plus the first 12 hex of the body digest. */
const CAPTURE_ID_PATTERN = /^\d{8}-[0-9a-f]{12}$/;

/** Selector charset. Rejects path separators before the value reaches the filesystem. */
const CAPTURE_SELECTOR_PATTERN = /^[0-9a-f-]+$/;

export type IntentPromotionTarget = "requirement" | "decision";

export interface CaptureIntentOptions {
  readonly root: string;
  /** Intent text, captured verbatim. Mutually exclusive with `file`. */
  readonly text?: string;
  /** Workspace-relative file whose contents are the intent text. */
  readonly file?: string;
  /** System name or unique prefix; defaults to the registry primary. */
  readonly system?: string;
  /** Free-text provenance note (conversation, ticket, meeting). */
  readonly source?: string;
  /** Capture ids this record corrects. */
  readonly supersedes?: readonly string[];
  /** Record against a system whose intent authority is elsewhere, marked as a shadow copy. */
  readonly force?: boolean;
  readonly now?: Date;
}

export interface IntentCapture {
  readonly id: string;
  /** Workspace-relative path of the capture markdown. */
  readonly path: string;
  readonly system: string;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly source: string | null;
  readonly supersedes: readonly string[];
  /** True when the system's intent authority lives elsewhere and `--force` was used. */
  readonly shadow: boolean;
}

export interface CaptureIntentResult {
  readonly root: string;
  readonly capture: IntentCapture;
  /** False when an identical capture already existed and nothing was written. */
  readonly created: boolean;
  readonly absolutePath: string;
  readonly eventFile?: string;
  /**
   * Option names whose requested value differs from the record that already
   * exists. A capture is append-only, so these were not applied; empty
   * whenever the record was written by this call.
   */
  readonly ignoredOptions: readonly string[];
}

export interface PromoteIntentOptions {
  readonly root: string;
  /** Capture id or unique id prefix. */
  readonly capture: string;
  readonly to: IntentPromotionTarget;
  readonly title?: string;
  readonly now?: Date;
}

export interface PromoteIntentResult {
  readonly root: string;
  readonly capture: IntentCapture;
  readonly to: IntentPromotionTarget;
  /** Workspace-relative path of the requirement or ADR that was written. */
  readonly path: string;
  readonly title: string;
  /** Set only for `--to decision`. */
  readonly adrId?: string;
  readonly eventFile: string;
}

/**
 * Whether a listed record still matches what was recorded. `modified` is a
 * readable record whose body no longer hashes to its own digest; `unreadable`
 * is a file that no longer parses as an intent record at all.
 */
export type IntentIntegrity = "ok" | "modified" | "unreadable";

export interface IntentListEntry extends IntentCapture {
  /** Workspace-relative requirement paths that declare `derives_from: <id>`. */
  readonly requirements: readonly string[];
  /** ADR ids that declare `related_intent: <id>`. */
  readonly decisions: readonly string[];
  readonly integrity: IntentIntegrity;
  /** Set when `integrity` is not `ok`: what is wrong and how to resolve it. */
  readonly integrityMessage?: string;
}

export interface ListIntentOptions {
  readonly root: string;
  /** System name or unique prefix to filter by. */
  readonly system?: string;
  /** Also include captures scoped to systems the filtered system supersedes. */
  readonly includeLineage?: boolean;
}

export interface ListIntentResult {
  readonly root: string;
  /** Resolved system filter, or null when unfiltered. */
  readonly system: string | null;
  /** Systems whose captures are included; a single name unless lineage was requested. */
  readonly systems: readonly string[];
  readonly captures: readonly IntentListEntry[];
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

async function requireFrameworkManifest(root: string): Promise<FrameworkManifest> {
  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new FrameworkNotFoundError(
      `No framework manifest found at ${path.join(root, MANIFEST_FILE)}.`,
    );
  }
  return manifest;
}

function intentPath(manifest: FrameworkManifest, ...segments: readonly string[]): string {
  const layout = resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
  return intentSubpath(layout, ...segments);
}

function dateCompact(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}

function dateStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Body of an intent record, normalized so the digest is stable across
 * platforms and always ends in exactly the bytes the file will hold.
 */
function intentBody(text: string): string {
  const normalized = normalizeText(text);
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

/**
 * Split a record into its frontmatter mapping and its verbatim body. The
 * separator is exact (`---` line, blank line) so the body read back is byte
 * identical to the body that was hashed at capture time.
 */
function splitRecord(content: string): { readonly header: unknown; readonly body: string } | null {
  const match = normalizeText(content).match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  let header: unknown;
  try {
    header = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return null;
  }
  return { header, body: match[2] };
}

function headerString(header: Record<string, unknown>, field: string): string | null {
  const value = header[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function headerStringList(header: Record<string, unknown>, field: string): string[] {
  const value = header[field];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function captureFromRecord(
  id: string,
  relativePath: string,
  header: Record<string, unknown>,
  body: string,
): IntentCapture {
  return {
    id,
    path: relativePath,
    system: headerString(header, "system") ?? "",
    sha256: headerString(header, "sha256") ?? computeHash(body),
    capturedAt: headerString(header, "captured_at") ?? "",
    source: headerString(header, "source"),
    supersedes: headerStringList(header, "supersedes"),
    shadow: header.shadow === true,
  };
}

function renderCapture(capture: IntentCapture, body: string): string {
  const header = [
    "---",
    `intent: ${yamlString(capture.id)}`,
    `system: ${yamlString(capture.system)}`,
    `sha256: ${yamlString(capture.sha256)}`,
    `captured_at: ${yamlString(capture.capturedAt)}`,
    ...(capture.source === null ? [] : [`source: ${yamlString(capture.source)}`]),
    ...(capture.supersedes.length === 0 ? [] : [`supersedes: ${yamlArray(capture.supersedes)}`]),
    ...(capture.shadow ? ["shadow: true"] : []),
    "---",
  ].join("\n");
  return `${header}\n\n${body}`;
}

/**
 * Outcome of reading one capture file. Everything except `ok` is a record that
 * no longer matches what was written; the callers differ only in whether they
 * refuse or report it, so the check happens once and the decision is theirs.
 */
type CaptureInspection =
  | { readonly integrity: "ok"; readonly capture: IntentCapture }
  | { readonly integrity: "modified"; readonly capture: IntentCapture; readonly message: string }
  | { readonly integrity: "unreadable"; readonly capture: IntentCapture; readonly message: string };

/**
 * Read a recorded capture and check it still holds the text it was recorded
 * with. Captures are append-only: the digest in the frontmatter is what makes
 * a later identical capture a no-op instead of an overwrite, so a body that no
 * longer hashes to it is a modified record, not a new one.
 */
async function inspectCapture(
  root: string,
  relativePath: string,
  id: string,
): Promise<CaptureInspection | null> {
  const absolutePath = path.join(root, relativePath);
  if (!(await exists(absolutePath))) {
    return null;
  }
  const record = splitRecord(await readFile(absolutePath, "utf8"));
  if (!record) {
    return {
      integrity: "unreadable",
      // Nothing in the file can be trusted as frontmatter, so the entry
      // carries only what the filename already proves.
      capture: {
        id,
        path: relativePath,
        system: "",
        sha256: "",
        capturedAt: "",
        source: null,
        supersedes: [],
        shadow: false,
      },
      message: `intent capture '${id}' is not a readable intent record: ${relativePath}. Restore it from version control instead of editing captures in place.`,
    };
  }
  const header = record.header as Record<string, unknown>;
  const capture = captureFromRecord(id, relativePath, header, record.body);
  const recorded = headerString(header, "sha256");
  const actual = computeHash(record.body);
  if (recorded !== null && recorded !== actual) {
    return {
      integrity: "modified",
      capture,
      message: `intent capture '${id}' was modified after recording (recorded sha256 ${recorded}, current ${actual}). Captures are append-only: restore the file, or record the corrected text as a new capture with --supersedes ${id}.`,
    };
  }
  return { integrity: "ok", capture };
}

/**
 * Read a capture, refusing anything that no longer matches its recording.
 * Every path that writes or promotes goes through this; only `intent list`
 * downgrades a bad record to a marked entry instead of an error.
 */
async function readCapture(
  root: string,
  relativePath: string,
  id: string,
): Promise<IntentCapture | null> {
  const inspection = await inspectCapture(root, relativePath, id);
  if (inspection === null) {
    return null;
  }
  if (inspection.integrity !== "ok") {
    throw new FrameworkError(inspection.message);
  }
  return inspection.capture;
}

async function requireSystemsRegistryForIntent(root: string): Promise<SystemsRegistry> {
  const registry = await loadSystemsRegistry(root);
  if (!registry || Object.keys(registry.systems).length === 0) {
    throw new FrameworkNotFoundError(
      "intent is scoped to a registered system, and this workspace has none. Run `assay system register <path>` first.",
    );
  }
  return registry;
}

/**
 * Resolve the system an intent record belongs to. "primary" is resolved to the
 * system that currently holds that status, because the primary pointer moves
 * on `system promote` while a capture must keep naming the system it was
 * actually about.
 */
async function resolveIntentSystem(
  registry: SystemsRegistry,
  selector: string | undefined,
): Promise<SystemRecord> {
  const trimmed = selector?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed === "primary") {
    const primary = registry.primary ? registry.systems[registry.primary] : undefined;
    if (!primary) {
      throw new FrameworkNotFoundError(
        "no primary system is set; name the system this intent belongs to with --system <name>.",
      );
    }
    return primary;
  }
  return findSystem(registry, trimmed);
}

/**
 * Refuse to record intent for a system whose intent authority is elsewhere.
 * This is an authority boundary, not an adoption policy: Assay does not check
 * whether the pointer is reachable, and `--force` still records the text here,
 * marked as a shadow copy so it is never mistaken for the authoritative one.
 */
function resolveShadow(system: SystemRecord, force: boolean): boolean {
  const authority = system.intent_authority;
  const mode = authority?.mode ?? "inline";
  if (mode === "inline") {
    return false;
  }
  if (force) {
    return true;
  }
  const pointer = authority?.pointer;
  if (mode === "external") {
    throw new FrameworkError(
      `intent authority for system '${system.name}' is external; record it there instead: ${pointer ?? "(no pointer recorded)"}. Re-run with --force to keep a shadow copy in this workspace.`,
    );
  }
  throw new FrameworkError(
    `system '${system.name}' declares no intent authority (mode: none)${pointer === undefined ? "" : `: ${pointer}`}; it does not keep intent records. Re-run with --force to keep a shadow copy in this workspace.`,
  );
}

async function intentText(root: string, options: CaptureIntentOptions): Promise<string> {
  if (options.text !== undefined && options.file !== undefined) {
    throw new FrameworkError("pass intent text or a file, not both");
  }
  if (options.file !== undefined) {
    const resolved = resolveContainedPath(root, options.file, "intent source path");
    if (!(await exists(resolved.absolutePath))) {
      throw new FrameworkNotFoundError(`intent source file not found: ${resolved.relativePath}`);
    }
    return readFile(resolved.absolutePath, "utf8");
  }
  if (options.text === undefined) {
    throw new FrameworkError("intent text is required; pass text or a workspace-relative file");
  }
  return options.text;
}

/**
 * Resolve `--supersedes` to ids this workspace actually holds. A correction
 * chain is only worth anything if every link resolves, and a mistyped id would
 * otherwise be stored verbatim and point at nothing forever.
 */
async function resolveSupersedes(
  root: string,
  manifest: FrameworkManifest,
  requested: readonly string[] | undefined,
): Promise<string[]> {
  const ids = [
    ...new Set(
      (requested ?? []).map((value) => value.trim().toLowerCase()).filter((id) => id.length > 0),
    ),
  ];
  const problems: string[] = [];
  for (const id of ids) {
    if (!CAPTURE_ID_PATTERN.test(id)) {
      problems.push(`'${id}' is not a capture id (expected <YYYYMMDD>-<12 hex>)`);
      continue;
    }
    if (!(await exists(path.join(root, intentPath(manifest, ORIGINAL_DIR, `${id}.md`))))) {
      problems.push(`'${id}' is not a recorded capture in this workspace`);
    }
  }
  if (problems.length > 0) {
    throw new FrameworkError(
      `--supersedes must name recorded intent captures: ${problems.join("; ")}. Run \`assay intent list\` to see the recorded capture ids.`,
    );
  }
  return ids;
}

/**
 * A capture is content-addressed, so the same text always lands on the same
 * record. That is only a no-op when the second call meant the same record: a
 * different system, or a different authority marking, is a different claim and
 * must not disappear into a silent success.
 */
function assertSameCaptureScope(
  existing: IntentCapture,
  id: string,
  systemName: string,
  shadow: boolean,
): void {
  if (existing.system !== systemName) {
    throw new FrameworkError(
      `identical text is already recorded for system '${existing.system}' as capture '${id}'; a capture is scoped to one system, so recording it for '${systemName}' would leave it scoped to '${existing.system}'. Capture text specific to '${systemName}', or read the existing record with \`assay intent list --system ${existing.system}\`.`,
    );
  }
  if (existing.shadow !== shadow) {
    const recordedAs = existing.shadow ? "a shadow copy" : "the authoritative record";
    const requestedAs = shadow ? "a shadow copy" : "the authoritative record";
    throw new FrameworkError(
      `identical text is already recorded for system '${systemName}' as capture '${id}', marked as ${recordedAs}; this call would record it as ${requestedAs}. Captures are append-only: restore the intent authority the record was made under, or record the corrected text as a new capture with --supersedes ${id}.`,
    );
  }
}

/** Requested metadata an existing, unchanged record does not carry. */
function ignoredCaptureOptions(
  existing: IntentCapture,
  source: string | undefined,
  supersedes: readonly string[],
): string[] {
  const ignored: string[] = [];
  if (source !== undefined && source !== existing.source) {
    ignored.push("--source");
  }
  const recorded = new Set(existing.supersedes);
  if (
    supersedes.length > 0 &&
    (supersedes.length !== recorded.size || supersedes.some((id) => !recorded.has(id)))
  ) {
    ignored.push("--supersedes");
  }
  return ignored;
}

export async function captureIntent(options: CaptureIntentOptions): Promise<CaptureIntentResult> {
  const root = path.resolve(options.root);
  const manifest = await requireFrameworkManifest(root);
  await requireCapability(root, "intent");
  const now = options.now ?? new Date();

  const body = intentBody(await intentText(root, options));
  if (body.trim().length === 0) {
    throw new FrameworkError("intent text is empty; nothing to capture");
  }

  const registry = await requireSystemsRegistryForIntent(root);
  const system = await resolveIntentSystem(registry, options.system);
  const shadow = resolveShadow(system, options.force ?? false);

  const sha256 = computeHash(body);
  const id = `${dateCompact(now)}-${sha256.slice(0, 12)}`;
  const relativePath = intentPath(manifest, ORIGINAL_DIR, `${id}.md`);
  const absolutePath = path.join(root, relativePath);

  const supersedes = await resolveSupersedes(root, manifest, options.supersedes);

  const existing = await readCapture(root, relativePath, id);
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new FrameworkError(
        `intent capture '${id}' already records different text (sha256 ${existing.sha256}); refusing to overwrite it.`,
      );
    }
    assertSameCaptureScope(existing, id, system.name, shadow);
    return {
      root,
      capture: existing,
      created: false,
      absolutePath,
      ignoredOptions: ignoredCaptureOptions(existing, options.source, supersedes),
    };
  }

  const capture: IntentCapture = {
    id,
    path: relativePath,
    system: system.name,
    sha256,
    capturedAt: nowIso(now),
    source: options.source ?? null,
    supersedes,
    shadow,
  };

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, renderCapture(capture, body), "utf8");
  const eventFile = await appendEvent(
    root,
    {
      event: "intent.captured",
      id,
      path: relativePath,
      system: capture.system,
      sha256,
      shadow,
      supersedes: capture.supersedes,
    },
    now,
  );

  return {
    root,
    capture,
    created: true,
    absolutePath,
    eventFile: relativeDisplayPath(eventFile, root),
    ignoredOptions: [],
  };
}

async function listCaptureIds(root: string, originalRoot: string): Promise<string[]> {
  const directory = path.join(root, originalRoot);
  if (!(await exists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .filter((id) => CAPTURE_ID_PATTERN.test(id))
    .sort();
}

/**
 * Resolve a capture selector to exactly one recorded capture. The selector is
 * charset-checked before it reaches the filesystem, so a path-shaped argument
 * is rejected instead of resolving to a file outside `intent/original/`.
 */
async function findCapture(
  root: string,
  manifest: FrameworkManifest,
  selector: string,
): Promise<IntentCapture> {
  const trimmed = selector.trim().toLowerCase();
  if (trimmed.length === 0 || !CAPTURE_SELECTOR_PATTERN.test(trimmed)) {
    throw new FrameworkError(
      `invalid intent capture selector '${selector}'; use a capture id such as 20260726-0a1b2c3d4e5f or a unique prefix of one`,
      { code: "IO_ERROR" },
    );
  }

  const originalRoot = intentPath(manifest, ORIGINAL_DIR);
  const ids = await listCaptureIds(root, originalRoot);
  const matches = ids.includes(trimmed) ? [trimmed] : ids.filter((id) => id.startsWith(trimmed));
  if (matches.length > 1) {
    throw new FrameworkNotFoundError(
      `intent capture selector '${selector}' is ambiguous (${matches.join(", ")})`,
    );
  }
  const id = matches[0];
  if (id === undefined) {
    throw new FrameworkNotFoundError(`intent capture not found: ${selector}`);
  }
  const capture = await readCapture(root, `${originalRoot}/${id}.md`, id);
  if (!capture) {
    throw new FrameworkNotFoundError(`intent capture not found: ${selector}`);
  }
  return capture;
}

function requirementMarkdown(input: {
  readonly title: string;
  readonly system: string;
  readonly derivesFrom: string;
  readonly createdAt: string;
}): string {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `system: ${yamlString(input.system)}`,
    `derives_from: ${yamlString(input.derivesFrom)}`,
    `created_at: ${yamlString(input.createdAt)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Requirement",
    "",
    "## Acceptance",
    "",
    "## Out of scope",
    "",
  ].join("\n");
}

export async function promoteIntent(options: PromoteIntentOptions): Promise<PromoteIntentResult> {
  const root = path.resolve(options.root);
  const manifest = await requireFrameworkManifest(root);
  await requireCapability(root, "intent");
  const now = options.now ?? new Date();
  const capture = await findCapture(root, manifest, options.capture);
  const title = options.title?.trim() || `Intent ${capture.id}`;

  if (options.to === "decision") {
    const result = await createAdr(
      root,
      { title, relatedIntent: capture.id, system: capture.system },
      { now },
    );
    const eventFile = await appendEvent(
      root,
      {
        event: "intent.promoted",
        id: capture.id,
        to: "decision",
        path: result.adr.path,
        adr: result.adr.id,
        system: capture.system,
      },
      now,
    );
    return {
      root,
      capture,
      to: "decision",
      path: result.adr.path,
      title,
      adrId: result.adr.id,
      eventFile: relativeDisplayPath(eventFile, root),
    };
  }

  const relativePath = intentPath(
    manifest,
    REQUIREMENTS_DIR,
    `${dateStamp(now)}-${slugify(title)}.md`,
  );
  const absolutePath = path.join(root, relativePath);
  if (await exists(absolutePath)) {
    throw new FrameworkAlreadyExistsError(`requirement already exists: ${relativePath}`);
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    requirementMarkdown({
      title,
      system: capture.system,
      derivesFrom: capture.id,
      createdAt: nowIso(now),
    }),
    "utf8",
  );
  const eventFile = await appendEvent(
    root,
    {
      event: "intent.promoted",
      id: capture.id,
      to: "requirement",
      path: relativePath,
      system: capture.system,
    },
    now,
  );

  return {
    root,
    capture,
    to: "requirement",
    path: relativePath,
    title,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

/** Requirement paths grouped by the capture id each one derives from. */
async function requirementsByCapture(
  root: string,
  manifest: FrameworkManifest,
): Promise<Map<string, string[]>> {
  const byCapture = new Map<string, string[]>();
  const requirementsRoot = intentPath(manifest, REQUIREMENTS_DIR);
  const directory = path.join(root, requirementsRoot);
  if (!(await exists(directory))) {
    return byCapture;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") {
      continue;
    }
    const relativePath = `${requirementsRoot}/${entry.name}`;
    let record: ReturnType<typeof splitRecord>;
    try {
      record = splitRecord(await readFile(path.join(directory, entry.name), "utf8"));
    } catch {
      continue;
    }
    if (!record) continue;
    const derivesFrom = headerString(record.header as Record<string, unknown>, "derives_from");
    if (derivesFrom === null) continue;
    byCapture.set(derivesFrom, [...(byCapture.get(derivesFrom) ?? []), relativePath]);
  }
  return byCapture;
}

/** ADR ids grouped by the capture id each one answers. */
async function decisionsByCapture(root: string): Promise<Map<string, string[]>> {
  const byCapture = new Map<string, string[]>();
  let index: Awaited<ReturnType<typeof loadAdrIndex>> = null;
  try {
    index = await loadAdrIndex(root);
  } catch {
    return byCapture;
  }
  for (const adr of Object.values(index?.adrs ?? {})) {
    if (adr.related_intent === undefined) continue;
    byCapture.set(adr.related_intent, [...(byCapture.get(adr.related_intent) ?? []), adr.id]);
  }
  return byCapture;
}

/**
 * The named system plus every system reachable through `supersedes`. A capture
 * names the system that was current when it was recorded, so answering "what
 * was ever asked of this system" has to walk the chain the registry already
 * keeps rather than a lineage id of its own.
 */
function lineageClosure(registry: SystemsRegistry, name: string): string[] {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const superseded of registry.systems[current]?.supersedes ?? []) {
      if (!seen.has(superseded)) {
        queue.push(superseded);
      }
    }
  }
  return [...seen].sort();
}

export async function listIntent(options: ListIntentOptions): Promise<ListIntentResult> {
  const root = path.resolve(options.root);
  const manifest = await requireFrameworkManifest(root);
  await requireCapability(root, "intent");

  let systemFilter: string | null = null;
  let systems: string[] = [];
  if (options.system !== undefined) {
    const registry = await requireSystemsRegistryForIntent(root);
    const system = await resolveIntentSystem(registry, options.system);
    systemFilter = system.name;
    systems = options.includeLineage ? lineageClosure(registry, system.name) : [system.name];
  }

  const originalRoot = intentPath(manifest, ORIGINAL_DIR);
  const requirements = await requirementsByCapture(root, manifest);
  const decisions = await decisionsByCapture(root);

  const captures: IntentListEntry[] = [];
  for (const id of await listCaptureIds(root, originalRoot)) {
    // Listing is how a workspace finds out one of its records went bad, so a
    // damaged capture is reported in place rather than allowed to take every
    // other capture down with it. Writing and promoting still refuse outright.
    const inspection = await inspectCapture(root, `${originalRoot}/${id}.md`, id);
    if (!inspection) continue;
    const { capture } = inspection;
    // An unreadable record has no trustworthy system name, so it survives the
    // filter: dropping it would hide the damage from every scoped listing.
    const scoped = inspection.integrity === "unreadable" || systems.includes(capture.system);
    if (systemFilter !== null && !scoped) continue;
    captures.push({
      ...capture,
      requirements: requirements.get(id) ?? [],
      decisions: decisions.get(id) ?? [],
      integrity: inspection.integrity,
      ...(inspection.integrity === "ok" ? {} : { integrityMessage: inspection.message }),
    });
  }

  return { root, system: systemFilter, systems, captures };
}
