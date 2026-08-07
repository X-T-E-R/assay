/** Stable, path-safe identifiers used by Assay-native semantic records. */

export type ReadableIdKind = "project" | "task" | "roadmap";

const SLUG_MAX_LENGTH = 48;

export function readableIdSlug(value: string, maxLength = SLUG_MAX_LENGTH): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized.slice(0, maxLength).replace(/-+$/g, "");
}

export function isReadableId(kind: ReadableIdKind, value: string): boolean {
  if (kind === "project") return /^project-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  return new RegExp(`^${kind}-(?:0*\\d{4,})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$`).test(value);
}

export function assertReadableId(kind: ReadableIdKind, value: string): string {
  if (!isReadableId(kind, value)) throw new Error(`invalid ${kind} id: ${value}`);
  return value;
}

export function projectReadableId(name: string): string {
  return `project-${readableIdSlug(name) || "main"}`;
}

export function readableSequence(id: string, kind: "task" | "roadmap"): number | undefined {
  const match = new RegExp(`^${kind}-(\\d{4,})(?:-|$)`).exec(id.toLowerCase());
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

export function allocateReadableId(
  kind: "task" | "roadmap",
  title: string,
  existingIds: Iterable<string>,
): string {
  let maximum = 0;
  const occupied = new Set<string>();
  for (const id of existingIds) {
    occupied.add(id.toLowerCase());
    const sequence = readableSequence(id, kind);
    if (sequence !== undefined) maximum = Math.max(maximum, sequence);
  }
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${kind} id sequence exceeds the safe integer range`);
  }
  const sequence = String(maximum + 1).padStart(4, "0");
  const slug = readableIdSlug(title);
  const id = `${kind}-${sequence}${slug ? `-${slug}` : ""}`;
  if (occupied.has(id.toLowerCase())) {
    throw new Error(`${kind} id allocation collided with existing storage: ${id}`);
  }
  return id;
}
