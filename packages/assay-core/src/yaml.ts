/**
 * Scalar rendering for the frontmatter Assay writes by hand.
 *
 * Records whose body must stay byte-identical to what was hashed (intent
 * captures, promoted requirements, ADR markdown) build their frontmatter as
 * text instead of running it through a YAML serializer. That makes escaping a
 * correctness boundary rather than a formatting detail: a value carrying a
 * newline would close the frontmatter block early, and the record would parse
 * as something other than what was written — or stop parsing at all.
 */

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** C0 controls and DEL are never legal raw inside a double-quoted scalar. */
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function escapeControl(character: string, code: number): string {
  return NAMED_ESCAPES[character] ?? `\\x${code.toString(16).padStart(2, "0")}`;
}

/**
 * Render a value as a YAML double-quoted scalar that parses back to exactly
 * the string given.
 */
export function yamlString(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") {
      escaped += "\\\\";
    } else if (character === '"') {
      escaped += '\\"';
    } else if (isControl(code)) {
      escaped += escapeControl(character, code);
    } else {
      escaped += character;
    }
  }
  return `"${escaped}"`;
}

/** Render a nullable value: an unquoted `null` or a quoted scalar. */
export function yamlNullable(value: string | null): string {
  return value === null ? "null" : yamlString(value);
}

/** Render a flow sequence of quoted scalars. */
export function yamlArray(values: readonly string[]): string {
  return `[${values.map((value) => yamlString(value)).join(", ")}]`;
}
