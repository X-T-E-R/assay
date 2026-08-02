import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BARE_ARCHETYPE,
  createTempDirectoryFixture,
  pathExists,
  writeBareArchetype,
} from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addPlugin,
  appendTrellisJournal,
  applyTrellisLegacyMigration,
  applyTrellisWal,
  archiveTrellisTask,
  atomicWriteJson,
  claimTrellisWorker,
  cleanupTrellisLegacyMigration,
  createTrellisChannel,
  createTrellisTask,
  currentTrellisSession,
  deterministicRemoveTombstone,
  endTrellisSession,
  finishTrellisWorker,
  getCurrentTrellisTask,
  heartbeatTrellisWorker,
  initFramework,
  listTrellisJournal,
  listTrellisMemory,
  listTrellisTasks,
  listTrellisWorkers,
  mutateTrellisLease,
  planTrellisLegacyMigration,
  prepareVerifiedRemove,
  readTrellisChannel,
  rebindTrellisSession,
  registerTrellisWorker,
  removePlugin,
  repairTrellisChannel,
  rollbackTrellisLegacyMigration,
  safeTrellisPath,
  sendTrellisChannel,
  setTrellisChannelCursor,
  setTrellisConfig,
  setTrellisMemoryProbeForTests,
  setTrellisStorageProbeForTests,
  showTrellisConfig,
  startTrellisSession,
  transitionTrellisTask,
  verifiedRemove,
  withInstalledTrellisMutation,
  withPidFileLock,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-trellis-operational");
beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});
afterEach(async () => {
  setTrellisStorageProbeForTests(null);
  setTrellisMemoryProbeForTests(null);
  await tempDirs.cleanup();
});
async function workspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype: BARE_ARCHETYPE });
  await addPlugin({ root, plugin: "assay.trellis" });
  return root;
}

describe("assay.trellis operational v1", () => {
  it("completes, closes pointers, lists, and archives terminal tasks idempotently", async () => {
    const root = await workspace("tasks");
    const created = await createTrellisTask({ root, title: "Finish me", sessionId: "session-a" });
    if (!created.task) throw new Error("task creation returned no task");
    const id = created.task.id;
    expect((await transitionTrellisTask({ root, taskId: id, status: "completed" })).changed).toBe(
      true,
    );
    expect((await transitionTrellisTask({ root, taskId: id, status: "completed" })).changed).toBe(
      false,
    );
    expect((await getCurrentTrellisTask({ root, sessionId: "session-a" })).task).toBeNull();
    expect((await listTrellisTasks({ root, status: "completed", limit: 1 })).tasks[0]?.id).toBe(id);
    expect((await archiveTrellisTask({ root, taskId: id })).archived).toBe(true);
    expect((await archiveTrellisTask({ root, taskId: id })).archived).toBe(false);
    expect((await listTrellisTasks({ root, archived: true })).tasks[0]?.id).toBe(id);
  });

  it("manages sessions, journal/config precedence, and recovers a prepared generic WAL", async () => {
    const root = await workspace("domains");
    const created = await createTrellisTask({ root, title: "Bound" });
    if (!created.task) throw new Error("task creation returned no task");
    await startTrellisSession({ root, sessionId: "external-worker" });
    await rebindTrellisSession({ root, sessionId: "external-worker", taskId: created.task.id });
    expect(
      (await currentTrellisSession({ root, sessionId: "external-worker" })).session
        ?.current_task_id,
    ).toBe(created.task.id);
    expect(
      await readFile(path.join(root, ".assay", "trellis", "sessions.json"), "utf8"),
    ).not.toContain("current_task_id");
    await endTrellisSession({ root, sessionId: "external-worker" });
    expect(
      (await currentTrellisSession({ root, sessionId: "external-worker" })).session?.status,
    ).toBe("ended");

    await appendTrellisJournal({ root, kind: "note", message: "durable" });
    await appendTrellisJournal({ root, kind: "note", message: "second" });
    await appendTrellisJournal({ root, kind: "note", message: "third" });
    expect((await listTrellisJournal({ root, limit: 1 })).entries[0]?.message).toBe("durable");
    const firstPage = await listTrellisJournal({ root, limit: 2 });
    expect(firstPage.next_cursor).toBe("2");
    if (!firstPage.next_cursor) throw new Error("journal page did not produce a cursor");
    expect(
      (await listTrellisJournal({ root, limit: 2, after: firstPage.next_cursor })).entries[0]
        ?.message,
    ).toBe("third");
    await expect(listTrellisJournal({ root, after: "999" })).rejects.toThrow(
      /unknown journal cursor/,
    );
    await setTrellisConfig({ root, key: "journal_page_size", value: 9 });
    expect(
      (
        await showTrellisConfig({
          root,
          env: { ASSAY_TRELLIS_JOURNAL_PAGE_SIZE: "7" },
          overrides: { journal_page_size: 5 },
        })
      ).values.journal_page_size,
    ).toBe(5);

    const relative = ".assay/trellis/config.json";
    const content = `${JSON.stringify({ __schema: 1, values: { journal_page_size: 11 }, updated_at: "2026-08-02T00:00:00+00:00" }, null, 2)}\n`;
    await writeFile(
      path.join(root, ".assay", "trellis", "wal", "active.json"),
      JSON.stringify({
        __schema: 1,
        id: "a928f2cc-58e4-45b8-a37c-641371266160",
        operation: "test.crash",
        prepared_at: "2026-08-02T00:00:00Z",
        writes: [
          { path: relative, content, sha256: createHash("sha256").update(content).digest("hex") },
        ],
        deletes: [],
      }),
      "utf8",
    );
    await getCurrentTrellisTask({ root });
    expect((await showTrellisConfig({ root, env: {} })).values.journal_page_size).toBe(11);
  });

  it("provides monotonic/idempotent channels, expiring leases, and an external worker reducer", async () => {
    const root = await workspace("channel-worker");
    await createTrellisChannel({ root, name: "jobs" });
    const sent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sendTrellisChannel({
          root,
          channel: "jobs",
          type: "job",
          payload: { index },
          idempotencyKey: `key-${index}`,
        }),
      ),
    );
    expect(sent.map((item) => item.event.seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      (
        await sendTrellisChannel({
          root,
          channel: "jobs",
          type: "job",
          payload: {},
          idempotencyKey: "key-0",
        })
      ).changed,
    ).toBe(false);
    expect(
      (
        await readTrellisChannel({
          root,
          channel: "jobs",
          consumer: "consumer",
          limit: 3,
          advance: true,
        })
      ).events,
    ).toHaveLength(3);
    expect((await repairTrellisChannel({ root, channel: "jobs" })).changed).toBe(false);
    await expect(
      setTrellisChannelCursor({ root, channel: "jobs", consumer: "future", seq: 99 }),
    ).rejects.toThrow(/exceeds durable tail/);

    const acquired = await mutateTrellisLease({
      root,
      channel: "jobs",
      lease: "manual",
      action: "acquire",
      owner: "one",
      now: new Date("2026-08-02T00:00:00Z"),
      ttlMs: 1000,
    });
    await expect(
      mutateTrellisLease({
        root,
        channel: "jobs",
        lease: "too-short",
        action: "acquire",
        owner: "one",
        ttlMs: 999,
      }),
    ).rejects.toThrow();
    await expect(
      mutateTrellisLease({
        root,
        channel: "jobs",
        lease: "manual",
        action: "acquire",
        owner: "two",
        now: new Date("2026-08-02T00:00:00.500Z"),
      }),
    ).rejects.toThrow(/active/);
    await expect(
      mutateTrellisLease({
        root,
        channel: "jobs",
        lease: "manual",
        action: "release",
        owner: "one",
        token: acquired.lease.token,
        now: new Date("2026-08-02T00:00:02Z"),
      }),
    ).rejects.toThrow(/not active/);

    await registerTrellisWorker({ root, workerId: "worker-1", channel: "jobs" });
    await createTrellisChannel({ root, name: "other-jobs" });
    await expect(
      registerTrellisWorker({ root, workerId: "worker-1", channel: "other-jobs" }),
    ).rejects.toThrow(/different channel or lease/);
    const claim = await claimTrellisWorker({ root, workerId: "worker-1" });
    expect(
      JSON.stringify(await registerTrellisWorker({ root, workerId: "worker-1", channel: "jobs" })),
    ).not.toContain(claim.token);
    await expect(
      finishTrellisWorker({
        root,
        workerId: "worker-1",
        status: "completed",
        token: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/ownership mismatch/);
    await heartbeatTrellisWorker({ root, workerId: "worker-1", token: claim.token });
    await finishTrellisWorker({
      root,
      workerId: "worker-1",
      status: "completed",
      token: claim.token,
      result: { ok: true },
    });
    expect((await listTrellisWorkers({ root })).workers[0]?.status).toBe("completed");
  });

  it("keeps Codex memory read-only and rejects channel reparse/dot-segment paths", async () => {
    const root = await workspace("memory-paths");
    const memoryRoot = path.join(await tempDirs.createTempDir(), "sessions");
    await mkdir(memoryRoot, { recursive: true });
    const fixture = path.join(memoryRoot, "rollout.jsonl");
    const original = `${JSON.stringify({ id: "thread-1", timestamp: "2026-08-02", message: "needle" })}\n{bad`;
    await writeFile(fixture, original, "utf8");
    const listed = await listTrellisMemory({ workspaceRoot: root, memoryRoot, limit: 10 });
    expect(listed.records.length).toBeGreaterThan(0);
    expect(listed.diagnostics.length).toBeGreaterThan(0);
    expect(await readFile(fixture, "utf8")).toBe(original);
    const malformed = path.join(memoryRoot, "many.jsonl");
    await writeFile(malformed, `${Array.from({ length: 2_000 }, () => "{bad").join("\n")}\n`);
    const bounded = await listTrellisMemory({ workspaceRoot: root, memoryRoot, limit: 1 });
    expect(bounded.records).toHaveLength(1);
    expect(bounded.diagnostics.length).toBeLessThanOrEqual(100);
    expect(bounded.diagnostics_omitted).toBeGreaterThan(0);
    await expect(createTrellisChannel({ root, name: ".." })).rejects.toThrow(/dot-segment/);
    const outside = await tempDirs.createTempDir();
    const link = path.join(root, ".assay", "trellis", "channels", "linked");
    await symlink(outside, link, "junction");
    await expect(safeTrellisPath(root, ".assay/trellis/channels/linked/data.json")).rejects.toThrow(
      /reparse/,
    );
  });

  it("rejects deterministic junction exchanges after storage and memory prechecks", async () => {
    const root = await workspace("junction-barriers");
    const storageParent = path.join(root, ".assay", "trellis", "channels", "race");
    const storageSaved = `${storageParent}-saved`;
    const outsideStorage = path.join(await tempDirs.createTempDir(), "outside-storage");
    await mkdir(storageParent, { recursive: true });
    await mkdir(outsideStorage, { recursive: true });
    let storageSwapped = false;
    setTrellisStorageProbeForTests(async (phase) => {
      if (phase !== "atomic-before-open" || storageSwapped) return;
      storageSwapped = true;
      await rename(storageParent, storageSaved);
      await symlink(outsideStorage, storageParent, "junction");
    });
    try {
      await expect(
        atomicWriteJson(root, ".assay/trellis/channels/race/value.json", { ok: true }),
      ).rejects.toThrow(/parent|reparse|identity/);
      expect(await pathExists(path.join(outsideStorage, "value.json"))).toBe(false);
    } finally {
      setTrellisStorageProbeForTests(null);
    }

    const memoryRoot = path.join(await tempDirs.createTempDir(), "memory");
    const memoryBucket = path.join(memoryRoot, "bucket");
    const memorySaved = `${memoryBucket}-saved`;
    const outsideMemory = path.join(await tempDirs.createTempDir(), "outside-memory");
    await mkdir(memoryBucket, { recursive: true });
    await mkdir(outsideMemory, { recursive: true });
    await writeFile(path.join(memoryBucket, "rollout.jsonl"), '{"id":"inside"}\n');
    await writeFile(path.join(outsideMemory, "rollout.jsonl"), '{"id":"outside"}\n');
    let memorySwapped = false;
    setTrellisMemoryProbeForTests(async () => {
      if (memorySwapped) return;
      memorySwapped = true;
      await rename(memoryBucket, memorySaved);
      await symlink(outsideMemory, memoryBucket, "junction");
    });
    try {
      await expect(
        listTrellisMemory({ workspaceRoot: root, memoryRoot, limit: 1 }),
      ).rejects.toThrow(/identity|escapes/);
    } finally {
      setTrellisMemoryProbeForTests(null);
    }
  });

  it("rejects junction exchanges in WAL, migration cleanup, and lifecycle purge removes", async () => {
    const walRoot = await workspace("wal-remove-barrier");
    const walParent = path.join(walRoot, ".assay", "trellis", "channels", "wal-delete");
    const walSaved = `${walParent}-saved`;
    const walOutside = path.join(await tempDirs.createTempDir(), "wal-outside");
    await mkdir(walParent, { recursive: true });
    await mkdir(walOutside, { recursive: true });
    await writeFile(path.join(walParent, "value.json"), "inside");
    await writeFile(path.join(walOutside, "value.json"), "outside");
    let walSwapped = false;
    setTrellisStorageProbeForTests(async (phase, target) => {
      if (phase !== "remove-before-rename" || !target.endsWith("value.json") || walSwapped) return;
      walSwapped = true;
      await rename(walParent, walSaved);
      await symlink(walOutside, walParent, "junction");
    });
    try {
      await expect(
        withInstalledTrellisMutation(walRoot, (lockedRoot) =>
          applyTrellisWal(
            lockedRoot,
            "probe.wal-delete",
            [],
            [".assay/trellis/channels/wal-delete/value.json"],
          ),
        ),
      ).rejects.toThrow(/parent|reparse|identity/);
      expect(await readFile(path.join(walOutside, "value.json"), "utf8")).toBe("outside");
    } finally {
      setTrellisStorageProbeForTests(null);
    }

    const migrationRoot = await workspace("migration-remove-barrier");
    const generation = "11111111-1111-4111-8111-111111111111";
    const generationRoot = path.join(migrationRoot, ".assay", "trellis", "migrations", generation);
    const generationSaved = `${generationRoot}-saved`;
    const migrationOutside = path.join(await tempDirs.createTempDir(), "migration-outside");
    await mkdir(path.join(generationRoot, "archive"), { recursive: true });
    await mkdir(path.join(migrationOutside, "archive"), { recursive: true });
    await writeFile(path.join(generationRoot, "archive", "inside.json"), "inside");
    await writeFile(path.join(migrationOutside, "archive", "outside.json"), "outside");
    let migrationSwapped = false;
    setTrellisStorageProbeForTests(async (phase, target) => {
      const normalized = target.replaceAll("\\", "/");
      if (phase !== "remove-before-rename" || !normalized.endsWith("/archive") || migrationSwapped)
        return;
      migrationSwapped = true;
      await rename(generationRoot, generationSaved);
      await symlink(migrationOutside, generationRoot, "junction");
    });
    try {
      await expect(
        cleanupTrellisLegacyMigration({ root: migrationRoot, generation, yes: true }),
      ).rejects.toThrow(/parent|reparse|identity/);
      expect(await readFile(path.join(migrationOutside, "archive", "outside.json"), "utf8")).toBe(
        "outside",
      );
    } finally {
      setTrellisStorageProbeForTests(null);
    }

    const lifecycleRoot = await workspace("lifecycle-remove-barrier");
    const assayRoot = path.join(lifecycleRoot, ".assay");
    const assaySaved = `${assayRoot}-saved`;
    const lifecycleOutside = path.join(await tempDirs.createTempDir(), "lifecycle-outside");
    await mkdir(path.join(lifecycleOutside, "trellis"), { recursive: true });
    await writeFile(path.join(lifecycleOutside, "trellis", "outside.json"), "outside");
    let lifecycleSwapped = false;
    setTrellisStorageProbeForTests(async (phase, target) => {
      const normalized = target.replaceAll("\\", "/");
      if (
        phase !== "remove-before-rename" ||
        !normalized.endsWith("/.assay/trellis") ||
        lifecycleSwapped
      )
        return;
      lifecycleSwapped = true;
      await rename(assayRoot, assaySaved);
      await symlink(lifecycleOutside, assayRoot, "junction");
    });
    try {
      await expect(
        removePlugin({
          root: lifecycleRoot,
          plugin: "assay.trellis",
          mode: "uninstall",
          purge: true,
          yes: true,
        }),
      ).rejects.toThrow(/parent|reparse|identity/);
      expect(await readFile(path.join(lifecycleOutside, "trellis", "outside.json"), "utf8")).toBe(
        "outside",
      );
    } finally {
      setTrellisStorageProbeForTests(null);
    }
  });

  it("recovers deterministic removal tombstones and fail-closes coexistence or identity mismatch", async () => {
    const walRoot = await workspace("wal-remove-crash");
    const walRelative = ".assay/trellis/channels/crash-delete/value.json";
    const walTarget = path.join(walRoot, walRelative);
    await mkdir(path.dirname(walTarget), { recursive: true });
    await writeFile(walTarget, "inside");
    let walCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "remove-after-rename" && target.includes("value.json") && !walCrashed) {
        walCrashed = true;
        throw new Error("probe crash after WAL rename");
      }
    });
    await expect(
      withInstalledTrellisMutation(walRoot, (lockedRoot) =>
        applyTrellisWal(lockedRoot, "probe.crash-delete", [], [walRelative]),
      ),
    ).rejects.toThrow(/probe crash/);
    setTrellisStorageProbeForTests(null);
    const walFile = path.join(walRoot, ".assay", "trellis", "wal", "active.json");
    const wal = JSON.parse(await readFile(walFile, "utf8")) as {
      deletes: Array<{ path: string; tombstone: string }>;
    };
    const walTombstone = path.join(walRoot, wal.deletes[0]?.tombstone ?? "missing");
    expect(await pathExists(walFile)).toBe(true);
    expect(await pathExists(walTombstone)).toBe(true);
    expect(await pathExists(walTarget)).toBe(false);
    await writeFile(walTarget, "neighbor-recreated");
    await expect(getCurrentTrellisTask({ root: walRoot })).rejects.toThrow(
      /both original and tombstone/,
    );
    expect(await readFile(walTarget, "utf8")).toBe("neighbor-recreated");
    expect(await pathExists(walTombstone)).toBe(true);
    await rm(walTarget, { force: true });
    await getCurrentTrellisTask({ root: walRoot });
    expect(await pathExists(walFile)).toBe(false);
    expect(await pathExists(walTombstone)).toBe(false);

    const migrationRoot = await workspace("migration-remove-crash");
    const generation = "22222222-2222-4222-8222-222222222222";
    const archive = path.join(
      migrationRoot,
      ".assay",
      "trellis",
      "migrations",
      generation,
      "archive",
    );
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, "inside.json"), "inside");
    let migrationCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "remove-after-rename" && target.includes("archive") && !migrationCrashed) {
        migrationCrashed = true;
        throw new Error("probe crash after migration rename");
      }
    });
    await expect(
      cleanupTrellisLegacyMigration({ root: migrationRoot, generation, yes: true }),
    ).rejects.toThrow(/probe crash/);
    setTrellisStorageProbeForTests(null);
    const cleanupPath = path.join(path.dirname(archive), "cleanup.json");
    expect(JSON.parse(await readFile(cleanupPath, "utf8")).phase).toBe("prepared");
    await cleanupTrellisLegacyMigration({ root: migrationRoot, generation, yes: true });
    const cleanup = JSON.parse(await readFile(cleanupPath, "utf8")) as {
      phase: string;
      deletes: Array<{ tombstone: string }>;
    };
    expect(cleanup.phase).toBe("completed");
    for (const deletion of cleanup.deletes)
      expect(await pathExists(path.join(migrationRoot, deletion.tombstone))).toBe(false);

    const lifecycleRoot = await workspace("lifecycle-remove-crash");
    let lifecycleCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "remove-after-rename" && target.includes("trellis") && !lifecycleCrashed) {
        lifecycleCrashed = true;
        throw new Error("probe crash after lifecycle rename");
      }
    });
    await expect(
      removePlugin({
        root: lifecycleRoot,
        plugin: "assay.trellis",
        mode: "uninstall",
        purge: true,
        yes: true,
      }),
    ).rejects.toThrow(/probe crash/);
    setTrellisStorageProbeForTests(null);
    const lifecycleFile = path.join(
      lifecycleRoot,
      ".assay",
      "plugin-lifecycle",
      "assay.trellis.json",
    );
    const interruptedLifecycle = JSON.parse(await readFile(lifecycleFile, "utf8")) as {
      phase: string;
      runtime_delete: { tombstone: string };
    };
    expect(interruptedLifecycle.phase).toBe("control-committed");
    expect(
      await pathExists(path.join(lifecycleRoot, interruptedLifecycle.runtime_delete.tombstone)),
    ).toBe(true);
    await removePlugin({
      root: lifecycleRoot,
      plugin: "assay.trellis",
      mode: "uninstall",
      purge: true,
      yes: true,
    });
    expect(JSON.parse(await readFile(lifecycleFile, "utf8")).phase).toBe("completed");
    expect(
      await pathExists(path.join(lifecycleRoot, interruptedLifecycle.runtime_delete.tombstone)),
    ).toBe(false);

    const mismatchRoot = await workspace("remove-identity-mismatch");
    const mismatchRelative = ".assay/trellis/channels/mismatch/value.json";
    const mismatchTarget = path.join(mismatchRoot, mismatchRelative);
    await mkdir(path.dirname(mismatchTarget), { recursive: true });
    await writeFile(mismatchTarget, "original");
    const mismatchReceipt = await prepareVerifiedRemove(
      mismatchRoot,
      mismatchRelative,
      "identity-mismatch",
    );
    const mismatchTombstone = path.join(mismatchRoot, mismatchReceipt.tombstone);
    await rename(mismatchTarget, mismatchTombstone);
    await rm(mismatchTombstone, { force: true });
    await writeFile(mismatchTombstone, "replacement");
    const neighbor = path.join(path.dirname(mismatchTarget), "neighbor.json");
    await writeFile(neighbor, "neighbor");
    await expect(verifiedRemove(mismatchRoot, mismatchReceipt)).rejects.toThrow(
      /identity mismatch/,
    );
    expect(await readFile(mismatchTombstone, "utf8")).toBe("replacement");
    expect(await readFile(neighbor, "utf8")).toBe("neighbor");
    expect(
      (await readdir(path.dirname(mismatchTarget))).filter((name) => name.includes("neighbor")),
    ).toEqual(["neighbor.json"]);
  }, 60_000);

  it("recovers WAL self-removal from its external control receipt without adopting collisions", async () => {
    const renameCrashRoot = await workspace("wal-self-rename-crash");
    let renameCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "remove-after-rename" && target.includes(".active.json.") && !renameCrashed) {
        renameCrashed = true;
        throw new Error("probe crash after active WAL rename");
      }
    });
    await expect(
      withInstalledTrellisMutation(renameCrashRoot, (lockedRoot) =>
        applyTrellisWal(lockedRoot, "probe.self-rename-crash", [
          {
            path: ".assay/trellis/channels/self-rename/result.json",
            value: { committed: true },
          },
        ]),
      ),
    ).rejects.toThrow(/probe crash after active WAL rename/);
    setTrellisStorageProbeForTests(null);

    const walDirectory = path.join(renameCrashRoot, ".assay", "trellis", "wal");
    const activeFile = path.join(walDirectory, "active.json");
    const controlFile = path.join(walDirectory, "control.json");
    const control = JSON.parse(await readFile(controlFile, "utf8")) as {
      wal_id: string;
      active: { path: string; tombstone: string; identity: { dev: number; ino: number } };
    };
    const governedTombstone = path.join(renameCrashRoot, control.active.tombstone);
    expect(control.active.path).toBe(".assay/trellis/wal/active.json");
    expect(control.active.tombstone).toBe(
      deterministicRemoveTombstone(control.active.path, `${control.wal_id}-receipt`),
    );
    expect(await pathExists(activeFile)).toBe(false);
    expect(await pathExists(governedTombstone)).toBe(true);
    expect(await pathExists(controlFile)).toBe(true);

    const unrelatedTombstone = path.join(walDirectory, ".active.json.unrelated.tombstone");
    await writeFile(unrelatedTombstone, "unrelated");
    await writeFile(activeFile, await readFile(governedTombstone));
    await expect(getCurrentTrellisTask({ root: renameCrashRoot })).rejects.toThrow(
      /both original and tombstone/,
    );
    expect(await pathExists(controlFile)).toBe(true);
    expect(await pathExists(governedTombstone)).toBe(true);
    expect(await pathExists(activeFile)).toBe(true);
    expect(await readFile(unrelatedTombstone, "utf8")).toBe("unrelated");
    await rm(activeFile, { force: true });
    await getCurrentTrellisTask({ root: renameCrashRoot });
    expect(await pathExists(controlFile)).toBe(false);
    expect(await pathExists(governedTombstone)).toBe(false);
    expect(await readFile(unrelatedTombstone, "utf8")).toBe("unrelated");

    const removedCrashRoot = await workspace("wal-self-removed-crash");
    let removedCrashed = false;
    setTrellisStorageProbeForTests((phase) => {
      if (phase === "wal-after-active-remove" && !removedCrashed) {
        removedCrashed = true;
        throw new Error("probe crash after active WAL removal");
      }
    });
    await expect(
      withInstalledTrellisMutation(removedCrashRoot, (lockedRoot) =>
        applyTrellisWal(lockedRoot, "probe.self-removed-crash", []),
      ),
    ).rejects.toThrow(/probe crash after active WAL removal/);
    setTrellisStorageProbeForTests(null);
    const removedWalDirectory = path.join(removedCrashRoot, ".assay", "trellis", "wal");
    const removedControlFile = path.join(removedWalDirectory, "control.json");
    const removedControl = JSON.parse(await readFile(removedControlFile, "utf8")) as {
      active: { tombstone: string };
    };
    expect(await pathExists(path.join(removedWalDirectory, "active.json"))).toBe(false);
    expect(await pathExists(path.join(removedCrashRoot, removedControl.active.tombstone))).toBe(
      false,
    );
    expect(await pathExists(removedControlFile)).toBe(true);
    await getCurrentTrellisTask({ root: removedCrashRoot });
    expect(await pathExists(removedControlFile)).toBe(false);

    const mismatchRoot = await workspace("wal-self-identity-mismatch");
    let mismatchCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "remove-after-rename" && target.includes(".active.json.") && !mismatchCrashed) {
        mismatchCrashed = true;
        throw new Error("probe crash before WAL tombstone removal");
      }
    });
    await expect(
      withInstalledTrellisMutation(mismatchRoot, (lockedRoot) =>
        applyTrellisWal(lockedRoot, "probe.self-identity-mismatch", []),
      ),
    ).rejects.toThrow(/probe crash before WAL tombstone removal/);
    setTrellisStorageProbeForTests(null);
    const mismatchControlFile = path.join(mismatchRoot, ".assay", "trellis", "wal", "control.json");
    const mismatchControl = JSON.parse(await readFile(mismatchControlFile, "utf8")) as {
      active: { tombstone: string };
    };
    const mismatchTombstone = path.join(mismatchRoot, mismatchControl.active.tombstone);
    await rm(mismatchTombstone, { force: true });
    await writeFile(mismatchTombstone, "replacement");
    await expect(getCurrentTrellisTask({ root: mismatchRoot })).rejects.toThrow(
      /identity mismatch/,
    );
    expect(await readFile(mismatchTombstone, "utf8")).toBe("replacement");
    expect(await pathExists(mismatchControlFile)).toBe(true);

    const collisionRoot = await workspace("remove-preexisting-collision");
    const collisionRelative = ".assay/trellis/channels/collision/value.json";
    const collisionTransaction = "preexisting-collision";
    const collisionTombstoneRelative = deterministicRemoveTombstone(
      collisionRelative,
      collisionTransaction,
    );
    const collisionTombstone = path.join(collisionRoot, collisionTombstoneRelative);
    await mkdir(path.dirname(collisionTombstone), { recursive: true });
    await writeFile(collisionTombstone, "pre-existing-content");
    await expect(
      prepareVerifiedRemove(collisionRoot, collisionRelative, collisionTransaction),
    ).rejects.toThrow(/tombstone collision/);
    expect(await readFile(collisionTombstone, "utf8")).toBe("pre-existing-content");
    expect(await pathExists(path.join(collisionRoot, collisionRelative))).toBe(false);
  }, 60_000);

  it("atomically takes over stale locks across 100 three-contender rounds", async () => {
    const root = path.join(await tempDirs.createTempDir(), "stale-lock-race");
    const lockRelative = ".assay/trellis/.lock";
    const lockFile = path.join(root, lockRelative);
    const gateFile = `${lockFile}.gate`;
    const staleFiles = [`${lockFile}.stale`, `${gateFile}.recovery.stale`];
    await mkdir(path.dirname(lockFile), { recursive: true });
    let active = 0;
    const batchMaxima: number[] = [];
    await writeFile(
      gateFile,
      `${JSON.stringify({ pid: 2_147_483_647, token: "dead-gate-holder" })}\n`,
    );
    const deadGateTime = new Date(Date.now() - 60_000);
    await utimes(gateFile, deadGateTime, deadGateTime);
    for (const staleFile of staleFiles) {
      await writeFile(
        staleFile,
        `${JSON.stringify({ pid: 2_147_483_647, token: "abandoned-stale" })}\n`,
      );
      await utimes(staleFile, deadGateTime, deadGateTime);
    }
    let transientSnapshotContention = 0;
    setTrellisStorageProbeForTests((phase) => {
      if (phase !== "lock-before-snapshot" || transientSnapshotContention >= 10) return;
      transientSnapshotContention += 1;
      throw Object.assign(new Error("simulated Windows sharing contention"), { code: "EPERM" });
    });
    await withPidFileLock(root, lockRelative, async () => undefined, { staleMs: 1 });
    setTrellisStorageProbeForTests(null);
    expect(transientSnapshotContention).toBe(10);
    expect(await pathExists(gateFile)).toBe(false);
    expect(await pathExists(`${gateFile}.recovery`)).toBe(false);
    for (const staleFile of staleFiles) expect(await pathExists(staleFile)).toBe(false);
    for (let batch = 0; batch < 3; batch += 1) {
      let maxSeen = 0;
      for (let round = 0; round < 100; round += 1) {
        await writeFile(
          lockFile,
          `${JSON.stringify({ pid: 2_147_483_647, token: `stale-${batch}-${round}` })}\n`,
        );
        const old = new Date(Date.now() - 60_000);
        await utimes(lockFile, old, old);
        await Promise.all(
          Array.from({ length: 3 }, () =>
            withPidFileLock(
              root,
              lockRelative,
              async () => {
                active += 1;
                maxSeen = Math.max(maxSeen, active);
                await new Promise((resolve) => setTimeout(resolve, 1));
                active -= 1;
              },
              { staleMs: 1 },
            ),
          ),
        );
      }
      batchMaxima.push(maxSeen);
    }
    expect(batchMaxima).toEqual([1, 1, 1]);
  }, 120_000);

  it("plans/applies/rolls back legacy state without deleting sources and removes plugins safely", async () => {
    const root = await workspace("migration-lifecycle");
    const legacy = path.join(root, ".trellis");
    await mkdir(path.join(legacy, "tasks"), { recursive: true });
    await writeFile(
      path.join(legacy, "tasks", "legacy.json"),
      JSON.stringify({ id: "legacy", title: "Migrated", status: "open" }),
      "utf8",
    );
    await writeFile(path.join(legacy, "unknown.bin"), "preserve", "utf8");
    const plan = await planTrellisLegacyMigration({ root });
    expect(plan.entries.map((entry) => entry.category)).toEqual(
      expect.arrayContaining(["dynamic-convert", "modified-or-unknown-archive"]),
    );
    const applied = await applyTrellisLegacyMigration({ root });
    const target = applied.operation.entries.find((entry) =>
      entry.source.endsWith("legacy.json"),
    )?.target;
    expect(target).toContain(".assay/trellis/tasks/");
    if (!target) throw new Error("migration did not produce a task target");
    expect(await pathExists(path.join(root, target))).toBe(true);
    await rollbackTrellisLegacyMigration({ root, generation: applied.operation.generation });
    expect(await pathExists(path.join(root, target))).toBe(false);
    expect(await readFile(path.join(legacy, "unknown.bin"), "utf8")).toBe("preserve");
    const disabled = await removePlugin({ root, plugin: "assay.trellis", mode: "disable" });
    expect(disabled.dataPreserved).toBe(true);
    expect(await pathExists(path.join(root, ".assay", "trellis"))).toBe(true);
    expect(await readFile(path.join(root, ".assay", "manifest.json"), "utf8")).toContain(
      "assay.trellis",
    );
    await expect(
      removePlugin({
        root,
        plugin: "assay.trellis",
        mode: "disable",
        purge: true,
        yes: true,
      }),
    ).rejects.toThrow(/preserves runtime data/);
    await addPlugin({ root, plugin: "assay.trellis" });
    const purged = await removePlugin({
      root,
      plugin: "assay.trellis",
      mode: "uninstall",
      purge: true,
      yes: true,
    });
    expect(purged.purgeReceipt).toContain(".assay/backups/");
    expect(await pathExists(path.join(root, ".assay", "trellis"))).toBe(false);
    if (!purged.purgeReceipt) throw new Error("purge did not return a backup receipt");
    expect(await pathExists(path.join(root, purged.purgeReceipt))).toBe(true);
  });
});
