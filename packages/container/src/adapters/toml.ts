/**
 * The smallest TOML writer the Codex config needs (spec 0010 §4): scalar
 * strings, booleans, numbers, string arrays, and nested tables. Keys are
 * quoted unless bare-safe, strings are escaped, so a server name or a
 * header value can never break out of its own line.
 */

export type TomlValue = string | number | boolean | string[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

/** Backslash, double quote, and every C0 control character are escaped. */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += char;
  }
  return out + '"';
}

function isTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: string | number | boolean | string[]): string {
  if (typeof value === "string") return tomlString(value);
  if (Array.isArray(value)) return "[" + value.map(tomlString).join(", ") + "]";
  return String(value);
}

/** One block per table that has scalars: its header (unless top-level) and its lines. */
function blocks(table: TomlTable, prefix: string[]): string[] {
  const lines: string[] = [];
  const nested: [string, TomlTable][] = [];
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) nested.push([key, value]);
    else lines.push(`${tomlKey(key)} = ${scalar(value)}`);
  }
  // A table with nothing but sub-tables needs no header of its own:
  // TOML defines it implicitly through its children.
  const own =
    lines.length > 0
      ? [(prefix.length > 0 ? `[${prefix.map(tomlKey).join(".")}]\n` : "") + lines.join("\n") + "\n"]
      : [];
  return [...own, ...nested.flatMap(([key, value]) => blocks(value, [...prefix, key]))];
}

/** Render a table: scalars first, then every nested table as its own [a.b] block, blank-line separated. */
export function renderToml(table: TomlTable): string {
  return blocks(table, []).join("\n");
}
