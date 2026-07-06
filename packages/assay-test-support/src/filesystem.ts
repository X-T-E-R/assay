import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempDirectoryFixture {
  readonly roots: readonly string[];
  createTempDir(): Promise<string>;
  cleanup(): Promise<void>;
}

export function createTempDirectoryFixture(prefix: string): TempDirectoryFixture {
  const roots: string[] = [];
  const normalizedPrefix = prefix.endsWith("-") ? prefix : `${prefix}-`;

  return {
    get roots() {
      return [...roots];
    },
    async createTempDir() {
      const root = await mkdtemp(path.join(tmpdir(), normalizedPrefix));
      roots.push(root);
      return root;
    },
    async cleanup() {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

export async function pathExists(target: string): Promise<boolean> {
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
