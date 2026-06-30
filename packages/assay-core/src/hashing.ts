import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function computeHash(text: string): string {
  return createHash("sha256").update(normalizeText(text), "utf8").digest("hex");
}

export async function fileHash(path: string): Promise<string> {
  return computeHash(await readFile(path, "utf8"));
}
