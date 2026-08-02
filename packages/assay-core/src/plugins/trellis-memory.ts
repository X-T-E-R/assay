import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FrameworkError } from "../errors.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import { readTrellisConfigValues } from "./trellis-domains.js";
import {
  TRELLIS_PROTOCOL_VERSION,
  requireInstalledTrellisRuntimeReadOnly,
} from "./trellis-runtime.js";

export interface TrellisMemoryRecord {
  readonly id: string;
  readonly file: string;
  readonly timestamp: string | null;
  readonly preview: string;
  readonly diagnostics: readonly string[];
}

let memoryProbe: ((phase: "memory-before-open", target: string) => void | Promise<void>) | null =
  null;

/** Deterministic race barrier for memory path hardening probes. */
export function setTrellisMemoryProbeForTests(
  probe: ((phase: "memory-before-open", target: string) => void | Promise<void>) | null,
): void {
  memoryProbe = probe;
}

function bounded(value: unknown, limit = 2_000): string {
  const redact = (item: unknown): unknown =>
    item && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .slice(0, 100)
            .map(([key, entry]) => [
              key,
              /token|secret|password|authorization|cookie/i.test(key)
                ? "[redacted]"
                : redact(entry),
            ]),
        )
      : item;
  const text = (
    typeof value === "string" ? value : (JSON.stringify(redact(value)) ?? String(value))
  )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function fixtureFiles(root: string, maxFiles = 200): Promise<string[]> {
  const resolved = path.resolve(root);
  let canonicalRoot: string;
  try {
    if ((await lstat(resolved)).isSymbolicLink())
      throw new FrameworkError(`memory root is a reparse point: ${resolved}`);
    canonicalRoot = await realpath(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (output.length >= maxFiles) return;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (await lstat(target)).isSymbolicLink())
        throw new FrameworkError(`memory root crosses a reparse point: ${target}`);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        const canonical = await realpath(target);
        if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
          throw new FrameworkError(`memory file escapes root: ${target}`);
        if ((await stat(target)).nlink > 1)
          throw new FrameworkError(`memory hardlink rejected: ${target}`);
        output.push(target);
      }
    }
  };
  try {
    if ((await stat(resolved)).isDirectory()) await visit(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return output.sort();
}

function recordFromLine(file: string, line: string, index: number): TrellisMemoryRecord {
  const diagnostics: string[] = [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    diagnostics.push("malformed-json");
  }
  const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const idValue = value.id ?? value.session_id ?? value.thread_id ?? value.conversation_id;
  const timestampValue = value.timestamp ?? value.created_at ?? value.ts;
  if (!idValue) diagnostics.push("missing-id");
  return {
    id: typeof idValue === "string" ? idValue : `${path.basename(file)}:${index + 1}`,
    file,
    timestamp: typeof timestampValue === "string" ? timestampValue : null,
    preview: bounded(parsed ?? line),
    diagnostics,
  };
}

const MEMORY_RECORD_BUDGET = 500;
const MEMORY_DIAGNOSTIC_BUDGET = 100;

async function loadRecords(root: string, maxFiles = 200): Promise<TrellisMemoryRecord[]> {
  const records: TrellisMemoryRecord[] = [];
  const files = await fixtureFiles(root, maxFiles);
  if (files.length === 0) return records;
  const canonicalRoot = await realpath(path.resolve(root));
  const push = (record: TrellisMemoryRecord): boolean => {
    if (records.length >= MEMORY_RECORD_BUDGET) return false;
    records.push(record);
    return records.length < MEMORY_RECORD_BUDGET;
  };
  let totalBytes = 0;
  for (const file of files) {
    let text: string;
    try {
      await memoryProbe?.("memory-before-open", file);
      const handle = await open(file, "r");
      try {
        const opened = await handle.stat();
        if (opened.nlink > 1) throw new FrameworkError(`memory hardlink rejected: ${file}`);
        const current = await lstat(file);
        const canonical = await realpath(file);
        if (
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          !canonical.startsWith(`${canonicalRoot}${path.sep}`)
        )
          throw new FrameworkError(`memory file identity changed during open: ${file}`);
        const budget = Math.min(1_048_576, 5_242_880 - totalBytes);
        if (budget <= 0) break;
        const buffer = Buffer.alloc(budget + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        totalBytes += Math.min(bytesRead, budget);
        text = buffer.subarray(0, Math.min(bytesRead, budget)).toString("utf8");
        if (bytesRead > budget) text += '\n{"diagnostic":"file-byte-limit"}';
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof FrameworkError) throw error;
      push({
        id: path.basename(file),
        file,
        timestamp: null,
        preview: "",
        diagnostics: ["unreadable"],
      });
      if (records.length >= MEMORY_RECORD_BUDGET) break;
      continue;
    }
    const lines = file.endsWith(".jsonl") ? text.split(/\r?\n/).filter(Boolean) : [text];
    const partialTail = text.length > 0 && !text.endsWith("\n") && file.endsWith(".jsonl");
    for (const [index, line] of lines.entries()) {
      const record = recordFromLine(file, line, index);
      const next =
        partialTail && index === lines.length - 1
          ? { ...record, diagnostics: [...record.diagnostics, "partial-tail"] }
          : record;
      if (!push(next)) break;
    }
    if (records.length >= MEMORY_RECORD_BUDGET) break;
  }
  return records;
}

function result<T extends object>(value: T) {
  return {
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    plugin: TRELLIS_PLUGIN_ID,
    read_only: true as const,
    ...value,
  };
}
export async function listTrellisMemory(options: {
  workspaceRoot: string;
  memoryRoot?: string;
  limit?: number;
}) {
  await requireInstalledTrellisRuntimeReadOnly(options.workspaceRoot);
  const root = options.memoryRoot
    ? path.resolve(options.memoryRoot)
    : path.join(os.homedir(), ".codex", "sessions");
  const configured = await readTrellisConfigValues(options.workspaceRoot);
  const limit = Math.max(1, Math.min(options.limit ?? configured.mem_max_results, 500));
  const records = await loadRecords(root);
  const allDiagnostics = records.flatMap((record) =>
    record.diagnostics.map((diagnostic) => ({ id: record.id, diagnostic })),
  );
  return result({
    memory_root: root,
    records: records.slice(-limit),
    diagnostics: allDiagnostics.slice(0, MEMORY_DIAGNOSTIC_BUDGET),
    diagnostics_omitted: Math.max(0, allDiagnostics.length - MEMORY_DIAGNOSTIC_BUDGET),
  });
}
export async function showTrellisMemory(options: {
  workspaceRoot: string;
  id: string;
  memoryRoot?: string;
}) {
  const listed = await listTrellisMemory({
    workspaceRoot: options.workspaceRoot,
    ...(options.memoryRoot === undefined ? {} : { memoryRoot: options.memoryRoot }),
    limit: 500,
  });
  const record = listed.records.find((entry) => entry.id === options.id);
  if (!record) throw new FrameworkError(`Codex memory record '${options.id}' not found`);
  return result({ memory_root: listed.memory_root, record });
}
export async function searchTrellisMemory(options: {
  workspaceRoot: string;
  query: string;
  memoryRoot?: string;
  limit?: number;
}) {
  const listed = await listTrellisMemory({
    workspaceRoot: options.workspaceRoot,
    ...(options.memoryRoot === undefined ? {} : { memoryRoot: options.memoryRoot }),
    limit: 500,
  });
  const needle = options.query.toLocaleLowerCase();
  const records = listed.records
    .filter((entry) => entry.preview.toLocaleLowerCase().includes(needle))
    .slice(0, Math.max(1, Math.min(options.limit ?? 50, 500)));
  return result({ memory_root: listed.memory_root, query: options.query, records });
}
export async function contextTrellisMemory(options: {
  workspaceRoot: string;
  query?: string;
  memoryRoot?: string;
  limit?: number;
}) {
  const common = {
    workspaceRoot: options.workspaceRoot,
    ...(options.memoryRoot === undefined ? {} : { memoryRoot: options.memoryRoot }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
  const data = options.query
    ? await searchTrellisMemory({ ...common, query: options.query })
    : await listTrellisMemory(common);
  return result({
    memory_root: data.memory_root,
    context: bounded(data.records, 12_000),
    count: data.records.length,
  });
}
