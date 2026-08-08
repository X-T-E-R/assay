import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setAuthorityReadProbeForTests } from "../src/authority-file-write.js";
import {
  InvalidManifestError,
  WorkspaceCutoverRequiredError,
  addKnowledge,
  addSource,
  analyzeUpdate,
  applyUpdate,
  attachExistingRepo,
  convertOverlayToStandalone,
  defaultManifest,
  discoverFrameworkRoot,
  getFrameworkStatus,
  initFramework,
  loadArchetype,
  loadExternalPluginsState,
  loadManifest,
  loadSystemsRegistry,
  manifestPath,
  saveManifest,
  setManifestSaveProbeForTests,
} from "../src/index.js";
import { frameworkProjectSchema } from "../src/schemas/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-manifest-current-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  setAuthorityReadProbeForTests(undefined);
  setManifestSaveProbeForTests(undefined);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeManifestJson(root: string, manifest: unknown, stateRoot = ".assay") {
  const file = path.join(root, stateRoot, "manifest.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file).replaceAll("\\", "/"));
      if (entry.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function layout4Manifest() {
  const current = defaultManifest("Old workspace") as unknown as Record<string, unknown>;
  current.__schema = 2;
  current.framework_version = "0.6.0";
  current.minimum_assay_version = "0.6.0";
  current.layout_version = 4;
  const layout = current.layout as Record<string, unknown>;
  layout.version = 4;
  layout.paths = {
    ...(layout.paths as Record<string, unknown>),
    adrs_index: ".assay/adrs.json",
  };
  return current;
}

describe("manifest 0.11 envelope", () => {
  it("writes and loads exactly schema 3 and layout 7 without a retired work path", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Current");
    expect(manifest).toMatchObject({
      __schema: 3,
      framework_version: "0.11.0",
      minimum_assay_version: "0.11.0",
      layout_version: 7,
      layout: { version: 7 },
    });
    expect(manifest.layout.paths).not.toHaveProperty("adrs_index");
    expect(manifest.layout.paths).not.toHaveProperty("iterations");
    await saveManifest(root, manifest);
    await expect(loadManifest(root)).resolves.toMatchObject({ framework_version: "0.11.0" });
  });

  it("rejects the exact 0.10.0+s3+l7 envelope before external or retired plugin state is read", async () => {
    const root = await tempDir();
    const old = defaultManifest("Previous release") as unknown as Record<string, unknown>;
    old.framework_version = "0.10.0";
    old.minimum_assay_version = "0.10.0";
    await writeManifestJson(root, old);
    await writeFile(path.join(root, ".assay", "external-plugins.json"), "{malformed", "utf8");
    await writeFile(path.join(root, ".assay", "plugins.json"), "{malformed", "utf8");
    const before = await treeHash(root);

    await expect(loadExternalPluginsState(root)).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.10.0+s3+l7",
      required: "0.11.0+s3+l7",
      locator: "assay-cutover:0.10.0+s3+l7->0.11.0+s3+l7",
    });
    expect(await treeHash(root)).toBe(before);
  });

  it("retains optional generic plugin declarations and bindings without creating built-in state", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Generic metadata");
    manifest.plugins = { "example.provider": { kind: "external-provider" } };
    manifest.bindings = {
      "example.responsibility": {
        provider: "example.provider",
        target: { kind: "workspace" },
      },
    };

    await saveManifest(root, manifest);

    await expect(loadManifest(root)).resolves.toMatchObject({
      plugins: { "example.provider": { kind: "external-provider" } },
      bindings: {
        "example.responsibility": {
          provider: "example.provider",
          target: { kind: "workspace" },
        },
      },
    });
    await expect(readFile(path.join(root, ".assay", "plugins.json"), "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("validates existing manifest bytes before overwrite and preserves invalid authorities", async () => {
    const root = await tempDir();
    const file = manifestPath(root);
    const replacement = defaultManifest("Replacement");
    const retired = defaultManifest("Retired") as unknown as Record<string, unknown>;
    retired.__schema = 2;
    retired.framework_version = "0.8.0";
    retired.minimum_assay_version = "0.8.0";

    for (const raw of [`${JSON.stringify(retired)}\n`, "{malformed\n"]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, raw, "utf8");
      await expect(saveManifest(root, replacement)).rejects.toBeInstanceOf(
        raw.startsWith("{") && !raw.startsWith('{"')
          ? InvalidManifestError
          : WorkspaceCutoverRequiredError,
      );
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });

  it("keeps current-to-current saves working without mutating the caller's object", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Current save");
    const callerUpdatedAt = manifest.updated_at;
    const first = await saveManifest(root, manifest);
    expect(manifest.updated_at).toBe(callerUpdatedAt);

    const nextInput = { ...first, project: { ...first.project, name: "Updated current" } };
    const nextInputUpdatedAt = nextInput.updated_at;
    const second = await saveManifest(root, nextInput);
    expect(nextInput.updated_at).toBe(nextInputUpdatedAt);
    expect(second.project.name).toBe("Updated current");
    await expect(loadManifest(root)).resolves.toMatchObject({
      project: { name: "Updated current" },
    });
  });

  it("rejects a redirected manifest authority without changing its target bytes", async () => {
    const root = await tempDir();
    const authority = path.join(root, "redirected-authority");
    const file = path.join(authority, "manifest.json");
    await mkdir(authority, { recursive: true });
    const raw = `${JSON.stringify(defaultManifest("Redirected"), null, 2)}\n`;
    await writeFile(file, raw, "utf8");
    await symlink(authority, path.join(root, ".assay"), "junction");

    await expect(saveManifest(root, defaultManifest("Replacement"))).rejects.toThrow(/redirect/);
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("rejects an empty redirected .assay parent on first create without touching its sentinel", async () => {
    const root = await tempDir();
    const authority = path.join(root, "empty-redirected-authority");
    await mkdir(authority, { recursive: true });
    const sentinel = path.join(authority, "sentinel.txt");
    await writeFile(sentinel, "outside\n", "utf8");
    await symlink(authority, path.join(root, ".assay"), "junction");

    await expect(saveManifest(root, defaultManifest("No redirect create"))).rejects.toThrow(
      /redirect/,
    );
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
    expect((await readdir(authority)).sort()).toEqual(["sentinel.txt"]);
  });

  it("detects a validated parent swap before staging and leaves both authorities untouched", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Parent swap"));
    const originalRaw = await readFile(manifestPath(root), "utf8");
    const preservedParent = path.join(root, ".assay-preserved");
    const outside = path.join(root, "outside-parent");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "sentinel.txt"), "outside\n", "utf8");
    let swapped = false;
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-validation" || swapped) return;
      swapped = true;
      await rename(path.join(root, ".assay"), preservedParent);
      await symlink(outside, path.join(root, ".assay"), "junction");
    });

    await expect(
      saveManifest(root, { ...current, project: { ...current.project, name: "Must not land" } }),
    ).rejects.toThrow(/parent.*(?:identity|redirect)/);
    expect(await readFile(path.join(preservedParent, "manifest.json"), "utf8")).toBe(originalRaw);
    expect((await readdir(outside)).sort()).toEqual(["sentinel.txt"]);
  });

  it("detects a validated file identity swap and preserves both byte sequences", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("File swap"));
    const file = manifestPath(root);
    const originalRaw = await readFile(file, "utf8");
    const displaced = path.join(root, ".assay", "manifest.displaced.json");
    const competitor = defaultManifest("Concurrent winner");
    const competitorRaw = `${JSON.stringify(competitor)}\n`;
    let swapped = false;
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-stage" || swapped) return;
      swapped = true;
      await rename(file, displaced);
      await writeFile(file, competitorRaw, "utf8");
    });

    await expect(saveManifest(root, current)).rejects.toThrow(/final move CAS/);
    expect(await readFile(displaced, "utf8")).toBe(originalRaw);
    expect(await readFile(file, "utf8")).toBe(competitorRaw);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses no-overwrite first commit and recovers its governed stage around an absent-target winner", async () => {
    const root = await tempDir();
    const file = manifestPath(root);
    const competitorRaw = `${JSON.stringify(defaultManifest("Concurrent first writer"))}\n`;
    let raced = false;
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-stage" || raced) return;
      raced = true;
      await writeFile(file, competitorRaw, "utf8");
    });

    await expect(saveManifest(root, defaultManifest("Losing first writer"))).rejects.toThrow(
      /concurrently created/,
    );
    expect(await readFile(file, "utf8")).toBe(competitorRaw);
    await expect(loadManifest(root)).resolves.toMatchObject({
      project: { name: "Concurrent first writer" },
    });
    expect((await readdir(path.dirname(file))).sort()).toEqual(["manifest.json"]);
  });

  it("recovers a durable staged transaction after simulated process death", async () => {
    const root = await tempDir();
    setManifestSaveProbeForTests((phase) => {
      if (phase === "after-stage") throw new Error("deterministic stage failure");
    });

    await expect(saveManifest(root, defaultManifest("Stage cleanup"))).rejects.toThrow(
      /deterministic stage failure/,
    );
    expect(await readdir(path.join(root, ".assay"))).toEqual([".authority-manifest.json.txn"]);
    await expect(loadManifest(root)).resolves.toMatchObject({ project: { name: "Stage cleanup" } });
    expect(await readdir(path.join(root, ".assay"))).toEqual(["manifest.json"]);
  });

  it.each([
    ["after-txn-durable", "old"],
    ["after-stage", "old"],
    ["after-old-moved", "new"],
    ["after-new-installed", "new"],
    ["before-cleanup", "new"],
  ] as const)(
    "recovers a governed current-file transaction after process death at %s",
    async (faultPhase, expectedVersion) => {
      const root = await tempDir();
      const current = await saveManifest(root, defaultManifest("Old authority"));
      const replacement = {
        ...current,
        project: { ...current.project, name: "New authority" },
      };
      setManifestSaveProbeForTests((phase) => {
        if (phase === faultPhase) throw new Error(`simulated death at ${faultPhase}`);
      });

      await expect(saveManifest(root, replacement)).rejects.toThrow(
        `simulated death at ${faultPhase}`,
      );
      const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
      expect(await readdir(transaction)).toContain("owner.json");
      setManifestSaveProbeForTests(undefined);

      await expect(loadManifest(root)).resolves.toMatchObject({
        project: { name: expectedVersion === "old" ? "Old authority" : "New authority" },
      });
      expect((await lstat(manifestPath(root))).nlink).toBe(1);
      expect((await readdir(path.join(root, ".assay"))).sort()).toEqual(["manifest.json"]);
    },
  );

  it("never cleans through a parent swapped to an outside junction after staging", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Parent swap after stage"));
    const ownedParent = path.join(root, ".assay-owned");
    const outside = path.join(root, "outside-after-stage");
    const assayParent = path.join(root, ".assay");
    let outsideStage = "";
    setManifestSaveProbeForTests(async (phase, context) => {
      if (phase !== "after-stage") return;
      await rename(assayParent, ownedParent);
      const relativeStage = path.relative(assayParent, context.stage ?? "missing-stage");
      outsideStage = path.join(outside, relativeStage);
      await mkdir(path.dirname(outsideStage), { recursive: true });
      await writeFile(path.join(outside, "manifest.json"), "outside target sentinel\n", "utf8");
      await writeFile(outsideStage, "outside stage sentinel\n", "utf8");
      await symlink(outside, assayParent, "junction");
    });

    await expect(
      saveManifest(root, { ...current, project: { ...current.project, name: "Never outside" } }),
    ).rejects.toMatchObject({ code: "AUTHORITY_REPAIR_REQUIRED" });
    expect(await readFile(path.join(outside, "manifest.json"), "utf8")).toBe(
      "outside target sentinel\n",
    );
    expect(await readFile(outsideStage, "utf8")).toBe("outside stage sentinel\n");
    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);

    setManifestSaveProbeForTests(undefined);
    await unlink(assayParent);
    await rename(ownedParent, assayParent);
    await expect(loadManifest(root)).resolves.toMatchObject({
      project: { name: "Parent swap after stage" },
    });
    expect((await readdir(assayParent)).sort()).toEqual(["manifest.json"]);
  });

  it.each(["after-txn-durable", "after-stage"] as const)(
    "rejects a transaction-directory junction swap at %s without touching outside or target bytes",
    async (faultPhase) => {
      const root = await tempDir();
      const current = await saveManifest(root, defaultManifest(`Txn swap ${faultPhase}`));
      const file = manifestPath(root);
      const canonicalRaw = await readFile(file, "utf8");
      const preserved = path.join(root, `.txn-preserved-${faultPhase}`);
      const outside = path.join(root, `.txn-outside-${faultPhase}`);
      let transaction = "";
      let outsideStage = "";
      setManifestSaveProbeForTests(async (phase, context) => {
        if (phase !== faultPhase) return;
        transaction = context.transaction ?? "missing-transaction";
        await rename(transaction, preserved);
        await mkdir(outside, { recursive: true });
        outsideStage = path.join(outside, path.basename(context.stage ?? "missing-stage"));
        await writeFile(path.join(outside, "owner.json"), "outside owner sentinel\n", "utf8");
        await writeFile(outsideStage, "outside stage sentinel\n", "utf8");
        await symlink(outside, transaction, "junction");
      });

      await expect(
        saveManifest(root, {
          ...current,
          project: { ...current.project, name: "Must not install after txn swap" },
        }),
      ).rejects.toMatchObject({ code: "AUTHORITY_REPAIR_REQUIRED" });
      expect(await readFile(file, "utf8")).toBe(canonicalRaw);
      expect(await readFile(path.join(outside, "owner.json"), "utf8")).toBe(
        "outside owner sentinel\n",
      );
      expect(await readFile(outsideStage, "utf8")).toBe("outside stage sentinel\n");

      setManifestSaveProbeForTests(undefined);
      await unlink(transaction);
      await rename(preserved, transaction);
      await expect(loadManifest(root)).resolves.toMatchObject({
        project: { name: `Txn swap ${faultPhase}` },
      });
      expect((await readdir(path.dirname(file))).sort()).toEqual(["manifest.json"]);
    },
  );

  it("rejects a recovery-time transaction swap before any outside read or cleanup", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Recovery txn swap"));
    setManifestSaveProbeForTests((phase) => {
      if (phase === "after-stage") throw new Error("leave governed txn for recovery");
    });
    await expect(saveManifest(root, current)).rejects.toThrow(/leave governed txn/);

    const file = manifestPath(root);
    const canonicalRaw = await readFile(file, "utf8");
    const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
    const preserved = path.join(root, ".txn-recovery-preserved");
    const outside = path.join(root, ".txn-recovery-outside");
    let outsideStage = "";
    setManifestSaveProbeForTests(async (phase, context) => {
      if (phase !== "recovery-after-owner") return;
      await rename(transaction, preserved);
      await mkdir(outside, { recursive: true });
      outsideStage = path.join(outside, path.basename(context.stage ?? "missing-stage"));
      await writeFile(path.join(outside, "owner.json"), "outside recovery owner\n", "utf8");
      await writeFile(outsideStage, "outside recovery stage\n", "utf8");
      await symlink(outside, transaction, "junction");
    });

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
    expect(await readFile(file, "utf8")).toBe(canonicalRaw);
    expect(await readFile(path.join(outside, "owner.json"), "utf8")).toBe(
      "outside recovery owner\n",
    );
    expect(await readFile(outsideStage, "utf8")).toBe("outside recovery stage\n");

    setManifestSaveProbeForTests(undefined);
    await unlink(transaction);
    await rename(preserved, transaction);
    await expect(loadManifest(root)).resolves.toMatchObject({
      project: { name: "Recovery txn swap" },
    });
    expect((await readdir(path.dirname(file))).sort()).toEqual(["manifest.json"]);
  });

  it("serializes first-create writers and gives exactly one writer authority", async () => {
    const root = await tempDir();
    let reached!: () => void;
    let release!: () => void;
    const atDurableOwner = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const continueFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-txn-durable") return;
      reached();
      await continueFirst;
    });

    const first = saveManifest(root, defaultManifest("First writer"));
    await atDurableOwner;
    await expect(saveManifest(root, defaultManifest("Second writer"))).rejects.toMatchObject({
      code: "AUTHORITY_WRITE_CONFLICT",
    });
    release();
    await first;
    setManifestSaveProbeForTests(undefined);
    await expect(loadManifest(root)).resolves.toMatchObject({
      project: { name: "First writer" },
    });
    expect((await readdir(path.join(root, ".assay"))).sort()).toEqual(["manifest.json"]);
  });

  it("fails closed on an ABA target replacement without deleting either version", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("ABA"));
    const file = manifestPath(root);
    const raw = await readFile(file, "utf8");
    const displaced = path.join(root, ".assay", "manifest.aba-original.json");
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-stage") return;
      await rename(file, displaced);
      await writeFile(file, raw, "utf8");
    });

    await expect(saveManifest(root, current)).rejects.toMatchObject({
      code: "AUTHORITY_WRITE_CONFLICT",
    });
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readFile(displaced, "utf8")).toBe(raw);
    setManifestSaveProbeForTests(undefined);
    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
  });

  it("fails closed on an unknown transaction receipt without reading or changing canonical bytes", async () => {
    const root = await tempDir();
    await saveManifest(root, defaultManifest("Unknown receipt"));
    const file = manifestPath(root);
    const raw = await readFile(file, "utf8");
    const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
    await mkdir(transaction);
    await writeFile(path.join(transaction, "owner.json"), "{unknown\n", "utf8");

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
    expect(await readFile(file, "utf8")).toBe(raw);
    expect((await readdir(transaction)).sort()).toEqual(["owner.json"]);
  });

  it.each([
    ["oversized", Buffer.alloc(64 * 1024 + 1, 0x61), "RECEIPT_SIZE_LIMIT"],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe, 0xfd]), "RECEIPT_INVALID_UTF8"],
  ] as const)(
    "bounds an %s transaction receipt before parsing and preserves its bytes",
    async (_case, receiptBytes, reason) => {
      const root = await tempDir();
      await saveManifest(root, defaultManifest(`Bounded ${reason}`));
      const file = manifestPath(root);
      const raw = await readFile(file, "utf8");
      const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
      await mkdir(transaction);
      const receipt = path.join(transaction, "owner.json");
      await writeFile(receipt, receiptBytes);

      await expect(loadManifest(root)).rejects.toMatchObject({
        code: "AUTHORITY_REPAIR_REQUIRED",
        details: expect.objectContaining({ reason }),
      });
      expect(await readFile(file, "utf8")).toBe(raw);
      expect(await readFile(receipt)).toEqual(receiptBytes);
    },
  );

  it("rechecks the authority buffer length after a same-inode growth race", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Authority read growth"));
    const file = manifestPath(root);
    let grown = false;
    setAuthorityReadProbeForTests(async (phase, observedFile) => {
      if (phase !== "authority-after-size-stat" || observedFile !== file || grown) return;
      grown = true;
      await appendFile(file, Buffer.alloc(16 * 1024 * 1024, 0x20));
    });

    await expect(saveManifest(root, current)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
      details: expect.objectContaining({
        reason: "AUTHORITY_FILE_SIZE_LIMIT",
        limit: 16 * 1024 * 1024,
      }),
    });
    expect((await readFile(file)).byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect((await readdir(path.dirname(file))).sort()).toEqual(["manifest.json"]);
  });

  it("rechecks receipt buffer length before UTF-8 decode or JSON parse", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Receipt read growth"));
    setManifestSaveProbeForTests((phase) => {
      if (phase === "after-txn-durable") throw new Error("leave owner receipt");
    });
    await expect(saveManifest(root, current)).rejects.toThrow(/leave owner receipt/);
    setManifestSaveProbeForTests(undefined);

    const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
    const owner = path.join(transaction, "owner.json");
    let grown = false;
    setAuthorityReadProbeForTests(async (phase, observedFile) => {
      if (phase !== "receipt-after-size-stat" || observedFile !== owner || grown) return;
      grown = true;
      await appendFile(owner, Buffer.alloc(64 * 1024, 0xff));
    });

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
      details: expect.objectContaining({ reason: "RECEIPT_SIZE_LIMIT", limit: 64 * 1024 }),
    });
    expect((await readFile(owner)).byteLength).toBeGreaterThan(64 * 1024);
    expect((await readdir(transaction)).sort()).toEqual(["owner.json"]);
  });

  it("caps transaction directory enumeration before inspecting an unbounded entry set", async () => {
    const root = await tempDir();
    await saveManifest(root, defaultManifest("Bounded entries"));
    const file = manifestPath(root);
    const raw = await readFile(file, "utf8");
    const parent = path.dirname(file);
    const parentInfo = await lstat(parent);
    const fileInfo = await lstat(file);
    const token = "00000000-0000-4000-8000-000000000002";
    const transaction = path.join(parent, ".authority-manifest.json.txn");
    await mkdir(transaction);
    const transactionInfo = await lstat(transaction);
    await writeFile(
      path.join(transaction, "owner.json"),
      `${JSON.stringify({
        __schema: 1,
        token,
        pid: 999999,
        target_basename: "manifest.json",
        parent: { canonical: parent, dev: Number(parentInfo.dev), ino: Number(parentInfo.ino) },
        transaction: {
          canonical: transaction,
          dev: Number(transactionInfo.dev),
          ino: Number(transactionInfo.ino),
        },
        expected: {
          dev: Number(fileInfo.dev),
          ino: Number(fileInfo.ino),
          digest: createHash("sha256").update(raw).digest("hex"),
        },
        replacement_digest: "0".repeat(64),
        stage_basename: `stage-${token}`,
        rollback_basename: `rollback-${token}`,
      })}\n`,
      "utf8",
    );
    for (let index = 0; index < 17; index += 1) {
      await writeFile(path.join(transaction, `unknown-${String(index).padStart(2, "0")}`), "x");
    }

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
      details: expect.objectContaining({ reason: "TRANSACTION_ENTRY_LIMIT", limit: 16 }),
    });
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("accepts a legal long Windows-style workspace path below the canonical path bound", async () => {
    const base = await tempDir();
    const root = path.join(
      base,
      ...Array.from({ length: 10 }, (_, index) => `segment-${index}-abcdefghijklmnop`),
    );
    await mkdir(root, { recursive: true });
    await saveManifest(root, defaultManifest("Long path"));
    await expect(loadManifest(root)).resolves.toMatchObject({ project: { name: "Long path" } });
  });

  it("fails closed on a stale valid owner receipt and preserves canonical bytes", async () => {
    const root = await tempDir();
    await saveManifest(root, defaultManifest("Stale owner"));
    const file = manifestPath(root);
    const raw = await readFile(file, "utf8");
    const parent = path.dirname(file);
    const parentInfo = await lstat(parent);
    const fileInfo = await lstat(file);
    const token = "00000000-0000-4000-8000-000000000001";
    const transaction = path.join(parent, ".authority-manifest.json.txn");
    await mkdir(transaction);
    const transactionInfo = await lstat(transaction);
    await writeFile(
      path.join(transaction, "owner.json"),
      `${JSON.stringify({
        __schema: 1,
        token,
        pid: 999999,
        target_basename: "manifest.json",
        parent: { canonical: parent, dev: Number(parentInfo.dev) + 1, ino: Number(parentInfo.ino) },
        transaction: {
          canonical: transaction,
          dev: Number(transactionInfo.dev),
          ino: Number(transactionInfo.ino),
        },
        expected: {
          dev: Number(fileInfo.dev),
          ino: Number(fileInfo.ino),
          digest: createHash("sha256").update(raw).digest("hex"),
        },
        replacement_digest: "0".repeat(64),
        stage_basename: `stage-${token}`,
        rollback_basename: `rollback-${token}`,
      })}\n`,
      "utf8",
    );

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("preserves an unknown concurrent winner and the governed rollback after old isolation", async () => {
    const root = await tempDir();
    const current = await saveManifest(root, defaultManifest("Governed old"));
    const file = manifestPath(root);
    const oldRaw = await readFile(file, "utf8");
    const winnerRaw = `${JSON.stringify(defaultManifest("Concurrent winner after move"))}\n`;
    setManifestSaveProbeForTests(async (phase) => {
      if (phase !== "after-old-moved") return;
      await writeFile(file, winnerRaw, "utf8");
      throw new Error("winner arrived after old move");
    });

    await expect(
      saveManifest(root, { ...current, project: { ...current.project, name: "Proposed new" } }),
    ).rejects.toThrow(/winner arrived/);
    setManifestSaveProbeForTests(undefined);
    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
    expect(await readFile(file, "utf8")).toBe(winnerRaw);
    const transaction = path.join(root, ".assay", ".authority-manifest.json.txn");
    const rollbackName = (await readdir(transaction)).find((name) => name.startsWith("rollback-"));
    expect(rollbackName).toBeDefined();
    expect(await readFile(path.join(transaction, rollbackName ?? "missing"), "utf8")).toBe(oldRaw);
  });

  it("rejects the exact 0.7 layout-5 envelope before reading retired work", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Retired work") as unknown as Record<string, unknown>;
    manifest.__schema = 2;
    manifest.framework_version = "0.7.0";
    manifest.minimum_assay_version = "0.7.0";
    manifest.layout_version = 5;
    const layout = manifest.layout as Record<string, unknown>;
    layout.version = 5;
    layout.paths = { ...(layout.paths as Record<string, unknown>), iterations: "iterations" };
    await writeManifestJson(root, manifest);
    await mkdir(path.join(root, "iterations", "open"), { recursive: true });
    await writeFile(path.join(root, "iterations", "open", "plan.md"), "not parsed", "utf8");
    const before = await treeHash(root);

    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.7.0+s2+l5",
      required: "0.11.0+s3+l7",
      locator: "assay-cutover:0.7.0+s2+l5->0.11.0+s3+l7",
    });
    await expect(
      convertOverlayToStandalone({ root, target: path.join(root, "target") }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CUTOVER_REQUIRED" });
    expect(await treeHash(root)).toBe(before);
  });

  it("rejects the exact 0.8.0+s2+l6 envelope before capability, Intent, plugin, archetype, or System semantics", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Phase 4 source") as unknown as Record<string, unknown>;
    manifest.__schema = 2;
    manifest.framework_version = "0.8.0";
    manifest.minimum_assay_version = "0.8.0";
    manifest.layout_version = 6;
    (manifest.project as Record<string, unknown>).capabilities = ["intent"];
    await writeManifestJson(root, manifest);
    await mkdir(path.join(root, ".assay", "archetypes"), { recursive: true });
    await writeFile(path.join(root, ".assay", "archetypes", "study.yaml"), "{malformed", "utf8");
    await writeFile(path.join(root, ".assay", "plugins.json"), "{malformed", "utf8");
    await writeFile(path.join(root, ".assay", "systems-registry.json"), "{malformed", "utf8");
    await mkdir(path.join(root, "intent"), { recursive: true });
    await writeFile(path.join(root, "intent", "capture.md"), "{malformed", "utf8");
    const before = await treeHash(root);

    await expect(getFrameworkStatus({ root })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.8.0+s2+l6",
      required: "0.11.0+s3+l7",
      locator: "assay-cutover:0.8.0+s2+l6->0.11.0+s3+l7",
    });
    for (const operation of [
      () => loadArchetype("study", { root }),
      () => loadExternalPluginsState(root),
      () => loadSystemsRegistry(root),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "WORKSPACE_CUTOVER_REQUIRED",
        observed: "0.8.0+s2+l6",
      });
    }
    expect(await treeHash(root)).toBe(before);
  });

  it.each([
    ["healthy", '{"__schema":1,"next_number":2,"adrs":{},"updated_at":"x"}'],
    ["malformed", "{"],
    ["missing", null],
  ])("rejects a layout 4 workspace before reading its retired index (%s)", async (_case, index) => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest());
    if (index !== null) await writeFile(path.join(root, ".assay", "adrs.json"), index, "utf8");
    const before = await treeHash(root);
    await expect(loadManifest(root)).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.6.0+s2+l4",
      required: "0.11.0+s3+l7",
      locator: "assay-cutover:0.6.0+s2+l4->0.11.0+s3+l7",
    });
    expect(await treeHash(root)).toBe(before);
  });

  it("rejects .framework through the same non-executable cutover locator", async () => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest(), ".framework");
    await expect(loadManifest(root)).rejects.toBeInstanceOf(WorkspaceCutoverRequiredError);
    await expect(loadManifest(root)).rejects.toMatchObject({
      locator: "assay-cutover:.framework:0.6.0+s2+l4->0.11.0+s3+l7",
    });
    const before = await readFile(path.join(root, ".framework", "manifest.json"), "utf8");
    await expect(saveManifest(root, defaultManifest("No overwrite"))).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
    });
    expect(await readFile(path.join(root, ".framework", "manifest.json"), "utf8")).toBe(before);
    await expect(readFile(manifestPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports malformed current JSON precisely without legacy parsing", async () => {
    const root = await tempDir();
    await mkdir(path.dirname(manifestPath(root)), { recursive: true });
    await writeFile(manifestPath(root), "{", "utf8");
    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
  });

  it("keeps current project schema extensible only through current fields", () => {
    expect(frameworkProjectSchema.parse({ name: "Current" })).toEqual({
      name: "Current",
      archetype: "study",
      mode: "learning",
    });
    expect(() => frameworkProjectSchema.parse({ name: "Old", core: "old-core" })).toThrow();
    expect(() => frameworkProjectSchema.parse({ name: "Old", capabilities: ["intent"] })).toThrow();
  });

  it.each([
    ["escape", "knowledge", "../outside"],
    ["dot alias", "references", "./references"],
    ["duplicate", "analyses", "references"],
    ["managed escape", "systems_contracts", ".assay/../systems"],
  ])("rejects a non-canonical layout-6 path before use (%s)", async (_case, key, value) => {
    const root = await tempDir();
    const manifest = defaultManifest("Unsafe layout");
    (manifest.layout.paths as Record<string, string>)[key] = value;
    await writeManifestJson(root, manifest);
    const before = await treeHash(root);

    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(root)).toBe(before);
  });

  it("fails knowledge, source, and update before an unsafe layout can write", async () => {
    const root = await tempDir();
    const manifest = defaultManifest("Unsafe operations");
    manifest.layout.paths.knowledge = "../outside";
    await writeManifestJson(root, manifest);
    const before = await treeHash(root);

    await expect(addKnowledge({ root, type: "pattern", title: "Blocked" })).rejects.toBeInstanceOf(
      InvalidManifestError,
    );
    await expect(addSource({ root, source: path.join(root, "source") })).rejects.toBeInstanceOf(
      InvalidManifestError,
    );
    await expect(applyUpdate({ root, dryRun: false })).rejects.toBeInstanceOf(InvalidManifestError);
    await expect(analyzeUpdate({ root })).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(root)).toBe(before);
  });

  it("fails conversion before an unsafe overlay layout writes either tree", async () => {
    const container = await tempDir();
    const root = path.join(container, "overlay");
    const target = path.join(container, "target");
    const manifest = defaultManifest("Unsafe overlay");
    manifest.layout = {
      ...manifest.layout,
      mode: "overlay",
      work_root: ".assay",
      privacy: "private",
      paths: {
        ...manifest.layout.paths,
        sources: "../outside",
        analyses: ".assay/analyses",
        knowledge: ".assay/knowledge",
        systems_contracts: ".assay/systems",
      },
    };
    await writeManifestJson(root, manifest);
    const before = await treeHash(container);

    await expect(
      convertOverlayToStandalone({ root, target, move: false, keepOverlay: true }),
    ).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await treeHash(container)).toBe(before);
  });

  it("blocks creation and conversion entries below a retired ancestor without writes", async () => {
    const root = await tempDir();
    await writeManifestJson(root, layout4Manifest(), ".framework");
    const nested = path.join(root, "systems", "nested-product");
    await mkdir(nested, { recursive: true });
    const targetContainer = await tempDir();
    const target = path.join(targetContainer, "converted");
    const beforeRoot = await treeHash(root);
    const beforeTarget = await treeHash(targetContainer);

    const discovered = await discoverFrameworkRoot(nested);
    expect(discovered).toBe(root);
    await expect(getFrameworkStatus({ root: discovered })).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
    });
    expect(await treeHash(root)).toBe(beforeRoot);

    for (const operation of [
      () => initFramework({ target: nested, name: "Nested" }),
      () => attachExistingRepo({ root: nested, name: "Nested", noTrack: true }),
      () => applyUpdate({ root: nested, dryRun: true }),
      () => convertOverlayToStandalone({ root: nested, target, move: false }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "WORKSPACE_CUTOVER_REQUIRED" });
      expect(await treeHash(root)).toBe(beforeRoot);
      expect(await treeHash(targetContainer)).toBe(beforeTarget);
    }
  });
});
