import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempDirectoryFixture, pathExists } from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  applyUpdate,
  attachExistingRepo,
  checkFramework,
  convertOverlayToStandalone,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  loadSystemsRegistry,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-removed-capability-intent");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function tree(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      result.push(`${entry.isDirectory() ? "d" : "f"}:${relative}`);
      if (entry.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  return result.sort();
}

describe("capability and native Intent removal", () => {
  it("writes the closed 0.11.0+s3+l7 envelope without capability or built-in plugin state", async () => {
    const root = path.join(await tempDirs.createTempDir(), "fresh");
    await initFramework({ target: root, name: "Fresh" });
    await applyUpdate({ root, dryRun: false });

    const manifestText = await readFile(path.join(root, ".assay", "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      __schema: 3,
      framework_version: "0.11.0",
      minimum_assay_version: "0.11.0",
      layout_version: 7,
    });
    expect((manifest.project as Record<string, unknown>).capabilities).toBeUndefined();
    expect(manifest.plugins).toBeUndefined();
    expect(await pathExists(path.join(root, ".assay", "plugins.json"))).toBe(false);
    expect(await pathExists(path.join(root, "intent"))).toBe(false);
  });

  it("rejects any custom archetype modules key before the first workspace write", async () => {
    for (const declaration of [
      "modules: []",
      "Modules: []",
      "MODULES: []",
      "modules: &retired []",
      "MODULES: *retired",
    ]) {
      const root = path.join(await tempDirs.createTempDir(), declaration.replace(/[^a-z]+/gi, "-"));
      const archetypeDir = path.join(root, ".assay", "archetypes");
      await mkdir(archetypeDir, { recursive: true });
      const prefix = declaration.includes("*retired") ? "retired: &retired []\n" : "";
      await writeFile(
        path.join(archetypeDir, "retired.yaml"),
        `${prefix}extends: base\nmode: learning\n${declaration}\ndirs: []\ntemplates: []\n`,
        "utf8",
      );
      const before = await tree(root);
      await expect(
        initFramework({ target: root, name: "NoWrite", archetype: "retired" }),
      ).rejects.toMatchObject({ code: "RETIRED_ARCHETYPE_FIELD" });
      expect(await tree(root)).toEqual(before);
    }
  });

  it("rejects a retired modules key before update writes", async () => {
    const root = path.join(await tempDirs.createTempDir(), "existing-custom");
    await initFramework({ target: root, name: "Existing" });
    const archetypePath = path.join(root, ".assay", "archetypes", "study.yaml");
    await mkdir(path.dirname(archetypePath), { recursive: true });
    await writeFile(
      archetypePath,
      "extends: base\nmode: learning\nmodules: []\ndirs: []\ntemplates: []\n",
      "utf8",
    );
    const before = await tree(root);
    const beforeManifest = await readFile(path.join(root, ".assay", "manifest.json"), "utf8");

    await expect(applyUpdate({ root, dryRun: false })).rejects.toThrow(
      /retired archetype key 'modules'/,
    );
    expect(await tree(root)).toEqual(before);
    expect(await readFile(path.join(root, ".assay", "manifest.json"), "utf8")).toBe(beforeManifest);
  });

  it("treats manually created intent directories as generic undeclared content", async () => {
    const root = path.join(await tempDirs.createTempDir(), "manual-intent");
    await initFramework({ target: root, name: "Manual" });
    await mkdir(path.join(root, "intent", "original"), { recursive: true });
    await writeFile(path.join(root, "intent", "original", "record.md"), "not native\n", "utf8");

    const status = await getFrameworkStatus({ root });
    expect(status.zones.map((zone) => zone.path)).not.toContain("intent");
    const check = await checkFramework({ root, includeAdvisories: true });
    expect(check.rows).toContainEqual(
      expect.objectContaining({ path: "intent", status: "warning" }),
    );
  });

  it("rejects systems registry schema 1 and the retired field instead of ignoring them", async () => {
    const root = path.join(await tempDirs.createTempDir(), "registry");
    await initFramework({ target: root, name: "Registry" });
    const registryPath = path.join(root, ".assay", "systems-registry.json");
    await writeFile(
      registryPath,
      `${JSON.stringify({
        __schema: 1,
        primary: "app",
        systems: {
          app: {
            name: "app",
            path: "systems/app",
            status: "primary",
            vcs: "embedded",
            vcs_ref: "",
            version: "0.1.0",
            contract_file: null,
            supersedes: [],
            absorbed_on: null,
            archived_on: null,
            archive_path: null,
            intent_authority: { mode: "inline" },
          },
        },
        updated_at: "2026-08-08T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/systems registry failed validation/);

    const current = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;
    current.__schema = 2;
    await writeFile(registryPath, `${JSON.stringify(current)}\n`, "utf8");
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/systems registry failed validation/);
  });

  it("does not copy, move, or rewrite unknown overlay intent residue during conversion", async () => {
    const source = path.join(await tempDirs.createTempDir(), "overlay-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "package.json"), '{"name":"product"}\n', "utf8");
    await execa("git", ["init"], { cwd: source });
    await execa("git", ["config", "user.email", "assay@example.test"], { cwd: source });
    await execa("git", ["config", "user.name", "Assay Test"], { cwd: source });
    await execa("git", ["add", "package.json"], { cwd: source });
    await execa("git", ["commit", "-m", "initial"], { cwd: source });
    await attachExistingRepo({ root: source, name: "Overlay", privacy: "private", noTrack: true });
    expect((await loadManifest(source))?.plugins).toBeUndefined();
    expect(await pathExists(path.join(source, ".assay", "plugins.json"))).toBe(false);
    expect(await pathExists(path.join(source, ".assay", "intent"))).toBe(false);
    await mkdir(path.join(source, ".assay", "intent"), { recursive: true });
    await writeFile(path.join(source, ".assay", "intent", "unknown.md"), "preserve me\n", "utf8");
    const target = path.join(await tempDirs.createTempDir(), "standalone-target");

    await expect(
      convertOverlayToStandalone({
        root: source,
        target,
        move: true,
        keepOverlay: false,
      }),
    ).rejects.toThrow(/unknown state/);
    expect(await pathExists(target)).toBe(false);
    expect(await pathExists(path.join(target, "intent"))).toBe(false);
    expect(await readFile(path.join(source, ".assay", "intent", "unknown.md"), "utf8")).toBe(
      "preserve me\n",
    );
  }, 30_000);

  it("copies current external plugin state while leaving retired runtime and receipt residuals untouched", async () => {
    const source = path.join(await tempDirs.createTempDir(), "copy-residual-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "package.json"), '{"name":"product"}\n', "utf8");
    await execa("git", ["init"], { cwd: source });
    await execa("git", ["config", "user.email", "assay@example.test"], { cwd: source });
    await execa("git", ["config", "user.name", "Assay Test"], { cwd: source });
    await execa("git", ["add", "package.json"], { cwd: source });
    await execa("git", ["commit", "-m", "initial"], { cwd: source });
    await attachExistingRepo({ root: source, name: "CopyResidual", noTrack: true });

    const runtimeSentinel = path.join(source, ".assay", "trellis", "sentinel.txt");
    const retiredReceipt = path.join(source, ".assay", "plugins.json");
    const externalState = path.join(source, ".assay", "external-plugins.json");
    await mkdir(path.dirname(runtimeSentinel), { recursive: true });
    await writeFile(runtimeSentinel, "retired runtime\n", "utf8");
    await writeFile(retiredReceipt, "{retired receipt bytes", "utf8");
    await writeFile(
      externalState,
      '{"__schema":1,"plugins":{},"updated_at":"2026-08-08T00:00:00.000Z"}\n',
      "utf8",
    );

    const target = path.join(await tempDirs.createTempDir(), "copy-residual-target");
    await convertOverlayToStandalone({ root: source, target });

    expect(await readFile(runtimeSentinel, "utf8")).toBe("retired runtime\n");
    expect(await readFile(retiredReceipt, "utf8")).toBe("{retired receipt bytes");
    expect(await pathExists(path.join(target, ".assay", "trellis"))).toBe(false);
    expect(await pathExists(path.join(target, ".assay", "plugins.json"))).toBe(false);
    expect(await readFile(path.join(target, ".assay", "external-plugins.json"), "utf8")).toBe(
      await readFile(externalState, "utf8"),
    );
  }, 30_000);

  it("fails a destructive move on a redirected retired residual without following or deleting it", async () => {
    const source = path.join(await tempDirs.createTempDir(), "redirect-residual-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "package.json"), '{"name":"product"}\n', "utf8");
    await execa("git", ["init"], { cwd: source });
    await execa("git", ["config", "user.email", "assay@example.test"], { cwd: source });
    await execa("git", ["config", "user.name", "Assay Test"], { cwd: source });
    await execa("git", ["add", "package.json"], { cwd: source });
    await execa("git", ["commit", "-m", "initial"], { cwd: source });
    await attachExistingRepo({ root: source, name: "RedirectResidual", noTrack: true });

    const outside = path.join(await tempDirs.createTempDir(), "outside-retired-runtime");
    await mkdir(outside, { recursive: true });
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "outside bytes\n", "utf8");
    const redirect = path.join(source, ".assay", "trellis");
    await symlink(outside, redirect, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(await tempDirs.createTempDir(), "redirect-residual-target");

    await expect(
      convertOverlayToStandalone({ root: source, target, move: true, keepOverlay: false }),
    ).rejects.toThrow(/unknown state/);
    expect(await pathExists(target)).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("outside bytes\n");
    expect(await pathExists(redirect)).toBe(true);
  }, 30_000);
});
