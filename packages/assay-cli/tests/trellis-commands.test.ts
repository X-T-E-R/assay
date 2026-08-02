import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "assay-test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = createTempDirectoryFixture("assay-cli-trellis");
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  const registryRoot = await createIsolatedRegistryRoot(tempDirs);
  cliRunner = createBuiltCliRunner({ registryRoot });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
    bare: true,
    extraArgs: ["--plugin", "assay.trellis"],
  });
}

async function runCliWithInput(
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliRunner.cliPath, ...args], {
      cwd: cliRunner.packageRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function runStoredHook(command: string, root: string) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      env: { ...process.env, PATH: "", CODEX_THREAD_ID: "clean-path-session" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end("{}\n");
  });
}

describe("assay trellis CLI", () => {
  it("supports task create, current, and Codex context JSON contracts", async () => {
    const root = await workspace("trellis-json");
    const created = await cliRunner.runCli([
      "trellis",
      "task",
      "create",
      "--title",
      "CLI vertical slice",
      "--root",
      root,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const createdJson = JSON.parse(created.stdout) as Record<string, unknown>;
    expect(createdJson).toEqual(
      expect.objectContaining({ protocol_version: 1, plugin: "assay.trellis", session_id: null }),
    );

    const current = await cliRunner.runCli([
      "trellis",
      "task",
      "current",
      "--root",
      root,
      "--json",
    ]);
    expect(current.exitCode, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toEqual(createdJson);

    const context = await cliRunner.runCli([
      "trellis",
      "context",
      "--host",
      "codex",
      "--root",
      root,
      "--json",
    ]);
    expect(context.exitCode, context.stderr).toBe(0);
    expect(JSON.parse(context.stdout)).toEqual({
      ...createdJson,
      host: "codex",
      workspace_root: root,
    });
  });

  it("uses session environment fallback and fail-closes ambiguity without it", async () => {
    const root = await workspace("trellis-sessions");
    for (const [session, title] of [
      ["session-a", "Alpha"],
      ["session-b", "Beta"],
    ] as const) {
      const result = await cliRunner.runCli(
        ["trellis", "task", "create", "--title", title, "--root", root, "--json"],
        { env: { ASSAY_TRELLIS_SESSION_ID: session } },
      );
      expect(result.exitCode, result.stderr).toBe(0);
    }

    const ambiguous = await cliRunner.runCli([
      "trellis",
      "task",
      "current",
      "--root",
      root,
      "--json",
    ]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous across sessions");

    const scoped = await cliRunner.runCli(
      ["trellis", "context", "--host", "codex", "--root", root, "--json"],
      { env: { CODEX_SESSION_ID: "session-b" } },
    );
    expect(scoped.exitCode, scoped.stderr).toBe(0);
    expect((JSON.parse(scoped.stdout) as { task: { title: string } }).task.title).toBe("Beta");
  });

  it("emits Codex SessionStart hook schema and resolves identity from stdin or env", async () => {
    const root = await workspace("trellis-hook-adapter");
    for (const [session, title] of [
      ["thread-stdin", "From stdin"],
      ["thread-env", "From env"],
    ] as const) {
      const result = await cliRunner.runCli([
        "trellis",
        "task",
        "create",
        "--title",
        title,
        "--session-id",
        session,
        "--root",
        root,
        "--json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
    }

    const fromStdin = await runCliWithInput(
      ["trellis", "context", "--host", "codex", "--hook-adapter", "--root", root],
      JSON.stringify({ hook_event_name: "SessionStart", thread_id: "thread-stdin" }),
      { CODEX_THREAD_ID: "thread-env" },
    );
    expect(fromStdin.exitCode, fromStdin.stderr).toBe(0);
    const stdinOutput = JSON.parse(fromStdin.stdout) as {
      continue: boolean;
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(stdinOutput.continue).toBe(true);
    expect(stdinOutput.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(JSON.parse(stdinOutput.hookSpecificOutput.additionalContext).task.title).toBe(
      "From stdin",
    );

    const fromEnv = await runCliWithInput(
      ["trellis", "context", "--host", "codex", "--hook-adapter", "--root", root],
      "",
      { CODEX_THREAD_ID: "thread-env" },
    );
    expect(fromEnv.exitCode, fromEnv.stderr).toBe(0);
    expect(
      JSON.parse(
        (JSON.parse(fromEnv.stdout) as { hookSpecificOutput: { additionalContext: string } })
          .hookSpecificOutput.additionalContext,
      ).task.title,
    ).toBe("From env");
  });

  it("previews and applies the Codex hook without copying a script", async () => {
    const root = await workspace("trellis-hook");
    const hookFile = path.join(root, ".codex", "hooks.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    await writeFile(
      hookFile,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "neighbor" }] }] } }),
      "utf8",
    );

    const preview = await cliRunner.runCli([
      "trellis",
      "hook",
      "install",
      "--host",
      "codex",
      "--dry-run",
      "--root",
      root,
      "--json",
    ]);
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual(
      expect.objectContaining({ action: "update", applied: false, protocol_version: 1 }),
    );

    const applied = await cliRunner.runCli([
      "trellis",
      "hook",
      "install",
      "--host",
      "codex",
      "--apply",
      "--root",
      root,
      "--json",
    ]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual(expect.objectContaining({ applied: true }));
    const content = await readFile(hookFile, "utf8");
    expect(content).toContain("neighbor");
    expect(content).toContain("trellis context --host codex --hook-adapter");
    expect(content).toContain("node.exe");
    const document = JSON.parse(content) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const invoked = await runStoredHook(
      document.hooks.SessionStart[0]?.hooks[0]?.command ?? "",
      root,
    );
    expect(invoked.exitCode, invoked.stderr).toBe(0);
    expect(JSON.parse(invoked.stdout)).toEqual(
      expect.objectContaining({
        continue: true,
        hookSpecificOutput: expect.objectContaining({ hookEventName: "SessionStart" }),
      }),
    );
    expect(await readFile(path.join(root, ".assay", "trellis", "state.json"), "utf8")).toContain(
      '"protocol_version": 1',
    );
  });

  it("plans, applies, idempotently reapplies, and explicitly restores legacy Codex hooks as JSON", async () => {
    const root = await workspace("trellis-hook-legacy");
    const hookFile = path.join(root, ".codex", "hooks.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    const original = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "python -X utf8 .codex/hooks/inject-workflow-state.py",
              },
            ],
          },
          { hooks: [{ type: "command", command: "neighbor" }] },
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
        ],
      },
    });
    await writeFile(hookFile, original, "utf8");

    const plan = await cliRunner.runCli([
      "trellis",
      "hook",
      "legacy",
      "plan",
      "--host",
      "codex",
      "--root",
      root,
      "--json",
    ]);
    expect(plan.exitCode, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toEqual(
      expect.objectContaining({
        action: "remove",
        read_only: true,
        contract_version: 1,
        removed_groups: expect.any(Array),
      }),
    );
    expect(await readFile(hookFile, "utf8")).toBe(original);

    const apply = await cliRunner.runCli([
      "trellis",
      "hook",
      "legacy",
      "apply",
      "--host",
      "codex",
      "--root",
      root,
      "--json",
    ]);
    expect(apply.exitCode, apply.stderr).toBe(0);
    expect(JSON.parse(apply.stdout)).toEqual(
      expect.objectContaining({ applied: true, recovered: false }),
    );
    expect(await readFile(hookFile, "utf8")).toContain("neighbor");
    expect(await readFile(hookFile, "utf8")).not.toContain("inject-workflow-state.py");

    const repeated = await cliRunner.runCli([
      "trellis",
      "hook",
      "legacy",
      "apply",
      "--host",
      "codex",
      "--root",
      root,
      "--json",
    ]);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(expect.objectContaining({ applied: false }));

    const restore = await cliRunner.runCli([
      "trellis",
      "hook",
      "legacy",
      "restore",
      "--host",
      "codex",
      "--root",
      root,
      "--json",
    ]);
    expect(restore.exitCode, restore.stderr).toBe(0);
    expect(JSON.parse(restore.stdout)).toEqual(expect.objectContaining({ restored: true }));
    expect(await readFile(hookFile, "utf8")).toBe(original);
  });

  it("exposes protocol, task lifecycle, journal, channel, and external-worker commands", async () => {
    const root = await workspace("trellis-operational-cli");
    const protocol = await cliRunner.runCli(["trellis", "protocol", "--root", root, "--json"]);
    expect(protocol.exitCode, protocol.stderr).toBe(0);
    expect(JSON.parse(protocol.stdout)).toEqual({
      plugin: "assay.trellis",
      plugin_spi: 1,
      trellis_protocol: 1,
      state_schema: 1,
    });

    const created = await cliRunner.runCli([
      "trellis",
      "task",
      "create",
      "--title",
      "Terminal",
      "--root",
      root,
      "--json",
    ]);
    const taskId = (JSON.parse(created.stdout) as { task: { id: string } }).task.id;
    expect(
      (await cliRunner.runCli(["trellis", "task", "complete", taskId, "--root", root, "--json"]))
        .exitCode,
    ).toBe(0);
    expect(
      (await cliRunner.runCli(["trellis", "task", "archive", taskId, "--root", root, "--json"]))
        .exitCode,
    ).toBe(0);
    const archived = await cliRunner.runCli([
      "trellis",
      "task",
      "list",
      "--archived",
      "--root",
      root,
      "--json",
    ]);
    expect((JSON.parse(archived.stdout) as { tasks: unknown[] }).tasks).toHaveLength(1);

    const journaled = await cliRunner.runCli([
      "trellis",
      "journal",
      "append",
      "--kind",
      "note",
      "--message",
      "hello",
      "--root",
      root,
      "--json",
    ]);
    expect(journaled.exitCode).toBe(0);
    expect(
      (await cliRunner.runCli(["trellis", "channel", "create", "jobs", "--root", root, "--json"]))
        .exitCode,
    ).toBe(0);
    const sent = await cliRunner.runCli([
      "trellis",
      "channel",
      "send",
      "jobs",
      "--type",
      "job",
      "--payload",
      '{"n":1}',
      "--idempotency-key",
      "one",
      "--root",
      root,
      "--json",
    ]);
    expect((JSON.parse(sent.stdout) as { event: { seq: number } }).event.seq).toBe(1);
    const registered = await cliRunner.runCli([
      "trellis",
      "worker",
      "register",
      "outside-1",
      "--channel",
      "jobs",
      "--root",
      root,
      "--json",
    ]);
    expect(registered.exitCode).toBe(0);
    const claimed = await cliRunner.runCli([
      "trellis",
      "worker",
      "claim",
      "outside-1",
      "--root",
      root,
      "--json",
    ]);
    expect(claimed.exitCode).toBe(0);
    const token = (JSON.parse(claimed.stdout) as { token: string }).token;
    const completed = await cliRunner.runCli([
      "trellis",
      "worker",
      "complete",
      "outside-1",
      "--token",
      token,
      "--result",
      '{"ok":true}',
      "--root",
      root,
      "--json",
    ]);
    expect((JSON.parse(completed.stdout) as { worker: { status: string } }).worker.status).toBe(
      "completed",
    );
  });

  it("requires explicit confirmation before lifecycle purge and preserves data on disable", async () => {
    const root = await workspace("trellis-lifecycle-cli");
    const refused = await cliRunner.runCli([
      "plugin",
      "uninstall",
      "assay.trellis",
      "--purge",
      "--root",
      root,
      "--json",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--purge and --yes");
    const disabled = await cliRunner.runCli([
      "plugin",
      "disable",
      "assay.trellis",
      "--root",
      root,
      "--json",
    ]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect((JSON.parse(disabled.stdout) as { dataPreserved: boolean }).dataPreserved).toBe(true);
    expect(await readFile(path.join(root, ".assay", "trellis", "state.json"), "utf8")).toContain(
      '"__schema": 1',
    );
  });
});
