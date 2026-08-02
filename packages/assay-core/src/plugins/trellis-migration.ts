import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { FrameworkError } from "../errors.js";
import { stringifySortedJson } from "../serialization.js";
import { nowIso } from "../time.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import {
  TRELLIS_PROTOCOL_VERSION,
  TRELLIS_RUNTIME_STATE_FILE,
  requireInstalledTrellisRuntime,
  requireInstalledTrellisRuntimeReadOnly,
  trellisRuntimeStateSchema,
  trellisTaskRecordSchema,
  withInstalledTrellisMutation,
} from "./trellis-runtime.js";
import {
  type VerifiedRemoveReceipt,
  applyTrellisWal,
  atomicWriteJson,
  atomicWriteText,
  listSafeFiles,
  pathExists,
  prepareVerifiedRemove,
  readJson,
  safeTrellisPath,
  verifiedRemove,
} from "./trellis-storage.js";

const operationSchema = z
  .object({
    __schema: z.literal(1),
    generation: z.string().uuid(),
    applied_at: z.string(),
    source_root: z.string(),
    channel_root: z.string().nullable(),
    entries: z.array(
      z
        .object({
          source: z.string(),
          category: z.enum([
            "dynamic-convert",
            "static-discard",
            "modified-or-unknown-archive",
            "structured-scrub",
          ]),
          sha256: z.string(),
          size: z.number(),
          target: z.string().nullable(),
        })
        .strict(),
    ),
    created_targets: z.array(z.string()),
    target_hashes: z.record(z.string(), z.string()),
    backups: z.record(z.string(), z.string()),
    rolled_back_at: z.string().nullable(),
  })
  .strict();
export type TrellisLegacyMigrationOperation = z.infer<typeof operationSchema>;

function sha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function classify(
  relative: string,
): TrellisLegacyMigrationOperation["entries"][number]["category"] {
  const lower = relative.toLowerCase();
  if (
    /(^|\/)(tasks?|sessions?|current|journals?|config|channels?)(\/|\.|$)/.test(lower) &&
    /\.(json|jsonl|md)$/.test(lower)
  )
    return "dynamic-convert";
  if (/(^|\/)(memory|memories|transcripts?|sessions-archive)(\/|\.|$)/.test(lower))
    return "structured-scrub";
  if (
    /(^|\/)(templates?|scripts?|static|vendor)(\/|$)/.test(lower) ||
    /(^|\/)\.gitignore$/.test(lower)
  )
    return "static-discard";
  return "modified-or-unknown-archive";
}
async function explicitLegacyRoot(workspaceRoot: string, value?: string): Promise<string> {
  const target = path.resolve(workspaceRoot, value ?? ".trellis");
  if (target !== path.join(path.resolve(workspaceRoot), ".trellis") && value === undefined)
    throw new FrameworkError("legacy migration only reads the explicit root .trellis directory");
  if (target === path.parse(target).root || target === path.resolve(workspaceRoot))
    throw new FrameworkError("unsafe legacy migration source root");
  const info = await stat(target);
  if (!info.isDirectory()) throw new FrameworkError("legacy Trellis source is not a directory");
  await safeTrellisPath(workspaceRoot, path.relative(workspaceRoot, target), false);
  return target;
}

export async function planTrellisLegacyMigration(options: {
  root: string;
  legacyRoot?: string;
  channelRoot?: string;
}) {
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntimeReadOnly(root);
  const source = await explicitLegacyRoot(root, options.legacyRoot);
  const files = await listSafeFiles(root, path.relative(root, source));
  const channelRoot = options.channelRoot
    ? await explicitLegacyRoot(root, options.channelRoot)
    : null;
  if (channelRoot && channelRoot !== source)
    files.push(...(await listSafeFiles(root, path.relative(root, channelRoot))));
  const entries = [];
  for (const sourceFile of [...new Set(files)].sort()) {
    const content = await readFile(await safeTrellisPath(root, sourceFile, false));
    entries.push({
      source: sourceFile,
      category: classify(sourceFile),
      sha256: sha(content),
      size: content.byteLength,
      target: null,
    });
  }
  return {
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    plugin: TRELLIS_PLUGIN_ID,
    read_only: true,
    source_root: path.relative(root, source).replaceAll("\\", "/"),
    channel_root: channelRoot ? path.relative(root, channelRoot).replaceAll("\\", "/") : null,
    entries,
  };
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return typeof value === "string" ? "[scrubbed]" : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /content|message|prompt|text|body/i.test(key) ? "[scrubbed]" : scrub(item),
    ]),
  );
}

export async function applyTrellisLegacyMigration(options: {
  root: string;
  legacyRoot?: string;
  channelRoot?: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  const plan = await planTrellisLegacyMigration(options);
  const generation = randomUUID();
  const base = `.assay/trellis/migrations/${generation}`;
  return withInstalledTrellisMutation(root, async () => {
    const writes: { path: string; value: unknown; jsonl?: boolean }[] = [];
    const createdTargets: string[] = [];
    const entries = [];
    const legacyTaskIds = new Map<string, string>();
    const openLegacyTaskIds = new Set<string>();
    const dynamicValues: Array<{ source: string; value: unknown }> = [];
    for (const entry of plan.entries) {
      const bytes = await readFile(await safeTrellisPath(root, entry.source, false));
      if (sha(bytes) !== entry.sha256)
        throw new FrameworkError(`legacy source changed after plan: ${entry.source}`);
      let target: string | null = null;
      if (entry.category === "modified-or-unknown-archive") {
        target = `${base}/archive/${entry.source.replaceAll("/", "__")}.json`;
        writes.push({
          path: target,
          value: {
            __schema: 1,
            source: entry.source,
            sha256: entry.sha256,
            encoding: "base64",
            content: bytes.toString("base64"),
          },
        });
        createdTargets.push(target);
      } else if (entry.category === "structured-scrub") {
        target = `${base}/scrubbed/${entry.source.replaceAll("/", "__")}.json`;
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString("utf8"));
        } catch {
          value = { source: entry.source, diagnostic: "unparseable structured record" };
        }
        writes.push({
          path: target,
          value: { __schema: 1, source_sha256: entry.sha256, value: scrub(value) },
        });
        createdTargets.push(target);
      } else if (entry.category === "dynamic-convert") {
        let value: unknown;
        try {
          value = entry.source.endsWith(".jsonl")
            ? bytes
                .toString("utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line))
            : JSON.parse(bytes.toString("utf8"));
        } catch {
          value = { diagnostic: "unparseable known-shape record", raw_sha256: entry.sha256 };
        }
        dynamicValues.push({ source: entry.source, value });
        const record =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        if (
          /\/(tasks?|task)\//i.test(`/${entry.source}`) &&
          record &&
          typeof (record.title ?? record.name) === "string"
        ) {
          const legacyId =
            typeof record.id === "string"
              ? record.id
              : path.basename(entry.source, path.extname(entry.source));
          let id: string;
          try {
            id = trellisTaskRecordSchema.shape.id.parse(legacyId);
          } catch {
            id = `task-${randomUUID()}`;
          }
          const statusValue =
            record.status === "done"
              ? "completed"
              : record.status === "canceled"
                ? "cancelled"
                : record.status;
          const status =
            statusValue === "completed" || statusValue === "cancelled" ? statusValue : "open";
          const timestamp =
            typeof record.created_at === "string"
              ? record.created_at
              : nowIso(options.now ?? new Date());
          const converted = trellisTaskRecordSchema.parse({
            id,
            title: String(record.title ?? record.name),
            status,
            created_at: timestamp,
            updated_at: typeof record.updated_at === "string" ? record.updated_at : timestamp,
          });
          target = `.assay/trellis/tasks/${id}.json`;
          writes.push({ path: target, value: converted });
          createdTargets.push(target);
          legacyTaskIds.set(legacyId, id);
          if (status === "open") openLegacyTaskIds.add(legacyId);
        } else if (/(^|\/)config\.json$/i.test(entry.source) && record) {
          const values = Object.fromEntries(
            Object.entries(record).filter(
              ([key, item]) =>
                [
                  "journal_page_size",
                  "channel_page_size",
                  "lock_stale_ms",
                  "lease_ttl_ms",
                  "mem_max_results",
                ].includes(key) && typeof item === "number",
            ),
          );
          target = ".assay/trellis/config.json";
          writes.push({
            path: target,
            value: { __schema: 1, values, updated_at: nowIso(options.now ?? new Date()) },
          });
          createdTargets.push(target);
        } else if (/journal/i.test(entry.source) && Array.isArray(value)) {
          const timestamp = nowIso(options.now ?? new Date());
          const records = value.map((item, index) => {
            const record =
              item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            return {
              __schema: 1,
              seq: index + 1,
              id:
                typeof record.id === "string" && /^[0-9a-f-]{36}$/i.test(record.id)
                  ? record.id
                  : randomUUID(),
              timestamp: typeof record.timestamp === "string" ? record.timestamp : timestamp,
              kind: typeof record.kind === "string" ? record.kind : "legacy",
              message:
                typeof record.message === "string"
                  ? record.message
                  : "migrated legacy journal record",
              task_id: null,
              session_id: null,
              data: { provenance: entry.source },
            };
          });
          target = ".assay/trellis/journal/events.jsonl";
          writes.push({ path: target, value: records, jsonl: true });
          createdTargets.push(target);
        } else {
          target = `${base}/converted/${entry.source.replaceAll("/", "__")}.json`;
          writes.push({
            path: target,
            value: {
              __schema: 1,
              provenance: { source: entry.source, sha256: entry.sha256 },
              value,
            },
          });
          createdTargets.push(target);
        }
      }
      entries.push({ ...entry, target });
    }
    if (legacyTaskIds.size > 0) {
      const runtimeState = await readJson(
        root,
        TRELLIS_RUNTIME_STATE_FILE,
        trellisRuntimeStateSchema,
      );
      for (const dynamic of dynamicValues) {
        if (
          !/(current|session)/i.test(dynamic.source) ||
          !dynamic.value ||
          typeof dynamic.value !== "object" ||
          Array.isArray(dynamic.value)
        )
          continue;
        const record = dynamic.value as Record<string, unknown>;
        const legacyCurrent =
          typeof record.current_task_id === "string"
            ? record.current_task_id
            : typeof record.task_id === "string"
              ? record.task_id
              : null;
        const mapped =
          legacyCurrent && openLegacyTaskIds.has(legacyCurrent)
            ? legacyTaskIds.get(legacyCurrent)
            : undefined;
        if (mapped) runtimeState.current_task_id = mapped;
        if (
          record.session_currents &&
          typeof record.session_currents === "object" &&
          !Array.isArray(record.session_currents)
        ) {
          for (const [session, legacyId] of Object.entries(
            record.session_currents as Record<string, unknown>,
          )) {
            const mappedSessionTask =
              typeof legacyId === "string" && openLegacyTaskIds.has(legacyId)
                ? legacyTaskIds.get(legacyId)
                : undefined;
            if (mappedSessionTask) runtimeState.session_currents[session] = mappedSessionTask;
          }
        }
      }
      runtimeState.updated_at = nowIso(options.now ?? new Date());
      writes.push({
        path: TRELLIS_RUNTIME_STATE_FILE,
        value: trellisRuntimeStateSchema.parse(runtimeState),
      });
      createdTargets.push(TRELLIS_RUNTIME_STATE_FILE);
    }
    const backups: Record<string, string> = {};
    for (const write of [...writes]) {
      if (write.path.startsWith(`${base}/`) || !(await pathExists(path.join(root, write.path))))
        continue;
      const content = await readFile(await safeTrellisPath(root, write.path, false));
      const backup = `${base}/target-backup/${write.path.replaceAll("/", "__")}.json`;
      backups[write.path] = backup;
      writes.push({
        path: backup,
        value: {
          __schema: 1,
          target: write.path,
          sha256: sha(content),
          encoding: "base64",
          content: content.toString("base64"),
        },
      });
      createdTargets.push(backup);
    }
    const targetHashes: Record<string, string> = {};
    for (const target of createdTargets) {
      const write = writes.find((candidate) => candidate.path === target);
      if (!write) continue;
      const content = write.jsonl
        ? (write.value as readonly unknown[]).map((record) => JSON.stringify(record)).join("\n") +
          ((write.value as readonly unknown[]).length ? "\n" : "")
        : stringifySortedJson(write.value);
      targetHashes[target] = sha(content);
    }
    const operation = operationSchema.parse({
      __schema: 1,
      generation,
      applied_at: nowIso(options.now ?? new Date()),
      source_root: plan.source_root,
      channel_root: plan.channel_root,
      entries,
      created_targets: createdTargets,
      target_hashes: targetHashes,
      backups,
      rolled_back_at: null,
    });
    writes.push(
      { path: `${base}/operation.json`, value: operation },
      { path: ".assay/trellis/migrations/current.json", value: { __schema: 1, generation } },
    );
    await applyTrellisWal(root, "migration.legacy.apply", writes);
    return { protocol_version: TRELLIS_PROTOCOL_VERSION, plugin: TRELLIS_PLUGIN_ID, operation };
  });
}

export async function rollbackTrellisLegacyMigration(options: {
  root: string;
  generation?: string;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  return withInstalledTrellisMutation(root, async () => {
    const currentPath = ".assay/trellis/migrations/current.json";
    const current = JSON.parse(
      await readFile(await safeTrellisPath(root, currentPath, false), "utf8"),
    ) as { generation: string };
    const generation = options.generation ?? current.generation;
    if (generation !== current.generation)
      throw new FrameworkError("only the current migration generation can be rolled back");
    const operationPath = `.assay/trellis/migrations/${generation}/operation.json`;
    const operation = operationSchema.parse(
      JSON.parse(await readFile(await safeTrellisPath(root, operationPath, false), "utf8")),
    );
    if (operation.rolled_back_at)
      return { protocol_version: 1, plugin: TRELLIS_PLUGIN_ID, operation, changed: false };
    for (const target of operation.created_targets) {
      if (
        !(await pathExists(path.join(root, target))) ||
        sha(await readFile(await safeTrellisPath(root, target, false))) !==
          operation.target_hashes[target]
      )
        throw new FrameworkError(`migration target has subsequent writes: ${target}`);
    }
    const restoreWrites: Array<{ path: string; value: unknown; jsonl?: boolean }> = [];
    for (const [target, backup] of Object.entries(operation.backups)) {
      const wrapper = JSON.parse(
        await readFile(await safeTrellisPath(root, backup, false), "utf8"),
      ) as { content: string; sha256: string };
      const content = Buffer.from(wrapper.content, "base64");
      if (sha(content) !== wrapper.sha256)
        throw new FrameworkError(`migration backup digest mismatch: ${backup}`);
      const text = content.toString("utf8");
      restoreWrites.push(
        target.endsWith(".jsonl")
          ? {
              path: target,
              value: text
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
              jsonl: true,
            }
          : { path: target, value: JSON.parse(text) },
      );
    }
    const backedUpTargets = new Set(Object.keys(operation.backups));
    const deletes = operation.created_targets.filter((target) => !backedUpTargets.has(target));
    const next = operationSchema.parse({
      ...operation,
      rolled_back_at: nowIso(options.now ?? new Date()),
    });
    restoreWrites.push(
      { path: operationPath, value: next },
      { path: currentPath, value: { __schema: 1, generation, status: "rolled_back" } },
    );
    await applyTrellisWal(root, "migration.legacy.rollback", restoreWrites, deletes);
    return { protocol_version: 1, plugin: TRELLIS_PLUGIN_ID, operation: next, changed: true };
  });
}

export async function cleanupTrellisLegacyMigration(options: {
  root: string;
  generation: string;
  yes?: boolean;
}) {
  const root = path.resolve(options.root);
  if (!options.yes) throw new FrameworkError("migration cleanup requires --yes");
  return withInstalledTrellisMutation(root, async () => {
    const relative = `.assay/trellis/migrations/${z.string().uuid().parse(options.generation)}`;
    const receipt = `${relative}/cleanup.json`;
    let cleanup: {
      __schema: 1;
      phase: "prepared" | "completed";
      cleaned_at: string;
      source_preserved: true;
      deletes: VerifiedRemoveReceipt[];
      removed?: string[];
    };
    try {
      cleanup = JSON.parse(await readFile(await safeTrellisPath(root, receipt, false), "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      cleanup = {
        __schema: 1,
        phase: "prepared",
        cleaned_at: nowIso(),
        source_preserved: true,
        deletes: await Promise.all(
          ["archive", "scrubbed", "converted", "target-backup"].map((child) =>
            prepareVerifiedRemove(
              root,
              `${relative}/${child}`,
              `cleanup-${options.generation}-${child}`,
            ),
          ),
        ),
      };
      await atomicWriteJson(root, receipt, cleanup);
    }
    const removed: string[] = [];
    for (const deletion of cleanup.deletes) {
      if (deletion.identity !== null) {
        await verifiedRemove(root, deletion, { recursive: true });
        removed.push(deletion.path);
      }
    }
    await atomicWriteJson(root, receipt, {
      ...cleanup,
      phase: "completed",
      cleaned_at: nowIso(),
      removed,
    });
    return {
      protocol_version: 1,
      plugin: TRELLIS_PLUGIN_ID,
      generation: options.generation,
      removed,
      operation_receipt_preserved: true,
      source_preserved: true,
    };
  });
}
