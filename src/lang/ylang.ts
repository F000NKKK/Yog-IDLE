/**
 * `.ylang` translation files (see docs/ylang.md): one JSON object of
 * translation keys in file order, each value either the text or
 * `{ "value": "...", "comment": "..." }`. Parsed by hand rather than with
 * `JSON.parse`, which would reorder integer-like keys and silently merge
 * duplicates — the editor shows both as they are in the file.
 */

export interface YlangEntry {
  key: string;
  value: string;
  /** Design-time note for translators — dropped by `yog build`. */
  comment?: string;
  /** 1-based line of the key. */
  line?: number;
}

export type YlangParse = { ok: true; entries: YlangEntry[] } | { ok: false; error: string; line: number };

export const REFERENCE_LOCALE = "en_us";

class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message);
  }
}

/** Parses `.ylang` text, duplicate keys kept (the editor flags them; `yog build` rejects them). */
export function parseYlang(text: string): YlangParse {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new ParseError(i >= text.length ? `${message}, found the end of the file` : message, line);
  };
  const ws = () => {
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") line++;
      else if (c !== " " && c !== "\t" && c !== "\r") break;
    }
  };
  const eat = (c: string) => {
    if (text[i] !== c) return false;
    i++;
    return true;
  };
  const string = (): string => {
    if (text[i] !== '"') fail("expected a string");
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("unterminated string (use \\n for a line break)");
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) fail("unterminated string");
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("invalid string escape");
    }
  };
  const valueObject = (key: string): [string, string | undefined] => {
    const startLine = line;
    eat("{");
    let value: string | undefined;
    let comment: string | undefined;
    ws();
    if (!eat("}")) {
      for (;;) {
        ws();
        const field = string();
        ws();
        if (!eat(":")) fail("expected `:`");
        ws();
        if (text[i] !== '"') fail(`"${key}": \`${field}\` must be a string`);
        const v = string();
        if (field === "value") value = v;
        else if (field === "comment") comment = v;
        else fail(`"${key}": unknown field \`${field}\` (expected \`value\` and optionally \`comment\`)`);
        ws();
        if (eat(",")) continue;
        if (eat("}")) break;
        fail("expected `,` or `}`");
      }
    }
    if (value === undefined) throw new ParseError(`"${key}": missing \`value\``, startLine);
    return [value, comment];
  };

  try {
    ws();
    if (!eat("{")) fail("expected `{` — a .ylang file is one JSON object of translation keys");
    const entries: YlangEntry[] = [];
    ws();
    if (!eat("}")) {
      for (;;) {
        ws();
        const keyLine = line;
        const key = string();
        ws();
        if (!eat(":")) fail("expected `:` after the key");
        ws();
        let value: string;
        let comment: string | undefined;
        if (text[i] === '"') value = string();
        else if (text[i] === "{") [value, comment] = valueObject(key);
        else return fail(`"${key}": the value must be a string or { "value": "...", "comment": "..." }`);
        entries.push(comment === undefined ? { key, value, line: keyLine } : { key, value, comment, line: keyLine });
        ws();
        if (eat(",")) continue;
        if (eat("}")) break;
        fail("expected `,` or `}`");
      }
    }
    ws();
    if (i < text.length) fail("unexpected text after the closing `}`");
    return { ok: true, entries };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, line: e.line };
    throw e;
  }
}

/** `.ylang` text for `entries`: 2-space indent, file order, a value object only where there's a comment. */
export function serializeYlang(entries: YlangEntry[]): string {
  if (entries.length === 0) return "{\n}\n";
  const lines = entries.map((e) => {
    const key = JSON.stringify(e.key);
    const value = JSON.stringify(e.value);
    return e.comment ? `  ${key}: { "value": ${value}, "comment": ${JSON.stringify(e.comment)} }` : `  ${key}: ${value}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** Minecraft's locale codes: lower case, `en_us`, `pt_br`, `lol_us`, ... */
export function isLocaleName(name: string): boolean {
  return /^[a-z]{2,3}_[a-z0-9]{2,4}$/.test(name);
}

/** `<dir>`, `<locale>` and the separator of a `.ylang` path. */
export function splitYlangPath(path: string): { dir: string; locale: string; sep: string } {
  const sep = path.includes("\\") ? "\\" : "/";
  const cut = path.lastIndexOf(sep);
  const name = path.slice(cut + 1);
  return { dir: path.slice(0, cut), locale: name.replace(/\.ylang$/i, ""), sep };
}

/** Text of a parsed `.ylang`'s keys — `key → value` (the first one for a duplicated key). */
export function valueMap(entries: YlangEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) if (!map.has(e.key)) map.set(e.key, e.value);
  return map;
}
