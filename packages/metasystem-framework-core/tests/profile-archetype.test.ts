import { describe, expect, it } from "vitest";

import {
  desiredTemplates,
  dirsForArchetype,
  dirsForMode,
  loadArchetype,
  loadProfile,
} from "../src/index.js";

const configTemplateId = "framework" + ".config";
const coreContractTemplateId = "system.core" + ".contract";
const frameworkConfigPath = ".framework/" + "config.yaml";

function hasPath(paths: readonly string[], path: string): boolean {
  return paths.includes(path);
}

async function templatePaths(archetypeName = "research"): Promise<string[]> {
  return (await desiredTemplates("Demo", "learning", archetypeName)).map(
    (template) => template.path,
  );
}

describe("profile to archetype loader compatibility", () => {
  it("loads research as the default archetype and resolves the deprecated metasystem alias", async () => {
    const defaultArchetype = await loadArchetype();
    const alias = await loadProfile("metasystem");

    expect(defaultArchetype.name).toBe("research");
    expect(defaultArchetype.mode).toBe("learning");
    expect(alias).toEqual(defaultArchetype);
    expect(alias).not.toHaveProperty("version");
  });

  it("keeps dirsForMode as a compatibility alias for dirsForArchetype", async () => {
    const research = await loadArchetype("research");

    expect(dirsForMode(research, "learning")).toEqual(dirsForArchetype(research, "learning"));
  });
});

describe("archetype data shapes", () => {
  it("research keeps analyses and frozen references without contest inputs", async () => {
    const research = await loadArchetype("research");
    const dirs = dirsForArchetype(research, research.mode);

    expect(research.modules).toEqual(["adr"]);
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
    expect(hasPath(dirs, "submissions")).toBe(false);
    expect(hasPath(dirs, "references/intake")).toBe(false);
  });

  it("contest owns contest input/output dirs and enables iteration by default", async () => {
    const contest = await loadArchetype("contest");
    const dirs = dirsForArchetype(contest, contest.mode);

    expect(contest.mode).toBe("absorption");
    expect(contest.modules).toEqual(["iteration"]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        "problem",
        "intake",
        "submissions",
        "benchmarks",
        "tools",
        "iterations/templates",
      ]),
    );
    expect(dirs.some((dir) => dir.startsWith("systems/") && dir !== "systems")).toBe(false);
  });

  it("library is shared core only", async () => {
    const library = await loadArchetype("library");
    const dirs = dirsForArchetype(library, library.mode);

    expect(library.mode).toBe("learning");
    expect(library.modules).toEqual([]);
    expect(dirs).toEqual([".framework/backups", ".framework/migrations", "systems", "knowledge"]);
    expect(dirs.some((dir) => dir.startsWith("analyses"))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith("references"))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith("iterations"))).toBe(false);
  });
});

describe("archetype templates", () => {
  it("default desired templates use research and do not emit config or preset core files", async () => {
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
    for (const archetypeName of ["research", "contest", "library"]) {
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
});
