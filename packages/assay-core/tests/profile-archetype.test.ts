import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SUPPORTED_CAPABILITY_MODULES,
  desiredTemplates,
  dirsForArchetype,
  listAvailableArchetypes,
  loadArchetype,
} from "../src/index.js";

const configTemplateId = "framework" + ".config";
const coreContractTemplateId = "system.core" + ".contract";
const frameworkConfigPath = ".assay/" + "config.yaml";
const USER_FACING_BUILT_INS = ["evaluation", "explore", "library", "science", "solve", "study"];
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

    for (const removedName of [`re${"search"}`, `con${"test"}`]) {
      await expect(loadArchetype(removedName, { userArchetypesDir })).rejects.toThrow(
        new RegExp(`archetype not found: ${removedName}`),
      );
      await expect(loadArchetype(removedName, { userArchetypesDir })).rejects.toThrow(
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
    expect(SUPPORTED_CAPABILITY_MODULES).toEqual(["adr", "iteration"]);
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
    const builtIn = await loadArchetype("library", { root, userArchetypesDir });

    expect(dirsForArchetype(custom, custom.mode)).toContain("user-zone");
    expect(builtIn.name).toBe("library");
    expect(dirsForArchetype(builtIn, builtIn.mode)).toEqual([
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
        expect.objectContaining({ name: "library", source: "built-in" }),
        expect.objectContaining({ name: "science", source: "built-in" }),
        expect.objectContaining({ name: "evaluation", source: "built-in" }),
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
    expect(error?.message).toContain("library (built-in)");
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

  it("science owns evidence research dirs and enables iteration by default", async () => {
    const science = await loadArchetype("science");
    const dirs = dirsForArchetype(science, science.mode);
    const paths = (await desiredTemplates("Demo", science.mode, "science")).map(
      (template) => template.path,
    );

    expect(science.mode).toBe("absorption");
    expect(science.modules).toEqual(["iteration"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "systems",
        "knowledge",
        "hypotheses",
        "experiments",
        "datasets",
        "findings",
        "papers",
        "iterations/templates",
      ]),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "hypotheses/README.md",
        "experiments/README.md",
        "datasets/README.md",
        "findings/README.md",
        "papers/README.md",
        "iterations/README.md",
        "iterations/templates/iteration-plan.md",
      ]),
    );
    expect(hasPath(dirs, "attempts")).toBe(false);
    expect(hasPath(dirs, "candidates")).toBe(false);
    expect(hasPath(dirs, "scorecards")).toBe(false);
  });

  it("evaluation owns candidate scorecards and enables ADR decisions", async () => {
    const evaluation = await loadArchetype("evaluation");
    const dirs = dirsForArchetype(evaluation, evaluation.mode);
    const paths = (await desiredTemplates("Demo", evaluation.mode, "evaluation")).map(
      (template) => template.path,
    );

    expect(evaluation.mode).toBe("learning");
    expect(evaluation.modules).toEqual(["adr"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "systems",
        "knowledge",
        "candidates",
        "scorecards",
        "knowledge/decisions",
      ]),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "candidates/README.md",
        "criteria.md",
        "scorecards/README.md",
        "knowledge/decisions/README.md",
        "knowledge/decisions/ADR-TEMPLATE.md",
      ]),
    );
    expect(hasPath(dirs, "analyses/gaps")).toBe(false);
    expect(hasPath(dirs, "analyses/patterns")).toBe(false);
    expect(hasPath(dirs, "references/frozen")).toBe(false);
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

  it("library is shared core only", async () => {
    const library = await loadArchetype("library");
    const dirs = dirsForArchetype(library, library.mode);
    const paths = (await desiredTemplates("Demo", library.mode, "library")).map(
      (template) => template.path,
    );

    expect(library.mode).toBe("learning");
    expect(library.modules).toEqual([]);
    expect(dirs).toEqual([".assay/backups", ".assay/migrations", "systems", "knowledge"]);
    expect(paths).toEqual([
      "README.md",
      ".gitignore",
      ".assay/README.md",
      ".assay/VERSION",
      ".assay/migrations/README.md",
      ".assay/backups/.gitkeep",
      "systems/README.md",
      "knowledge/README.md",
    ]);
    expect(dirs.some((dir) => dir.startsWith("analyses"))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith("references"))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith("iterations"))).toBe(false);
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
    const removedSolveSpecificTerms = new RegExp(
      [
        ["con", "test"].join(""),
        "selection",
        "scor(e|ing|ecard)",
        ["sub", "mission"].join(""),
      ].join("|"),
      "i",
    );
    const removedNarrowTerms = new RegExp(
      [["con", "test"].join(""), "gaps", "patterns"].join("|"),
      "i",
    );
    const removedExploreTerms = new RegExp(
      [["con", "test"].join(""), "selection", "scorecards", "single goal"].join("|"),
      "i",
    );

    const science = await desiredTemplates("Demo", "absorption", "science");
    const scienceText = science
      .filter((template) => template.templateId.startsWith("science."))
      .map((template) => template.content)
      .join("\n");
    expect(scienceText).toContain("hypothesis");
    expect(scienceText).toContain("evidence");
    expect(scienceText).not.toMatch(removedSolveSpecificTerms);

    const evaluation = await desiredTemplates("Demo", "learning", "evaluation");
    const evaluationText = evaluation
      .filter((template) => template.templateId.startsWith("evaluation."))
      .map((template) => template.content)
      .join("\n");
    expect(evaluationText).toContain("decision matrix");
    expect(evaluationText).toContain("scorecards");
    expect(evaluationText).toContain("final selection");
    expect(evaluationText).not.toMatch(removedNarrowTerms);

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
