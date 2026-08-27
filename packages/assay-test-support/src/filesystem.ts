import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Environment variable that names this run's workspace fixture root. */
export const FIXTURE_ROOT_ENV = "ASSAY_TEST_FIXTURE_ROOT";

/**
 * One directory per run for every workspace fixture.
 *
 * Fixtures used to land loose in the shared temp directory, indistinguishable
 * from every other process's scratch files. Keeping them together means a
 * crashed run's leftovers are identifiable and a gate can clear them in one
 * sweep instead of globbing the whole temp directory.
 */
export function fixtureRoot(): string {
  const configured = process.env[FIXTURE_ROOT_ENV];
  if (configured && configured.trim() !== "") return configured;
  return path.join(tmpdir(), `assay-test-fixtures-${process.pid}`);
}

/** A fresh, unused path for one workspace fixture inside this run's root. */
export function fixturePath(name: string): string {
  return path.join(fixtureRoot(), `${name}-${randomUUID()}`);
}

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
      const parent = fixtureRoot();
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(path.join(parent, normalizedPrefix));
      roots.push(root);
      return root;
    },
    async cleanup() {
      await Promise.all(
        roots
          .splice(0)
          .map((root) =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
          ),
      );
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
