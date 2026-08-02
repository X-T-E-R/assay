import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BARE_ARCHETYPE,
  createTempDirectoryFixture,
  pathExists,
  writeBareArchetype,
} from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CODEX_TRELLIS_HOOK_COMMAND,
  CODEX_TRELLIS_HOOK_MARKER,
  TRELLIS_RUNTIME_STATE_FILE,
  TRELLIS_TRANSACTION_FILE,
  addCapability,
  addPlugin,
  checkFramework,
  checkPlugins,
  createAdr,
  createTrellisTask,
  getCurrentTrellisTask,
  getDecisionGovernanceStatus,
  getTrellisContext,
  initFramework,
  installTrellisHook,
  loadManifest,
  loadPluginsState,
  probeTrellisRuntime,
  reconcilePlugins,
  removeTrellisHook,
  renderCodexSessionStartHook,
  saveManifest,
  savePluginsState,
  setTrellisStorageProbeForTests,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-trellis-runtime");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  setTrellisStorageProbeForTests(null);
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype: BARE_ARCHETYPE });
  return root;
}

describe("assay.trellis built-in runtime", () => {
  it("records hook ownership through the installed mutation WAL", async () => {
    const root = await workspace("HookReceiptWal");
    await addPlugin({ root, plugin: "assay.trellis" });
    const writes: string[] = [];
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "atomic-before-open") writes.push(target.replaceAll("\\", "/"));
    });
    await installTrellisHook({ root, host: "codex", apply: true });
    await removeTrellisHook({ root, host: "codex" });
    expect(
      writes.filter((target) => target.endsWith("/.assay/trellis/wal/active.json")),
    ).toHaveLength(2);
    expect(writes.some((target) => target.endsWith("/.assay/trellis/state.json"))).toBe(true);
  });

  it("installs v1 state under .assay and leaves native decisions active", async () => {
    const root = await workspace("BuiltInTrellis");
    const result = await addPlugin({
      root,
      plugin: "trellis",
      now: new Date("2026-08-02T08:00:00.000Z"),
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "assay.trellis",
        kind: "workspace-runtime",
        action: "install",
      }),
    ]);
    expect(await pathExists(path.join(root, ".trellis"))).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, TRELLIS_RUNTIME_STATE_FILE), "utf8"))).toEqual(
      expect.objectContaining({ __schema: 1, protocol_version: 1, session_currents: {} }),
    );
    expect((await loadManifest(root))?.plugins?.["assay.trellis"]).toEqual({
      kind: "workspace-runtime",
    });
    expect((await loadManifest(root))?.bindings?.["decision-governance"]).toBeUndefined();
    expect((await loadPluginsState(root))?.plugins["assay.trellis"]).toEqual(
      expect.objectContaining({ kind: "workspace-runtime", state_version: 1 }),
    );
    expect((await getDecisionGovernanceStatus(root)).activeProvider).toBe("assay.native");
    expect((await checkPlugins(root)).ok).toBe(true);
    expect((await checkFramework({ root })).ok).toBe(true);
    await addCapability({ root, module: "adr" });
    await expect(createAdr(root, { title: "Native decisions stay available" })).resolves.toEqual(
      expect.objectContaining({
        adr: expect.objectContaining({ title: "Native decisions stay available" }),
      }),
    );
  });

  it("creates tasks with a recoverable staged commit and renders the current Codex context", async () => {
    const root = await workspace("TaskRuntime");
    await addPlugin({ root, plugin: "assay.trellis" });

    const created = await createTrellisTask({
      root,
      title: "First operational slice",
      now: new Date("2026-08-02T09:00:00.000Z"),
    });
    expect(created).toEqual({
      protocol_version: 1,
      plugin: "assay.trellis",
      session_id: null,
      task: expect.objectContaining({
        id: expect.stringMatching(/^task-/),
        title: "First operational slice",
        status: "open",
      }),
    });
    expect(await getCurrentTrellisTask({ root })).toEqual(created);
    expect(await getTrellisContext({ root, host: "codex" })).toEqual({
      ...created,
      host: "codex",
      workspace_root: root,
    });
    expect(
      await pathExists(path.join(root, ".assay", "trellis", "tasks", `${created.task?.id}.json`)),
    ).toBe(true);
  });

  it("fail-closes an unscoped current lookup when sessions disagree", async () => {
    const root = await workspace("SessionAmbiguity");
    await addPlugin({ root, plugin: "assay.trellis" });
    const alpha = await createTrellisTask({ root, title: "Alpha", sessionId: "alpha" });
    const beta = await createTrellisTask({ root, title: "Beta", sessionId: "beta" });

    await expect(getCurrentTrellisTask({ root })).rejects.toThrow(/ambiguous across sessions/);
    expect((await getCurrentTrellisTask({ root, sessionId: "alpha" })).task?.id).toBe(
      alpha.task?.id,
    );
    expect((await getCurrentTrellisTask({ root, sessionId: "beta" })).task?.id).toBe(beta.task?.id);
  });

  it("serializes concurrent task creation without losing session pointers", async () => {
    const root = await workspace("ConcurrentTasks");
    await addPlugin({ root, plugin: "assay.trellis" });
    await Promise.all([
      createTrellisTask({ root, title: "Alpha", sessionId: "alpha" }),
      createTrellisTask({ root, title: "Beta", sessionId: "beta" }),
    ]);

    expect((await getCurrentTrellisTask({ root, sessionId: "alpha" })).task?.title).toBe("Alpha");
    expect((await getCurrentTrellisTask({ root, sessionId: "beta" })).task?.title).toBe("Beta");
  });

  it.each(["journal", "task", "state"] as const)(
    "recovers a task.create transaction after the %s stage",
    async (stage) => {
      const root = await workspace(`Recover-${stage}`);
      await addPlugin({ root, plugin: "assay.trellis" });
      const state = JSON.parse(
        await readFile(path.join(root, TRELLIS_RUNTIME_STATE_FILE), "utf8"),
      ) as Record<string, unknown>;
      const taskId = `task-${randomUUID()}`;
      const timestamp = "2026-08-03T10:00:00+00:00";
      const task = {
        id: taskId,
        title: `Recovered after ${stage}`,
        status: "open",
        created_at: timestamp,
        updated_at: timestamp,
      };
      const nextState = { ...state, current_task_id: taskId, updated_at: timestamp };
      await writeFile(
        path.join(root, TRELLIS_TRANSACTION_FILE),
        JSON.stringify({
          __schema: 1,
          protocol_version: 1,
          transaction_id: randomUUID(),
          operation: "task.create",
          task,
          next_state: nextState,
          prepared_at: timestamp,
        }),
        "utf8",
      );
      if (stage === "task" || stage === "state") {
        await writeFile(
          path.join(root, ".assay", "trellis", "tasks", `${taskId}.json`),
          JSON.stringify(task),
          "utf8",
        );
      }
      if (stage === "state") {
        await writeFile(
          path.join(root, TRELLIS_RUNTIME_STATE_FILE),
          JSON.stringify(nextState),
          "utf8",
        );
      }
      if (stage === "journal") {
        await writeFile(path.join(root, ".assay", "trellis", ".lock"), "999999999\n", "utf8");
      }

      expect((await probeTrellisRuntime(root)).message).toContain("pending task transaction");
      expect((await getCurrentTrellisTask({ root })).task?.title).toBe(`Recovered after ${stage}`);
      expect(await pathExists(path.join(root, TRELLIS_TRANSACTION_FILE))).toBe(false);
      expect((await probeTrellisRuntime(root)).health).toBe("healthy");
    },
  );

  it("fails plugin checks when workspace or session pointers do not close over task records", async () => {
    const root = await workspace("DanglingPointers");
    await addPlugin({ root, plugin: "assay.trellis" });
    const statePath = path.join(root, TRELLIS_RUNTIME_STATE_FILE);
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const missingWorkspace = `task-${randomUUID()}`;
    const missingSession = `task-${randomUUID()}`;
    await writeFile(
      statePath,
      JSON.stringify({
        ...state,
        current_task_id: missingWorkspace,
        session_currents: { broken: missingSession },
      }),
      "utf8",
    );

    const probe = await probeTrellisRuntime(root);
    expect(probe.health).toBe("unhealthy");
    expect(probe.missingPaths).toEqual(
      expect.arrayContaining([
        `.assay/trellis/tasks/${missingWorkspace}.json`,
        `.assay/trellis/tasks/${missingSession}.json`,
      ]),
    );
    expect((await checkPlugins(root)).ok).toBe(false);
    await expect(getCurrentTrellisTask({ root })).rejects.toThrow(
      /dangling current-task references/,
    );
  });

  it("renders the Codex SessionStart host schema and resolves stdin identity before env", async () => {
    const root = await workspace("CodexAdapter");
    await addPlugin({ root, plugin: "assay.trellis" });
    await createTrellisTask({ root, title: "From stdin", sessionId: "thread-stdin" });
    await createTrellisTask({ root, title: "From env", sessionId: "thread-env" });

    const fromStdin = await renderCodexSessionStartHook({
      root,
      stdin: JSON.stringify({ hook_event_name: "SessionStart", thread_id: "thread-stdin" }),
      env: { CODEX_THREAD_ID: "thread-env" },
    });
    expect(fromStdin).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.any(String),
      },
    });
    expect(JSON.parse(fromStdin.hookSpecificOutput.additionalContext).task.title).toBe(
      "From stdin",
    );

    const fromEnv = await renderCodexSessionStartHook({
      root,
      stdin: "",
      env: { CODEX_THREAD_ID: "thread-env" },
    });
    expect(JSON.parse(fromEnv.hookSpecificOutput.additionalContext).task.title).toBe("From env");
    await expect(renderCodexSessionStartHook({ root, stdin: "not-json", env: {} })).rejects.toThrow(
      /stdin is not valid JSON/,
    );
  });

  it("plans and applies a marker-owned Codex hook while preserving neighbors", async () => {
    const root = await workspace("CodexHook");
    await addPlugin({ root, plugin: "assay.trellis" });
    const hookFile = path.join(root, ".codex", "hooks.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    await writeFile(
      hookFile,
      JSON.stringify({
        custom: "keep",
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "user-neighbor", timeout: 5 }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: "stop-neighbor" }] }],
        },
      }),
      "utf8",
    );

    const preview = await installTrellisHook({ root, host: "codex" });
    expect(preview).toEqual(
      expect.objectContaining({ action: "update", applied: false, protocol_version: 1 }),
    );
    expect(await readFile(hookFile, "utf8")).not.toContain("assay trellis context");

    const applied = await installTrellisHook({ root, host: "codex", apply: true });
    expect(applied.applied).toBe(true);
    const document = JSON.parse(await readFile(hookFile, "utf8")) as Record<string, unknown>;
    expect(document.custom).toBe("keep");
    expect(JSON.stringify(document)).toContain("user-neighbor");
    expect(JSON.stringify(document)).toContain("stop-neighbor");
    expect(document).toEqual(
      expect.objectContaining({
        hooks: expect.objectContaining({
          SessionStart: expect.arrayContaining([
            expect.objectContaining({
              hooks: expect.arrayContaining([
                expect.objectContaining({ command: CODEX_TRELLIS_HOOK_COMMAND }),
              ]),
            }),
          ]),
        }),
      }),
    );
    const registration = (
      JSON.parse(await readFile(path.join(root, TRELLIS_RUNTIME_STATE_FILE), "utf8")) as {
        hook_registrations: Record<string, { marker: string; fingerprint: string }>;
      }
    ).hook_registrations.codex;
    expect(registration).toEqual({
      marker: CODEX_TRELLIS_HOOK_MARKER,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      installed_at: expect.any(String),
      target: ".codex/hooks.json",
      updated_at: expect.any(String),
    });
    expect((await installTrellisHook({ root, host: "codex", apply: true })).action).toBe("noop");
  });

  it("adopts one canonical unreceipted hook without rewriting neighboring configuration", async () => {
    const root = await workspace("CodexHookAdopt");
    await addPlugin({ root, plugin: "assay.trellis" });
    const hookFile = path.join(root, ".codex", "hooks.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    const original = JSON.stringify({
      custom: "keep",
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear|compact",
            hooks: [{ type: "command", command: CODEX_TRELLIS_HOOK_COMMAND, timeout: 10 }],
          },
        ],
      },
    });
    await writeFile(hookFile, original, "utf8");

    expect((await installTrellisHook({ root, host: "codex" })).action).toBe("adopt");
    const applied = await installTrellisHook({ root, host: "codex", apply: true });
    expect(applied).toEqual(expect.objectContaining({ action: "adopt", applied: true }));
    expect(await readFile(hookFile, "utf8")).toBe(original);
    expect((await installTrellisHook({ root, host: "codex" })).action).toBe("noop");
  });

  it("preserves duplicated or modified unreceipted hooks as conflicts", async () => {
    const root = await workspace("CodexHookConflict");
    await addPlugin({ root, plugin: "assay.trellis" });
    const hookFile = path.join(root, ".codex", "hooks.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    const original = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: CODEX_TRELLIS_HOOK_COMMAND, timeout: 99 }],
          },
          {
            matcher: "resume",
            hooks: [{ type: "command", command: CODEX_TRELLIS_HOOK_COMMAND, timeout: 10 }],
          },
        ],
      },
    });
    await writeFile(hookFile, original, "utf8");

    expect((await installTrellisHook({ root, host: "codex" })).action).toBe("conflict");
    await expect(installTrellisHook({ root, host: "codex", apply: true })).rejects.toThrow(
      /install conflict/,
    );
    expect(await readFile(hookFile, "utf8")).toBe(original);
  });

  it("does not rewrite a receipted hook group after a user adds a neighbor", async () => {
    const root = await workspace("CodexHookReceiptConflict");
    await addPlugin({ root, plugin: "assay.trellis" });
    await installTrellisHook({ root, host: "codex", apply: true });
    const hookFile = path.join(root, ".codex", "hooks.json");
    const document = JSON.parse(await readFile(hookFile, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: unknown[] }> };
    };
    document.hooks.SessionStart[0]?.hooks.push({
      type: "command",
      command: "user-added-neighbor",
      timeout: 5,
    });
    const modified = JSON.stringify(document);
    await writeFile(hookFile, modified, "utf8");

    expect((await installTrellisHook({ root, host: "codex" })).action).toBe("conflict");
    await expect(installTrellisHook({ root, host: "codex", apply: true })).rejects.toThrow(
      /install conflict/,
    );
    expect(await readFile(hookFile, "utf8")).toBe(modified);
  });

  it("migrates legacy v1 federated metadata without reading or writing .trellis", async () => {
    const root = await workspace("LegacyMetadata");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.__schema = 2;
    manifest.minimum_assay_version = "0.5.0";
    manifest.plugins = { "assay.trellis": { kind: "federated-provider" } };
    manifest.bindings = {
      "decision-governance": {
        provider: "assay.trellis",
        target: { kind: "workspace" },
      },
    };
    await saveManifest(root, manifest);
    await savePluginsState(root, {
      __schema: 2,
      plugins: {
        "assay.trellis": {
          kind: "federated-provider",
          state_version: 1,
          installed_at: "2026-07-28T00:00:00+00:00",
          updated_at: "2026-07-28T00:00:00+00:00",
          observations: {
            provider_locator: "workspace:.trellis",
            provider_version: "1.0.0",
          },
        },
      },
      updated_at: "2026-07-28T00:00:00+00:00",
    });

    expect((await getDecisionGovernanceStatus(root)).activeProvider).toBe("assay.native");
    const migrated = await reconcilePlugins({ root, apply: true });
    expect(migrated.plugins[0]).toEqual(expect.objectContaining({ action: "repair" }));
    expect((await loadManifest(root))?.plugins?.["assay.trellis"]?.kind).toBe("workspace-runtime");
    expect((await loadManifest(root))?.bindings?.["decision-governance"]).toBeUndefined();
    expect((await loadPluginsState(root))?.plugins["assay.trellis"]).toEqual(
      expect.objectContaining({ kind: "workspace-runtime", state_version: 1 }),
    );
    expect((await loadPluginsState(root))?.plugins["assay.trellis"]?.observations).toBeUndefined();
    expect(await pathExists(path.join(root, ".trellis"))).toBe(false);
  });
});
