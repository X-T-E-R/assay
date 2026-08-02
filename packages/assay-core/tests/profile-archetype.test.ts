import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SUPPORTED_CAPABILITY_MODULES,
  archetypeDirectories,
  archetypeZones,
  desiredTemplates,
  dirsForArchetype,
  listAvailableArchetypes,
  loadArchetype,
} from "../src/index.js";

const configTemplateId = "framework" + ".config";
const coreContractTemplateId = "system.core" + ".contract";
const frameworkConfigPath = ".assay/" + "config.yaml";
const USER_FACING_BUILT_INS = ["explore", "solve", "study"];
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-profile-archetype-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hasPath(paths: readonly string[], path: string): boolean {
  return paths.includes(path);
}

async function templatePaths(archetypeName = "study"): Promise<string[]> {
  return (await desiredTemplates("Demo", "learning", archetypeName)).map(
    (template) => template.path,
  );
}

async function writeCustomArchetype(
  file: string,
  options: {
    readonly mode?: string;
    readonly modules?: readonly string[];
    readonly dirs: readonly string[];
  },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "extends: base",
      `mode: ${options.mode ?? "learning"}`,
      "modules:",
      ...((options.modules ?? []).length === 0
        ? []
        : (options.modules ?? []).map((module) => `  - ${module}`)),
      "",
      "dirs:",
      ...options.dirs.map((directory) => `  - ${directory}`),
      "",
      "dirs_learning: []",
      "dirs_absorption: []",
      "templates: []",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("archetype loader", () => {
  it("loads study as the default archetype and rejects the removed assay profile alias", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    const defaultArchetype = await loadArchetype(undefined, { userArchetypesDir });

    expect(defaultArchetype.name).toBe("study");
    expect(defaultArchetype.mode).toBe("learning");
    expect(defaultArchetype).not.toHaveProperty("extendsName");
    await expect(loadArchetype("assay", { userArchetypesDir })).rejects.toThrow(
      /archetype not found: assay/,
    );
    await expect(loadArchetype("assay", { userArchetypesDir })).rejects.toThrow(
      /Available archetypes:/,
    );

    await expect(loadArchetype(`con${"test"}`, { userArchetypesDir })).rejects.toThrow(
      /archetype not found: con/,
    );
    await expect(loadArchetype(`con${"test"}`, { userArchetypesDir })).rejects.toThrow(
      /Available archetypes:/,
    );
  });

  it("resolves the old research name to study so existing manifests keep loading", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    const aliased = await loadArchetype(`re${"search"}`, { userArchetypesDir });
    const study = await loadArchetype("study", { userArchetypesDir });

    expect(aliased.name).toBe("study");
    expect(dirsForArchetype(aliased, aliased.mode)).toEqual(dirsForArchetype(study, study.mode));
  });

  it("lets an archetype file with an aliased name win over the alias", async () => {
    const root = path.join(await tempDir(), "workspace");
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, `re${"search"}.yaml`), {
      dirs: ["user-zone"],
    });

    const archetype = await loadArchetype(`re${"search"}`, { root, userArchetypesDir });

    expect(archetype.name).toBe(`re${"search"}`);
    expect(dirsForArchetype(archetype, archetype.mode)).toContain("user-zone");
  });

  it("names the removal when a deleted built-in archetype is requested", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");

    for (const removed of ["science", "evaluation", "library"]) {
      await expect(loadArchetype(removed, { userArchetypesDir })).rejects.toThrow(
        new RegExp(`archetype '${removed}' was removed in Assay 0\\.4\\.0`),
      );
      await expect(loadArchetype(removed, { userArchetypesDir })).rejects.toThrow(
        /Available archetypes:/,
      );
    }
  });

  it("does not expose the internal base archetype as selectable", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await expect(loadArchetype("base", { userArchetypesDir })).rejects.toThrow(
      /archetype not found: base/,
    );
  });

  it("does not expose events as an optional capability module", () => {
    expect(SUPPORTED_CAPABILITY_MODULES).toEqual(["adr", "intent", "iteration"]);
  });

  it("loads project-local archetypes before user-global and built-in archetypes", async () => {
    const root = path.join(await tempDir(), "workspace");
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, "foo.yaml"), {
      dirs: ["user-zone"],
      mode: "learning",
    });
    await writeCustomArchetype(path.join(root, ".assay", "archetypes", "foo.yaml"), {
      dirs: ["project-zone"],
      mode: "absorption",
      modules: ["iteration"],
    });

    const archetype = await loadArchetype("foo", { root, userArchetypesDir });
    const dirs = dirsForArchetype(archetype, archetype.mode);

    expect(archetype.name).toBe("foo");
    expect(archetype.mode).toBe("absorption");
    expect(archetype.modules).toEqual(["iteration"]);
    expect(dirs).toEqual(expect.arrayContaining(["systems", "knowledge", "project-zone"]));
    expect(dirs).not.toContain("user-zone");
  });

  it("loads user-global archetypes before falling back to built-ins", async () => {
    const root = path.join(await tempDir(), "workspace");
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, "foo.yaml"), {
      dirs: ["user-zone"],
      mode: "learning",
    });

    const custom = await loadArchetype("foo", { root, userArchetypesDir });
    const builtIn = await loadArchetype("explore", { root, userArchetypesDir });

    expect(dirsForArchetype(custom, custom.mode)).toContain("user-zone");
    expect(builtIn.name).toBe("explore");
    expect(dirsForArchetype(builtIn, builtIn.mode)).toEqual([
      "approaches",
      "trials",
      "iterations",
      "iterations/templates",
      ".assay/backups",
      ".assay/migrations",
      "systems",
      "knowledge",
    ]);
  });

  it("lists available archetypes with source labels and omits internal base", async () => {
    const root = path.join(await tempDir(), "workspace");
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(root, ".assay", "archetypes", "project-only.yaml"), {
      dirs: ["project-zone"],
    });
    await writeCustomArchetype(path.join(userArchetypesDir, "user-only.yaml"), {
      dirs: ["user-zone"],
    });

    const archetypes = await listAvailableArchetypes({ root, userArchetypesDir });

    expect(archetypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "study", source: "built-in" }),
        expect.objectContaining({ name: "solve", source: "built-in" }),
        expect.objectContaining({ name: "explore", source: "built-in" }),
        expect.objectContaining({ name: "project-only", source: "project" }),
        expect.objectContaining({ name: "user-only", source: "user" }),
      ]),
    );
    expect(
      archetypes
        .filter((archetype) => archetype.source === "built-in")
        .map((archetype) => archetype.name),
    ).toEqual(USER_FACING_BUILT_INS);
    expect(archetypes.some((archetype) => archetype.name === "base")).toBe(false);
  });

  it("reports missing archetypes with the available options", async () => {
    const root = path.join(await tempDir(), "workspace");
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, "foo.yaml"), {
      dirs: ["user-zone"],
    });

    let error: Error | null = null;
    try {
      await loadArchetype("missing", { root, userArchetypesDir });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain("archetype not found: missing");
    expect(error?.message).toContain("foo (user)");
    expect(error?.message).toContain("study (built-in)");
    expect(error?.message).not.toContain("base");
  });

  it("rejects custom archetypes with invalid mode values", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, "badmode.yaml"), {
      dirs: ["user-zone"],
      mode: "typo",
    });

    await expect(loadArchetype("badmode", { userArchetypesDir })).rejects.toThrow(
      /unsupported mode 'typo'/,
    );
    await expect(loadArchetype("badmode", { userArchetypesDir })).rejects.toThrow(
      /supported modes: learning, absorption/,
    );
  });
});

describe("archetype directory purposes", () => {
  it("accepts bare-string dirs, which stay valid and carry no purpose", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeCustomArchetype(path.join(userArchetypesDir, "legacy.yaml"), {
      dirs: ["zone", "zone/deep"],
    });

    const archetype = await loadArchetype("legacy", { userArchetypesDir });

    expect(dirsForArchetype(archetype, archetype.mode)).toEqual(
      expect.arrayContaining(["zone", "zone/deep", "systems", "knowledge"]),
    );
    expect(archetype.description).toBe("");
    expect(archetypeDirectories(archetype, archetype.mode)).toEqual(
      expect.arrayContaining([
        { path: "zone", purpose: "" },
        { path: "zone/deep", purpose: "" },
      ]),
    );
    expect(archetypeZones(archetype, archetype.mode)).toEqual(
      expect.arrayContaining([{ path: "zone", purpose: "" }]),
    );
  });

  it("reads path/purpose objects and mixes them with bare strings", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await mkdir(userArchetypesDir, { recursive: true });
    await writeFile(
      path.join(userArchetypesDir, "mixed.yaml"),
      [
        "extends: base",
        "mode: learning",
        "description: A mixed declaration.",
        "dirs:",
        "  - plain",
        "  - path: described",
        "    purpose: What belongs in described",
        "templates: []",
        "",
      ].join("\n"),
      "utf8",
    );

    const archetype = await loadArchetype("mixed", { userArchetypesDir });

    expect(archetype.description).toBe("A mixed declaration.");
    expect(archetypeDirectories(archetype, "learning")).toEqual([
      { path: "plain", purpose: "" },
      { path: "described", purpose: "What belongs in described" },
      { path: ".assay/backups", purpose: "" },
      { path: ".assay/migrations", purpose: "" },
      { path: "systems", purpose: "Registered systems and local implementations" },
      { path: "knowledge", purpose: "Accepted, reusable knowledge" },
    ]);
  });

  it("lets an archetype restate a shared directory in its own words", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await mkdir(userArchetypesDir, { recursive: true });
    await writeFile(
      path.join(userArchetypesDir, "restated.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - path: knowledge",
        "    purpose: Team playbooks only",
        "templates: []",
        "",
      ].join("\n"),
      "utf8",
    );

    const archetype = await loadArchetype("restated", { userArchetypesDir });

    expect(archetypeZones(archetype, "learning")).toContainEqual({
      path: "knowledge",
      purpose: "Team playbooks only",
    });
  });

  it("rejects a directory entry with no usable path", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await mkdir(userArchetypesDir, { recursive: true });
    await writeFile(
      path.join(userArchetypesDir, "broken.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - purpose: no path here",
        "templates: []",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadArchetype("broken", { userArchetypesDir })).rejects.toThrow(
      /invalid dirs path in archetype broken/,
    );
  });

  it("every built-in archetype describes itself and its own directories", async () => {
    for (const archetypeName of USER_FACING_BUILT_INS) {
      const archetype = await loadArchetype(archetypeName);
      expect(archetype.description).not.toBe("");
      for (const zone of archetypeZones(archetype, archetype.mode, archetype.modules)) {
        expect(zone.purpose, `${archetypeName}:${zone.path}`).not.toBe("");
      }
    }
  });

  it("leaves runtime state and template folders out of the zone list", async () => {
    const solve = await loadArchetype("solve");
    const zones = archetypeZones(solve, solve.mode, solve.modules).map((zone) => zone.path);

    expect(zones).toEqual([
      "problem",
      "intake",
      "benchmarks",
      "attempts",
      "tools",
      "iterations",
      "systems",
      "knowledge",
    ]);
  });
});

describe("archetype data shapes", () => {
  it("study keeps analyses and frozen references without solve inputs", async () => {
    const study = await loadArchetype("study");
    const dirs = dirsForArchetype(study, study.mode);

    expect(study.modules).toEqual(["adr"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "systems",
        "knowledge",
        "knowledge/decisions",
        "analyses/references",
        "analyses/gaps",
        "analyses/patterns",
        "analyses/templates",
        "references/frozen",
      ]),
    );
    expect(hasPath(dirs, "problem")).toBe(false);
    expect(hasPath(dirs, "intake")).toBe(false);
    expect(hasPath(dirs, "attempts")).toBe(false);
    expect(hasPath(dirs, "references/intake")).toBe(false);
  });

  it("solve owns solve input/output dirs and enables iteration by default", async () => {
    const solve = await loadArchetype("solve");
    const dirs = dirsForArchetype(solve, solve.mode);

    expect(solve.mode).toBe("absorption");
    expect(solve.modules).toEqual(["iteration"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "problem",
        "intake",
        "attempts",
        "benchmarks",
        "tools",
        "iterations/templates",
      ]),
    );
    expect(dirs.some((dir) => dir.startsWith("systems/") && dir !== "systems")).toBe(false);
  });

  it("explore owns approach trials and enables iteration by default", async () => {
    const explore = await loadArchetype("explore");
    const dirs = dirsForArchetype(explore, explore.mode);
    const paths = (await desiredTemplates("Demo", explore.mode, "explore")).map(
      (template) => template.path,
    );

    expect(explore.mode).toBe("absorption");
    expect(explore.modules).toEqual(["iteration"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "systems",
        "knowledge",
        "approaches",
        "trials",
        "iterations/templates",
      ]),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "approaches/README.md",
        "trials/README.md",
        "comparison.md",
        "iterations/README.md",
        "iterations/templates/iteration-plan.md",
      ]),
    );
    expect(hasPath(dirs, "problem")).toBe(false);
    expect(hasPath(dirs, "candidates")).toBe(false);
    expect(hasPath(dirs, "scorecards")).toBe(false);
  });
});

describe("custom archetype template content", () => {
  async function writeArchetypeYaml(file: string, body: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  }

  it("renders inline content and substitutes {{project}}", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.zone.readme",
        '    content: "# {{project}} zone\\n"',
        "",
      ].join("\n"),
    );

    const templates = await desiredTemplates("Demo", "learning", "custom", { userArchetypesDir });
    const zoneReadme = templates.find((template) => template.path === "zone/README.md");

    expect(zoneReadme?.content).toBe("# Demo zone\n");
    expect(zoneReadme?.templateId).toBe("custom.zone.readme");
  });

  it("reads file-based content relative to the archetype directory", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await mkdir(path.join(userArchetypesDir, "custom"), { recursive: true });
    await writeFile(
      path.join(userArchetypesDir, "custom", "zone-readme.md"),
      "# zone for {{project}}\n",
      "utf8",
    );
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.zone.readme",
        "    file: custom/zone-readme.md",
        "",
      ].join("\n"),
    );

    const templates = await desiredTemplates("Demo", "learning", "custom", { userArchetypesDir });
    const zoneReadme = templates.find((template) => template.path === "zone/README.md");

    expect(zoneReadme?.content).toBe("# zone for Demo\n");
  });

  it("rejects file references that escape the archetype directory", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.zone.readme",
        "    file: ../../outside.md",
        "",
      ].join("\n"),
    );

    await expect(loadArchetype("custom", { userArchetypesDir })).rejects.toThrow(
      /escapes the archetype directory/,
    );
  });

  it("rejects entries that set both content and file", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.zone.readme",
        '    content: "x"',
        "    file: custom/zone-readme.md",
        "",
      ].join("\n"),
    );

    await expect(loadArchetype("custom", { userArchetypesDir })).rejects.toThrow(
      /sets both content and file/,
    );
  });

  it("lets an archetype override base templates such as the root README", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: README.md",
        "    templateId: custom.root.readme",
        '    content: "# {{project}} custom root\\n"',
        "",
      ].join("\n"),
    );

    const templates = await desiredTemplates("Demo", "learning", "custom", { userArchetypesDir });
    const readmes = templates.filter((template) => template.path === "README.md");

    expect(readmes).toHaveLength(1);
    expect(readmes[0]?.content).toBe("# Demo custom root\n");
    expect(readmes[0]?.templateId).toBe("custom.root.readme");
  });

  it("fails loudly when a templateId resolves to no content", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.unknown.id",
        "",
      ].join("\n"),
    );

    await expect(
      desiredTemplates("Demo", "learning", "custom", { userArchetypesDir }),
    ).rejects.toThrow(/unknown templateId 'custom.unknown.id'/);
  });

  it("reports missing template files with the archetype name", async () => {
    const userArchetypesDir = path.join(await tempDir(), "user-archetypes");
    await writeArchetypeYaml(
      path.join(userArchetypesDir, "custom.yaml"),
      [
        "extends: base",
        "mode: learning",
        "dirs:",
        "  - zone",
        "templates:",
        "  - path: zone/README.md",
        "    templateId: custom.zone.readme",
        "    file: custom/missing.md",
        "",
      ].join("\n"),
    );

    await expect(loadArchetype("custom", { userArchetypesDir })).rejects.toThrow(
      /referenced by archetype custom not found/,
    );
  });
});

describe("archetype templates", () => {
  it("default desired templates use study and do not emit config or preset core files", async () => {
    const paths = await templatePaths();
    const templateIds = (await desiredTemplates("Demo")).map((template) => template.templateId);

    expect(paths).toContain("systems/README.md");
    expect(paths).toContain("references/frozen/README.md");
    expect(paths).toContain("knowledge/decisions/ADR-TEMPLATE.md");
    expect(paths).not.toContain(frameworkConfigPath);
    expect(paths.some((path) => path.includes("{core}") || path.includes("demo-core"))).toBe(false);
    expect(templateIds).not.toContain(configTemplateId);
    expect(templateIds).not.toContain(coreContractTemplateId);
  });

  it("all archetype templates avoid config files and preset core interpolation", async () => {
    for (const archetypeName of USER_FACING_BUILT_INS) {
      const templates = await desiredTemplates("Demo", "learning", archetypeName);
      const paths = templates.map((template) => template.path);

      expect(paths).not.toContain(frameworkConfigPath);
      expect(paths.some((path) => path.includes("{core}") || path.includes("demo-core"))).toBe(
        false,
      );
      expect(templates.map((template) => template.templateId)).not.toContain(configTemplateId);
      expect(templates.map((template) => template.templateId)).not.toContain(
        coreContractTemplateId,
      );
    }
  });

  it("new archetype templates use distinct domain language", async () => {
    const removedExploreTerms = new RegExp(
      [["con", "test"].join(""), "selection", "scorecards", "single goal"].join("|"),
      "i",
    );

    const explore = await desiredTemplates("Demo", "absorption", "explore");
    const exploreText = explore
      .filter((template) => template.templateId.startsWith("explore."))
      .map((template) => template.content)
      .join("\n");
    expect(exploreText).toContain("horse-race");
    expect(exploreText).toContain("approaches");
    expect(exploreText).toContain("converging");
    expect(exploreText).not.toMatch(removedExploreTerms);
  });
});
