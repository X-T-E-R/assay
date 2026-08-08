import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidManifestError,
  MANIFEST_FILE,
  appendEvent,
  computeHash,
  defaultManifest,
  discoverFrameworkRoot,
  eventPath,
  fileHash,
  loadManifest,
  manifestPath,
  projectFromManifest,
  recordManagedFile,
  recordTemplate,
  relativeDisplayPath,
  saveManifest,
  slugify,
  withWorkspaceConversionCoordination,
  withWorkspaceMutationCoordination,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-core-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("slugify", () => {
  it("preserves CJK text while normalizing separators", () => {
    expect(slugify("  Hello, Assay!  ")).toBe("hello-assay");
    expect(slugify("多 Agent / 测试 2026")).toBe("多-agent-测试-2026");
    expect(slugify("___")).toBe("untitled");
  });
});

describe("relativeDisplayPath", () => {
  it("returns a posix-style relative path when target is inside the root", () => {
    const root = path.join("C:", "workspace", "demo");
    const target = path.join(root, "references", "frozen", "README.md");

    expect(relativeDisplayPath(target, root)).toBe("references/frozen/README.md");
  });

  it("returns the original display path when target is outside the root", () => {
    const outside = path.join("C:", "outside", "file.md");

    expect(relativeDisplayPath(outside, path.join("C:", "workspace", "demo"))).toBe(
      outside.replaceAll("\\", "/"),
    );
  });
});

describe("workspace coordination boundaries", () => {
  it.each(["state-root", "coordination"] as const)(
    "rejects a pre-existing %s junction before external writes",
    async (redirect) => {
      const root = path.join(await tempDir(), "workspace");
      const outside = path.join(await tempDir(), "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel.txt"), "unchanged", "utf8");
      if (redirect === "state-root") {
        await symlink(outside, path.join(root, ".assay"), "junction");
      } else {
        await mkdir(path.join(root, ".assay"));
        await symlink(outside, path.join(root, ".assay", "coordination"), "junction");
      }
      let called = false;

      await expect(
        withWorkspaceConversionCoordination(root, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ name: "TaskStorageBoundaryError" });

      expect(called).toBe(false);
      expect(await readdir(outside)).toEqual(["sentinel.txt"]);
      expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
    },
  );

  it("removes transient state after success or failure and preserves a pre-existing empty root", async () => {
    const successRoot = path.join(await tempDir(), "success");
    const failureRoot = path.join(await tempDir(), "failure");
    const conversionFailureRoot = path.join(await tempDir(), "conversion-failure");
    const existingRoot = path.join(await tempDir(), "existing");
    await Promise.all([
      mkdir(successRoot),
      mkdir(failureRoot),
      mkdir(conversionFailureRoot),
      mkdir(path.join(existingRoot, ".assay"), { recursive: true }),
    ]);

    await expect(withWorkspaceMutationCoordination(successRoot, async () => "ok")).resolves.toBe(
      "ok",
    );
    await expect(
      withWorkspaceMutationCoordination(failureRoot, async () => {
        throw new Error("expected failure");
      }),
    ).rejects.toThrow(/expected failure/);
    await expect(
      withWorkspaceConversionCoordination(conversionFailureRoot, async () => {
        throw new Error("expected conversion failure");
      }),
    ).rejects.toThrow(/expected conversion failure/);
    await expect(
      withWorkspaceMutationCoordination(existingRoot, async () => undefined),
    ).resolves.toBeUndefined();

    expect(await lstat(path.join(successRoot, ".assay")).catch(() => null)).toBeNull();
    expect(await lstat(path.join(failureRoot, ".assay")).catch(() => null)).toBeNull();
    expect(await lstat(path.join(conversionFailureRoot, ".assay")).catch(() => null)).toBeNull();
    expect((await lstat(path.join(existingRoot, ".assay"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(existingRoot, ".assay"))).toEqual([]);
  });

  it("serializes consecutive mutations on an empty root without leaving coordination state", async () => {
    const root = path.join(await tempDir(), "consecutive");
    await mkdir(root);
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        withWorkspaceMutationCoordination(root, async () => {
          order.push(index);
        }),
      ),
    );

    expect(order).toHaveLength(4);
    expect(await lstat(path.join(root, ".assay")).catch(() => null)).toBeNull();
  });
});

describe("discoverFrameworkRoot", () => {
  it("finds the nearest framework root from a nested directory", async () => {
    const root = await tempDir();
    const nested = path.join(root, "systems", "core", "docs");
    await mkdir(path.join(root, ".assay"), { recursive: true });
    await mkdir(nested, { recursive: true });

    await expect(discoverFrameworkRoot(nested)).resolves.toBe(root);
  });

  it("starts from the parent when the start path is a file", async () => {
    const root = await tempDir();
    const file = path.join(root, "README.md");
    await mkdir(path.join(root, ".assay"), { recursive: true });
    await writeFile(path.join(root, ".assay", "manifest.json"), "{}", "utf8");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Card\n", "utf8");

    await expect(discoverFrameworkRoot(file)).resolves.toBe(root);
  });

  it("uses .framework only as a locator for retired workspaces", async () => {
    const root = await tempDir();
    const nested = path.join(root, "outer", "systems", "nested", "work");
    await mkdir(path.join(root, ".framework"), { recursive: true });
    await writeFile(path.join(root, ".framework", "manifest.json"), "{}", "utf8");
    await mkdir(nested, { recursive: true });

    await expect(discoverFrameworkRoot(nested)).resolves.toBe(root);
  });
});

describe("hashing", () => {
  it("normalizes CRLF to LF before hashing", () => {
    expect(computeHash("a\r\nb\r\n")).toBe(computeHash("a\nb\n"));
  });

  it("hashes files using the same normalization", async () => {
    const root = await tempDir();
    const target = path.join(root, "hash.txt");
    await writeFile(target, "a\r\nb\r\n", "utf8");

    await expect(fileHash(target)).resolves.toBe(computeHash("a\nb\n"));
  });
});

describe("manifest", () => {
  it("saves, parses, records, and projects manifest data", async () => {
    const root = await tempDir();
    let manifest = defaultManifest("Demo");

    recordManagedFile(manifest, {
      path: "README.md",
      templateId: "root.readme",
      content: "# Demo\r\n",
    });
    recordTemplate(manifest, {
      path: ".assay/VERSION",
      template_id: "framework.version",
      content: "0.2.0\n",
      executable: false,
      protected: true,
    });

    manifest = await saveManifest(root, manifest);
    const loaded = await loadManifest(root);

    expect(loaded).toEqual(manifest);
    expect(loaded?.managed_files["README.md"]?.hash).toBe(computeHash("# Demo\n"));
    expect(projectFromManifest(loaded, root)).toBe("Demo");
    expect(manifestPath(root)).toBe(path.join(root, MANIFEST_FILE));
  });

  it("returns fallback project names when no manifest is available", async () => {
    const root = path.join(await tempDir(), "demo");

    expect(projectFromManifest(null, root)).toBe("demo");
  });

  it("returns null when the manifest file does not exist", async () => {
    await expect(loadManifest(await tempDir())).resolves.toBeNull();
  });

  it("throws a typed error when manifest JSON is invalid", async () => {
    const root = await tempDir();
    await mkdir(path.dirname(manifestPath(root)), { recursive: true });
    await writeFile(manifestPath(root), "{not-json", "utf8");

    await expect(loadManifest(root)).rejects.toBeInstanceOf(InvalidManifestError);
  });

  it("throws a typed error when manifest shape is invalid", async () => {
    const root = await tempDir();
    await mkdir(path.dirname(manifestPath(root)), { recursive: true });
    const invalid = defaultManifest("Demo");
    invalid.project.name = "";
    await writeFile(manifestPath(root), JSON.stringify(invalid), "utf8");

    await expect(loadManifest(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });
});

describe("events", () => {
  it("appends sorted JSONL event entries under the monthly event path", async () => {
    const root = await tempDir();
    const when = new Date("2026-06-14T12:00:00.000Z");

    const firstPath = await appendEvent(root, { kind: "reference.frozen", text: "Frozen" }, when);
    const secondPath = await appendEvent(root, { kind: "analysis.created", text: "Created" }, when);

    expect(firstPath).toBe(secondPath);
    expect(firstPath).toBe(eventPath(root, when));

    const lines = (await readFile(firstPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      kind: "reference.frozen",
      text: "Frozen",
      ts: expect.any(String),
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      kind: "analysis.created",
      text: "Created",
      ts: expect.any(String),
    });
  });
});
