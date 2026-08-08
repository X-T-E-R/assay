import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { EVENTS_DIR } from "./constants.js";
import { InvalidEventError } from "./errors.js";
import { stringifySortedJson } from "./serialization.js";
import { nowIso } from "./time.js";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function eventPath(root: string, when = new Date()): string {
  return path.join(root, EVENTS_DIR, `${when.getFullYear()}-${pad(when.getMonth() + 1)}.jsonl`);
}

export async function appendEvent(
  root: string,
  event: Record<string, unknown>,
  when = new Date(),
): Promise<string> {
  if (event.ts !== undefined && (typeof event.ts !== "string" || event.ts.length === 0)) {
    throw new InvalidEventError("Event timestamp must be a non-empty string.");
  }
  const persisted = { ...event, ts: typeof event.ts === "string" ? event.ts : nowIso(when) };
  const file = eventPath(root, when);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, stringifySortedJson(persisted, 0), "utf8");
  return file;
}
