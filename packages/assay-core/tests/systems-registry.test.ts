import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
  archiveSystem,
  checkFramework,
  defaultManifest,
  defaultSystemsRegistry,
  findSystem,
  initFramework,
  listSystems,
  loadSystemsRegistry,
  promoteSystem,
  registerSystem,
  saveSystemsRegistry,
  setSystemsRegistrySaveProbeForTests,
  systemsRegistryPath,
  updateSystem,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-registry-"));
  tempRoots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  setSystemsRegistrySaveProbeForTests(undefined);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("defaultSystemsRegistry", () => {
  it("starts empty with schema 2 and null primary", () => {
    const registry = defaultSystemsRegistry();
    expect(registry.__schema).toBe(2);
    expect(registry.primary).toBeNull();
    expect(registry.systems).toEqual({});
  });
});

describe("saveSystemsRegistry / loadSystemsRegistry", () => {
  it("round-trips a registry with one system", async () => {
    const root = await tempDir();
    const registry = defaultSystemsRegistry();
    registry.systems.alpha = {
      name: "alpha",
      path: "systems/alpha",
      status: "primary",
      vcs: "independent-git",
      vcs_ref: "main",
      version: "0.1.0",
      contract_file: "systems/alpha/system.yaml",
      supersedes: [],
      absorbed_on: "2026-06-17",
      archived_on: null,
      archive_path: null,
    };
    registry.primary = "alpha";

    await saveSystemsRegistry(root, registry);
    expect(await exists(systemsRegistryPath(root))).toBe(true);

    const loaded = await loadSystemsRegistry(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.primary).toBe("alpha");
    expect(loaded?.systems.alpha?.vcs).toBe("independent-git");

    const updated = await saveSystemsRegistry(root, { ...registry, primary: null });
    expect(updated.primary).toBeNull();
    expect((await loadSystemsRegistry(root))?.primary).toBeNull();
  });

  it("validates existing registry bytes and preserves old, malformed, or retired state", async () => {
    const root = path.join(await tempDir(), "workspace");
    await initFramework({ target: root, name: "Registry writer" });
    const file = systemsRegistryPath(root);
    const currentWithRetiredField = {
      __schema: 2,
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
    };
    const old = { ...currentWithRetiredField, __schema: 1 };

    for (const raw of [
      `${JSON.stringify(old)}\n`,
      "{malformed\n",
      `${JSON.stringify(currentWithRetiredField)}\n`,
    ]) {
      await writeFile(file, raw, "utf8");
      await expect(saveSystemsRegistry(root, defaultSystemsRegistry())).rejects.toThrow(
        /registry.*(?:valid|validation)/,
      );
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });

  it("rejects a redirected existing registry without changing target bytes", async () => {
    const root = await tempDir();
    const authority = path.join(root, "redirected-authority");
    await mkdir(authority, { recursive: true });
    await writeFile(
      path.join(authority, "manifest.json"),
      `${JSON.stringify(defaultManifest())}\n`,
      "utf8",
    );
    const file = path.join(authority, "systems-registry.json");
    const raw = `${JSON.stringify(defaultSystemsRegistry())}\n`;
    await writeFile(file, raw, "utf8");
    await symlink(authority, path.join(root, ".assay"), "junction");

    await expect(saveSystemsRegistry(root, defaultSystemsRegistry())).rejects.toThrow(/redirect/);
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("rejects an empty redirected .assay parent on first registry create", async () => {
    const root = await tempDir();
    const authority = path.join(root, "empty-registry-authority");
    await mkdir(authority, { recursive: true });
    const sentinel = path.join(authority, "sentinel.txt");
    await writeFile(sentinel, "outside\n", "utf8");
    await symlink(authority, path.join(root, ".assay"), "junction");

    await expect(saveSystemsRegistry(root, defaultSystemsRegistry())).rejects.toThrow(/redirect/);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
    expect((await readdir(authority)).sort()).toEqual(["sentinel.txt"]);
  });

  it("detects a validated registry identity swap and preserves both versions", async () => {
    const root = await tempDir();
    const current = await saveSystemsRegistry(root, defaultSystemsRegistry());
    const file = systemsRegistryPath(root);
    const originalRaw = await readFile(file, "utf8");
    const displaced = path.join(root, ".assay", "systems-registry.displaced.json");
    const competitor = { ...defaultSystemsRegistry(), updated_at: "2026-08-08T00:00:00.000Z" };
    const competitorRaw = `${JSON.stringify(competitor)}\n`;
    let swapped = false;
    setSystemsRegistrySaveProbeForTests(async (phase) => {
      if (phase !== "after-validation" || swapped) return;
      swapped = true;
      await rename(file, displaced);
      await writeFile(file, competitorRaw, "utf8");
    });

    await expect(saveSystemsRegistry(root, current)).rejects.toThrow(/changed after validation/);
    expect(await readFile(displaced, "utf8")).toBe(originalRaw);
    expect(await readFile(file, "utf8")).toBe(competitorRaw);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves an absent-target winner and cleans the registry stage", async () => {
    const root = await tempDir();
    const file = systemsRegistryPath(root);
    const competitorRaw = `${JSON.stringify(defaultSystemsRegistry())}\n`;
    let raced = false;
    setSystemsRegistrySaveProbeForTests(async (phase) => {
      if (phase !== "after-stage" || raced) return;
      raced = true;
      await writeFile(file, competitorRaw, "utf8");
    });

    await expect(saveSystemsRegistry(root, defaultSystemsRegistry())).rejects.toThrow(
      /concurrently created/,
    );
    expect(await readFile(file, "utf8")).toBe(competitorRaw);
    await expect(loadSystemsRegistry(root)).resolves.toMatchObject({ __schema: 2 });
    expect((await readdir(path.dirname(file))).sort()).toEqual(["systems-registry.json"]);
  });

  it.each(["after-txn-durable", "after-stage"] as const)(
    "rejects a registry transaction-directory junction swap at %s",
    async (faultPhase) => {
      const root = await tempDir();
      const current = await saveSystemsRegistry(root, defaultSystemsRegistry());
      const file = systemsRegistryPath(root);
      const canonicalRaw = await readFile(file, "utf8");
      const preserved = path.join(root, `.registry-txn-preserved-${faultPhase}`);
      const outside = path.join(root, `.registry-txn-outside-${faultPhase}`);
      let transaction = "";
      let outsideStage = "";
      setSystemsRegistrySaveProbeForTests(async (phase, context) => {
        if (phase !== faultPhase) return;
        transaction = context.transaction ?? "missing-transaction";
        await rename(transaction, preserved);
        await mkdir(outside, { recursive: true });
        outsideStage = path.join(outside, path.basename(context.stage ?? "missing-stage"));
        await writeFile(path.join(outside, "owner.json"), "outside registry owner\n", "utf8");
        await writeFile(outsideStage, "outside registry stage\n", "utf8");
        await symlink(outside, transaction, "junction");
      });

      await expect(saveSystemsRegistry(root, current)).rejects.toMatchObject({
        code: "AUTHORITY_REPAIR_REQUIRED",
      });
      expect(await readFile(file, "utf8")).toBe(canonicalRaw);
      expect(await readFile(path.join(outside, "owner.json"), "utf8")).toBe(
        "outside registry owner\n",
      );
      expect(await readFile(outsideStage, "utf8")).toBe("outside registry stage\n");

      setSystemsRegistrySaveProbeForTests(undefined);
      await unlink(transaction);
      await rename(preserved, transaction);
      await expect(loadSystemsRegistry(root)).resolves.toMatchObject({ __schema: 2 });
      expect((await readdir(path.dirname(file))).sort()).toEqual(["systems-registry.json"]);
    },
  );

  it("rejects a recovery-time registry transaction swap without outside writes", async () => {
    const root = await tempDir();
    const current = await saveSystemsRegistry(root, defaultSystemsRegistry());
    setSystemsRegistrySaveProbeForTests((phase) => {
      if (phase === "after-stage") throw new Error("leave registry txn for recovery");
    });
    await expect(saveSystemsRegistry(root, current)).rejects.toThrow(/leave registry txn/);

    const file = systemsRegistryPath(root);
    const canonicalRaw = await readFile(file, "utf8");
    const transaction = path.join(root, ".assay", ".authority-systems-registry.json.txn");
    const preserved = path.join(root, ".registry-recovery-preserved");
    const outside = path.join(root, ".registry-recovery-outside");
    let outsideStage = "";
    setSystemsRegistrySaveProbeForTests(async (phase, context) => {
      if (phase !== "recovery-after-owner") return;
      await rename(transaction, preserved);
      await mkdir(outside, { recursive: true });
      outsideStage = path.join(outside, path.basename(context.stage ?? "missing-stage"));
      await writeFile(path.join(outside, "owner.json"), "outside registry recovery owner\n");
      await writeFile(outsideStage, "outside registry recovery stage\n");
      await symlink(outside, transaction, "junction");
    });

    await expect(loadSystemsRegistry(root)).rejects.toMatchObject({
      code: "AUTHORITY_REPAIR_REQUIRED",
    });
    expect(await readFile(file, "utf8")).toBe(canonicalRaw);
    expect(await readFile(path.join(outside, "owner.json"), "utf8")).toBe(
      "outside registry recovery owner\n",
    );
    expect(await readFile(outsideStage, "utf8")).toBe("outside registry recovery stage\n");

    setSystemsRegistrySaveProbeForTests(undefined);
    await unlink(transaction);
    await rename(preserved, transaction);
    await expect(loadSystemsRegistry(root)).resolves.toMatchObject({ __schema: 2 });
    expect((await readdir(path.dirname(file))).sort()).toEqual(["systems-registry.json"]);
  });

  it("returns null when no registry file exists", async () => {
    const root = await tempDir();
    expect(await loadSystemsRegistry(root)).toBeNull();
  });
});

describe("registerSystem", () => {
  it("creates a system contract that matches the registry record", async () => {
    const root = path.join(await tempDir(), "workspace");
    await initFramework({ target: root, name: "Contract Project" });
    await mkdir(path.join(root, "systems", "demo-core"), { recursive: true });

    await registerSystem(root, {
      path: "systems/demo-core",
      name: "demo-core",
      primary: true,
      vcs: "independent-git",
      vcsRef: "main",
      version: "0.2.0",
      supersedes: ["old-core"],
    });

    const contractPath = path.join(root, "systems", "demo-core", "system.yaml");
    expect(await readFile(contractPath, "utf8")).toBe(`system:
  project: Contract Project
  name: demo-core
  version: 0.2.0
  status: primary
  vcs: independent-git
  vcs_ref: main
  supersedes:
    - old-core
contract_managed_by: assay
`);

    const check = await checkFramework({ root });
    expect(check.rows.some((row) => row.message?.includes("contract file missing"))).toBe(false);
  });

  it("preserves an existing system contract", async () => {
    const root = path.join(await tempDir(), "workspace");
    await initFramework({ target: root, name: "Preserve Contract" });
    const systemPath = path.join(root, "systems", "custom");
    const contractPath = path.join(systemPath, "system.yaml");
    await mkdir(systemPath, { recursive: true });
    await writeFile(contractPath, "user-owned: true\n", "utf8");

    await registerSystem(root, { path: "systems/custom", name: "custom", primary: true });

    expect(await readFile(contractPath, "utf8")).toBe("user-owned: true\n");
  });

  it("does not create a contract when the registry record opts out", async () => {
    const root = path.join(await tempDir(), "workspace");
    await initFramework({ target: root, name: "No Contract" });
    const systemPath = path.join(root, "systems", "metadata-only");
    await mkdir(systemPath, { recursive: true });

    const result = await registerSystem(root, {
      path: "systems/metadata-only",
      name: "metadata-only",
      contractFile: null,
    });

    expect(result.system.contract_file).toBeNull();
    expect(await exists(path.join(systemPath, "system.yaml"))).toBe(false);
  });

  it("removes a newly created contract when registry validation fails", async () => {
    const root = path.join(await tempDir(), "workspace");
    await initFramework({ target: root, name: "Rollback Contract" });
    const systemPath = path.join(root, "systems", "invalid");
    const contractPath = path.join(systemPath, "system.yaml");
    await mkdir(systemPath, { recursive: true });

    await expect(
      registerSystem(root, { path: "systems/invalid", name: "", primary: true }),
    ).rejects.toThrow();

    expect(await exists(contractPath)).toBe(false);
    expect(await loadSystemsRegistry(root)).toBeNull();
  });

  it("registers an embedded system and writes an event", async () => {
    const root = await tempDir();
    const result = await registerSystem(root, {
      path: "systems/demo-core",
      name: "demo-core",
      primary: true,
      version: "0.2.0",
    });

    expect(result.system.name).toBe("demo-core");
    expect(result.system.status).toBe("primary");
    expect(result.system.vcs).toBe("embedded");
    expect(result.registry.primary).toBe("demo-core");

    const loaded = await loadSystemsRegistry(root);
    expect(loaded?.systems["demo-core"]).toBeDefined();
  });

  it("registers an independent-git system with supersedes", async () => {
    const root = await tempDir();
    await registerSystem(root, {
      path: "systems/old-game",
      name: "old-game",
      vcs: "independent-git",
      vcsRef: "main",
    });
    const result = await registerSystem(root, {
      path: "systems/new-game",
      name: "new-game",
      vcs: "independent-git",
      vcsRef: "main",
      primary: true,
      supersedes: ["old-game"],
    });

    expect(result.system.supersedes).toEqual(["old-game"]);
    expect(result.system.status).toBe("primary");
    expect(result.registry.systems["old-game"]?.status).toBe("active");
  });

  it("rejects duplicate registration", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/dupe", name: "dupe" });
    await expect(
      registerSystem(root, { path: "systems/dupe-2", name: "dupe" }),
    ).rejects.toBeInstanceOf(FrameworkAlreadyExistsError);
  });
});

describe("updateSystem", () => {
  it("updates an embedded system to independent-git and preserves omitted fields", async () => {
    const root = await tempDir();
    await registerSystem(root, {
      path: "systems/skill-creator",
      name: "skill-creator",
      version: "0.2.0",
      supersedes: ["old-skill"],
    });

    const result = await updateSystem(
      root,
      "skill",
      { vcs: "independent-git", vcsRef: "main" },
      { now: new Date("2026-07-06T00:00:00.000Z") },
    );

    expect(result.previous.vcs).toBe("embedded");
    expect(result.system).toMatchObject({
      name: "skill-creator",
      path: "systems/skill-creator",
      status: "active",
      vcs: "independent-git",
      vcs_ref: "main",
      version: "0.2.0",
      contract_file: "systems/skill-creator/system.yaml",
      supersedes: ["old-skill"],
      archived_on: null,
      archive_path: null,
    });
    expect(result.changes.map((change) => change.field)).toEqual(["vcs", "vcs_ref"]);

    const loaded = await loadSystemsRegistry(root);
    expect(loaded?.systems["skill-creator"]?.vcs).toBe("independent-git");
    expect(loaded?.systems["skill-creator"]?.vcs_ref).toBe("main");
    expect(loaded?.systems["skill-creator"]?.version).toBe("0.2.0");

    const eventText = await readFile(path.join(root, result.eventFile), "utf8");
    const events = eventText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const updateEvent = events.find((event) => event.event === "system.updated");
    expect(updateEvent).toMatchObject({
      name: "skill-creator",
      changed_fields: ["vcs", "vcs_ref"],
      primary: false,
      previous_primary: null,
    });
  });

  it("refuses to update an archived system", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/old", name: "old" });

    const registry = await loadSystemsRegistry(root);
    const old = registry?.systems.old;
    if (!registry || !old) {
      throw new Error("old system missing from registry");
    }
    registry.systems.old = {
      ...old,
      status: "archived",
      archived_on: "2026-07-06",
      archive_path: "systems/archive/2026-07-06-pre-old/old",
    };
    await saveSystemsRegistry(root, registry);

    await expect(updateSystem(root, "old", { vcs: "independent-git" })).rejects.toBeInstanceOf(
      FrameworkError,
    );
  });

  it("can promote during update while preserving the one-primary invariant", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/a", name: "a", primary: true });
    await registerSystem(root, { path: "systems/b", name: "b" });

    const result = await updateSystem(root, "b", { primary: true });

    expect(result.system.status).toBe("primary");
    expect(result.registry.primary).toBe("b");
    expect(result.registry.systems.a?.status).toBe("superseded");
    expect(result.changes.map((change) => change.field)).toEqual(["status"]);
  });
});

describe("promoteSystem", () => {
  it("demotes the previous primary to superseded", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/a", name: "a", primary: true });
    await registerSystem(root, { path: "systems/b", name: "b" });

    const result = await promoteSystem(root, "b");

    expect(result.system.status).toBe("primary");
    expect(result.registry.primary).toBe("b");
    expect(result.previousPrimary?.name).toBe("a");
    expect(result.registry.systems.a?.status).toBe("superseded");
  });

  it("refuses to promote an archived system", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/active", name: "active", primary: true });
    await registerSystem(root, { path: "systems/old", name: "old" });

    // Manually mark as archived to test the guard without file moves.
    const registry = await loadSystemsRegistry(root);
    const old = registry?.systems.old;
    if (!registry || !old) {
      throw new Error("old system missing from registry");
    }
    registry.systems.old = { ...old, status: "archived" };
    await saveSystemsRegistry(root, registry);

    await expect(promoteSystem(root, "old")).rejects.toBeInstanceOf(FrameworkError);
  });

  it("throws NotFound for unknown system", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/a", name: "a", primary: true });
    await expect(promoteSystem(root, "nope")).rejects.toBeInstanceOf(FrameworkNotFoundError);
  });
});

describe("archiveSystem", () => {
  it("dry-run reports destination without moving files or writing events", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/active", name: "active", primary: true });
    await registerSystem(root, { path: "systems/old", name: "old" });

    const systemPath = path.join(root, "systems", "old");
    await mkdir(systemPath, { recursive: true });
    await writeFile(path.join(systemPath, "marker.txt"), "x", "utf8");

    const result = await archiveSystem(root, "old", { dryRun: true, now: new Date("2026-06-17") });

    expect(result.dryRun).toBe(true);
    expect(result.movedTo).toContain("systems/archive/2026-06-17-pre-old");
    expect(result.eventFile).toBeNull();
    // Source still present
    expect(await exists(systemPath)).toBe(true);
    // Status unchanged
    expect(result.registry.systems.old?.status).toBe("active");
  });

  it("apply moves the directory and marks the system archived", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/active", name: "active", primary: true });
    await registerSystem(root, { path: "systems/old", name: "old" });

    const systemPath = path.join(root, "systems", "old");
    await mkdir(systemPath, { recursive: true });
    await writeFile(path.join(systemPath, "marker.txt"), "x", "utf8");

    const result = await archiveSystem(root, "old", { now: new Date("2026-06-17") });

    expect(result.dryRun).toBe(false);
    expect(result.system.status).toBe("archived");
    expect(result.system.archived_on).toBe("2026-06-17");
    expect(result.system.archive_path).toContain("systems/archive/2026-06-17-pre-old");
    expect(result.movedTo).toContain("systems/archive/2026-06-17-pre-old");
    expect(result.eventFile).not.toBeNull();

    // Source removed
    expect(await exists(systemPath)).toBe(false);
    // Destination has the marker
    if (!result.movedTo) {
      throw new Error("archive destination missing");
    }
    const movedMarker = path.join(root, result.movedTo, "marker.txt");
    expect(await exists(movedMarker)).toBe(true);
  });

  it("refuses to archive the primary system", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/primary", name: "primary", primary: true });

    await expect(archiveSystem(root, "primary")).rejects.toBeInstanceOf(FrameworkError);
  });
});

describe("findSystem", () => {
  it("matches by exact name and by prefix", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/alpha-core", name: "alpha-core", primary: true });

    const registry = await loadSystemsRegistry(root);
    if (!registry) {
      throw new Error("registry missing");
    }

    const exact = await findSystem(registry, "alpha-core");
    expect(exact.name).toBe("alpha-core");

    const prefix = await findSystem(registry, "alpha");
    expect(prefix.name).toBe("alpha-core");
  });

  it("throws NotFound for ambiguous prefix", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/alpha-one", name: "alpha-one", primary: true });
    await registerSystem(root, { path: "systems/alpha-two", name: "alpha-two" });

    const registry = await loadSystemsRegistry(root);
    if (!registry) {
      throw new Error("registry missing");
    }
    await expect(findSystem(registry, "alpha")).rejects.toBeInstanceOf(FrameworkNotFoundError);
  });
});

describe("listSystems", () => {
  it("returns systems sorted by status then name", async () => {
    const root = await tempDir();
    await registerSystem(root, { path: "systems/zeta", name: "zeta" });
    await registerSystem(root, { path: "systems/alpha", name: "alpha", primary: true });

    const { systems } = await listSystems(root);
    expect(systems.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(systems[0]?.status).toBe("primary");
  });
});
