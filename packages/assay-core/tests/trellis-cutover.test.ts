import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { BARE_ARCHETYPE, createTempDirectoryFixture, writeBareArchetype } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CODEX_TRELLIS_HOOK_COMMAND,
  CONFINED_READER_MAX_FILE_BYTES,
  TRELLIS_LEGACY_HOOK_RECEIPT,
  addPlugin,
  applyTrellisLegacyHookScrub,
  applyTrellisLegacyMigration,
  initFramework,
  planTrellisLegacyHookScrub,
  planTrellisLegacyMigration,
  restoreTrellisLegacyHookScrub,
  setConfinedReaderProbeForTests,
  setTrellisLegacyHookProbeForTests,
  setTrellisMigrationProbeForTests,
  setTrellisStorageProbeForTests,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-trellis-cutover");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  setConfinedReaderProbeForTests(null);
  setTrellisMigrationProbeForTests(null);
  setTrellisLegacyHookProbeForTests(null);
  setTrellisStorageProbeForTests(null);
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype: BARE_ARCHETYPE });
  await addPlugin({ root, plugin: "assay.trellis" });
  await mkdir(path.join(root, ".trellis"), { recursive: true });
  return root;
}

async function writeHooks(root: string, value: unknown): Promise<string> {
  const file = path.join(root, ".codex", "hooks.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

async function exchangeArtifacts(root: string): Promise<string[]> {
  return (await readdir(path.join(root, ".codex")))
    .filter((name) => name.endsWith(".stage") || name.endsWith(".rollback"))
    .sort();
}

function legacyHookDocument() {
  return {
    custom: "keep",
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "neighbor-before" }] },
        {
          hooks: [
            {
              type: "command",
              command: "python -X utf8 .codex/hooks/inject-workflow-state.py",
            },
          ],
        },
      ],
      SubagentStart: [
        {
          matcher: "^trellis_",
          hooks: [
            {
              type: "command",
              command: "python -X utf8 .codex/hooks/inject-subagent-context.py",
            },
          ],
        },
        { matcher: "^other_", hooks: [{ type: "command", command: "neighbor-after" }] },
      ],
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [{ type: "command", command: CODEX_TRELLIS_HOOK_COMMAND, timeout: 10 }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "stop-neighbor" }] }],
    },
  };
}

describe("external legacy channel confined reader", () => {
  it("plans and applies an absolute external channel source without changing source bytes or metadata", async () => {
    const base = await tempDirs.createTempDir();
    const root = await workspace("external-positive");
    const channel = path.join(base, "external-channel");
    await mkdir(channel, { recursive: true });
    const source = path.join(channel, "events.jsonl");
    const content = `${JSON.stringify({ id: randomUUID(), kind: "channel", message: "legacy" })}\n`;
    await writeFile(source, content, "utf8");
    const before = await stat(source);

    const plan = await planTrellisLegacyMigration({ root, channelRoot: channel });
    const entry = plan.entries.find((candidate) => candidate.source_kind === "channel");
    expect(plan.channel_root).toBe(channel);
    expect(entry).toEqual(
      expect.objectContaining({
        source: source,
        source_path: source,
        source_kind: "channel",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_identity: expect.objectContaining({
          dev: expect.any(Number),
          ino: expect.any(Number),
        }),
      }),
    );

    const applied = await applyTrellisLegacyMigration({ root, channelRoot: channel });
    expect(applied.operation.source_roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "channel", canonical_path: channel }),
      ]),
    );
    expect(
      applied.operation.entries.find((candidate) => candidate.source === source)?.target,
    ).toMatch(/^\.assay\/trellis\//);
    const after = await stat(source);
    expect(await readFile(source, "utf8")).toBe(content);
    expect({ size: after.size, mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
      ino: before.ino,
    });
  });

  it("rejects a channel root reached through a junction", async () => {
    const base = await tempDirs.createTempDir();
    const root = await workspace("junction-root");
    const real = path.join(base, "channel-real");
    const junction = path.join(base, "channel-junction");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "event.json"), "{}", "utf8");
    await symlink(real, junction, process.platform === "win32" ? "junction" : "dir");
    await expect(planTrellisLegacyMigration({ root, channelRoot: junction })).rejects.toThrow(
      /reparse/,
    );
  });

  it("rejects hardlinks, oversized files, and deterministic file replacement races", async () => {
    const base = await tempDirs.createTempDir();
    const root = await workspace("confined-negative");

    const hardlinkRoot = path.join(base, "hardlink-channel");
    await mkdir(hardlinkRoot, { recursive: true });
    const original = path.join(base, "hardlink-source.json");
    await writeFile(original, "{}", "utf8");
    await link(original, path.join(hardlinkRoot, "event.json"));
    await expect(planTrellisLegacyMigration({ root, channelRoot: hardlinkRoot })).rejects.toThrow(
      /hardlink/,
    );

    const oversizeRoot = path.join(base, "oversize-channel");
    await mkdir(oversizeRoot, { recursive: true });
    await writeFile(
      path.join(oversizeRoot, "large.bin"),
      Buffer.alloc(CONFINED_READER_MAX_FILE_BYTES + 1),
    );
    await expect(planTrellisLegacyMigration({ root, channelRoot: oversizeRoot })).rejects.toThrow(
      /exceeds/,
    );

    const raceRoot = path.join(base, "race-channel");
    await mkdir(raceRoot, { recursive: true });
    const raced = path.join(raceRoot, "event.json");
    await writeFile(raced, '{"before":true}', "utf8");
    let replaced = false;
    setConfinedReaderProbeForTests(async (phase, target) => {
      if (phase !== "after-read" || target !== raced || replaced) return;
      replaced = true;
      await writeFile(raced, '{"after":true}', "utf8");
    });
    await expect(planTrellisLegacyMigration({ root, channelRoot: raceRoot })).rejects.toThrow(
      /changed/,
    );
  });

  it("fails if the source set changes between apply planning and its locked re-plan", async () => {
    const base = await tempDirs.createTempDir();
    const root = await workspace("changed-plan-apply");
    const channel = path.join(base, "changed-channel");
    await mkdir(channel, { recursive: true });
    const source = path.join(channel, "event.json");
    await writeFile(source, "{}", "utf8");
    setTrellisMigrationProbeForTests(async (phase) => {
      if (phase === "apply-after-plan") await writeFile(source, '{"changed":true}', "utf8");
    });
    await expect(applyTrellisLegacyMigration({ root, channelRoot: channel })).rejects.toThrow(
      /changed after plan|source set changed/,
    );
  });

  it("rejects exact and nested legacy/channel root overlap", async () => {
    const root = await workspace("overlapping-roots");
    const legacy = path.join(root, ".trellis");
    const nested = path.join(legacy, "channels", "bucket");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "event.json"), "{}", "utf8");
    await expect(planTrellisLegacyMigration({ root, channelRoot: legacy })).rejects.toThrow(
      /overlap/,
    );
    await expect(planTrellisLegacyMigration({ root, channelRoot: nested })).rejects.toThrow(
      /overlap/,
    );
  });

  it("archives malformed known-shape input with its raw bytes instead of dropping it", async () => {
    const root = await workspace("malformed-archive");
    const malformed = path.join(root, ".trellis", "tasks", "broken.json");
    await mkdir(path.dirname(malformed), { recursive: true });
    await writeFile(malformed, "{not-json", "utf8");
    const applied = await applyTrellisLegacyMigration({ root });
    const entry = applied.operation.entries.find((candidate) =>
      candidate.source.endsWith("broken.json"),
    );
    expect(entry).toEqual(
      expect.objectContaining({
        category: "modified-or-unknown-archive",
        target: expect.any(String),
      }),
    );
    if (!entry?.target) throw new Error("malformed input was not archived");
    const archive = JSON.parse(await readFile(path.join(root, entry.target), "utf8")) as {
      encoding: string;
      content: string;
    };
    expect(archive.encoding).toBe("base64");
    expect(Buffer.from(archive.content, "base64").toString("utf8")).toBe("{not-json");
  });
});

describe("structured legacy Codex hook scrub", () => {
  it("removes only the RKTeam-shaped allowlisted groups, is idempotent, and explicitly restores", async () => {
    const root = await workspace("hook-positive");
    const original = legacyHookDocument();
    const hookFile = await writeHooks(root, original);
    const before = await readFile(hookFile, "utf8");

    const plan = await planTrellisLegacyHookScrub({ root, host: "codex" });
    expect(plan).toEqual(
      expect.objectContaining({
        action: "remove",
        read_only: true,
        removed_groups: expect.any(Array),
      }),
    );
    expect(plan.removed_groups).toHaveLength(2);
    expect(await readFile(hookFile, "utf8")).toBe(before);

    const applied = await applyTrellisLegacyHookScrub({ root, host: "codex" });
    expect(applied).toEqual(expect.objectContaining({ applied: true, recovered: false }));
    const scrubbed = await readFile(hookFile, "utf8");
    expect(scrubbed).toContain("neighbor-before");
    expect(scrubbed).toContain("neighbor-after");
    expect(scrubbed).toContain("stop-neighbor");
    const scrubbedDocument = JSON.parse(scrubbed) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(scrubbedDocument.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      CODEX_TRELLIS_HOOK_COMMAND,
    );
    expect(scrubbed).not.toContain("inject-workflow-state.py");
    expect(scrubbed).not.toContain("inject-subagent-context.py");
    expect(
      JSON.parse(await readFile(path.join(root, TRELLIS_LEGACY_HOOK_RECEIPT), "utf8")),
    ).toEqual(expect.objectContaining({ phase: "applied", removed_groups: expect.any(Array) }));
    expect((await applyTrellisLegacyHookScrub({ root, host: "codex" })).applied).toBe(false);

    expect((await restoreTrellisLegacyHookScrub({ root, host: "codex" })).restored).toBe(true);
    expect(await readFile(hookFile, "utf8")).toBe(before);
    expect((await restoreTrellisLegacyHookScrub({ root, host: "codex" })).restored).toBe(false);
  });

  it("refuses duplicate and modified legacy-looking groups", async () => {
    const duplicateRoot = await workspace("hook-duplicate");
    const duplicate = legacyHookDocument();
    const duplicatedGroup = duplicate.hooks.UserPromptSubmit[1];
    if (!duplicatedGroup) throw new Error("legacy fixture group is missing");
    duplicate.hooks.UserPromptSubmit.push(duplicatedGroup);
    await writeHooks(duplicateRoot, duplicate);
    await expect(
      planTrellisLegacyHookScrub({ root: duplicateRoot, host: "codex" }),
    ).rejects.toThrow(/duplicated/);

    const modifiedRoot = await workspace("hook-modified");
    const modified = legacyHookDocument();
    const command = modified.hooks.SubagentStart[0]?.hooks[0];
    if (command) command.command += " --changed";
    await writeHooks(modifiedRoot, modified);
    await expect(planTrellisLegacyHookScrub({ root: modifiedRoot, host: "codex" })).rejects.toThrow(
      /modified|allowlist/,
    );
  });

  it("rejects junction and hardlink hook files", async () => {
    const base = await tempDirs.createTempDir();
    const junctionRoot = await workspace("hook-junction");
    const externalCodex = path.join(base, "external-codex");
    await mkdir(externalCodex, { recursive: true });
    await writeFile(path.join(externalCodex, "hooks.json"), JSON.stringify(legacyHookDocument()));
    await symlink(
      externalCodex,
      path.join(junctionRoot, ".codex"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(planTrellisLegacyHookScrub({ root: junctionRoot, host: "codex" })).rejects.toThrow(
      /reparse/,
    );

    const hardlinkRoot = await workspace("hook-hardlink");
    const donor = path.join(base, "donor-hooks.json");
    await writeFile(donor, JSON.stringify(legacyHookDocument()));
    await mkdir(path.join(hardlinkRoot, ".codex"), { recursive: true });
    await link(donor, path.join(hardlinkRoot, ".codex", "hooks.json"));
    await expect(planTrellisLegacyHookScrub({ root: hardlinkRoot, host: "codex" })).rejects.toThrow(
      /hardlink/,
    );
  });

  it("detects same-content ABA replacement between plan and apply", async () => {
    const root = await workspace("hook-aba");
    const hookFile = await writeHooks(root, legacyHookDocument());
    let replaced = false;
    setTrellisLegacyHookProbeForTests(async (phase) => {
      if (phase !== "apply-after-plan" || replaced) return;
      replaced = true;
      const content = await readFile(hookFile);
      const replacement = `${hookFile}.replacement`;
      await writeFile(replacement, content);
      await rename(replacement, hookFile);
    });
    await expect(applyTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(
      /changed between|CAS/,
    );
  });

  it("fails closed on a concurrent hook edit after preparing its receipt", async () => {
    const root = await workspace("hook-concurrent-change");
    const hookFile = await writeHooks(root, legacyHookDocument());
    setTrellisLegacyHookProbeForTests(async (phase) => {
      if (phase !== "apply-before-cas") return;
      const document = JSON.parse(await readFile(hookFile, "utf8")) as {
        hooks: Record<string, unknown[]>;
      };
      document.hooks.Stop = [{ hooks: [{ type: "command", command: "concurrent-neighbor" }] }];
      await writeFile(hookFile, JSON.stringify(document), "utf8");
    });
    await expect(applyTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(/CAS/);
    expect(await readFile(hookFile, "utf8")).toContain("concurrent-neighbor");
  });

  it("preserves a non-cooperating neighbor injected at the final atomic replace boundary", async () => {
    const root = await workspace("hook-final-cas");
    const hookFile = await writeHooks(root, legacyHookDocument());
    let injected = false;
    setTrellisStorageProbeForTests(async (phase, target) => {
      if (phase !== "atomic-before-rename" || target !== hookFile || injected) return;
      injected = true;
      const document = JSON.parse(await readFile(hookFile, "utf8")) as {
        hooks: Record<string, unknown[]>;
      };
      document.hooks.Stop = [{ hooks: [{ type: "command", command: "boundary-neighbor" }] }];
      await writeFile(hookFile, JSON.stringify(document), "utf8");
    });
    await expect(applyTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(/final CAS/);
    const current = await readFile(hookFile, "utf8");
    expect(current).toContain("boundary-neighbor");
    expect(current).toContain("inject-workflow-state.py");
  });

  it("does not bless apply or restore crash ABA with the same bytes on a new inode", async () => {
    const applyRoot = await workspace("hook-apply-crash-aba");
    const applyHook = await writeHooks(applyRoot, legacyHookDocument());
    let applyReplaced = false;
    setTrellisLegacyHookProbeForTests(async (phase) => {
      if (phase !== "apply-after-hook-write" || applyReplaced) return;
      applyReplaced = true;
      const replacement = `${applyHook}.aba`;
      await writeFile(replacement, await readFile(applyHook));
      await rename(replacement, applyHook);
      throw new Error("simulated apply crash after ABA");
    });
    await expect(applyTrellisLegacyHookScrub({ root: applyRoot, host: "codex" })).rejects.toThrow(
      /simulated apply crash after ABA/,
    );
    setTrellisLegacyHookProbeForTests(null);
    await expect(applyTrellisLegacyHookScrub({ root: applyRoot, host: "codex" })).rejects.toThrow(
      /replacement identity|ABA|concurrent replacement|not in a resumable receipt state/,
    );
    const applyReceipt = JSON.parse(
      await readFile(path.join(applyRoot, TRELLIS_LEGACY_HOOK_RECEIPT), "utf8"),
    ) as { phase: string };
    expect(applyReceipt.phase).toBe("apply-prepared");

    const restoreRoot = await workspace("hook-restore-crash-aba");
    const restoreHook = await writeHooks(restoreRoot, legacyHookDocument());
    await applyTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" });
    let restoreReplaced = false;
    setTrellisLegacyHookProbeForTests(async (phase) => {
      if (phase !== "restore-after-hook-write" || restoreReplaced) return;
      restoreReplaced = true;
      const replacement = `${restoreHook}.aba`;
      await writeFile(replacement, await readFile(restoreHook));
      await rename(replacement, restoreHook);
      throw new Error("simulated restore crash after ABA");
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" }),
    ).rejects.toThrow(/simulated restore crash after ABA/);
    setTrellisLegacyHookProbeForTests(null);
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" }),
    ).rejects.toThrow(
      /replacement identity|ABA|concurrent replacement|not in a resumable receipt state/,
    );
    const restoreReceipt = JSON.parse(
      await readFile(path.join(restoreRoot, TRELLIS_LEGACY_HOOK_RECEIPT), "utf8"),
    ) as { phase: string };
    expect(restoreReceipt.phase).toBe("restore-prepared");
  });

  it("recovers deterministic apply/restore crashes and refuses restore after later neighbors", async () => {
    const applyCrashRoot = await workspace("hook-apply-crash");
    const applyHook = await writeHooks(applyCrashRoot, legacyHookDocument());
    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "apply-after-hook-write") throw new Error("simulated apply crash");
    });
    await expect(
      applyTrellisLegacyHookScrub({ root: applyCrashRoot, host: "codex" }),
    ).rejects.toThrow(/simulated apply crash/);
    setTrellisLegacyHookProbeForTests(null);
    const recovered = await applyTrellisLegacyHookScrub({ root: applyCrashRoot, host: "codex" });
    expect(recovered).toEqual(expect.objectContaining({ applied: false, recovered: true }));

    const current = JSON.parse(await readFile(applyHook, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    current.hooks.Stop?.push({ hooks: [{ type: "command", command: "later-neighbor" }] });
    await writeFile(applyHook, JSON.stringify(current), "utf8");
    await expect(
      restoreTrellisLegacyHookScrub({ root: applyCrashRoot, host: "codex" }),
    ).rejects.toThrow(/exact receipted post-scrub|not in a resumable receipt state/);

    const restoreCrashRoot = await workspace("hook-restore-crash");
    const restoreHook = await writeHooks(restoreCrashRoot, legacyHookDocument());
    const original = await readFile(restoreHook, "utf8");
    await applyTrellisLegacyHookScrub({ root: restoreCrashRoot, host: "codex" });
    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "restore-after-hook-write") throw new Error("simulated restore crash");
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreCrashRoot, host: "codex" }),
    ).rejects.toThrow(/simulated restore crash/);
    setTrellisLegacyHookProbeForTests(null);
    const restoreRecovered = await restoreTrellisLegacyHookScrub({
      root: restoreCrashRoot,
      host: "codex",
    });
    expect(restoreRecovered.restored).toBe(false);
    expect(await readFile(restoreHook, "utf8")).toEqual(original);
  });

  it("resumes every apply and restore staged-exchange boundary and cleans only after terminal receipt", async () => {
    const storagePhases = [
      "exchange-before-stage-open",
      "exchange-after-stage-sync",
      "exchange-before-target-move",
      "exchange-after-target-move",
      "exchange-before-target-link",
      "exchange-after-target-link",
      "exchange-before-stage-unlink",
      "exchange-after-stage-unlink",
      "exchange-before-rollback-cleanup",
      "exchange-after-rollback-cleanup",
    ] as const;
    for (const phase of ["apply-after-intent", "apply-after-prepared"] as const) {
      const root = await workspace(`apply-receipt-boundary-${phase}`);
      const hookFile = await writeHooks(root, legacyHookDocument());
      setTrellisLegacyHookProbeForTests((current) => {
        if (current === phase) throw new Error(`apply receipt boundary ${phase}`);
      });
      await expect(applyTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(
        new RegExp(`apply receipt boundary ${phase}`),
      );
      setTrellisLegacyHookProbeForTests(null);
      await applyTrellisLegacyHookScrub({ root, host: "codex" });
      expect(await readFile(hookFile, "utf8")).not.toContain("inject-workflow-state.py");
      expect(await exchangeArtifacts(root)).toEqual([]);
    }

    for (const phase of ["restore-after-intent", "restore-after-prepared"] as const) {
      const root = await workspace(`restore-receipt-boundary-${phase}`);
      const hookFile = await writeHooks(root, legacyHookDocument());
      const original = await readFile(hookFile, "utf8");
      await applyTrellisLegacyHookScrub({ root, host: "codex" });
      setTrellisLegacyHookProbeForTests((current) => {
        if (current === phase) throw new Error(`restore receipt boundary ${phase}`);
      });
      await expect(restoreTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(
        new RegExp(`restore receipt boundary ${phase}`),
      );
      setTrellisLegacyHookProbeForTests(null);
      await restoreTrellisLegacyHookScrub({ root, host: "codex" });
      expect(await readFile(hookFile, "utf8")).toBe(original);
      expect(await exchangeArtifacts(root)).toEqual([]);
    }

    for (const phase of storagePhases) {
      const root = await workspace(`apply-boundary-${phase}`);
      const hookFile = await writeHooks(root, legacyHookDocument());
      let crashed = false;
      setTrellisStorageProbeForTests((current, target) => {
        if (current !== phase || crashed || !target.includes("hooks.json")) return;
        crashed = true;
        throw new Error(`apply boundary ${phase}`);
      });
      await expect(applyTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(
        new RegExp(`apply boundary ${phase}`),
      );
      setTrellisStorageProbeForTests(null);
      await applyTrellisLegacyHookScrub({ root, host: "codex" });
      expect(await readFile(hookFile, "utf8")).not.toContain("inject-workflow-state.py");
      expect(await exchangeArtifacts(root)).toEqual([]);
      expect(
        JSON.parse(await readFile(path.join(root, TRELLIS_LEGACY_HOOK_RECEIPT), "utf8")),
      ).toEqual(expect.objectContaining({ phase: "applied" }));
    }

    for (const phase of storagePhases) {
      const root = await workspace(`restore-boundary-${phase}`);
      const hookFile = await writeHooks(root, legacyHookDocument());
      const original = await readFile(hookFile, "utf8");
      await applyTrellisLegacyHookScrub({ root, host: "codex" });
      let crashed = false;
      setTrellisStorageProbeForTests((current, target) => {
        if (current !== phase || crashed || !target.includes("hooks.json")) return;
        crashed = true;
        throw new Error(`restore boundary ${phase}`);
      });
      await expect(restoreTrellisLegacyHookScrub({ root, host: "codex" })).rejects.toThrow(
        new RegExp(`restore boundary ${phase}`),
      );
      setTrellisStorageProbeForTests(null);
      await restoreTrellisLegacyHookScrub({ root, host: "codex" });
      expect(await readFile(hookFile, "utf8")).toBe(original);
      expect(await exchangeArtifacts(root)).toEqual([]);
      expect(
        JSON.parse(await readFile(path.join(root, TRELLIS_LEGACY_HOOK_RECEIPT), "utf8")),
      ).toEqual(expect.objectContaining({ phase: "restored" }));
    }
  }, 120_000);

  it("finishes a terminal exchange cleanup before crossing into the opposite transition", async () => {
    const applyRoot = await workspace("apply-cleanup-before-restore");
    const applyHook = await writeHooks(applyRoot, legacyHookDocument());
    let applyCleanupCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (
        phase !== "exchange-before-rollback-cleanup" ||
        !target.includes("-apply.rollback") ||
        applyCleanupCrashed
      )
        return;
      applyCleanupCrashed = true;
      throw new Error("apply terminal cleanup crash");
    });
    await expect(applyTrellisLegacyHookScrub({ root: applyRoot, host: "codex" })).rejects.toThrow(
      /apply terminal cleanup crash/,
    );
    setTrellisStorageProbeForTests(null);
    const appliedReceiptFile = path.join(applyRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const appliedReceiptText = await readFile(appliedReceiptFile, "utf8");
    const appliedReceipt = JSON.parse(appliedReceiptText) as {
      phase: string;
      apply_exchange: { rollback: string };
    };
    expect(appliedReceipt.phase).toBe("applied");
    expect(await exchangeArtifacts(applyRoot)).toEqual([
      path.basename(appliedReceipt.apply_exchange.rollback),
    ]);

    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "restore-after-apply-cleanup") {
        throw new Error("crash after governed apply cleanup");
      }
    });
    await expect(restoreTrellisLegacyHookScrub({ root: applyRoot, host: "codex" })).rejects.toThrow(
      /crash after governed apply cleanup/,
    );
    setTrellisLegacyHookProbeForTests(null);
    expect(await readFile(appliedReceiptFile, "utf8")).toBe(appliedReceiptText);
    expect(await exchangeArtifacts(applyRoot)).toEqual([]);
    expect(await readFile(applyHook, "utf8")).not.toContain("inject-workflow-state.py");
    await restoreTrellisLegacyHookScrub({ root: applyRoot, host: "codex" });
    expect(await exchangeArtifacts(applyRoot)).toEqual([]);

    const restoreRoot = await workspace("restore-cleanup-before-reapply");
    const restoreHook = await writeHooks(restoreRoot, legacyHookDocument());
    const original = await readFile(restoreHook, "utf8");
    await applyTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" });
    let restoreCleanupCrashed = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (
        phase !== "exchange-before-rollback-cleanup" ||
        !target.includes("-restore.rollback") ||
        restoreCleanupCrashed
      )
        return;
      restoreCleanupCrashed = true;
      throw new Error("restore terminal cleanup crash");
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" }),
    ).rejects.toThrow(/restore terminal cleanup crash/);
    setTrellisStorageProbeForTests(null);
    const restoredReceiptFile = path.join(restoreRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const restoredReceiptText = await readFile(restoredReceiptFile, "utf8");
    const restoredReceipt = JSON.parse(restoredReceiptText) as {
      phase: string;
      generation: string;
      restore_exchange: { rollback: string };
    };
    expect(restoredReceipt.phase).toBe("restored");
    expect(await exchangeArtifacts(restoreRoot)).toEqual([
      path.basename(restoredReceipt.restore_exchange.rollback),
    ]);

    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "apply-after-restore-cleanup") {
        throw new Error("crash after governed restore cleanup");
      }
    });
    await expect(applyTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" })).rejects.toThrow(
      /crash after governed restore cleanup/,
    );
    setTrellisLegacyHookProbeForTests(null);
    expect(await readFile(restoredReceiptFile, "utf8")).toBe(restoredReceiptText);
    expect(await exchangeArtifacts(restoreRoot)).toEqual([]);
    expect(await readFile(restoreHook, "utf8")).toBe(original);
    const reapplied = await applyTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" });
    expect(reapplied.receipt).toEqual(
      expect.objectContaining({
        phase: "applied",
        generation: expect.not.stringMatching(restoredReceipt.generation),
      }),
    );
    expect(await exchangeArtifacts(restoreRoot)).toEqual([]);
  });

  it("keeps terminal governance when prior exchange cleanup fails or finds a mismatch", async () => {
    const failureRoot = await workspace("opposite-cleanup-failure");
    const failureHook = await writeHooks(failureRoot, legacyHookDocument());
    let initialCrash = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (
        phase !== "exchange-before-rollback-cleanup" ||
        !target.includes("-apply.rollback") ||
        initialCrash
      )
        return;
      initialCrash = true;
      throw new Error("leave governed apply rollback");
    });
    await expect(applyTrellisLegacyHookScrub({ root: failureRoot, host: "codex" })).rejects.toThrow(
      /leave governed apply rollback/,
    );
    setTrellisStorageProbeForTests(null);
    const failureReceiptFile = path.join(failureRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const failureReceiptText = await readFile(failureReceiptFile, "utf8");
    const failureReceipt = JSON.parse(failureReceiptText) as {
      phase: string;
      apply_exchange: { rollback: string };
    };
    const governedApplyArtifacts = [path.basename(failureReceipt.apply_exchange.rollback)];
    expect(await exchangeArtifacts(failureRoot)).toEqual(governedApplyArtifacts);
    setTrellisStorageProbeForTests((phase, target) => {
      if (phase === "exchange-before-rollback-cleanup" && target.includes("-apply.rollback")) {
        throw new Error("opposite transition cleanup failure");
      }
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: failureRoot, host: "codex" }),
    ).rejects.toThrow(/opposite transition cleanup failure/);
    setTrellisStorageProbeForTests(null);
    expect(await readFile(failureReceiptFile, "utf8")).toBe(failureReceiptText);
    expect(await exchangeArtifacts(failureRoot)).toEqual(governedApplyArtifacts);
    expect(await readFile(failureHook, "utf8")).not.toContain("inject-workflow-state.py");

    const mismatchRoot = await workspace("opposite-cleanup-mismatch");
    const mismatchHook = await writeHooks(mismatchRoot, legacyHookDocument());
    const mismatchOriginal = await readFile(mismatchHook, "utf8");
    await applyTrellisLegacyHookScrub({ root: mismatchRoot, host: "codex" });
    let restoreCrash = false;
    setTrellisStorageProbeForTests((phase, target) => {
      if (
        phase !== "exchange-before-rollback-cleanup" ||
        !target.includes("-restore.rollback") ||
        restoreCrash
      )
        return;
      restoreCrash = true;
      throw new Error("leave governed restore rollback");
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: mismatchRoot, host: "codex" }),
    ).rejects.toThrow(/leave governed restore rollback/);
    setTrellisStorageProbeForTests(null);
    const mismatchReceiptFile = path.join(mismatchRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const mismatchReceiptText = await readFile(mismatchReceiptFile, "utf8");
    const mismatchReceipt = JSON.parse(mismatchReceiptText) as {
      phase: string;
      restore_exchange: { rollback: string };
    };
    const rollback = path.join(mismatchRoot, mismatchReceipt.restore_exchange.rollback);
    await writeFile(rollback, "tampered governed rollback", "utf8");
    await expect(
      applyTrellisLegacyHookScrub({ root: mismatchRoot, host: "codex" }),
    ).rejects.toThrow(/rollback does not match its receipt/);
    expect(await readFile(mismatchReceiptFile, "utf8")).toBe(mismatchReceiptText);
    expect(await exchangeArtifacts(mismatchRoot)).toEqual([path.basename(rollback)]);
    expect(await readFile(mismatchHook, "utf8")).toBe(mismatchOriginal);
  });

  it("rejects crafted receipt redirects and semantic mismatches before lock or file mutation", async () => {
    interface CraftedReceipt {
      generation: string;
      post_document: Record<string, unknown>;
      apply_exchange: {
        target: string;
        stage: string;
        expected_sha256: string;
        replacement_identity: { dev: number; ino: number };
      };
      [key: string]: unknown;
    }
    const root = await workspace("crafted-hook-receipts");
    const hookFile = await writeHooks(root, legacyHookDocument());
    await applyTrellisLegacyHookScrub({ root, host: "codex" });
    const receiptFile = path.join(root, TRELLIS_LEGACY_HOOK_RECEIPT);
    const valid = JSON.parse(await readFile(receiptFile, "utf8")) as CraftedReceipt;
    const neighbor = path.join(root, ".codex", "neighbor.json");
    await writeFile(neighbor, "neighbor-stays", "utf8");
    const mutations: Array<{ label: string; mutate: (receipt: CraftedReceipt) => void }> = [
      {
        label: "target",
        mutate: (receipt) => {
          receipt.apply_exchange.target = ".codex/neighbor.json";
        },
      },
      {
        label: "stage",
        mutate: (receipt) => {
          receipt.apply_exchange.stage = ".codex/.neighbor.redirect.stage";
        },
      },
      {
        label: "expected-hash",
        mutate: (receipt) => {
          receipt.apply_exchange.expected_sha256 = "0".repeat(64);
        },
      },
      {
        label: "replacement-identity",
        mutate: (receipt) => {
          receipt.apply_exchange.replacement_identity.dev += 1;
        },
      },
      {
        label: "generation",
        mutate: (receipt) => {
          receipt.generation = randomUUID();
        },
      },
      {
        label: "post-document",
        mutate: (receipt) => {
          receipt.post_document.custom = "forged";
        },
      },
    ];
    for (const { label, mutate } of mutations) {
      const crafted = structuredClone(valid);
      mutate(crafted);
      const craftedText = JSON.stringify(crafted);
      await writeFile(receiptFile, craftedText, "utf8");
      const hookBefore = await readFile(hookFile, "utf8");
      const neighborBefore = await readFile(neighbor, "utf8");
      let lockTouched = false;
      setTrellisStorageProbeForTests((phase) => {
        if (phase.startsWith("lock-")) lockTouched = true;
      });
      let rejected = false;
      try {
        await applyTrellisLegacyHookScrub({ root, host: "codex" });
      } catch {
        rejected = true;
      }
      expect(rejected, label).toBe(true);
      setTrellisStorageProbeForTests(null);
      expect(lockTouched).toBe(false);
      expect(await readFile(hookFile, "utf8")).toBe(hookBefore);
      expect(await readFile(neighbor, "utf8")).toBe(neighborBefore);
      expect(await readFile(receiptFile, "utf8")).toBe(craftedText);
      expect(await readdir(path.join(root, ".codex"))).not.toContain(".assay-trellis-hook.lock");
    }

    const pendingRoot = await workspace("crafted-pending-stage-identity");
    const pendingHook = await writeHooks(pendingRoot, legacyHookDocument());
    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "apply-after-prepared") throw new Error("leave apply prepared");
    });
    await expect(applyTrellisLegacyHookScrub({ root: pendingRoot, host: "codex" })).rejects.toThrow(
      /leave apply prepared/,
    );
    setTrellisLegacyHookProbeForTests(null);
    const pendingReceiptFile = path.join(pendingRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const pending = JSON.parse(await readFile(pendingReceiptFile, "utf8")) as CraftedReceipt;
    pending.apply_exchange.replacement_identity.dev += 1;
    const pendingText = JSON.stringify(pending);
    await writeFile(pendingReceiptFile, pendingText, "utf8");
    const pendingHookBefore = await readFile(pendingHook, "utf8");
    let pendingLockTouched = false;
    setTrellisStorageProbeForTests((phase) => {
      if (phase.startsWith("lock-")) pendingLockTouched = true;
    });
    await expect(applyTrellisLegacyHookScrub({ root: pendingRoot, host: "codex" })).rejects.toThrow(
      /stage does not match its receipt/,
    );
    setTrellisStorageProbeForTests(null);
    expect(pendingLockTouched).toBe(false);
    expect(await readFile(pendingHook, "utf8")).toBe(pendingHookBefore);
    expect(await readFile(pendingReceiptFile, "utf8")).toBe(pendingText);

    const restoreRoot = await workspace("crafted-restore-redirect");
    const restoreHook = await writeHooks(restoreRoot, legacyHookDocument());
    await applyTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" });
    setTrellisLegacyHookProbeForTests((phase) => {
      if (phase === "restore-after-prepared") throw new Error("leave restore prepared");
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" }),
    ).rejects.toThrow(/leave restore prepared/);
    setTrellisLegacyHookProbeForTests(null);
    const restoreReceiptFile = path.join(restoreRoot, TRELLIS_LEGACY_HOOK_RECEIPT);
    const restoreCrafted = JSON.parse(await readFile(restoreReceiptFile, "utf8")) as Record<
      string,
      unknown
    > & { restore_exchange: { target: string } };
    restoreCrafted.restore_exchange.target = ".codex/neighbor.json";
    const restoreText = JSON.stringify(restoreCrafted);
    await writeFile(restoreReceiptFile, restoreText, "utf8");
    const restoreHookBefore = await readFile(restoreHook, "utf8");
    let restoreLockTouched = false;
    setTrellisStorageProbeForTests((phase) => {
      if (phase.startsWith("lock-")) restoreLockTouched = true;
    });
    await expect(
      restoreTrellisLegacyHookScrub({ root: restoreRoot, host: "codex" }),
    ).rejects.toThrow();
    setTrellisStorageProbeForTests(null);
    expect(restoreLockTouched).toBe(false);
    expect(await readFile(restoreHook, "utf8")).toBe(restoreHookBefore);
    expect(await readFile(restoreReceiptFile, "utf8")).toBe(restoreText);
  });
});
