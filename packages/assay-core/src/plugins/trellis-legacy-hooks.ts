import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { FrameworkError } from "../errors.js";
import { stringifySortedJson } from "../serialization.js";
import { nowIso } from "../time.js";
import {
  type ConfinedReadFile,
  inspectConfinedReadFile,
  openConfinedReadRoot,
  readConfinedFile,
} from "./confined-reader.js";
import { TRELLIS_PLUGIN_ID } from "./registry.js";
import {
  TRELLIS_PROTOCOL_VERSION,
  requireInstalledTrellisRuntimeReadOnly,
} from "./trellis-runtime.js";
import {
  type AtomicTextExchangeIntent,
  atomicWriteJson,
  cleanupAtomicTextExchange,
  commitAtomicTextExchange,
  createAtomicTextExchangeIntent,
  pathExists,
  prepareAtomicTextExchange,
  readJson,
  validateAtomicTextExchangeState,
  withPidFileLock,
} from "./trellis-storage.js";

export const LEGACY_CODEX_HOOK_CONTRACT_VERSION = 1 as const;
export const TRELLIS_LEGACY_HOOK_RECEIPT =
  ".assay/trellis/hooks/legacy/codex-current.json" as const;
const HOOK_TARGET = ".codex/hooks.json";
const HOOK_LOCK = ".codex/.assay-trellis-hook.lock";

const legacyGroups = [
  {
    event: "UserPromptSubmit",
    group: {
      hooks: [
        {
          type: "command",
          command: "python -X utf8 .codex/hooks/inject-workflow-state.py",
        },
      ],
    },
  },
  {
    event: "SubagentStart",
    group: {
      matcher: "^trellis_",
      hooks: [
        {
          type: "command",
          command: "python -X utf8 .codex/hooks/inject-subagent-context.py",
        },
      ],
    },
  },
] as const;

const identitySchema = z.object({ dev: z.number(), ino: z.number() }).strict();
const exchangeBaseSchema = z
  .object({
    target: z.literal(HOOK_TARGET),
    stage: z.string(),
    rollback: z.string(),
    expected_identity: identitySchema,
    expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    replacement_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const exchangeIntentSchema = exchangeBaseSchema.extend({ replacement_identity: z.null() }).strict();
const exchangePreparedSchema = exchangeBaseSchema
  .extend({ replacement_identity: identitySchema })
  .strict();
const removedGroupSchema = z
  .object({ event: z.string(), index: z.number().int().nonnegative(), group: z.unknown() })
  .strict();
const backupSchema = z
  .object({
    __schema: z.literal(1),
    target: z.literal(HOOK_TARGET),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    encoding: z.literal("base64"),
    content: z.string(),
  })
  .strict();
const receiptBaseSchema = z
  .object({
    __schema: z.literal(1),
    contract_version: z.literal(LEGACY_CODEX_HOOK_CONTRACT_VERSION),
    generation: z.string().uuid(),
    host: z.literal("codex"),
    target: z.literal(HOOK_TARGET),
    prepared_at: z.string(),
    pre_hash: z.string().regex(/^[a-f0-9]{64}$/),
    post_hash: z.string().regex(/^[a-f0-9]{64}$/),
    pre_identity: identitySchema,
    backup: z.string(),
    pre_content: z.string(),
    post_document: z.unknown(),
    removed_groups: z.array(removedGroupSchema),
  })
  .strict();

const receiptSchema = z.discriminatedUnion("phase", [
  receiptBaseSchema
    .extend({
      phase: z.literal("apply-intent"),
      applied_at: z.null(),
      restored_at: z.null(),
      post_identity: z.null(),
      restored_identity: z.null(),
      apply_exchange: exchangeIntentSchema,
      restore_exchange: z.null(),
    })
    .strict(),
  receiptBaseSchema
    .extend({
      phase: z.literal("apply-prepared"),
      applied_at: z.null(),
      restored_at: z.null(),
      post_identity: z.null(),
      restored_identity: z.null(),
      apply_exchange: exchangePreparedSchema,
      restore_exchange: z.null(),
    })
    .strict(),
  receiptBaseSchema
    .extend({
      phase: z.literal("applied"),
      applied_at: z.string(),
      restored_at: z.null(),
      post_identity: identitySchema,
      restored_identity: z.null(),
      apply_exchange: exchangePreparedSchema,
      restore_exchange: z.null(),
    })
    .strict(),
  receiptBaseSchema
    .extend({
      phase: z.literal("restore-intent"),
      applied_at: z.string(),
      restored_at: z.null(),
      post_identity: identitySchema,
      restored_identity: z.null(),
      apply_exchange: exchangePreparedSchema,
      restore_exchange: exchangeIntentSchema,
    })
    .strict(),
  receiptBaseSchema
    .extend({
      phase: z.literal("restore-prepared"),
      applied_at: z.string(),
      restored_at: z.null(),
      post_identity: identitySchema,
      restored_identity: z.null(),
      apply_exchange: exchangePreparedSchema,
      restore_exchange: exchangePreparedSchema,
    })
    .strict(),
  receiptBaseSchema
    .extend({
      phase: z.literal("restored"),
      applied_at: z.string(),
      restored_at: z.string(),
      post_identity: identitySchema,
      restored_identity: identitySchema,
      apply_exchange: exchangePreparedSchema,
      restore_exchange: exchangePreparedSchema,
    })
    .strict(),
]);

export type TrellisLegacyHookReceipt = z.infer<typeof receiptSchema>;
type HookDocument = {
  readonly hooks: Record<string, readonly unknown[]>;
  readonly [key: string]: unknown;
};
type HookSnapshot = {
  readonly identity: { readonly dev: number; readonly ino: number };
  readonly hash: string;
  readonly text: string;
  readonly document: HookDocument;
};

export type TrellisLegacyHookProbePhase =
  | "apply-after-plan"
  | "apply-after-restore-cleanup"
  | "apply-after-intent"
  | "apply-after-prepared"
  | "apply-before-cas"
  | "apply-after-hook-write"
  | "restore-after-intent"
  | "restore-after-prepared"
  | "restore-after-apply-cleanup"
  | "restore-after-hook-write";
let legacyHookProbe:
  | ((phase: TrellisLegacyHookProbePhase, target: string) => void | Promise<void>)
  | null = null;

/** Deterministic race/crash barrier for legacy-hook transaction tests. */
export function setTrellisLegacyHookProbeForTests(
  probe: ((phase: TrellisLegacyHookProbePhase, target: string) => void | Promise<void>) | null,
): void {
  legacyHookProbe = probe;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotMatches(
  snapshot: HookSnapshot | null,
  expected: {
    readonly identity: { readonly dev: number; readonly ino: number };
    readonly hash: string;
  },
): boolean {
  return (
    snapshot !== null &&
    snapshot.hash === expected.hash &&
    sameIdentity(snapshot.identity, expected.identity)
  );
}

function normalizeDocument(value: unknown): HookDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FrameworkError("Codex hooks configuration must be a JSON object");
  }
  const source = value as Record<string, unknown>;
  if (!source.hooks || typeof source.hooks !== "object" || Array.isArray(source.hooks)) {
    throw new FrameworkError("Codex hooks configuration 'hooks' must be an object");
  }
  const hooks: Record<string, readonly unknown[]> = {};
  for (const [event, groups] of Object.entries(source.hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      throw new FrameworkError(`Codex hook event '${event}' must be an array`);
    }
    hooks[event] = groups;
  }
  return { ...source, hooks } as HookDocument;
}

async function hookSnapshot(rootValue: string): Promise<HookSnapshot | null> {
  const root = await openConfinedReadRoot(path.resolve(rootValue));
  let file: ConfinedReadFile;
  try {
    file = await inspectConfinedReadFile(root, HOOK_TARGET);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readConfinedFile(root, file);
  let document: HookDocument;
  try {
    document = normalizeDocument(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FrameworkError("Codex hooks configuration is invalid JSON", { cause: error });
    }
    throw error;
  }
  return { identity: file.identity, hash: sha(bytes), text: bytes.toString("utf8"), document };
}

function commandOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.type === "command" && typeof record.command === "string" ? record.command : null;
}

function legacyLooking(group: unknown): boolean {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const hooks = (group as Record<string, unknown>).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => {
      const command = commandOf(hook);
      return (
        command?.includes("inject-workflow-state.py") === true ||
        command?.includes("inject-subagent-context.py") === true
      );
    })
  );
}

function analyze(document: HookDocument): {
  readonly removed: Array<{ event: string; index: number; group: unknown }>;
  readonly next: HookDocument;
} {
  const exact = new Map(legacyGroups.map((item) => [fingerprint(item.group), item] as const));
  const removed: Array<{ event: string; index: number; group: unknown }> = [];
  for (const [event, groups] of Object.entries(document.hooks)) {
    for (const [index, group] of groups.entries()) {
      const contract = exact.get(fingerprint(group));
      if (contract) {
        if (event !== contract.event) {
          throw new FrameworkError("legacy Trellis hook has an unexpected event");
        }
        removed.push({ event, index, group });
      } else if (legacyLooking(group)) {
        throw new FrameworkError("legacy Trellis hook is modified or outside the v1 allowlist");
      }
    }
  }
  for (const contract of legacyGroups) {
    if (
      removed.filter((candidate) => fingerprint(candidate.group) === fingerprint(contract.group))
        .length > 1
    ) {
      throw new FrameworkError(`legacy Trellis hook is duplicated for ${contract.event}`);
    }
  }
  const removeIndexes = new Map<string, Set<number>>();
  for (const item of removed) {
    const indexes = removeIndexes.get(item.event) ?? new Set<number>();
    indexes.add(item.index);
    removeIndexes.set(item.event, indexes);
  }
  const hooks = Object.fromEntries(
    Object.entries(document.hooks).map(([event, groups]) => [
      event,
      groups.filter((_, index) => !removeIndexes.get(event)?.has(index)),
    ]),
  );
  return { removed, next: { ...document, hooks } };
}

function fingerprint(value: unknown): string {
  return sha(stringifySortedJson(value));
}

function assertExchangeIntent(
  actual: AtomicTextExchangeIntent,
  expected: AtomicTextExchangeIntent,
  label: string,
): void {
  if (
    actual.target !== HOOK_TARGET ||
    actual.target !== expected.target ||
    actual.stage !== expected.stage ||
    actual.rollback !== expected.rollback ||
    actual.expected_sha256 !== expected.expected_sha256 ||
    actual.replacement_sha256 !== expected.replacement_sha256 ||
    !sameIdentity(actual.expected_identity, expected.expected_identity)
  ) {
    throw new FrameworkError(`legacy hook receipt has an invalid ${label} exchange contract`);
  }
}

function validateReceiptSemantics(receipt: TrellisLegacyHookReceipt): TrellisLegacyHookReceipt {
  const bytes = Buffer.from(receipt.pre_content, "base64");
  if (bytes.toString("base64") !== receipt.pre_content || sha(bytes) !== receipt.pre_hash) {
    throw new FrameworkError("legacy hook receipt pre-content/hash mismatch");
  }
  let preDocument: HookDocument;
  try {
    preDocument = normalizeDocument(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new FrameworkError("legacy hook receipt pre-document is invalid", { cause: error });
  }
  const postDocument = normalizeDocument(receipt.post_document);
  const analysis = analyze(preDocument);
  if (
    sha(stringifySortedJson(postDocument)) !== receipt.post_hash ||
    stringifySortedJson(analysis.next) !== stringifySortedJson(postDocument) ||
    stringifySortedJson(analysis.removed) !== stringifySortedJson(receipt.removed_groups)
  ) {
    throw new FrameworkError("legacy hook receipt pre/post documents are inconsistent");
  }
  const expectedBackup = `.assay/trellis/hooks/legacy/backups/${receipt.generation}.json`;
  if (receipt.backup !== expectedBackup) {
    throw new FrameworkError("legacy hook receipt backup path is outside its generation namespace");
  }
  const applyIntent = createAtomicTextExchangeIntent(
    HOOK_TARGET,
    stringifySortedJson(postDocument),
    {
      transactionId: `${receipt.generation}-apply`,
      expectedIdentity: receipt.pre_identity,
      expectedSha256: receipt.pre_hash,
    },
  );
  assertExchangeIntent(receipt.apply_exchange, applyIntent, "apply");
  if (receipt.phase !== "apply-intent" && receipt.apply_exchange.replacement_identity === null) {
    throw new FrameworkError("legacy hook receipt lacks its prepared apply identity");
  }
  if (
    receipt.phase !== "apply-intent" &&
    receipt.phase !== "apply-prepared" &&
    !sameIdentity(receipt.post_identity, receipt.apply_exchange.replacement_identity)
  ) {
    throw new FrameworkError("legacy hook receipt post identity does not match its apply stage");
  }
  if (
    receipt.phase === "restore-intent" ||
    receipt.phase === "restore-prepared" ||
    receipt.phase === "restored"
  ) {
    const restoreIntent = createAtomicTextExchangeIntent(HOOK_TARGET, bytes.toString("utf8"), {
      transactionId: `${receipt.generation}-restore`,
      expectedIdentity: receipt.post_identity,
      expectedSha256: receipt.post_hash,
    });
    assertExchangeIntent(receipt.restore_exchange, restoreIntent, "restore");
    if (
      receipt.phase !== "restore-intent" &&
      receipt.restore_exchange.replacement_identity === null
    ) {
      throw new FrameworkError("legacy hook receipt lacks its prepared restore identity");
    }
    if (
      receipt.phase === "restored" &&
      !sameIdentity(receipt.restored_identity, receipt.restore_exchange.replacement_identity)
    ) {
      throw new FrameworkError(
        "legacy hook receipt restored identity does not match its restore stage",
      );
    }
  }
  return receipt;
}

async function currentReceipt(root: string): Promise<TrellisLegacyHookReceipt | null> {
  if (!(await pathExists(path.join(root, TRELLIS_LEGACY_HOOK_RECEIPT)))) return null;
  return validateReceiptSemantics(await readJson(root, TRELLIS_LEGACY_HOOK_RECEIPT, receiptSchema));
}

async function preflightReceipt(root: string): Promise<TrellisLegacyHookReceipt | null> {
  const receipt = await currentReceipt(root);
  if (!receipt) return null;
  if (
    receipt.phase === "apply-intent" ||
    receipt.phase === "apply-prepared" ||
    receipt.phase === "applied"
  ) {
    await validateAtomicTextExchangeState(root, receipt.apply_exchange);
  } else {
    await validateAtomicTextExchangeState(root, receipt.restore_exchange);
  }
  return receipt;
}

export interface TrellisLegacyHookPlan {
  readonly protocol_version: typeof TRELLIS_PROTOCOL_VERSION;
  readonly plugin: typeof TRELLIS_PLUGIN_ID;
  readonly contract_version: typeof LEGACY_CODEX_HOOK_CONTRACT_VERSION;
  readonly host: "codex";
  readonly target: typeof HOOK_TARGET;
  readonly read_only: true;
  readonly action: "remove" | "noop" | "conflict";
  readonly pre_hash: string | null;
  readonly pre_identity: { readonly dev: number; readonly ino: number } | null;
  readonly post_hash: string | null;
  readonly removed_groups: readonly {
    readonly event: string;
    readonly index: number;
    readonly group: unknown;
  }[];
  readonly document: HookDocument | null;
  readonly message: string;
}

export async function planTrellisLegacyHookScrub(options: {
  readonly root: string;
  readonly host: string;
}): Promise<TrellisLegacyHookPlan> {
  if (options.host !== "codex") {
    throw new FrameworkError(`unsupported Trellis hook host '${options.host}'; supported: codex`);
  }
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntimeReadOnly(root);
  const snapshot = await hookSnapshot(root);
  if (!snapshot) {
    return {
      protocol_version: TRELLIS_PROTOCOL_VERSION,
      plugin: TRELLIS_PLUGIN_ID,
      contract_version: LEGACY_CODEX_HOOK_CONTRACT_VERSION,
      host: "codex",
      target: HOOK_TARGET,
      read_only: true,
      action: "noop",
      pre_hash: null,
      pre_identity: null,
      post_hash: null,
      removed_groups: [],
      document: null,
      message: "Codex hooks configuration is absent",
    };
  }
  const analysis = analyze(snapshot.document);
  const nextText = stringifySortedJson(analysis.next);
  return {
    protocol_version: TRELLIS_PROTOCOL_VERSION,
    plugin: TRELLIS_PLUGIN_ID,
    contract_version: LEGACY_CODEX_HOOK_CONTRACT_VERSION,
    host: "codex",
    target: HOOK_TARGET,
    read_only: true,
    action: analysis.removed.length ? "remove" : "noop",
    pre_hash: snapshot.hash,
    pre_identity: snapshot.identity,
    post_hash: sha(nextText),
    removed_groups: analysis.removed,
    document: analysis.next,
    message: analysis.removed.length
      ? `remove ${analysis.removed.length} exact legacy Trellis hook group(s)`
      : "no exact legacy Trellis hook groups are present",
  };
}

async function writeReceipt(
  root: string,
  receipt: TrellisLegacyHookReceipt,
): Promise<TrellisLegacyHookReceipt> {
  const parsed = validateReceiptSemantics(receiptSchema.parse(receipt));
  await atomicWriteJson(root, TRELLIS_LEGACY_HOOK_RECEIPT, parsed);
  return parsed;
}

async function ensureLegacyHookBackup(
  root: string,
  receipt: TrellisLegacyHookReceipt,
): Promise<void> {
  const expected = {
    __schema: 1 as const,
    target: HOOK_TARGET,
    sha256: receipt.pre_hash,
    encoding: "base64" as const,
    content: receipt.pre_content,
  };
  if (await pathExists(path.join(root, receipt.backup))) {
    const existing = await readJson(root, receipt.backup, backupSchema);
    if (stringifySortedJson(existing) !== stringifySortedJson(expected)) {
      throw new FrameworkError("legacy hook backup does not match its receipt");
    }
    return;
  }
  await atomicWriteJson(root, receipt.backup, expected);
}

export async function applyTrellisLegacyHookScrub(options: {
  readonly root: string;
  readonly host: string;
  readonly now?: Date;
}) {
  const root = path.resolve(options.root);
  if (options.host !== "codex") {
    throw new FrameworkError(`unsupported Trellis hook host '${options.host}'; supported: codex`);
  }
  await requireInstalledTrellisRuntimeReadOnly(root);
  await preflightReceipt(root);
  return withPidFileLock(root, HOOK_LOCK, async () => {
    let receipt = await preflightReceipt(root);
    const recoveringApply =
      receipt?.phase === "apply-intent" || receipt?.phase === "apply-prepared";
    if (receipt?.phase === "restore-intent" || receipt?.phase === "restore-prepared") {
      throw new FrameworkError("legacy hook restore transaction requires explicit recovery");
    }
    if (receipt?.phase === "applied") {
      const snapshot = await hookSnapshot(root);
      if (snapshotMatches(snapshot, { identity: receipt.post_identity, hash: receipt.post_hash })) {
        await cleanupAtomicTextExchange(root, receipt.apply_exchange);
        const plan = await planTrellisLegacyHookScrub(options);
        return { ...plan, action: "noop" as const, applied: false, recovered: false, receipt };
      }
      if (snapshot?.hash === receipt.post_hash) {
        throw new FrameworkError("legacy hook apply detects same-content target identity ABA");
      }
    }
    let plan: TrellisLegacyHookPlan;
    if (!receipt || receipt.phase === "restored") {
      if (receipt?.phase === "restored") {
        await cleanupAtomicTextExchange(root, receipt.restore_exchange);
        await legacyHookProbe?.("apply-after-restore-cleanup", path.join(root, HOOK_TARGET));
      }
      plan = await planTrellisLegacyHookScrub(options);
      await legacyHookProbe?.("apply-after-plan", path.join(root, HOOK_TARGET));
      if (plan.action === "noop") {
        return { ...plan, applied: false, recovered: false, receipt };
      }
      if (!plan.document || !plan.pre_hash || !plan.pre_identity || !plan.post_hash) {
        throw new FrameworkError("legacy hook scrub plan is incomplete");
      }
      const snapshot = await hookSnapshot(root);
      if (
        !snapshot ||
        !snapshotMatches(snapshot, { identity: plan.pre_identity, hash: plan.pre_hash })
      ) {
        throw new FrameworkError("Codex hooks changed between legacy scrub plan and apply");
      }
      const generation = randomUUID();
      const nextText = stringifySortedJson(plan.document);
      const applyIntent = createAtomicTextExchangeIntent(HOOK_TARGET, nextText, {
        transactionId: `${generation}-apply`,
        expectedIdentity: plan.pre_identity,
        expectedSha256: plan.pre_hash,
      });
      receipt = await writeReceipt(root, {
        __schema: 1,
        contract_version: LEGACY_CODEX_HOOK_CONTRACT_VERSION,
        generation,
        host: "codex",
        target: HOOK_TARGET,
        phase: "apply-intent",
        prepared_at: nowIso(options.now ?? new Date()),
        applied_at: null,
        restored_at: null,
        pre_hash: plan.pre_hash,
        post_hash: plan.post_hash,
        pre_identity: plan.pre_identity,
        post_identity: null,
        restored_identity: null,
        backup: `.assay/trellis/hooks/legacy/backups/${generation}.json`,
        pre_content: Buffer.from(snapshot.text, "utf8").toString("base64"),
        post_document: plan.document,
        removed_groups: [...plan.removed_groups],
        apply_exchange: {
          ...applyIntent,
          target: HOOK_TARGET,
          replacement_identity: null,
        },
        restore_exchange: null,
      });
      await legacyHookProbe?.("apply-after-intent", path.join(root, HOOK_TARGET));
    } else {
      plan = await planTrellisLegacyHookScrub(options).catch(() => ({
        protocol_version: TRELLIS_PROTOCOL_VERSION,
        plugin: TRELLIS_PLUGIN_ID,
        contract_version: LEGACY_CODEX_HOOK_CONTRACT_VERSION,
        host: "codex" as const,
        target: HOOK_TARGET,
        read_only: true as const,
        action: "noop" as const,
        pre_hash: null,
        pre_identity: null,
        post_hash: null,
        removed_groups: [],
        document: null,
        message: "recovering receipt-bound legacy hook transaction",
      }));
    }
    if (receipt.phase === "apply-intent") {
      const snapshot = await hookSnapshot(root);
      if (!snapshotMatches(snapshot, { identity: receipt.pre_identity, hash: receipt.pre_hash })) {
        throw new FrameworkError("legacy hook apply intent no longer matches its source hook");
      }
      await ensureLegacyHookBackup(root, receipt);
      const preparedExchange = await prepareAtomicTextExchange(
        root,
        receipt.apply_exchange,
        stringifySortedJson(receipt.post_document),
      );
      receipt = await writeReceipt(root, {
        ...receipt,
        phase: "apply-prepared",
        apply_exchange: { ...preparedExchange, target: HOOK_TARGET },
      });
      await legacyHookProbe?.("apply-after-prepared", path.join(root, HOOK_TARGET));
    }
    if (receipt.phase !== "apply-prepared") {
      throw new FrameworkError("legacy hook apply receipt did not reach its prepared phase");
    }
    await legacyHookProbe?.("apply-before-cas", path.join(root, HOOK_TARGET));
    await commitAtomicTextExchange(root, receipt.apply_exchange);
    await legacyHookProbe?.("apply-after-hook-write", path.join(root, HOOK_TARGET));
    const installed = await hookSnapshot(root);
    if (
      !snapshotMatches(installed, {
        identity: receipt.apply_exchange.replacement_identity,
        hash: receipt.apply_exchange.replacement_sha256,
      })
    ) {
      throw new FrameworkError("legacy hook scrub post-write hash mismatch");
    }
    const applied = await writeReceipt(root, {
      ...receipt,
      phase: "applied",
      applied_at: nowIso(options.now ?? new Date()),
      post_identity: receipt.apply_exchange.replacement_identity,
    });
    await cleanupAtomicTextExchange(root, receipt.apply_exchange);
    return {
      ...plan,
      applied: !recoveringApply,
      recovered: recoveringApply,
      receipt: applied,
    };
  });
}

export async function restoreTrellisLegacyHookScrub(options: {
  readonly root: string;
  readonly host: string;
  readonly now?: Date;
}) {
  if (options.host !== "codex") {
    throw new FrameworkError(`unsupported Trellis hook host '${options.host}'; supported: codex`);
  }
  const root = path.resolve(options.root);
  await requireInstalledTrellisRuntimeReadOnly(root);
  const receiptBeforeLock = await preflightReceipt(root);
  if (!receiptBeforeLock) throw new FrameworkError("legacy hook restore receipt is missing");
  return withPidFileLock(root, HOOK_LOCK, async () => {
    let receipt = await preflightReceipt(root);
    if (!receipt) throw new FrameworkError("legacy hook restore receipt is missing");
    const recoveringRestore =
      receipt.phase === "restore-intent" || receipt.phase === "restore-prepared";
    if (receipt.phase === "apply-intent" || receipt.phase === "apply-prepared") {
      throw new FrameworkError("legacy hook apply transaction requires apply recovery first");
    }
    if (receipt.phase === "restored") {
      const snapshot = await hookSnapshot(root);
      if (
        snapshotMatches(snapshot, { identity: receipt.restored_identity, hash: receipt.pre_hash })
      ) {
        await cleanupAtomicTextExchange(root, receipt.restore_exchange);
        return { protocol_version: 1, plugin: TRELLIS_PLUGIN_ID, restored: false, receipt };
      }
      if (snapshot?.hash === receipt.pre_hash) {
        throw new FrameworkError("legacy hook restore detects same-content target identity ABA");
      }
      throw new FrameworkError("legacy hook restored target has subsequent writes");
    }
    if (receipt.phase === "applied") {
      const snapshot = await hookSnapshot(root);
      if (
        !snapshotMatches(snapshot, { identity: receipt.post_identity, hash: receipt.post_hash })
      ) {
        if (snapshot?.hash === receipt.post_hash) {
          throw new FrameworkError("legacy hook restore detects same-content target identity ABA");
        }
        throw new FrameworkError(
          "legacy hook restore requires the exact receipted post-scrub hooks file",
        );
      }
      await cleanupAtomicTextExchange(root, receipt.apply_exchange);
      await legacyHookProbe?.("restore-after-apply-cleanup", path.join(root, HOOK_TARGET));
      await ensureLegacyHookBackup(root, receipt);
      const restoreIntent = createAtomicTextExchangeIntent(
        HOOK_TARGET,
        Buffer.from(receipt.pre_content, "base64").toString("utf8"),
        {
          transactionId: `${receipt.generation}-restore`,
          expectedIdentity: receipt.post_identity,
          expectedSha256: receipt.post_hash,
        },
      );
      receipt = await writeReceipt(root, {
        ...receipt,
        phase: "restore-intent",
        restore_exchange: {
          ...restoreIntent,
          target: HOOK_TARGET,
          replacement_identity: null,
        },
      });
      await legacyHookProbe?.("restore-after-intent", path.join(root, HOOK_TARGET));
    }
    if (receipt.phase === "restore-intent") {
      const snapshot = await hookSnapshot(root);
      if (
        !snapshotMatches(snapshot, {
          identity: receipt.restore_exchange.expected_identity,
          hash: receipt.restore_exchange.expected_sha256,
        })
      ) {
        throw new FrameworkError("legacy hook restore intent no longer matches its source hook");
      }
      await ensureLegacyHookBackup(root, receipt);
      const preparedExchange = await prepareAtomicTextExchange(
        root,
        receipt.restore_exchange,
        Buffer.from(receipt.pre_content, "base64").toString("utf8"),
      );
      receipt = await writeReceipt(root, {
        ...receipt,
        phase: "restore-prepared",
        restore_exchange: { ...preparedExchange, target: HOOK_TARGET },
      });
      await legacyHookProbe?.("restore-after-prepared", path.join(root, HOOK_TARGET));
    }
    if (receipt.phase !== "restore-prepared") {
      throw new FrameworkError("legacy hook restore receipt did not reach its prepared phase");
    }
    await commitAtomicTextExchange(root, receipt.restore_exchange);
    await legacyHookProbe?.("restore-after-hook-write", path.join(root, HOOK_TARGET));
    const installed = await hookSnapshot(root);
    if (
      !snapshotMatches(installed, {
        identity: receipt.restore_exchange.replacement_identity,
        hash: receipt.restore_exchange.replacement_sha256,
      })
    ) {
      throw new FrameworkError("legacy hook restore post-write identity/hash mismatch");
    }
    const restored = await writeReceipt(root, {
      ...receipt,
      phase: "restored",
      restored_at: nowIso(options.now ?? new Date()),
      restored_identity: receipt.restore_exchange.replacement_identity,
    });
    await cleanupAtomicTextExchange(root, receipt.restore_exchange);
    return {
      protocol_version: 1,
      plugin: TRELLIS_PLUGIN_ID,
      restored: !recoveringRestore,
      recovered: recoveringRestore,
      receipt: restored,
    };
  });
}
