import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BARE_ARCHETYPE,
  createTempDirectoryFixture,
  pathExists as exists,
  writeBareArchetype,
} from "assay-test-support";
import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  acceptAdr,
  addCapability,
  addSource,
  applyUpdate,
  attachExistingRepo,
  captureIntent,
  checkFramework,
  closeAnalysis,
  closeIteration,
  convertOverlayToStandalone,
  createAdr,
  createAnalysis,
  initFramework,
  listAdrs,
  listIntent,
  loadManifest,
  promoteIntent,
  reconcilePlugins,
  registerSystem,
  saveManifest,
  savePluginsState,
  switchSource,
  syncSource,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-hardening");
const GIT_TIMEOUT_MS = 45_000;

beforeAll(() => {
  // Never touch the user-global Assay project registry from tests.
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

async function gitRepo(name: string, file = "README.md"): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, file), `# ${name}\n\nv1\n`, "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "assay@example.test"]);
  await git(root, ["config", "user.name", "Assay Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["branch", "-M", "main"]);
  return root;
}

async function standaloneWorkspace(name: string, archetype?: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  if (archetype === BARE_ARCHETYPE) {
    await writeBareArchetype(root);
  }
  await initFramework({ target: root, name, ...(archetype ? { archetype } : {}) });
  return root;
}

/**
 * Path outside every workspace used as the injection payload target. Its
 * absence after a rejected command is the actual security assertion: a thrown
 * error alone does not prove the side effect was prevented.
 */
async function payloadTarget(name: string): Promise<string> {
  return path.join(await tempDirs.createTempDir(), name);
}

/**
 * Ref shaped like a git option. `--upload-pack=<command>` makes git run
 * `<command>` while transport is being set up, so the command executes even
 * though the surrounding invocation reports a usage error.
 */
function uploadPackPayloadRef(target: string): string {
  return `--upload-pack=touch ${target.replaceAll("\\", "/")}`;
}

describe("git ref arguments cannot be parsed as git options", () => {
  it(
    "refuses an option-shaped ref in `source switch` without running its payload",
    async () => {
      const root = await standaloneWorkspace("SwitchInjection");
      const repo = await gitRepo("switch-injection-source");
      await addSource({ root, source: repo, alias: "gs", branch: "main" });

      const target = await payloadTarget("switch-payload.txt");
      const headBefore = (
        await execa("git", ["rev-parse", "HEAD"], {
          cwd: path.join(root, "references", "gs", "checkout"),
        })
      ).stdout.trim();

      await expect(
        switchSource({ root, alias: "gs", target: uploadPackPayloadRef(target) }),
      ).rejects.toThrow(/must not start with '-'/);

      expect(await exists(target)).toBe(false);
      expect(
        (
          await execa("git", ["rev-parse", "HEAD"], {
            cwd: path.join(root, "references", "gs", "checkout"),
          })
        ).stdout.trim(),
      ).toBe(headBefore);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "refuses an option-shaped --ref in `source sync` without running its payload",
    async () => {
      const root = await standaloneWorkspace("SyncInjection");
      const repo = await gitRepo("sync-injection-source");
      await addSource({ root, source: repo, alias: "gs", branch: "main" });

      const target = await payloadTarget("sync-payload.txt");

      await expect(
        syncSource({ root, alias: "gs", ref: uploadPackPayloadRef(target) }),
      ).rejects.toThrow(/must not start with '-'/);

      expect(await exists(target)).toBe(false);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "refuses an option-shaped --branch in `source add` without running its payload",
    async () => {
      const root = await standaloneWorkspace("AddBranchInjection");
      const repo = await gitRepo("add-branch-injection-source");
      const target = await payloadTarget("add-branch-payload.txt");

      await expect(
        addSource({
          root,
          source: repo,
          alias: "gs",
          branch: uploadPackPayloadRef(target),
        }),
      ).rejects.toThrow(/must not start with '-'/);

      expect(await exists(target)).toBe(false);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "refuses an option-shaped source URI in `source add` without running its payload",
    async () => {
      const root = await standaloneWorkspace("AddUriInjection");
      const target = await payloadTarget("add-uri-payload.txt");

      await expect(
        addSource({
          root,
          // Ends with .git so it is classified as a Git URI and reaches clone.
          source: `${uploadPackPayloadRef(target)}.git`,
          alias: "gs",
        }),
      ).rejects.toThrow(/must not start with '-'/);

      expect(await exists(target)).toBe(false);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "still checks out a legitimate ref after the option guard",
    async () => {
      const root = await standaloneWorkspace("SwitchLegitimate");
      const repo = await gitRepo("switch-legitimate-source");
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "README.md"), "# feature\n\nv2\n", "utf8");
      await git(repo, ["commit", "-am", "feature"]);
      const featureCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
      await git(repo, ["checkout", "main"]);

      await addSource({ root, source: repo, alias: "gs", branch: "main" });
      const switched = await switchSource({ root, alias: "gs", target: "feature" });

      expect(switched.vcs.commit).toBe(featureCommit);
      expect(
        await readFile(path.join(root, "references", "gs", "checkout", "README.md"), "utf8"),
      ).toContain("v2");
    },
    GIT_TIMEOUT_MS,
  );
});

/**
 * Frontmatter is written as text, so any value that can carry a newline can
 * also carry a second `---` terminator. The record would still be written, and
 * only the next read would fail — permanently, because captures and ADR
 * markdown are not rewritten from the value that produced them.
 */
const TERMINATOR_PAYLOAD = 'ticket #42\n---\n\ninjected: "yes"';

/** The same payload plus the control characters a quoted scalar cannot hold raw. */
const CONTROL_PAYLOAD = `${TERMINATOR_PAYLOAD}\r\tbell:\u0007`;

function frontmatterOf(markdown: string): Record<string, unknown> {
  const header = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  expect(header, "record has no frontmatter block").toBeDefined();
  return parseYaml(header as string) as Record<string, unknown>;
}

describe("frontmatter values cannot terminate their own record", () => {
  it("round-trips an intent source carrying a frontmatter terminator", async () => {
    const root = await standaloneWorkspace("IntentSourceInjection", BARE_ARCHETYPE);
    await addCapability({ root, module: "intent" });
    await mkdir(path.join(root, "systems", "app"), { recursive: true });
    await registerSystem(root, { path: "systems/app", primary: true });
    const text = "Exports must include every column the table shows.\n";

    const captured = await captureIntent({ root, text, source: CONTROL_PAYLOAD });

    const content = await readFile(path.join(root, captured.capture.path), "utf8");
    expect(frontmatterOf(content).source).toBe(CONTROL_PAYLOAD);
    expect(content.endsWith(`\n\n${text}`)).toBe(true);

    // readCapture and the listing both have to survive it, and the digest has
    // to still match, or the record is unusable from here on.
    const listed = await listIntent({ root });
    expect(listed.captures).toHaveLength(1);
    expect(listed.captures[0]?.source).toBe(CONTROL_PAYLOAD);
    expect(listed.captures[0]?.integrity).toBe("ok");

    const again = await captureIntent({ root, text, source: CONTROL_PAYLOAD });
    expect(again.created).toBe(false);
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("round-trips a promoted requirement title carrying a frontmatter terminator", async () => {
    const root = await standaloneWorkspace("RequirementTitleInjection", BARE_ARCHETYPE);
    await addCapability({ root, module: "intent" });
    await mkdir(path.join(root, "systems", "app"), { recursive: true });
    await registerSystem(root, { path: "systems/app", primary: true });
    const captured = await captureIntent({ root, text: "Retention is ninety days.\n" });

    const promoted = await promoteIntent({
      root,
      capture: captured.capture.id,
      to: "requirement",
      title: TERMINATOR_PAYLOAD,
    });

    const header = frontmatterOf(await readFile(path.join(root, promoted.path), "utf8"));
    expect(header.title).toBe(TERMINATOR_PAYLOAD);
    expect(header.derives_from).toBe(captured.capture.id);
    expect(header.injected).toBeUndefined();
    // The requirement is still discoverable from the capture it derives from.
    expect((await listIntent({ root })).captures[0]?.requirements).toEqual([promoted.path]);
  });

  it("round-trips an ADR title carrying a frontmatter terminator through accept", async () => {
    const root = await standaloneWorkspace("AdrTitleInjection");

    const created = await createAdr(root, { title: TERMINATOR_PAYLOAD });

    const header = frontmatterOf(await readFile(path.join(root, created.adr.path), "utf8"));
    expect(header.title).toBe(TERMINATOR_PAYLOAD);
    expect(header.status).toBe("proposed");
    expect(header.injected).toBeUndefined();

    // `accept` rewrites the frontmatter in place by matching the terminator.
    await acceptAdr(root, created.adr.id);
    const accepted = await readFile(path.join(root, created.adr.path), "utf8");
    expect(frontmatterOf(accepted).title).toBe(TERMINATOR_PAYLOAD);
    expect(frontmatterOf(accepted).status).toBe("accepted");
    expect(accepted).toContain("## Consequences");
    expect((await listAdrs(root)).adrs[0]?.title).toBe(TERMINATOR_PAYLOAD);
  });
});

describe("workspace path arguments stay inside the workspace", () => {
  it("refuses `analysis close` on a path above the workspace and leaves the file untouched", async () => {
    const root = await standaloneWorkspace("AnalysisEscape");
    const outside = path.join(path.dirname(root), "outside.md");
    const original = "# Outside\n\n- Status: draft\n\n- [ ] adopt\n";
    await writeFile(outside, original, "utf8");

    await expect(closeAnalysis({ root, path: "../outside.md", exit: "adopt" })).rejects.toThrow(
      /analysis path escapes the workspace/,
    );

    expect(await readFile(outside, "utf8")).toBe(original);
  });

  it("refuses `analysis close` on an absolute path outside the workspace", async () => {
    const root = await standaloneWorkspace("AnalysisAbsoluteEscape");
    const outside = path.join(path.dirname(root), "absolute-outside.md");
    const original = "# Outside\n\n- Status: draft\n";
    await writeFile(outside, original, "utf8");

    await expect(closeAnalysis({ root, path: outside, exit: "adopt" })).rejects.toThrow(
      /analysis path escapes the workspace/,
    );

    expect(await readFile(outside, "utf8")).toBe(original);
  });

  it("still closes an analysis inside the workspace", async () => {
    const root = await standaloneWorkspace("AnalysisCloseInside");
    const analysis = await createAnalysis({ root, title: "Inside Analysis" });

    const closed = await closeAnalysis({ root, path: analysis.path, exit: "adopt" });

    expect(closed.path).toBe(analysis.path);
    const content = await readFile(analysis.absolutePath, "utf8");
    expect(content).toContain("- Status: applied");
    expect(content).toContain("- [x] adopt");
  });

  it("refuses `iteration close` on a directory above the workspace and leaves its plan untouched", async () => {
    // `solve` enables the iteration capability, which is checked before the
    // selector is resolved.
    const root = await standaloneWorkspace("IterationEscape", "solve");
    const outside = path.join(path.dirname(root), "evil-iteration");
    await mkdir(outside, { recursive: true });
    const plan = path.join(outside, "plan.md");
    const original = "# Evil\n\n- Status: open\n\n## Result\n";
    await writeFile(plan, original, "utf8");

    await expect(
      closeIteration({ root, selector: "../evil-iteration", result: "applied" }),
    ).rejects.toThrow(/iteration selector escapes the workspace/);

    expect(await readFile(plan, "utf8")).toBe(original);
  });

  it("refuses `analysis new --for-reference` pointing above the workspace", async () => {
    const root = await standaloneWorkspace("ReferenceEscape");
    const outside = path.join(path.dirname(root), "outside-reference");
    await mkdir(outside, { recursive: true });

    await expect(
      createAnalysis({ root, title: "Escaping Reference", forReference: "../outside-reference" }),
    ).rejects.toThrow(/reference path escapes the workspace/);
  });
});

async function overlayWorkspace(
  name: string,
  options: { readonly archetype?: string } = {},
): Promise<string> {
  const root = await gitRepo(name, "product.txt");
  await attachExistingRepo({
    root,
    name,
    archetype: options.archetype ?? "study",
    privacy: "private",
    noTrack: true,
  });
  return root;
}

describe("update respects the overlay layout", () => {
  it("does not create Assay work folders or root files in an attached product repo", async () => {
    const root = await overlayWorkspace("UpdateOverlay");
    await writeFile(path.join(root, "README.md"), "# Product\n\nReal product readme.\n", "utf8");
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
    await git(root, ["add", "README.md", ".gitignore"]);
    await git(root, ["commit", "-m", "product files"]);

    await applyUpdate({ root });

    // Product-owned root files stay exactly as the product wrote them.
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe(
      "# Product\n\nReal product readme.\n",
    );
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
    for (const directory of ["analyses", "knowledge", "references", "systems"]) {
      expect(await exists(path.join(root, directory))).toBe(false);
    }
    // Product Git must see nothing new: /.assay/ is excluded, everything else
    // would show up here.
    expect((await git(root, ["status", "--short"])).trim()).toBe("");

    // The same templates still land under .assay/.
    expect(await exists(path.join(root, ".assay", "analyses", "README.md"))).toBe(true);
    expect(await exists(path.join(root, ".assay", "knowledge", "README.md"))).toBe(true);
  });

  it("does not replace product root files even with --force", async () => {
    const root = await overlayWorkspace("UpdateOverlayForce");
    await writeFile(path.join(root, "README.md"), "# Product\n\nOwned by the product.\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "product readme"]);

    await applyUpdate({ root, action: "force" });

    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe(
      "# Product\n\nOwned by the product.\n",
    );
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
  });

  it("still writes root templates in a standalone workspace", async () => {
    const root = await standaloneWorkspace("UpdateStandalone");

    const result = await applyUpdate({ root });

    expect(
      result.analysis.changes.new.length + result.analysis.changes.unchanged.length,
    ).toBeGreaterThan(0);
    expect(await exists(path.join(root, "README.md"))).toBe(true);
    expect(await exists(path.join(root, "analyses", "README.md"))).toBe(true);
  });
});

describe("convert carries the full workspace state to the new standalone root", () => {
  it.each([
    { label: "copy", move: false, keepOverlay: true },
    { label: "move", move: true, keepOverlay: false },
  ])(
    "preserves Project Authority bytes during $label conversion",
    async (mode) => {
      const root = await overlayWorkspace(`ConvertProjectAuthority-${mode.label}`);
      await addCapability({ root, module: "project-authority" });
      const sourceAuthority = path.join(root, ".assay", "project-authority");
      const modifiedPolicy = Buffer.from("# Project-owned policy\r\n\r\nExact bytes.\r\n", "utf8");
      const unknownFacts = Buffer.from([0, 1, 2, 13, 10, 255]);
      await writeFile(path.join(sourceAuthority, "policy", "README.md"), modifiedPolicy);
      await writeFile(path.join(sourceAuthority, "facts", "snapshot.bin"), unknownFacts);

      const target = path.join(path.dirname(root), `converted-project-authority-${mode.label}`);
      await convertOverlayToStandalone({
        root,
        target,
        move: mode.move,
        keepOverlay: mode.keepOverlay,
      });

      expect(await readFile(path.join(target, "project-authority", "policy", "README.md"))).toEqual(
        modifiedPolicy,
      );
      expect(
        await readFile(path.join(target, "project-authority", "facts", "snapshot.bin")),
      ).toEqual(unknownFacts);
      const manifest = await loadManifest(target);
      expect(Object.keys(manifest?.managed_files ?? {})).toContain(
        "project-authority/policy/README.md",
      );
      expect(
        Object.keys(manifest?.managed_files ?? {}).some((entry) =>
          entry.startsWith(".assay/project-authority/"),
        ),
      ).toBe(false);
      expect((await checkFramework({ root: target })).ok).toBe(true);

      if (mode.move) {
        expect(await exists(path.join(root, ".assay"))).toBe(false);
      } else {
        expect(await readFile(path.join(sourceAuthority, "policy", "README.md"))).toEqual(
          modifiedPolicy,
        );
      }
    },
    30_000,
  );

  it("rejects a Project Authority target conflict before writing any conversion output", async () => {
    const root = await overlayWorkspace("ConvertProjectAuthorityConflict");
    await addCapability({ root, module: "project-authority" });
    const sourcePolicy = path.join(root, ".assay", "project-authority", "policy", "README.md");
    const sourceBytes = await readFile(sourcePolicy);

    const target = path.join(path.dirname(root), "converted-project-authority-conflict");
    const conflict = path.join(target, "project-authority", "policy", "README.md");
    await mkdir(path.dirname(conflict), { recursive: true });
    await writeFile(conflict, "# Target-owned content\n", "utf8");

    await expect(convertOverlayToStandalone({ root, target })).rejects.toThrow(
      /target project-authority path already contains content/,
    );

    expect(await readFile(conflict, "utf8")).toBe("# Target-owned content\n");
    expect(await exists(path.join(target, ".assay", "manifest.json"))).toBe(false);
    expect(await readFile(sourcePolicy)).toEqual(sourceBytes);
    expect(await exists(path.join(root, ".assay", "manifest.json"))).toBe(true);
  });

  it.each([
    { label: "copy", move: false, keepOverlay: true },
    { label: "move", move: true, keepOverlay: false },
  ])(
    "rejects an empty Project Authority target junction before $label writes or removals",
    async (mode) => {
      const root = await overlayWorkspace(`ConvertProjectAuthorityJunction-${mode.label}`);
      await addCapability({ root, module: "project-authority" });
      const sourceManifest = path.join(root, ".assay", "manifest.json");
      const sourcePolicy = path.join(root, ".assay", "project-authority", "policy", "README.md");
      const sourceUnknown = path.join(root, ".assay", "project-authority", "facts", "owned.bin");
      const unknownBytes = Buffer.from([255, 10, 0, 13, 7]);
      await writeFile(sourcePolicy, "# Project-owned exact bytes\r\n", "utf8");
      await writeFile(sourceUnknown, unknownBytes);
      const manifestBytes = await readFile(sourceManifest);
      const policyBytes = await readFile(sourcePolicy);

      const target = path.join(path.dirname(root), `converted-pa-junction-${mode.label}`);
      const outside = path.join(path.dirname(root), `outside-pa-junction-${mode.label}`);
      await mkdir(target, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(
        outside,
        path.join(target, "project-authority"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        convertOverlayToStandalone({
          root,
          target,
          move: mode.move,
          keepOverlay: mode.keepOverlay,
        }),
      ).rejects.toThrow(/real directory|symlink|junction|reparse point/);

      expect(await readdir(outside)).toEqual([]);
      expect(await exists(path.join(target, ".assay"))).toBe(false);
      expect(await readFile(sourceManifest)).toEqual(manifestBytes);
      expect(await readFile(sourcePolicy)).toEqual(policyBytes);
      expect(await readFile(sourceUnknown)).toEqual(unknownBytes);
    },
    30_000,
  );

  it("keeps native ADR templates through legacy Trellis reconcile and conversion", async () => {
    const root = await overlayWorkspace("ConvertLegacyTrellisAdr");
    const manifest = await loadManifest(root);
    if (!manifest) throw new Error("manifest missing");
    manifest.plugins = { "assay.trellis": { kind: "federated-provider" } };
    manifest.bindings = {
      "decision-governance": {
        provider: "assay.trellis",
        target: { kind: "workspace" },
      },
    };
    await saveManifest(root, manifest);
    await savePluginsState(root, {
      __schema: 2,
      plugins: {
        "assay.trellis": {
          kind: "federated-provider",
          state_version: 1,
          installed_at: "2026-07-28T00:00:00+00:00",
          updated_at: "2026-07-28T00:00:00+00:00",
        },
      },
      updated_at: "2026-07-28T00:00:00+00:00",
    });

    await applyUpdate({ root });
    const overlayAdrTemplate = path.join(
      root,
      ".assay",
      "knowledge",
      "decisions",
      "ADR-TEMPLATE.md",
    );
    expect(await exists(overlayAdrTemplate)).toBe(true);
    await reconcilePlugins({ root, apply: true });
    await applyUpdate({ root });
    expect(await exists(overlayAdrTemplate)).toBe(true);

    const target = path.join(path.dirname(root), "converted-legacy-trellis-adr");
    await convertOverlayToStandalone({ root, target });
    await applyUpdate({ root: target });
    expect(await exists(path.join(target, "knowledge", "decisions", "ADR-TEMPLATE.md"))).toBe(true);
    expect((await createAdr(target, { title: "Native After Convert" })).adr.id).toBe(
      "ADR-0001-native-after-convert",
    );
  });

  it("copies the ADR index so ADR numbering continues instead of restarting", async () => {
    const root = await overlayWorkspace("ConvertAdrs");
    const first = await createAdr(root, { title: "Overlay Decision" });
    expect(first.adr.id).toBe("ADR-0001-overlay-decision");

    const target = path.join(path.dirname(root), "converted-adrs");
    await convertOverlayToStandalone({ root, target });

    // The index travelled with the ADR markdown, so `adr list` sees the ADR ...
    const listed = await listAdrs(target);
    expect(listed.adrs.map((adr) => adr.id)).toEqual(["ADR-0001-overlay-decision"]);
    expect(await exists(path.join(target, ".assay", "adrs.json"))).toBe(true);

    // ... and the next ADR gets a fresh number instead of colliding on 0001.
    const second = await createAdr(target, { title: "Standalone Decision" });
    expect(second.adr.id).toBe("ADR-0002-standalone-decision");

    // Index paths follow the hoisted markdown, so `check` finds every ADR.
    expect(listed.adrs[0]?.path).toBe("knowledge/decisions/ADR-0001-overlay-decision.md");
    expect(await exists(path.join(target, "knowledge", "decisions"))).toBe(true);
    for (const adr of (await listAdrs(target)).adrs) {
      expect(await exists(path.join(target, adr.path))).toBe(true);
    }
    const check = await checkFramework({ root: target });
    expect(check.rows.filter((row) => row.message?.includes("missing on disk"))).toEqual([]);
  });

  it("copies project-local archetypes so the converted workspace can still load its archetype", async () => {
    const root = await overlayWorkspace("ConvertArchetypes");
    const archetypeDir = path.join(root, ".assay", "archetypes");
    await mkdir(archetypeDir, { recursive: true });
    await writeFile(
      path.join(archetypeDir, "local-study.yaml"),
      [
        "extends: base",
        "mode: learning",
        "modules:",
        "  - adr",
        "dirs:",
        "  - knowledge/decisions",
        "templates: []",
        "",
      ].join("\n"),
      "utf8",
    );
    const manifestPath = path.join(root, ".assay", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      project: { archetype: string };
    };
    manifest.project.archetype = "local-study";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const target = path.join(path.dirname(root), "converted-archetypes");
    await convertOverlayToStandalone({ root, target });

    expect(await exists(path.join(target, ".assay", "archetypes", "local-study.yaml"))).toBe(true);
    // A command that must resolve the archetype now works in the new root.
    const adr = await createAdr(target, { title: "Post Convert Decision" });
    expect(adr.adr.id).toBe("ADR-0001-post-convert-decision");
  });

  it("rewrites managed-file paths for the hoisted work folders so `check` passes", async () => {
    const root = await overlayWorkspace("ConvertManagedFiles");
    await applyUpdate({ root });

    const target = path.join(path.dirname(root), "converted-managed-files");
    await convertOverlayToStandalone({ root, target });

    const manifest = JSON.parse(
      await readFile(path.join(target, ".assay", "manifest.json"), "utf8"),
    ) as { managed_files: Record<string, unknown> };
    const managedPaths = Object.keys(manifest.managed_files);
    expect(managedPaths).toContain("analyses/README.md");
    expect(managedPaths.some((entry) => entry.startsWith(".assay/analyses/"))).toBe(false);

    const check = await checkFramework({ root: target });
    expect(check.rows.filter((row) => row.status === "error")).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("copies donor state", async () => {
    const root = await overlayWorkspace("ConvertDonors");
    const donorDir = path.join(root, ".assay", "donors", "example");
    await mkdir(donorDir, { recursive: true });
    await writeFile(path.join(donorDir, "state.json"), "{}\n", "utf8");

    const target = path.join(path.dirname(root), "converted-donors");
    await convertOverlayToStandalone({ root, target });

    expect(await exists(path.join(target, ".assay", "donors", "example", "state.json"))).toBe(true);
  });

  it("refuses --no-keep-overlay without --move instead of silently keeping the overlay", async () => {
    const root = await overlayWorkspace("ConvertKeepOverlay");
    const target = path.join(path.dirname(root), "converted-keep-overlay");

    await expect(
      convertOverlayToStandalone({ root, target, move: false, keepOverlay: false }),
    ).rejects.toThrow(/requires --move/);

    // The refusal happens before any target state is written.
    expect(await exists(path.join(target, ".assay", "manifest.json"))).toBe(false);
  });

  it("removes the emptied overlay state directory with --move --no-keep-overlay", async () => {
    const root = await overlayWorkspace("ConvertMoveRemoveOverlay");
    await createAdr(root, { title: "Moved Decision" });

    const target = path.join(path.dirname(root), "converted-move-remove");
    const result = await convertOverlayToStandalone({
      root,
      target,
      move: true,
      keepOverlay: false,
    });

    expect(result.overlayStateRemoved).toBe(true);
    expect(await exists(path.join(root, ".assay"))).toBe(false);
    // The product repo itself is untouched.
    expect(await exists(path.join(root, "product.txt"))).toBe(true);
    expect((await git(root, ["status", "--short"])).trim()).toBe("");
    expect(await exists(path.join(target, ".assay", "adrs.json"))).toBe(true);
  });
});

describe("check accepts archetype-declared knowledge subdirectories", () => {
  it("does not warn about a knowledge folder the archetype declares", async () => {
    const root = path.join(await tempDirs.createTempDir(), "CustomKnowledge");
    const archetypeDir = path.join(root, ".assay", "archetypes");
    await mkdir(archetypeDir, { recursive: true });
    await writeFile(
      path.join(archetypeDir, "playbook-study.yaml"),
      [
        "extends: base",
        "mode: learning",
        "modules:",
        "  - adr",
        "dirs:",
        "  - knowledge/decisions",
        "  - knowledge/playbooks",
        "templates: []",
        "",
      ].join("\n"),
      "utf8",
    );

    await initFramework({ target: root, name: "CustomKnowledge", archetype: "playbook-study" });
    expect(await exists(path.join(root, "knowledge", "playbooks"))).toBe(true);

    const result = await checkFramework({ root });

    expect(
      result.rows.filter((row) => row.message?.includes("unexpected knowledge subdirectory")),
    ).toEqual([]);
  });

  it("still warns about the legacy troubleshootings directory", async () => {
    const root = await standaloneWorkspace("LegacyKnowledgeDrift");
    await mkdir(path.join(root, "knowledge", "troubleshootings"), { recursive: true });

    const result = await checkFramework({ root });

    expect(
      result.rows.some(
        (row) =>
          row.path === "knowledge/troubleshootings" &&
          row.status === "warning" &&
          row.message?.includes("troubleshootings"),
      ),
    ).toBe(true);
  });
});
