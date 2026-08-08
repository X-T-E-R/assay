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

describe("0.13 control-plane cleanup", () => {
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
      framework_version: "0.13.0",
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
      required: "0.13.0+s4+l8",
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
    await trackWorkspace({ root: two, indexRoot });
    expect(
      (await listWorkspaces({ indexRoot })).filter((item) => item.status === "current"),
    ).toHaveLength(2);
    await trackWorkspace({ root: three, rebind: one, indexRoot });
    const listed = await listWorkspaces({ indexRoot });
    expect(listed.map((item) => item.record?.path).sort()).toEqual([two, three].sort());
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
    await trackWorkspace({ root: stale, indexRoot });
    const staleRecord = path.join(indexRoot, workspaceRecordFilename(stale));
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
    await trackWorkspace({ root, indexRoot });
    const outside = path.join(parent, "outside-state");
    await rename(path.join(root, ".assay"), outside);
    await symlink(outside, path.join(root, ".assay"), "junction");
    const recordFile = path.join(indexRoot, workspaceRecordFilename(root));
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
