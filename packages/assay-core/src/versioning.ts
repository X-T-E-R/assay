import { CURRENT_VERSION } from "./constants.js";
import { FrameworkError } from "./errors.js";

function numericVersion(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    throw new FrameworkError(`invalid Assay version '${value}'`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertSupportedAssayVersion(minimumVersion: string | undefined): void {
  if (minimumVersion && compareVersions(CURRENT_VERSION, minimumVersion) < 0) {
    throw new FrameworkError(
      `workspace requires Assay ${minimumVersion} or newer; this build is ${CURRENT_VERSION}`,
    );
  }
}
