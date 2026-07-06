import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
  archiveSystem,
  defaultSystemsRegistry,
  findSystem,
  listSystems,
  loadSystemsRegistry,
  promoteSystem,
  registerSystem,
  saveSystemsRegistry,
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
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("defaultSystemsRegistry", () => {
  it("starts empty with schema 1 and null primary", () => {
    const registry = defaultSystemsRegistry();
    expect(registry.__schema).toBe(1);
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
  });

  it("returns null when no registry file exists", async () => {
    const root = await tempDir();
    expect(await loadSystemsRegistry(root)).toBeNull();
  });
});

describe("registerSystem", () => {
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
