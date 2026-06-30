import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ADRS_FILE, MANIFEST_FILE } from "./constants.js";
import { FrameworkAlreadyExistsError, FrameworkError, FrameworkNotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { detectExternalGovernance } from "./governance.js";
import { loadManifest } from "./manifest.js";
import { relativeDisplayPath, slugify } from "./paths.js";
import { requireCapability } from "./profile.js";
import { type AdrIndex, type AdrRecord, type AdrStatus, adrIndexSchema } from "./schemas/index.js";
import { stringifySortedJson } from "./serialization.js";
import { nowIso } from "./time.js";

export interface AdrIndexOptions {
  readonly now?: Date;
  /** Skip external-governance deferral (e.g. trellis detected). */
  readonly force?: boolean;
}

export interface CreateAdrInput {
  readonly title: string;
  readonly relatedAnalysis?: string;
  readonly relatedIteration?: string;
}

export interface AdrMutationResult {
  readonly root: string;
  readonly index: AdrIndex;
  readonly adr: AdrRecord;
  readonly eventFile: string;
}

export interface SupersedeAdrResult {
  readonly root: string;
  readonly index: AdrIndex;
  readonly oldAdr: AdrRecord;
  readonly newAdr: AdrRecord;
  readonly eventFile: string;
}

export function adrIndexPath(root: string): string {
  return path.join(root, ADRS_FILE);
}

export function defaultAdrIndex(): AdrIndex {
  return {
    __schema: 1,
    next_number: 1,
    adrs: {},
    updated_at: nowIso(),
  };
}

export async function loadAdrIndex(root: string): Promise<AdrIndex | null> {
  const file = adrIndexPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new FrameworkError(`ADR index is not valid JSON: ${file}`, { cause: error });
  }

  const result = adrIndexSchema.safeParse(data);
  if (!result.success) {
    throw new FrameworkError(`ADR index failed validation: ${file}`, {
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  return result.data;
}

export async function saveAdrIndex(root: string, index: AdrIndex): Promise<AdrIndex> {
  const file = adrIndexPath(root);
  const next = adrIndexSchema.parse({ ...index, updated_at: nowIso() });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifySortedJson(next), "utf8");
  return next;
}

export async function requireAdrIndex(root: string): Promise<AdrIndex> {
  await requireCapability(root, "adr");
  const index = await loadAdrIndex(root);
  if (!index) {
    throw new FrameworkNotFoundError(
      `No ADR index found at ${adrIndexPath(root)}. Run \`metasystem adr new\` first.`,
    );
  }
  return index;
}

function requireFrameworkManifest(root: string): Promise<unknown> {
  return loadManifest(root).then((manifest) => {
    if (!manifest) {
      throw new FrameworkNotFoundError(
        `No framework manifest found at ${path.join(root, MANIFEST_FILE)}.`,
      );
    }
    return manifest;
  });
}

function adrNumberLabel(number: number): string {
  return String(number).padStart(4, "0");
}

function adrId(number: number, slug: string): string {
  return `ADR-${adrNumberLabel(number)}-${slug}`;
}

function yamlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function yamlNullable(value: string | null): string {
  return value === null ? "null" : yamlString(value);
}

function yamlArray(values: readonly string[]): string {
  return `[${values.map((value) => yamlString(value)).join(", ")}]`;
}

function adrFrontmatter(adr: AdrRecord): string {
  return [
    "---",
    `adr: ${adr.id}`,
    `title: ${yamlString(adr.title)}`,
    `status: ${adr.status}`,
    `date: ${adr.date}`,
    `supersedes: ${yamlArray(adr.supersedes)}`,
    `superseded_by: ${yamlNullable(adr.superseded_by)}`,
    `related_analysis: ${yamlNullable(adr.related_analysis)}`,
    `related_iteration: ${yamlNullable(adr.related_iteration)}`,
    "---",
  ].join("\n");
}

function adrMarkdown(adr: AdrRecord): string {
  return `${adrFrontmatter(adr)}

# ${adr.title}

## Context

## Decision

## Consequences
`;
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

async function syncAdrMarkdown(root: string, adr: AdrRecord): Promise<void> {
  const file = path.join(root, adr.path);
  if (!(await exists(file))) {
    return;
  }
  const current = await readFile(file, "utf8");
  const match = current.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = match?.[1] ?? current;
  await writeFile(file, `${adrFrontmatter(adr)}\n\n${body.trimStart()}`, "utf8");
}

function bySelector(index: AdrIndex, selector: string): AdrRecord[] {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const direct = index.adrs[trimmed];
  if (direct) {
    return [direct];
  }
  const numeric = trimmed.match(/^(?:ADR-)?0*(\d+)$/i)?.[1];
  if (numeric) {
    const number = Number.parseInt(numeric, 10);
    return Object.values(index.adrs).filter((adr) => adr.number === number);
  }
  return Object.values(index.adrs).filter((adr) => adr.id.startsWith(trimmed));
}

export function findAdr(index: AdrIndex, selector: string): AdrRecord {
  const matches = bySelector(index, selector);
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new FrameworkNotFoundError(
      `ADR selector '${selector}' is ambiguous (${matches.map((adr) => adr.id).join(", ")})`,
    );
  }
  throw new FrameworkNotFoundError(`ADR not found: ${selector}`);
}

export async function createAdr(
  rootInput: string,
  input: CreateAdrInput,
  options: AdrIndexOptions = {},
): Promise<AdrMutationResult> {
  const root = path.resolve(rootInput);
  await requireFrameworkManifest(root);
  await requireCapability(root, "adr");

  // Governance deferral (ADR-0005): if an external governance system (trellis,
  // superpowers, docs/adr/) is detected, defer ADR creation to it unless
  // --force.
  if (options.force !== true) {
    const governance = await detectExternalGovernance(root);
    if (governance.system !== "none") {
      throw new FrameworkError(
        `external governance detected (${governance.system} at ${governance.path}): ${governance.message}`,
        { code: "GOVERNANCE_DEFERRED" },
      );
    }
  }

  const now = options.now ?? new Date();
  const index = (await loadAdrIndex(root)) ?? defaultAdrIndex();
  const slug = slugify(input.title);
  const number = index.next_number;
  const id = adrId(number, slug);
  const date = nowIso(now).slice(0, 10);
  const relativePath = `knowledge/decisions/${id}.md`;
  const absolutePath = path.join(root, relativePath);

  if (index.adrs[id] || (await exists(absolutePath))) {
    throw new FrameworkAlreadyExistsError(`ADR already exists: ${id}`);
  }

  const adr: AdrRecord = {
    id,
    number,
    title: input.title,
    slug,
    status: "proposed",
    date,
    path: relativePath,
    supersedes: [],
    superseded_by: null,
    related_analysis: input.relatedAnalysis ?? null,
    related_iteration: input.relatedIteration ?? null,
  };
  index.adrs[id] = adr;
  index.next_number = number + 1;

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, adrMarkdown(adr), "utf8");
  const saved = await saveAdrIndex(root, index);
  const savedAdr = saved.adrs[id];
  if (!savedAdr) {
    throw new FrameworkError(`internal error: created ADR missing from index: ${id}`);
  }
  const eventFile = await appendEvent(
    root,
    {
      event: "adr.created",
      id,
      path: relativePath,
      status: savedAdr.status,
      title: input.title,
    },
    now,
  );

  return { root, index: saved, adr: savedAdr, eventFile: relativeDisplayPath(eventFile, root) };
}

function assertTransition(adr: AdrRecord, allowed: readonly AdrStatus[], action: string): void {
  if (!allowed.includes(adr.status)) {
    throw new FrameworkError(`cannot ${action} ADR '${adr.id}' from status '${adr.status}'`);
  }
}

export async function acceptAdr(
  rootInput: string,
  selector: string,
  options: AdrIndexOptions = {},
): Promise<AdrMutationResult> {
  const root = path.resolve(rootInput);
  await requireFrameworkManifest(root);
  await requireCapability(root, "adr");
  const now = options.now ?? new Date();
  const index = await requireAdrIndex(root);
  const adr = findAdr(index, selector);
  assertTransition(adr, ["proposed"], "accept");

  const accepted: AdrRecord = { ...adr, status: "accepted" };
  index.adrs[accepted.id] = accepted;
  await syncAdrMarkdown(root, accepted);
  const saved = await saveAdrIndex(root, index);
  const savedAdr = saved.adrs[accepted.id];
  if (!savedAdr) {
    throw new FrameworkError(`internal error: accepted ADR missing from index: ${accepted.id}`);
  }
  const eventFile = await appendEvent(
    root,
    { event: "adr.accepted", id: savedAdr.id, path: savedAdr.path },
    now,
  );

  return { root, index: saved, adr: savedAdr, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function supersedeAdr(
  rootInput: string,
  oldSelector: string,
  newSelector: string,
  options: AdrIndexOptions = {},
): Promise<SupersedeAdrResult> {
  const root = path.resolve(rootInput);
  await requireFrameworkManifest(root);
  await requireCapability(root, "adr");
  const now = options.now ?? new Date();
  const index = await requireAdrIndex(root);
  const oldAdr = findAdr(index, oldSelector);
  const newAdr = findAdr(index, newSelector);

  if (oldAdr.id === newAdr.id) {
    throw new FrameworkError(`ADR cannot supersede itself: ${oldAdr.id}`);
  }
  assertTransition(oldAdr, ["accepted"], "supersede");
  assertTransition(newAdr, ["accepted"], "supersede with replacement");

  const updatedOld: AdrRecord = {
    ...oldAdr,
    status: "superseded",
    superseded_by: newAdr.id,
  };
  const updatedNew: AdrRecord = {
    ...newAdr,
    supersedes: [...new Set([...newAdr.supersedes, oldAdr.id])],
  };
  index.adrs[updatedOld.id] = updatedOld;
  index.adrs[updatedNew.id] = updatedNew;

  await syncAdrMarkdown(root, updatedOld);
  await syncAdrMarkdown(root, updatedNew);
  const saved = await saveAdrIndex(root, index);
  const savedOld = saved.adrs[updatedOld.id];
  const savedNew = saved.adrs[updatedNew.id];
  if (!savedOld || !savedNew) {
    throw new FrameworkError("internal error: superseded ADRs missing from index");
  }
  const eventFile = await appendEvent(
    root,
    {
      event: "adr.superseded",
      old_id: savedOld.id,
      new_id: savedNew.id,
    },
    now,
  );

  return {
    root,
    index: saved,
    oldAdr: savedOld,
    newAdr: savedNew,
    eventFile: relativeDisplayPath(eventFile, root),
  };
}

export async function deprecateAdr(
  rootInput: string,
  selector: string,
  options: AdrIndexOptions = {},
): Promise<AdrMutationResult> {
  const root = path.resolve(rootInput);
  await requireFrameworkManifest(root);
  await requireCapability(root, "adr");
  const now = options.now ?? new Date();
  const index = await requireAdrIndex(root);
  const adr = findAdr(index, selector);
  assertTransition(adr, ["proposed", "accepted"], "deprecate");

  const deprecated: AdrRecord = { ...adr, status: "deprecated" };
  index.adrs[deprecated.id] = deprecated;
  await syncAdrMarkdown(root, deprecated);
  const saved = await saveAdrIndex(root, index);
  const savedAdr = saved.adrs[deprecated.id];
  if (!savedAdr) {
    throw new FrameworkError(`internal error: deprecated ADR missing from index: ${deprecated.id}`);
  }
  const eventFile = await appendEvent(
    root,
    { event: "adr.deprecated", id: savedAdr.id, path: savedAdr.path },
    now,
  );

  return { root, index: saved, adr: savedAdr, eventFile: relativeDisplayPath(eventFile, root) };
}

export async function listAdrs(
  rootInput: string,
  status?: AdrStatus,
): Promise<{ readonly index: AdrIndex; readonly adrs: AdrRecord[] }> {
  const root = path.resolve(rootInput);
  const index = await requireAdrIndex(root);
  const adrs = Object.values(index.adrs)
    .filter((adr) => status === undefined || adr.status === status)
    .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  return { index, adrs };
}
