import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { identitySafeRealpath } from "../src/filesystem-boundary.js";
import * as publicCore from "../src/index.js";
import {
  applyUpdate,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  forgetWorkspace,
  getFrameworkStatus,
  initFramework,
  listAvailableTemplates,
  listWorkspaces,
  loadManagedFiles,
  loadManifest,
  loadSystemsRegistry,
  loadTemplate,
  registerSystem,
  saveManagedFiles,
  setAssayAgentsWriteProbeForTests,
  setManagedFilesWriteProbeForTests,
  setUpdateWriteProbeForTests,
  trackWorkspace,
  workspaceRecordFilename,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function tempRoot(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "assay-012-"));
  roots.push(parent);
  return path.join(parent, name);
}

afterEach(async () => {
  setAssayAgentsWriteProbeForTests(undefined);
  setManagedFilesWriteProbeForTests(undefined);
  setUpdateWriteProbeForTests(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function customTemplate(parent: string, content = "custom output\n"): Promise<string> {
  const file = path.join(parent, "custom.yaml");
  await writeFile(
    file,
    [
      "__schema: 1",
      "description: Explicit custom template.",
      "directories:",
      "  - path: custom",
      "    purpose: User-owned custom material",
      "files:",
      "  - path: custom/output.txt",
      `    content: ${JSON.stringify(content)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

async function windowsShortPath(target: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AssayPathNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint size);
}
'@
$buffer = New-Object System.Text.StringBuilder 32768
$length = [AssayPathNative]::GetShortPathName($args[0], $buffer, $buffer.Capacity)
if ($length -eq 0) { exit 2 }
$buffer.ToString()
`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      target,
    ]);
    const candidate = stdout.trim();
    return candidate === "" ? null : candidate;
  } catch {
    return null;
  }
}

describe("0.13 control-plane cleanup", () => {
  it("accepts a Windows DOS short-name workspace alias without accepting redirects", async () => {
    if (process.platform !== "win32") return;
    const temp = path.resolve(tmpdir());
    const canonicalTemp = await import("node:fs/promises").then(({ realpath }) => realpath(temp));
    const runnerProvidedShortTemp = /~[0-9]+(?:\\|$)/i.test(temp);
    if (runnerProvidedShortTemp) {
      expect(canonicalTemp.toLowerCase()).not.toBe(temp.toLowerCase());
      await expect(identitySafeRealpath(temp)).resolves.toMatchObject({
        windowsShortPathAlias: true,
      });
    }
    const shortTemp =
      temp.toLowerCase() !== canonicalTemp.toLowerCase() ? temp : await windowsShortPath(temp);
    if (!shortTemp || !/~[0-9]+(?:\\|$)/i.test(shortTemp)) return;

    await expect(identitySafeRealpath(shortTemp)).resolves.toMatchObject({
      windowsShortPathAlias: true,
    });

    const parent = await mkdtemp(path.join(shortTemp, "assay-short-path-"));
    roots.push(parent);
    const descriptor = await customTemplate(parent);
    const root = path.join(parent, "workspace");
    await initFramework({ target: root, name: "Short Path", template: descriptor });

    const manifest = await loadManifest(root);
    expect(manifest).toMatchObject({
      framework_version: "0.14.0",
      layout: { version: 8 },
    });
    if (!manifest) throw new Error("short-path workspace manifest was not created");
    await expect(publicCore.saveManifest(root, manifest)).resolves.toEqual(manifest);
    await expect(checkFramework({ root })).resolves.toMatchObject({ ok: true });
  });

  it("exposes exactly three built-ins and requires an explicit strict YAML path for custom templates", async () => {
    expect((await listAvailableTemplates()).map((entry) => entry.name)).toEqual([
      "study",
      "solve",
      "explore",
    ]);
    await expect(loadTemplate("custom-name")).rejects.toThrow("explicit YAML path");
    const root = await tempRoot("strict-template");
    await mkdir(root, { recursive: true });
    const descriptor = path.join(root, "bad.yaml");
    await writeFile(
      descriptor,
      "__schema: 1\ndescription: bad\nextends: base\ndirectories: []\nfiles: []\n",
      "utf8",
    );
    await expect(
      initFramework({ target: path.join(root, "workspace"), template: descriptor }),
    ).rejects.toThrow("unsupported field(s): extends");
    await expect(stat(path.join(root, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects legacy template fields and unsafe paths before the first scaffold write", async () => {
    const parent = await tempRoot("template-negative");
    await mkdir(parent, { recursive: true });
    for (const field of [
      "extends",
      "mode",
      "dirs_required",
      "dirs_optional",
      "modules",
      "templateId",
    ]) {
      const descriptor = path.join(parent, `${field}.yaml`);
      await writeFile(
        descriptor,
        `__schema: 1\ndescription: bad\n${field}: legacy\ndirectories: []\nfiles: []\n`,
        "utf8",
      );
      await expect(loadTemplate(descriptor)).rejects.toThrow("unsupported field");
    }
    for (const [name, unsafePath] of [
      ["absolute", "C:/outside"],
      ["traversal", "../outside"],
      ["retired", "iterations/old"],
      ["native-project", "project/project.yaml"],
      ["native-root", "project"],
      ["native-descendant", "project/project.yaml/child"],
      ["managed-core", "README.md"],
      ["manifest-authority", ".assay/manifest.json"],
      ["receipt-authority", ".assay/managed-files.json"],
      ["registry-authority", ".assay/systems-registry.json"],
      ["external-state", ".assay/external-plugins.json"],
      ["task-contexts", ".assay/task-contexts.json"],
      ["systems-root", "systems/root.yaml"],
    ] as const) {
      const descriptor = path.join(parent, `${name}.yaml`);
      await writeFile(
        descriptor,
        `__schema: 1\ndescription: bad\ndirectories:\n  - path: ${unsafePath}\n    purpose: bad\nfiles: []\n`,
        "utf8",
      );
      const target = path.join(parent, `target-${name}`);
      await expect(initFramework({ target, template: descriptor })).rejects.toThrow(
        /template path|retired/,
      );
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await writeFile(path.join(parent, "outside.txt"), "outside\n", "utf8");
    const escapedContent = path.join(parent, "nested", "escaped-file.yaml");
    await mkdir(path.dirname(escapedContent));
    await writeFile(
      escapedContent,
      "__schema: 1\ndescription: bad\ndirectories: []\nfiles:\n  - path: safe.txt\n    file: ../outside.txt\n",
      "utf8",
    );
    await expect(loadTemplate(escapedContent)).rejects.toThrow("escapes its descriptor directory");
  });

  it("persists expanded entries, not template identity, and never manages custom output", async () => {
    const root = await tempRoot("custom-workspace");
    const descriptor = await customTemplate(path.dirname(root));
    await initFramework({
      target: root,
      name: "Custom Project",
      template: descriptor,
      agents: false,
    });
    await rm(descriptor);

    const manifest = await loadManifest(root);
    expect(manifest).toMatchObject({
      __schema: 4,
      framework_version: "0.14.0",
      layout: { version: 8, entries: expect.any(Array) },
    });
    expect(manifest?.layout.paths).toEqual({
      manifest: ".assay/manifest.json",
      events: ".assay/events",
      backups: ".assay/backups",
      systems_registry: ".assay/systems-registry.json",
      sources: "sources",
      analyses: "analyses",
      knowledge: "knowledge",
      systems: "systems",
    });
    const { systems: staleSystemsPath, ...stalePaths } = manifest?.layout.paths ?? {};
    const staleLayoutName = {
      ...manifest,
      layout: {
        ...manifest?.layout,
        paths: { ...stalePaths, systems_contracts: staleSystemsPath },
      },
    };
    expect(publicCore.frameworkManifestSchema.safeParse(staleLayoutName).success).toBe(false);
    expect(Object.hasOwn(manifest as object, "entries")).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/template|archetype|profile|managed_files/);
    expect(Object.hasOwn(manifest as object, "project")).toBe(false);
    expect(manifest?.layout.entries).toContainEqual({
      path: "custom/output.txt",
      kind: "file",
      purpose: "",
    });
    expect(manifest?.layout.entries.every((entry) => entry.path.startsWith("custom"))).toBe(true);
    const receipt = await loadManagedFiles(root);
    expect(receipt.__schema).toBe(1);
    expect(receipt.files.some((entry) => entry.path === "custom/output.txt")).toBe(false);
    await expect(getFrameworkStatus({ root })).resolves.toMatchObject({
      project: "Custom Project",
    });
    await expect(checkFramework({ root })).resolves.toMatchObject({ ok: true });
    await expect(applyUpdate({ root, dryRun: true })).resolves.toMatchObject({ dryRun: true });
    const manifestFile = path.join(root, ".assay", "manifest.json");
    const before = await readFile(manifestFile, "utf8");
    await expect(
      publicCore.saveManifest(root, {
        ...manifest,
        framework_version: "0.13.1",
      } as never),
    ).rejects.toThrow();
    expect(await readFile(manifestFile, "utf8")).toBe(before);
  });

  it("fails an old tuple before writing any new state", async () => {
    const root = await tempRoot("old-tuple");
    await mkdir(path.join(root, ".assay"), { recursive: true });
    const old = { __schema: 3, framework_version: "0.11.0", layout_version: 7 };
    await writeFile(path.join(root, ".assay", "manifest.json"), JSON.stringify(old), "utf8");
    const before = await readdir(path.join(root, ".assay"));
    await expect(initFramework({ target: root })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      required: "0.14.0+s4+l8",
    });
    expect(await readdir(path.join(root, ".assay"))).toEqual(before);
    expect(await readFile(path.join(root, ".assay", "manifest.json"), "utf8")).toBe(
      JSON.stringify(old),
    );
  });

  it("keeps three-way no-clobber semantics in the separate receipt", async () => {
    const root = await tempRoot("receipt");
    await initFramework({ target: root, name: "Receipt", agents: false });
    await writeFile(path.join(root, "README.md"), "user edit\n", "utf8");
    await rm(path.join(root, "systems", "README.md"));
    const result = await applyUpdate({ root, action: "force" });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("user edit\n");
    await expect(stat(path.join(root, "systems", "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.report.skipped_files).toEqual(
      expect.arrayContaining(["README.md", "systems/README.md"]),
    );
  });

  it("updates managed files without retained backups and preserves existing file modes", async () => {
    const root = await tempRoot("zero-backup");
    await initFramework({ target: root, name: "Zero Backup", agents: false });
    const target = path.join(root, ".assay", "README.md");
    const targetMode = (await stat(target)).mode & 0o7777;
    await writeFile(target, "user edit\n", "utf8");

    const backups = path.join(root, ".assay", "backups");
    const sentinel = path.join(backups, "existing", "nested", "sentinel.bin");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, Buffer.from([0, 1, 2, 255]));
    const backupEntriesBefore = (await readdir(backups, { recursive: true })).sort();
    const sentinelBefore = await readFile(sentinel);

    const result = await applyUpdate({ root, action: "force", now: new Date("2020-01-02") });

    expect(result).not.toHaveProperty("backup");
    expect(result.report.updated_files).toContain(".assay/README.md");
    expect((await readdir(backups, { recursive: true })).sort()).toEqual(backupEntriesBefore);
    expect(await readFile(sentinel)).toEqual(sentinelBefore);
    expect((await stat(target)).mode & 0o7777).toBe(targetMode);
    expect(await exists(path.join(root, ".assay", ".authority-README.md.txn"))).toBe(false);
  });

  it("recovers a managed-file crash window and reconciles its stale receipt on rerun", async () => {
    const root = await tempRoot("managed-recovery");
    await initFramework({ target: root, name: "Managed Recovery", agents: false });
    const target = path.join(root, ".assay", "README.md");
    const desired = await readFile(target, "utf8");
    const oldGenerated = "old generated framework guide\n";
    await writeFile(target, oldGenerated, "utf8");
    const receipt = await loadManagedFiles(root);
    await saveManagedFiles(root, {
      ...receipt,
      files: receipt.files.map((record) =>
        record.path === ".assay/README.md"
          ? {
              ...record,
              baseline_hash: publicCore.computeHash(oldGenerated),
            }
          : record,
      ),
    });

    let crashed = false;
    setUpdateWriteProbeForTests((phase, context) => {
      if (!crashed && phase === "after-new-installed" && context.file === target) {
        crashed = true;
        throw new Error("simulated managed write crash");
      }
    });
    await expect(applyUpdate({ root })).rejects.toThrow("simulated managed write crash");
    expect(await exists(path.join(root, ".assay", ".authority-README.md.txn"))).toBe(true);

    setUpdateWriteProbeForTests(undefined);
    await expect(applyUpdate({ root })).resolves.toMatchObject({ dryRun: false });
    expect(await readFile(target, "utf8")).toBe(desired);
    expect(await exists(path.join(root, ".assay", ".authority-README.md.txn"))).toBe(false);
    expect(
      (await loadManagedFiles(root)).files.find((record) => record.path === ".assay/README.md")
        ?.baseline_hash,
    ).toBe(publicCore.computeHash(desired));
    const converged = await applyUpdate({ root });
    expect(converged.report.updated_files).not.toContain(".assay/README.md");
    expect(converged.report.updated_files).not.toContain(".assay/managed-files.json");
  }, 30_000);

  it.each(["after-stage", "after-old-moved", "after-new-installed", "before-cleanup"] as const)(
    "recovers and retries a managed receipt write interrupted at %s",
    async (crashPhase) => {
      const root = await tempRoot(`managed-receipt-${crashPhase}`);
      await initFramework({ target: root, name: "Managed Receipt", agents: false });
      const original = await loadManagedFiles(root);
      const next = {
        ...original,
        files: original.files.map((record, index) =>
          index === 0 ? { ...record, baseline_hash: "a".repeat(64) } : record,
        ),
      };
      const receipt = path.join(root, ".assay", "managed-files.json");
      const transaction = path.join(root, ".assay", ".authority-managed-files.json.txn");
      let crashed = false;
      setManagedFilesWriteProbeForTests((phase, context) => {
        if (!crashed && phase === crashPhase && context.file === receipt) {
          crashed = true;
          throw new Error(`simulated receipt crash at ${crashPhase}`);
        }
      });

      await expect(saveManagedFiles(root, next)).rejects.toThrow(
        `simulated receipt crash at ${crashPhase}`,
      );
      expect(await exists(transaction)).toBe(true);

      setManagedFilesWriteProbeForTests(undefined);
      await expect(saveManagedFiles(root, next)).resolves.toEqual(next);
      await expect(loadManagedFiles(root)).resolves.toEqual(next);
      expect(await exists(transaction)).toBe(false);
    },
  );

  it("fails closed on a missing or corrupt managed receipt without a valid transaction", async () => {
    const missingRoot = await tempRoot("managed-receipt-missing");
    await initFramework({ target: missingRoot, name: "Missing Receipt", agents: false });
    await rm(path.join(missingRoot, ".assay", "managed-files.json"));
    await expect(loadManagedFiles(missingRoot)).rejects.toThrow("Managed receipt is missing");

    const corruptRoot = await tempRoot("managed-receipt-corrupt");
    await initFramework({ target: corruptRoot, name: "Corrupt Receipt", agents: false });
    await writeFile(path.join(corruptRoot, ".assay", "managed-files.json"), "not json\n", "utf8");
    await expect(loadManagedFiles(corruptRoot)).rejects.toThrow("not valid JSON");
  });

  it("recovers an AGENTS managed-block crash window on rerun", async () => {
    const root = await tempRoot("agents-recovery");
    await initFramework({ target: root, name: "Agents Recovery" });
    const agents = path.join(root, "AGENTS.md");
    await writeFile(
      agents,
      (await readFile(agents, "utf8")).replace(
        "This workspace is managed by Assay.",
        "This workspace has a stale Assay block.",
      ),
      "utf8",
    );

    let crashed = false;
    setAssayAgentsWriteProbeForTests((phase, context) => {
      if (!crashed && phase === "after-new-installed" && context.file === agents) {
        crashed = true;
        throw new Error("simulated AGENTS write crash");
      }
    });
    await expect(applyUpdate({ root })).rejects.toThrow("simulated AGENTS write crash");
    expect(await exists(path.join(root, ".authority-AGENTS.md.txn"))).toBe(true);

    setAssayAgentsWriteProbeForTests(undefined);
    await expect(applyUpdate({ root })).resolves.toMatchObject({ dryRun: false });
    expect(await readFile(agents, "utf8")).toContain("This workspace is managed by Assay.");
    expect(await exists(path.join(root, ".authority-AGENTS.md.txn"))).toBe(false);
    const converged = await applyUpdate({ root });
    expect(converged.report.updated_files).not.toContain("AGENTS.md");
  });

  it("refuses an existing .new sidecar before any ordinary update write", async () => {
    const root = await tempRoot("sidecar-no-clobber");
    await initFramework({ target: root, name: "Sidecar No Clobber" });
    const target = path.join(root, ".assay", "README.md");
    const agents = path.join(root, "AGENTS.md");
    const receipt = path.join(root, ".assay", "managed-files.json");
    const sidecar = `${target}.new`;
    await writeFile(target, "user-owned managed edit\n", "utf8");
    await writeFile(
      agents,
      (await readFile(agents, "utf8")).replace(
        "This workspace is managed by Assay.",
        "This workspace has a stale Assay block.",
      ),
      "utf8",
    );
    await writeFile(sidecar, "unique existing sidecar bytes\n", "utf8");
    const before = {
      target: await readFile(target),
      agents: await readFile(agents),
      receipt: await readFile(receipt),
      sidecar: await readFile(sidecar),
      events: (await readdir(path.join(root, ".assay", "events"))).sort(),
      backups: (await readdir(path.join(root, ".assay", "backups"), { recursive: true })).sort(),
    };

    await expect(applyUpdate({ root, action: "create-new" })).rejects.toThrow(
      "sidecar already exists",
    );
    expect(await readFile(target)).toEqual(before.target);
    expect(await readFile(agents)).toEqual(before.agents);
    expect(await readFile(receipt)).toEqual(before.receipt);
    expect(await readFile(sidecar)).toEqual(before.sidecar);
    expect((await readdir(path.join(root, ".assay", "events"))).sort()).toEqual(before.events);
    expect(
      (await readdir(path.join(root, ".assay", "backups"), { recursive: true })).sort(),
    ).toEqual(before.backups);
  });

  it.each(["after-stage", "after-new-installed", "before-cleanup"] as const)(
    "recovers its planned .new sidecar interrupted at %s and reports it on retry",
    async (crashPhase) => {
      const root = await tempRoot(`sidecar-recovery-${crashPhase}`);
      await initFramework({ target: root, name: "Sidecar Recovery", agents: false });
      const target = path.join(root, ".assay", "README.md");
      const sidecar = `${target}.new`;
      const desired = await readFile(target);
      await writeFile(target, "user-owned managed edit\n", "utf8");
      let crashed = false;
      setUpdateWriteProbeForTests((phase, context) => {
        if (!crashed && phase === crashPhase && context.file === sidecar) {
          crashed = true;
          throw new Error(`simulated sidecar crash at ${crashPhase}`);
        }
      });

      await expect(applyUpdate({ root, action: "create-new" })).rejects.toThrow(
        `simulated sidecar crash at ${crashPhase}`,
      );
      expect(await exists(path.join(root, ".assay", ".authority-README.md.new.txn"))).toBe(true);

      setUpdateWriteProbeForTests(undefined);
      const result = await applyUpdate({ root, action: "create-new" });
      expect(result.report.new_copies).toContain(".assay/README.md.new");
      expect(await readFile(sidecar)).toEqual(desired);
      expect(await exists(path.join(root, ".assay", ".authority-README.md.new.txn"))).toBe(false);
    },
  );

  it("retains and preflight-blocks an exact-byte concurrent .new sidecar winner", async () => {
    const root = await tempRoot("sidecar-concurrent-winner");
    await initFramework({ target: root, name: "Sidecar Concurrent Winner" });
    const target = path.join(root, ".assay", "README.md");
    const sidecar = `${target}.new`;
    const desired = await readFile(target);
    await writeFile(target, "user-owned managed edit\n", "utf8");
    let installedWinner = false;
    setUpdateWriteProbeForTests(async (phase, context) => {
      if (!installedWinner && phase === "after-stage" && context.file === sidecar) {
        installedWinner = true;
        await writeFile(sidecar, desired);
        throw new Error("simulated concurrent sidecar winner");
      }
    });
    await expect(applyUpdate({ root, action: "create-new" })).rejects.toThrow(
      "simulated concurrent sidecar winner",
    );

    setUpdateWriteProbeForTests(undefined);
    const agents = path.join(root, "AGENTS.md");
    await writeFile(
      agents,
      (await readFile(agents, "utf8")).replace(
        "This workspace is managed by Assay.",
        "This workspace has a stale Assay block.",
      ),
      "utf8",
    );
    const receipt = path.join(root, ".assay", "managed-files.json");
    const before = {
      target: await readFile(target),
      agents: await readFile(agents),
      receipt: await readFile(receipt),
      sidecar: await readFile(sidecar),
      events: (await readdir(path.join(root, ".assay", "events"))).sort(),
    };

    await expect(applyUpdate({ root, action: "create-new" })).rejects.toThrow(
      "sidecar already exists",
    );
    expect(await readFile(target)).toEqual(before.target);
    expect(await readFile(agents)).toEqual(before.agents);
    expect(await readFile(receipt)).toEqual(before.receipt);
    expect(await readFile(sidecar)).toEqual(before.sidecar);
    expect((await readdir(path.join(root, ".assay", "events"))).sort()).toEqual(before.events);
  });

  it("does not recreate deleted native Project guide files during ordinary update", async () => {
    const root = await tempRoot("project-guides");
    await initFramework({ target: root, name: "Project Guides", agents: false });
    const guides = [
      path.join(root, "project", "README.md"),
      path.join(root, "project", "roadmap", "README.md"),
    ];
    for (const guide of guides) await rm(guide);

    await expect(applyUpdate({ root })).resolves.toMatchObject({ dryRun: false });
    for (const guide of guides) {
      await expect(stat(guide)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails closed on malformed or shared managed receipts without workspace writes", async () => {
    const parent = await tempRoot("receipt-safety");
    const malformed = path.join(parent, "malformed");
    await initFramework({ target: malformed, agents: false });
    const receipt = path.join(malformed, ".assay", "managed-files.json");
    await writeFile(receipt, '{"__schema":1,"files":"bad"}', "utf8");
    const malformedEntries = await readdir(path.join(malformed, ".assay"));
    await expect(applyUpdate({ root: malformed })).rejects.toThrow("failed validation");
    expect(await readdir(path.join(malformed, ".assay"))).toEqual(malformedEntries);
    expect(await readFile(receipt, "utf8")).toBe('{"__schema":1,"files":"bad"}');

    const shared = path.join(parent, "shared");
    await initFramework({ target: shared, agents: false });
    const sharedReceipt = path.join(shared, ".assay", "managed-files.json");
    const outside = path.join(parent, "outside-receipt.json");
    await writeFile(outside, await readFile(sharedReceipt), "utf8");
    await rm(sharedReceipt);
    await link(outside, sharedReceipt);
    const sharedEntries = await readdir(path.join(shared, ".assay"));
    await expect(applyUpdate({ root: shared })).rejects.toThrow("unshared file");
    expect(await readdir(path.join(shared, ".assay"))).toEqual(sharedEntries);
    expect(await readFile(outside, "utf8")).toBe(await readFile(sharedReceipt, "utf8"));
  });

  it("tracks clones explicitly by path hash and rebinds only the same Project", async () => {
    const parent = await tempRoot("index-case");
    const one = path.join(parent, "one");
    const two = path.join(parent, "two");
    const three = path.join(parent, "three");
    const indexRoot = path.join(parent, "index");
    for (const root of [one, two, three])
      await initFramework({ target: root, name: "Clone", agents: false });
    await trackWorkspace({ root: one, indexRoot });
    const trackedTwo = await trackWorkspace({ root: two, indexRoot });
    expect(
      (await listWorkspaces({ indexRoot })).filter((item) => item.status === "current"),
    ).toHaveLength(2);
    const trackedThree = await trackWorkspace({ root: three, rebind: one, indexRoot });
    const listed = await listWorkspaces({ indexRoot });
    expect(listed.map((item) => item.record?.path).sort()).toEqual(
      [trackedTwo.path, trackedThree.path].sort(),
    );
    await forgetWorkspace(two, { indexRoot });
    expect(await listWorkspaces({ indexRoot })).toHaveLength(1);

    const other = path.join(parent, "other");
    await initFramework({ target: other, name: "Other", agents: false });
    await expect(trackWorkspace({ root: other, rebind: three, indexRoot })).rejects.toThrow(
      "same Project id",
    );
  });

  it("rebind validates the old workspace rather than trusting index payload bytes", async () => {
    const parent = await tempRoot("rebind-validation");
    const indexRoot = path.join(parent, "index");
    const next = path.join(parent, "next");
    await initFramework({ target: next, name: "Same", agents: false });
    const snapshot = async () =>
      new Map(
        await Promise.all(
          (await readdir(indexRoot)).map(
            async (name) => [name, await readFile(path.join(indexRoot, name), "utf8")] as const,
          ),
        ),
      );

    const stale = path.join(parent, "stale");
    await initFramework({ target: stale, name: "Same", agents: false });
    const trackedStale = await trackWorkspace({ root: stale, indexRoot });
    const staleRecord = path.join(indexRoot, workspaceRecordFilename(trackedStale.path));
    const payload = JSON.parse(await readFile(staleRecord, "utf8"));
    payload.project_id = "project-forged";
    await writeFile(staleRecord, JSON.stringify(payload), "utf8");
    let before = await snapshot();
    await expect(trackWorkspace({ root: next, rebind: stale, indexRoot })).rejects.toThrow("stale");
    expect(await snapshot()).toEqual(before);

    const cutover = path.join(parent, "cutover-old");
    await initFramework({ target: cutover, name: "Same", agents: false });
    await trackWorkspace({ root: cutover, indexRoot });
    await writeFile(
      path.join(cutover, ".assay", "manifest.json"),
      JSON.stringify({ __schema: 3, framework_version: "0.11.0", layout_version: 7 }),
      "utf8",
    );
    before = await snapshot();
    await expect(trackWorkspace({ root: next, rebind: cutover, indexRoot })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
    });
    expect(await snapshot()).toEqual(before);

    const missing = path.join(parent, "missing-old");
    await initFramework({ target: missing, name: "Same", agents: false });
    await trackWorkspace({ root: missing, indexRoot });
    await rename(missing, `${missing}-gone`);
    before = await snapshot();
    await expect(trackWorkspace({ root: next, rebind: missing, indexRoot })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("lists every workspace-index state without rewriting records", async () => {
    const parent = await tempRoot("index-status");
    const indexRoot = path.join(parent, "index");
    const current = path.join(parent, "current");
    const missing = path.join(parent, "missing");
    const cutover = path.join(parent, "cutover");
    for (const root of [current, missing, cutover]) {
      await initFramework({ target: root, agents: false });
      await trackWorkspace({ root, indexRoot });
    }
    await rename(missing, `${missing}-moved`);
    await writeFile(
      path.join(cutover, ".assay", "manifest.json"),
      JSON.stringify({ __schema: 3, framework_version: "0.11.0", layout_version: 7 }),
      "utf8",
    );
    const invalidFile = path.join(indexRoot, `${"a".repeat(64)}.json`);
    await writeFile(
      invalidFile,
      JSON.stringify({ __schema: 1, project_id: "project-invalid", path: current }),
      "utf8",
    );
    expect(path.basename(invalidFile)).not.toBe(workspaceRecordFilename(current));
    const snapshot = async () =>
      new Map(
        await Promise.all(
          (await readdir(indexRoot)).map(
            async (name) => [name, await readFile(path.join(indexRoot, name), "utf8")] as const,
          ),
        ),
      );
    const before = await snapshot();
    expect((await listWorkspaces({ indexRoot })).map((item) => item.status).sort()).toEqual([
      "current",
      "cutover_required",
      "invalid",
      "missing",
    ]);
    expect(await snapshot()).toEqual(before);
    await expect(forgetWorkspace("../escape.json", { indexRoot })).rejects.toThrow(
      "Tracked workspace not found",
    );
  });

  it("lists redirected workspace authority as invalid without reading through it", async () => {
    const parent = await tempRoot("index-redirect");
    const root = path.join(parent, "workspace");
    const indexRoot = path.join(parent, "index");
    await initFramework({ target: root, agents: false });
    const tracked = await trackWorkspace({ root, indexRoot });
    const outside = path.join(parent, "outside-state");
    await rename(path.join(root, ".assay"), outside);
    await symlink(outside, path.join(root, ".assay"), "junction");
    const recordFile = path.join(indexRoot, workspaceRecordFilename(tracked.path));
    const before = await readFile(recordFile, "utf8");
    expect(await listWorkspaces({ indexRoot })).toMatchObject([{ status: "invalid" }]);
    expect(await readFile(recordFile, "utf8")).toBe(before);
  });

  it("round-trips overlay entries and managed receipt to standalone", async () => {
    const parent = await tempRoot("convert-case");
    const source = path.join(parent, "product");
    const target = path.join(parent, "workbench");
    await mkdir(source, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: source });
    await attachExistingRepo({
      root: source,
      name: "Product",
      template: "study",
      privacy: "tracked",
    });
    expect(await exists(path.join(source, ".assay", "systems", "root.yaml"))).toBe(false);
    const ordinary = path.join(source, ".assay", "systems", "legacy", "system.yaml");
    await mkdir(path.dirname(ordinary), { recursive: true });
    await writeFile(ordinary, "ordinary-user-bytes: true\n", "utf8");
    await registerSystem(source, {
      path: path.dirname(ordinary),
      name: "legacy",
      vcs: "embedded",
    });
    const converted = await convertOverlayToStandalone({
      root: source,
      target,
      move: true,
      keepOverlay: false,
    });
    expect(converted.layout).toMatchObject({ version: 8, mode: "standalone" });
    const manifest = await loadManifest(target);
    expect(manifest?.layout.entries.some((entry) => entry.path.startsWith(".assay/project"))).toBe(
      false,
    );
    expect(manifest?.layout.entries.some((entry) => entry.path.startsWith("project/"))).toBe(false);
    const receipt = await loadManagedFiles(target);
    expect(receipt.files.every((entry) => !entry.path.startsWith(".assay/knowledge"))).toBe(true);
    expect(await readFile(ordinary, "utf8")).toBe("ordinary-user-bytes: true\n");
    expect(await readFile(path.join(target, "systems", "legacy", "system.yaml"), "utf8")).toBe(
      "ordinary-user-bytes: true\n",
    );
    expect((await loadSystemsRegistry(target))?.systems.legacy?.path).toBe("systems/legacy");
    expect(converted.overlayStateRemoved).toBe(false);
    expect((await checkFramework({ root: target })).ok).toBe(true);
  });

  it("keeps automatic events internal and read commands event-free", async () => {
    expect("appendEvent" in publicCore).toBe(false);
    expect("eventPath" in publicCore).toBe(false);
    expect("captureEvent" in publicCore).toBe(false);
    const root = await tempRoot("events");
    await initFramework({ target: root, agents: false });
    const eventsDir = path.join(root, ".assay", "events");
    const [file] = await readdir(eventsDir);
    const eventFile = path.join(eventsDir, file as string);
    const before = await readFile(eventFile, "utf8");
    await getFrameworkStatus({ root });
    await checkFramework({ root });
    expect(await readFile(eventFile, "utf8")).toBe(before);
  });
});
