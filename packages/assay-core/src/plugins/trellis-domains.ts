import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { FrameworkError } from "../errors.js";
import { nowIso } from "../time.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import {
  TRELLIS_PROTOCOL_VERSION,
  TRELLIS_RUNTIME_STATE_FILE,
  type TrellisRuntimeState,
  type TrellisTaskRecord,
  requireInstalledTrellisRuntime,
  trellisRuntimeStateSchema,
  trellisTaskRecordSchema,
  withInstalledTrellisMutation,
} from "./trellis-runtime.js";
import {
  applyTrellisWal,
  pathExists,
  readJson,
  readJsonLines,
  recoverTrellisWal,
  safeTrellisPath,
  withTrellisLock,
} from "./trellis-storage.js";

const TASKS = ".assay/trellis/tasks";
const ARCHIVE = ".assay/trellis/archive";
const SESSIONS = ".assay/trellis/sessions.json";
const JOURNAL = ".assay/trellis/journal/events.jsonl";
const CONFIG = ".assay/trellis/config.json";
const CHANNELS = ".assay/trellis/channels";
const WORKERS = ".assay/trellis/workers.json";
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .refine((value) => value !== "." && value !== "..", "dot-segment ids are unsafe");

function envelope<T extends object>(
  value: T,
): T & { plugin: typeof TRELLIS_PLUGIN_ID; protocol_version: 1 } {
  return { protocol_version: TRELLIS_PROTOCOL_VERSION, plugin: TRELLIS_PLUGIN_ID, ...value };
}

function taskFile(id: string): string {
  return `${TASKS}/${trellisTaskRecordSchema.shape.id.parse(id)}.json`;
}
async function state(root: string): Promise<TrellisRuntimeState> {
  return (await readJson(
    root,
    TRELLIS_RUNTIME_STATE_FILE,
    trellisRuntimeStateSchema,
  )) as TrellisRuntimeState;
}
async function task(root: string, id: string): Promise<TrellisTaskRecord> {
  const value = await readJson(root, taskFile(id), trellisTaskRecordSchema);
  if (value.id !== id) throw new FrameworkError(`Trellis task file identity mismatch: ${id}`);
  return value;
}
function closePointers(
  current: TrellisRuntimeState,
  id: string,
  timestamp: string,
): TrellisRuntimeState {
  const sessions = Object.fromEntries(
    Object.entries(current.session_currents).filter(([, value]) => value !== id),
  );
  return trellisRuntimeStateSchema.parse({
    ...current,
    current_task_id: current.current_task_id === id ? null : current.current_task_id,
    session_currents: sessions,
    updated_at: timestamp,
  });
}
function resolvePointer(current: TrellisRuntimeState, sessionId?: string): string | null {
  if (sessionId) return current.session_currents[sessionId] ?? null;
  if (current.current_task_id) return current.current_task_id;
  const ids = [...new Set(Object.values(current.session_currents))];
  if (ids.length > 1)
    throw new FrameworkError(
      "current Trellis task is ambiguous across sessions; pass --session-id",
    );
  return ids[0] ?? null;
}

export async function transitionTrellisTask(options: {
  root: string;
  taskId?: string;
  sessionId?: string;
  status: "completed" | "cancelled";
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const current = await state(root);
    const id = options.taskId ?? resolvePointer(current, options.sessionId);
    if (!id) throw new FrameworkError("no current Trellis task");
    const record = await task(root, id);
    if (record.status !== "open" && record.status !== options.status)
      throw new FrameworkError(`task '${id}' is already ${record.status}`);
    const timestamp = nowIso(options.now ?? new Date());
    if (record.status === options.status) {
      const hadPointer =
        current.current_task_id === id || Object.values(current.session_currents).includes(id);
      if (hadPointer)
        await applyTrellisWal(root, `task.${options.status}.close-pointers`, [
          { path: TRELLIS_RUNTIME_STATE_FILE, value: closePointers(current, id, timestamp) },
        ]);
      return envelope({ task: record, changed: hadPointer });
    }
    const next = trellisTaskRecordSchema.parse({
      ...record,
      status: options.status,
      updated_at: timestamp,
    });
    await applyTrellisWal(root, `task.${options.status}`, [
      { path: taskFile(id), value: next },
      { path: TRELLIS_RUNTIME_STATE_FILE, value: closePointers(current, id, timestamp) },
    ]);
    return envelope({ task: next, changed: true });
  });
}

export async function showTrellisTask(options: { root: string; taskId: string }) {
  await requireInstalledTrellisRuntime(options.root);
  return envelope({ task: await task(options.root, options.taskId) });
}

const archiveIndexSchema = z
  .object({
    __schema: z.literal(1),
    tasks: z.record(z.string(), z.object({ path: z.string(), archived_at: z.string() }).strict()),
  })
  .strict();
export async function listTrellisTasks(options: {
  root: string;
  status?: "open" | "completed" | "cancelled";
  limit?: number;
  after?: string;
  archived?: boolean;
}) {
  await requireInstalledTrellisRuntime(options.root);
  const root = path.resolve(options.root);
  const directory = options.archived ? `${ARCHIVE}/tasks` : TASKS;
  const { readdir } = await import("node:fs/promises");
  let names: string[] = [];
  try {
    names = (await readdir(await safeTrellisPath(root, directory)))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const records: TrellisTaskRecord[] = [];
  for (const name of names) {
    const value = await readJson(root, `${directory}/${name}`, trellisTaskRecordSchema);
    if (
      (!options.status || value.status === options.status) &&
      (!options.after || value.id > options.after)
    )
      records.push(value);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const items = records.slice(0, limit);
  return envelope({
    tasks: items,
    next_cursor: records.length > limit ? (items.at(-1)?.id ?? null) : null,
    archived: options.archived === true,
  });
}

export async function archiveTrellisTask(options: { root: string; taskId: string; now?: Date }) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    let index: z.infer<typeof archiveIndexSchema> = { __schema: 1, tasks: {} };
    if (await pathExists(path.join(root, `${ARCHIVE}/index.json`)))
      index = await readJson(root, `${ARCHIVE}/index.json`, archiveIndexSchema);
    const archived = index.tasks[options.taskId];
    if (archived)
      return envelope({
        task: await readJson(root, archived.path, trellisTaskRecordSchema),
        archived: false,
        path: archived.path,
      });
    const record = await task(root, options.taskId);
    if (record.status === "open") throw new FrameworkError("only terminal tasks can be archived");
    const target = `${ARCHIVE}/tasks/${record.id}.json`;
    index.tasks[record.id] = { path: target, archived_at: nowIso(options.now ?? new Date()) };
    const current = await state(root);
    await applyTrellisWal(
      root,
      "task.archive",
      [
        { path: target, value: record },
        { path: `${ARCHIVE}/index.json`, value: index },
        {
          path: TRELLIS_RUNTIME_STATE_FILE,
          value: closePointers(current, record.id, nowIso(options.now ?? new Date())),
        },
      ],
      [taskFile(record.id)],
    );
    return envelope({ task: record, archived: true, path: target });
  });
}

const sessionRecordSchema = z
  .object({
    id: idSchema,
    status: z.enum(["active", "ended"]),
    started_at: z.string(),
    updated_at: z.string(),
    ended_at: z.string().nullable(),
  })
  .strict();
const sessionsSchema = z
  .object({
    __schema: z.literal(1),
    sessions: z.record(idSchema, sessionRecordSchema),
    updated_at: z.string(),
  })
  .strict();
async function sessions(root: string) {
  return readJson(root, SESSIONS, sessionsSchema);
}
async function sessionsOrDefault(root: string) {
  try {
    return await sessions(root);
  } catch (error) {
    if (!(await pathExists(path.join(root, SESSIONS))))
      return { __schema: 1 as const, sessions: {}, updated_at: nowIso() };
    const raw = JSON.parse(await readFile(path.join(root, SESSIONS), "utf8")) as {
      __schema: number;
      sessions: Record<string, Record<string, unknown>>;
      updated_at: string;
    };
    return sessionsSchema.parse({
      ...raw,
      sessions: Object.fromEntries(
        Object.entries(raw.sessions ?? {}).map(([id, value]) => {
          const { current_task_id: _legacyPointer, ...rest } = value;
          return [id, rest];
        }),
      ),
    });
  }
}
export async function startTrellisSession(options: {
  root: string;
  sessionId: string;
  taskId?: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  const id = idSchema.parse(options.sessionId);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const domain = await sessionsOrDefault(root);
    const current = await state(root);
    const timestamp = nowIso(options.now ?? new Date());
    const prior = domain.sessions[id];
    if (prior?.status === "active") return envelope({ session: prior, changed: false });
    if (options.taskId) {
      const record = await task(root, options.taskId);
      if (record.status !== "open") throw new FrameworkError("session can only bind an open task");
    }
    const record = sessionRecordSchema.parse({
      id,
      status: "active",
      started_at: timestamp,
      updated_at: timestamp,
      ended_at: null,
    });
    domain.sessions[id] = record;
    domain.updated_at = timestamp;
    const nextState = trellisRuntimeStateSchema.parse({
      ...current,
      session_currents: options.taskId
        ? { ...current.session_currents, [id]: options.taskId }
        : current.session_currents,
      updated_at: timestamp,
    });
    await applyTrellisWal(root, "session.start", [
      { path: SESSIONS, value: domain },
      { path: TRELLIS_RUNTIME_STATE_FILE, value: nextState },
    ]);
    return envelope({ session: record, changed: true });
  });
}
function chooseSession(domain: z.infer<typeof sessionsSchema>, id?: string) {
  if (id) return domain.sessions[id] ?? null;
  const active = Object.values(domain.sessions).filter((entry) => entry.status === "active");
  if (active.length > 1)
    throw new FrameworkError("current Trellis session is ambiguous; pass --session-id");
  return active[0] ?? null;
}
export async function currentTrellisSession(options: { root: string; sessionId?: string }) {
  await requireInstalledTrellisRuntime(options.root);
  const selected = chooseSession(await sessionsOrDefault(options.root), options.sessionId);
  const runtime = await state(options.root);
  return envelope({
    session: selected
      ? { ...selected, current_task_id: runtime.session_currents[selected.id] ?? null }
      : null,
  });
}
export async function endTrellisSession(options: { root: string; sessionId?: string; now?: Date }) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const domain = await sessionsOrDefault(root);
    const record = chooseSession(domain, options.sessionId);
    if (!record) throw new FrameworkError("no active Trellis session");
    if (record.status === "ended") return envelope({ session: record, changed: false });
    const timestamp = nowIso(options.now ?? new Date());
    const next = sessionRecordSchema.parse({
      ...record,
      status: "ended",
      ended_at: timestamp,
      updated_at: timestamp,
    });
    domain.sessions[next.id] = next;
    domain.updated_at = timestamp;
    const current = await state(root);
    const pointers = { ...current.session_currents };
    delete pointers[next.id];
    await applyTrellisWal(root, "session.end", [
      { path: SESSIONS, value: domain },
      {
        path: TRELLIS_RUNTIME_STATE_FILE,
        value: trellisRuntimeStateSchema.parse({
          ...current,
          session_currents: pointers,
          updated_at: timestamp,
        }),
      },
    ]);
    return envelope({ session: next, changed: true });
  });
}
export async function rebindTrellisSession(options: {
  root: string;
  sessionId: string;
  taskId: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const domain = await sessionsOrDefault(root);
    const record = domain.sessions[idSchema.parse(options.sessionId)];
    if (!record || record.status !== "active")
      throw new FrameworkError(`active session '${options.sessionId}' not found`);
    const selected = await task(root, options.taskId);
    if (selected.status !== "open") throw new FrameworkError("session can only bind an open task");
    const timestamp = nowIso(options.now ?? new Date());
    const next = sessionRecordSchema.parse({ ...record, updated_at: timestamp });
    domain.sessions[next.id] = next;
    domain.updated_at = timestamp;
    const current = await state(root);
    await applyTrellisWal(root, "session.rebind", [
      { path: SESSIONS, value: domain },
      {
        path: TRELLIS_RUNTIME_STATE_FILE,
        value: trellisRuntimeStateSchema.parse({
          ...current,
          session_currents: { ...current.session_currents, [next.id]: selected.id },
          updated_at: timestamp,
        }),
      },
    ]);
    return envelope({ session: next, changed: true });
  });
}

export const trellisJournalEntrySchema = z
  .object({
    __schema: z.literal(1),
    seq: z.number().int().positive(),
    id: z.string().uuid(),
    timestamp: z.string(),
    kind: idSchema,
    message: z.string().min(1).max(10_000),
    task_id: trellisTaskRecordSchema.shape.id.nullable(),
    session_id: idSchema.nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export async function appendTrellisJournal(options: {
  root: string;
  kind: string;
  message: string;
  taskId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const entries = await readJsonLines(root, JOURNAL, trellisJournalEntrySchema);
    const entry = trellisJournalEntrySchema.parse({
      __schema: 1,
      seq: (entries.at(-1)?.seq ?? 0) + 1,
      id: randomUUID(),
      timestamp: nowIso(options.now ?? new Date()),
      kind: options.kind,
      message: options.message,
      task_id: options.taskId ?? null,
      session_id: options.sessionId ?? null,
      data: options.data ?? null,
    });
    entries.push(entry);
    await applyTrellisWal(root, "journal.append", [{ path: JOURNAL, value: entries, jsonl: true }]);
    return envelope({ entry });
  });
}
export async function listTrellisJournal(options: {
  root: string;
  limit?: number;
  after?: string;
  kind?: string;
}) {
  await requireInstalledTrellisRuntime(options.root);
  const all = await readJsonLines(options.root, JOURNAL, trellisJournalEntrySchema);
  const after = options.after === undefined ? 0 : Number(options.after);
  if (!Number.isInteger(after) || after < 0)
    throw new FrameworkError(`unknown journal cursor '${options.after}'`);
  if (after > 0 && !all.some((entry) => entry.seq === after))
    throw new FrameworkError(`unknown journal cursor '${options.after}'`);
  const filtered = all.filter(
    (entry) => entry.seq > after && (!options.kind || entry.kind === options.kind),
  );
  const configured = await readTrellisConfigValues(options.root);
  const limit = Math.max(1, Math.min(options.limit ?? configured.journal_page_size, 500));
  const entries = filtered.slice(0, limit);
  return envelope({
    entries,
    next_cursor: filtered.length > limit ? String(entries.at(-1)?.seq ?? after) : null,
  });
}
export async function showTrellisJournal(options: { root: string; id: string }) {
  await requireInstalledTrellisRuntime(options.root);
  const entry = (await readJsonLines(options.root, JOURNAL, trellisJournalEntrySchema)).find(
    (value) => value.id === options.id,
  );
  if (!entry) throw new FrameworkError(`journal entry '${options.id}' not found`);
  return envelope({ entry });
}

export const TRELLIS_CONFIG_KEYS = [
  "journal_page_size",
  "channel_page_size",
  "lock_stale_ms",
  "lease_ttl_ms",
  "mem_max_results",
] as const;
const configSchema = z
  .object({
    __schema: z.literal(1),
    values: z
      .object({
        journal_page_size: z.number().int().min(1).max(500).optional(),
        channel_page_size: z.number().int().min(1).max(500).optional(),
        lock_stale_ms: z.number().int().min(1000).max(600_000).optional(),
        lease_ttl_ms: z.number().int().min(1000).max(86_400_000).optional(),
        mem_max_results: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    updated_at: z.string(),
  })
  .strict();
const DEFAULT_CONFIG = {
  journal_page_size: 100,
  channel_page_size: 100,
  lock_stale_ms: 30_000,
  lease_ttl_ms: 60_000,
  mem_max_results: 50,
};
const ttlMillisecondsSchema = z.number().int().min(1000).max(86_400_000);
export async function readTrellisConfigValues(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
) {
  let file: z.infer<typeof configSchema> | null = null;
  if (await pathExists(path.join(root, CONFIG))) file = await readJson(root, CONFIG, configSchema);
  const values = { ...DEFAULT_CONFIG, ...(file?.values ?? {}) } as Record<string, number>;
  for (const key of TRELLIS_CONFIG_KEYS) {
    const raw = env[`ASSAY_TRELLIS_${key.toUpperCase()}`];
    if (raw !== undefined) values[key] = Number(raw);
  }
  Object.assign(values, overrides);
  return { ...DEFAULT_CONFIG, ...configSchema.shape.values.parse(values) } as typeof DEFAULT_CONFIG;
}
export async function showTrellisConfig(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<typeof DEFAULT_CONFIG>;
}) {
  await requireInstalledTrellisRuntime(options.root);
  const values = await readTrellisConfigValues(
    options.root,
    options.env ?? process.env,
    options.overrides ?? {},
  );
  return envelope({
    values,
    sources: { precedence: ["cli", "env", "file", "defaults"] },
  });
}
export async function setTrellisConfig(options: {
  root: string;
  key: string;
  value: number;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  if (!(TRELLIS_CONFIG_KEYS as readonly string[]).includes(options.key))
    throw new FrameworkError(`unsupported Trellis config key '${options.key}'`);
  return withInstalledTrellisMutation(root, async () => {
    let current: z.infer<typeof configSchema> = { __schema: 1, values: {}, updated_at: nowIso() };
    if (await pathExists(path.join(root, CONFIG)))
      current = await readJson(root, CONFIG, configSchema);
    const next = configSchema.parse({
      ...current,
      values: { ...current.values, [options.key]: options.value },
      updated_at: nowIso(options.now ?? new Date()),
    });
    await applyTrellisWal(root, "config.set", [{ path: CONFIG, value: next }]);
    return envelope({ config: next });
  });
}

const channelMetaSchema = z
  .object({
    __schema: z.literal(1),
    name: idSchema,
    next_seq: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    idempotency: z.record(z.string(), z.number().int().positive()),
  })
  .strict();
const channelEventSchema = z
  .object({
    __schema: z.literal(1),
    seq: z.number().int().positive(),
    id: z.string().uuid(),
    sent_at: z.string(),
    sender: idSchema.nullable(),
    type: idSchema,
    payload: z.unknown(),
    idempotency_key: z.string().nullable(),
  })
  .strict();
const leaseSchema = z
  .object({
    owner: idSchema,
    token: z.string().uuid(),
    acquired_at: z.string(),
    expires_at: z.string(),
  })
  .strict();
const channelStateSchema = z
  .object({
    __schema: z.literal(1),
    cursors: z.record(idSchema, z.number().int().nonnegative()),
    leases: z.record(idSchema, leaseSchema),
    updated_at: z.string(),
  })
  .strict();
function channelRoot(name: string) {
  return `${CHANNELS}/${idSchema.parse(name)}`;
}
async function channelMeta(root: string, name: string) {
  return readJson(root, `${channelRoot(name)}/meta.json`, channelMetaSchema);
}
async function channelState(root: string, name: string) {
  try {
    return await readJson(root, `${channelRoot(name)}/state.json`, channelStateSchema);
  } catch {
    if (!(await pathExists(path.join(root, `${channelRoot(name)}/state.json`))))
      return { __schema: 1 as const, cursors: {}, leases: {}, updated_at: nowIso() };
    throw new FrameworkError("channel state invalid");
  }
}
export async function createTrellisChannel(options: { root: string; name: string; now?: Date }) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const rel = `${channelRoot(options.name)}/meta.json`;
    if (await pathExists(path.join(root, rel)))
      return envelope({ channel: await channelMeta(root, options.name), changed: false });
    const timestamp = nowIso(options.now ?? new Date());
    const meta = channelMetaSchema.parse({
      __schema: 1,
      name: options.name,
      next_seq: 1,
      created_at: timestamp,
      updated_at: timestamp,
      idempotency: {},
    });
    await applyTrellisWal(root, "channel.create", [
      { path: rel, value: meta },
      {
        path: `${channelRoot(options.name)}/state.json`,
        value: { __schema: 1, cursors: {}, leases: {}, updated_at: timestamp },
      },
    ]);
    return envelope({ channel: meta, changed: true });
  });
}
export async function sendTrellisChannel(options: {
  root: string;
  channel: string;
  type: string;
  payload: unknown;
  sender?: string;
  idempotencyKey?: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await recoverTrellisWal(root);
    const meta = await channelMeta(root, options.channel);
    const events = await readJsonLines(
      root,
      `${channelRoot(options.channel)}/events.jsonl`,
      channelEventSchema,
    );
    const key = options.idempotencyKey;
    if (key && meta.idempotency[key]) {
      const sequence = meta.idempotency[key];
      const event = events.find((entry) => entry.seq === sequence);
      if (!event)
        throw new FrameworkError("channel idempotency index is corrupt; run channel repair");
      return envelope({ event, changed: false });
    }
    const actualNext = Math.max(meta.next_seq, (events.at(-1)?.seq ?? 0) + 1);
    const event = channelEventSchema.parse({
      __schema: 1,
      seq: actualNext,
      id: randomUUID(),
      sent_at: nowIso(options.now ?? new Date()),
      sender: options.sender ?? null,
      type: options.type,
      payload: options.payload,
      idempotency_key: key ?? null,
    });
    events.push(event);
    meta.next_seq = actualNext + 1;
    meta.updated_at = event.sent_at;
    if (key) meta.idempotency[key] = event.seq;
    await applyTrellisWal(root, "channel.send", [
      { path: `${channelRoot(options.channel)}/events.jsonl`, value: events, jsonl: true },
      { path: `${channelRoot(options.channel)}/meta.json`, value: meta },
    ]);
    return envelope({ event, changed: true });
  });
}
export async function readTrellisChannel(options: {
  root: string;
  channel: string;
  consumer?: string;
  after?: number;
  limit?: number;
  advance?: boolean;
}) {
  await requireInstalledTrellisRuntime(options.root);
  await channelMeta(options.root, options.channel);
  const stateValue = await channelState(options.root, options.channel);
  const after =
    options.after ?? (options.consumer ? (stateValue.cursors[options.consumer] ?? 0) : 0);
  const all = await readJsonLines(
    options.root,
    `${channelRoot(options.channel)}/events.jsonl`,
    channelEventSchema,
  );
  const configured = await readTrellisConfigValues(options.root);
  const limit = Math.max(1, Math.min(options.limit ?? configured.channel_page_size, 500));
  const filtered = all.filter((event) => event.seq > after);
  const events = filtered.slice(0, limit);
  if (options.advance && options.consumer && events.length)
    await setTrellisChannelCursor({
      root: options.root,
      channel: options.channel,
      consumer: options.consumer,
      seq: events.at(-1)?.seq ?? after,
    });
  return envelope({
    events,
    cursor: events.at(-1)?.seq ?? after,
    has_more: filtered.length > limit,
  });
}
export async function setTrellisChannelCursor(options: {
  root: string;
  channel: string;
  consumer: string;
  seq: number;
}) {
  const root = path.resolve(options.root);
  const requestedSeq = z.number().int().nonnegative().parse(options.seq);
  return withInstalledTrellisMutation(root, async () => {
    await channelMeta(root, options.channel);
    const events = await readJsonLines(
      root,
      `${channelRoot(options.channel)}/events.jsonl`,
      channelEventSchema,
    );
    const durableTail = events.at(-1)?.seq ?? 0;
    if (requestedSeq > durableTail)
      throw new FrameworkError(
        `channel cursor ${requestedSeq} exceeds durable tail ${durableTail}`,
      );
    const stateValue = await channelState(root, options.channel);
    const previous = stateValue.cursors[idSchema.parse(options.consumer)] ?? 0;
    if (requestedSeq < previous) throw new FrameworkError("channel cursor cannot move backwards");
    stateValue.cursors[options.consumer] = requestedSeq;
    stateValue.updated_at = nowIso();
    await applyTrellisWal(root, "channel.cursor", [
      { path: `${channelRoot(options.channel)}/state.json`, value: stateValue },
    ]);
    return envelope({ consumer: options.consumer, cursor: requestedSeq });
  });
}
export async function repairTrellisChannel(options: { root: string; channel: string }) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const meta = await channelMeta(root, options.channel);
    const events = await readJsonLines(
      root,
      `${channelRoot(options.channel)}/events.jsonl`,
      channelEventSchema,
    );
    let expected = 1;
    const keys: Record<string, number> = {};
    for (const event of events) {
      if (event.seq !== expected) throw new FrameworkError(`channel sequence gap at ${expected}`);
      if (event.idempotency_key) keys[event.idempotency_key] = event.seq;
      expected += 1;
    }
    const stable = (value: Record<string, number>) =>
      JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    const changed = meta.next_seq !== expected || stable(meta.idempotency) !== stable(keys);
    meta.next_seq = expected;
    meta.idempotency = keys;
    meta.updated_at = nowIso();
    if (changed)
      await applyTrellisWal(root, "channel.repair", [
        { path: `${channelRoot(options.channel)}/meta.json`, value: meta },
      ]);
    return envelope({ channel: meta, changed });
  });
}
export async function mutateTrellisLease(options: {
  root: string;
  channel: string;
  lease: string;
  action: "acquire" | "renew" | "release";
  owner: string;
  token?: string;
  ttlMs?: number;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    await channelMeta(root, options.channel);
    const value = await channelState(root, options.channel);
    const now = options.now ?? new Date();
    const configured = await readTrellisConfigValues(root);
    const current = value.leases[idSchema.parse(options.lease)];
    const expired = current ? Date.parse(current.expires_at) <= now.getTime() : true;
    const ttlMs = ttlMillisecondsSchema.parse(options.ttlMs ?? configured.lease_ttl_ms);
    if (options.action === "acquire") {
      if (current && !expired) {
        if (current.owner === options.owner && current.token === options.token)
          return envelope({ lease: current, changed: false });
        throw new FrameworkError(`lease '${options.lease}' is active`);
      }
      const lease = leaseSchema.parse({
        owner: options.owner,
        token: randomUUID(),
        acquired_at: nowIso(now),
        expires_at: nowIso(new Date(now.getTime() + ttlMs)),
      });
      value.leases[options.lease] = lease;
      value.updated_at = nowIso(now);
      await applyTrellisWal(root, "lease.acquire", [
        { path: `${channelRoot(options.channel)}/state.json`, value },
      ]);
      return envelope({ lease, changed: true });
    }
    if (!current || expired) throw new FrameworkError(`lease '${options.lease}' is not active`);
    if (current.owner !== options.owner || current.token !== options.token)
      throw new FrameworkError(`lease '${options.lease}' ownership mismatch`);
    if (options.action === "renew") {
      const lease = {
        ...current,
        expires_at: nowIso(new Date(now.getTime() + ttlMs)),
      };
      value.leases[options.lease] = lease;
      value.updated_at = nowIso(now);
      await applyTrellisWal(root, "lease.renew", [
        { path: `${channelRoot(options.channel)}/state.json`, value },
      ]);
      return envelope({ lease, changed: true });
    }
    delete value.leases[options.lease];
    value.updated_at = nowIso(now);
    await applyTrellisWal(root, "lease.release", [
      { path: `${channelRoot(options.channel)}/state.json`, value },
    ]);
    return envelope({ lease: current, changed: true });
  });
}

const workerSchema = z
  .object({
    id: idSchema,
    status: z.enum(["registered", "claimed", "stopped", "completed"]),
    channel: idSchema,
    lease: idSchema,
    lease_token: z.string().uuid().nullable(),
    registered_at: z.string(),
    updated_at: z.string(),
    heartbeat_at: z.string().nullable(),
    result: z.unknown().nullable(),
  })
  .strict();
const workersSchema = z
  .object({
    __schema: z.literal(1),
    workers: z.record(idSchema, workerSchema),
    updated_at: z.string(),
  })
  .strict();
async function workers(root: string) {
  try {
    return await readJson(root, WORKERS, workersSchema);
  } catch {
    if (!(await pathExists(path.join(root, WORKERS))))
      return { __schema: 1 as const, workers: {}, updated_at: nowIso() };
    throw new FrameworkError("worker store invalid");
  }
}
export async function registerTrellisWorker(options: {
  root: string;
  workerId: string;
  channel: string;
  lease?: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const value = await workers(root);
    const prior = value.workers[idSchema.parse(options.workerId)];
    if (prior && prior.status !== "stopped") {
      if (prior.channel !== options.channel || prior.lease !== (options.lease ?? "worker"))
        throw new FrameworkError(
          `active worker '${options.workerId}' is already registered with a different channel or lease`,
        );
      return envelope({ worker: { ...prior, lease_token: null }, changed: false });
    }
    await channelMeta(root, options.channel);
    const timestamp = nowIso(options.now ?? new Date());
    const worker = workerSchema.parse({
      id: options.workerId,
      status: "registered",
      channel: options.channel,
      lease: options.lease ?? "worker",
      lease_token: null,
      registered_at: prior?.registered_at ?? timestamp,
      updated_at: timestamp,
      heartbeat_at: null,
      result: null,
    });
    value.workers[worker.id] = worker;
    value.updated_at = timestamp;
    await applyTrellisWal(root, "worker.register", [{ path: WORKERS, value }]);
    return envelope({ worker, changed: true });
  });
}
export async function listTrellisWorkers(options: { root: string }) {
  await requireInstalledTrellisRuntime(options.root);
  return envelope({
    workers: Object.values((await workers(options.root)).workers)
      .map(({ lease_token: _secret, ...worker }) => worker)
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export async function claimTrellisWorker(options: {
  root: string;
  workerId: string;
  ttlMs?: number;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const store = await workers(root);
    const worker = store.workers[options.workerId];
    if (!worker || worker.status !== "registered")
      throw new FrameworkError(`worker '${options.workerId}' is not claimable`);
    const channels = await channelState(root, worker.channel);
    const now = options.now ?? new Date();
    const configured = await readTrellisConfigValues(root);
    const ttlMs = ttlMillisecondsSchema.parse(options.ttlMs ?? configured.lease_ttl_ms);
    const active = channels.leases[worker.lease];
    if (active && Date.parse(active.expires_at) > now.getTime())
      throw new FrameworkError(`lease '${worker.lease}' is active`);
    const lease = leaseSchema.parse({
      owner: worker.id,
      token: randomUUID(),
      acquired_at: nowIso(now),
      expires_at: nowIso(new Date(now.getTime() + ttlMs)),
    });
    channels.leases[worker.lease] = lease;
    channels.updated_at = nowIso(now);
    const next = workerSchema.parse({
      ...worker,
      status: "claimed",
      lease_token: lease.token,
      heartbeat_at: nowIso(now),
      updated_at: nowIso(now),
    });
    store.workers[next.id] = next;
    store.updated_at = nowIso(now);
    await applyTrellisWal(root, "worker.claim", [
      { path: WORKERS, value: store },
      { path: `${channelRoot(worker.channel)}/state.json`, value: channels },
    ]);
    return envelope({ worker: { ...next, lease_token: null }, token: lease.token });
  });
}
export async function heartbeatTrellisWorker(options: {
  root: string;
  workerId: string;
  token: string;
  ttlMs?: number;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const store = await workers(root);
    const worker = store.workers[options.workerId];
    if (!worker || worker.status !== "claimed" || !worker.lease_token)
      throw new FrameworkError(`worker '${options.workerId}' is not claimed`);
    const channels = await channelState(root, worker.channel);
    const lease = channels.leases[worker.lease];
    const now = options.now ?? new Date();
    const configured = await readTrellisConfigValues(root);
    const ttlMs = ttlMillisecondsSchema.parse(options.ttlMs ?? configured.lease_ttl_ms);
    if (
      !lease ||
      lease.owner !== worker.id ||
      lease.token !== worker.lease_token ||
      lease.token !== options.token ||
      Date.parse(lease.expires_at) <= now.getTime()
    )
      throw new FrameworkError(`worker '${worker.id}' lease is not active`);
    const renewed = leaseSchema.parse({
      ...lease,
      expires_at: nowIso(new Date(now.getTime() + ttlMs)),
    });
    channels.leases[worker.lease] = renewed;
    channels.updated_at = nowIso(now);
    const next = workerSchema.parse({
      ...worker,
      heartbeat_at: nowIso(now),
      updated_at: nowIso(now),
    });
    store.workers[next.id] = next;
    store.updated_at = nowIso(now);
    await applyTrellisWal(root, "worker.heartbeat", [
      { path: WORKERS, value: store },
      { path: `${channelRoot(worker.channel)}/state.json`, value: channels },
    ]);
    return envelope({ worker: { ...next, lease_token: null } });
  });
}
export async function finishTrellisWorker(options: {
  root: string;
  workerId: string;
  status: "completed" | "stopped";
  token: string;
  result?: unknown;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const store = await workers(root);
    const worker = store.workers[options.workerId];
    if (!worker) throw new FrameworkError(`worker '${options.workerId}' not found`);
    if (worker.status === "completed" || worker.status === "stopped")
      throw new FrameworkError(`worker '${worker.id}' is already terminal`);
    if (worker.status !== "claimed" || !worker.lease_token)
      throw new FrameworkError(`worker '${worker.id}' must be claimed before completion`);
    const writes: Array<{ path: string; value: unknown }> = [];
    if (worker.status === "claimed" && worker.lease_token) {
      const channels = await channelState(root, worker.channel);
      const lease = channels.leases[worker.lease];
      if (
        !lease ||
        lease.owner !== worker.id ||
        lease.token !== worker.lease_token ||
        lease.token !== options.token ||
        Date.parse(lease.expires_at) <= (options.now ?? new Date()).getTime()
      )
        throw new FrameworkError(`worker '${worker.id}' lease ownership mismatch`);
      delete channels.leases[worker.lease];
      channels.updated_at = nowIso(options.now ?? new Date());
      writes.push({ path: `${channelRoot(worker.channel)}/state.json`, value: channels });
    }
    const timestamp = nowIso(options.now ?? new Date());
    const next = workerSchema.parse({
      ...worker,
      status: options.status,
      lease_token: null,
      result: options.result ?? null,
      updated_at: timestamp,
    });
    store.workers[next.id] = next;
    store.updated_at = timestamp;
    writes.unshift({ path: WORKERS, value: store });
    await applyTrellisWal(root, `worker.${options.status}`, writes);
    return envelope({ worker: { ...next, lease_token: null }, changed: true });
  });
}

/** Parse an optional JSON payload without silently treating malformed input as text. */
export function parseTrellisJson(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new FrameworkError("value is not valid JSON", { cause: error });
  }
}

export async function readTrellisSessionIdFromStdin(
  stdin: string,
  env: NodeJS.ProcessEnv,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return idSchema.parse(explicit);
  if (stdin.trim()) {
    let value: unknown;
    try {
      value = JSON.parse(stdin);
    } catch (error) {
      throw new FrameworkError("session stdin is not valid JSON", { cause: error });
    }
    if (value && typeof value === "object") {
      const id =
        (value as Record<string, unknown>).session_id ??
        (value as Record<string, unknown>).thread_id;
      if (typeof id === "string" && id.trim()) return idSchema.parse(id);
    }
  }
  return env.ASSAY_TRELLIS_SESSION_ID ?? env.CODEX_SESSION_ID ?? env.CODEX_THREAD_ID;
}
