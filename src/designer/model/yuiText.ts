// The `.yui` text itself, beyond the tree `parseYui` makes of it: where each
// element sits (the split view's selection sync), Format Document, and
// writing a designer edit back as a patch — everything the edit didn't touch
// (formatting, comments, attribute order) stays exactly as the user wrote it.

import { attrRank, escapeAttr, formatStartTag, INDENT, isImplicitXmlns, orderedAttrs, parseYui, parseYuiXml, serializeYui, writeYuiNode, type YuiDoc, type YuiNode } from "./yui";

export interface AttrSpan {
  name: string;
  start: number;
  /** After the closing quote. */
  end: number;
  valueStart: number;
  valueEnd: number;
  quote: string;
}

/** Where an element is in the text; offsets are UTF-16 indices, like CodeMirror's. */
export interface ElementSpan {
  name: string;
  start: number;
  /** After the start tag's `>` (or `/>`). */
  tagEnd: number;
  selfClosing: boolean;
  attrs: AttrSpan[];
  children: ElementSpan[];
  /** The end tag's `<` — `tagEnd` for a self-closing one. */
  closeStart: number;
  end: number;
}

const NAME = /[A-Za-z_][\w:.-]*/y;
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Every element's position in `text` — `null` when it isn't well-formed enough to tell. */
export function scanYui(text: string): ElementSpan | null {
  const stack: ElementSpan[] = [];
  let root: ElementSpan | null = null;
  let pos = 0;
  const skipTo = (from: number, end: string) => {
    const i = text.indexOf(end, from);
    return i < 0 ? -1 : i + end.length;
  };
  const name = (at: number) => {
    NAME.lastIndex = at;
    return NAME.exec(text)?.[0] ?? null;
  };
  for (;;) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    pos = lt;
    if (text.startsWith("<!--", pos) || text.startsWith("<![CDATA[", pos) || text.startsWith("<?", pos) || text.startsWith("<!", pos)) {
      const end = text.startsWith("<!--", pos) ? "-->" : text.startsWith("<![CDATA[", pos) ? "]]>" : text.startsWith("<?", pos) ? "?>" : ">";
      pos = skipTo(pos + 2, end);
      if (pos < 0) return null;
      continue;
    }
    if (text.startsWith("</", pos)) {
      const closing = name(pos + 2);
      const el = stack.pop();
      if (!closing || !el || el.name !== closing) return null;
      const gt = skipTo(pos + 2 + closing.length, ">");
      if (gt < 0) return null;
      el.closeStart = pos;
      el.end = gt;
      if (stack.length === 0) root = el;
      pos = gt;
      continue;
    }
    const tag = name(pos + 1);
    if (!tag || (stack.length === 0 && root)) return null;
    const el: ElementSpan = { name: tag, start: pos, tagEnd: 0, selfClosing: false, attrs: [], children: [], closeStart: 0, end: 0 };
    let p = pos + 1 + tag.length;
    for (;;) {
      while (isSpace(text[p])) p++;
      if (p >= text.length) return null;
      if (text.startsWith("/>", p)) {
        el.selfClosing = true;
        p += 2;
        break;
      }
      if (text[p] === ">") {
        p++;
        break;
      }
      const attr = name(p);
      if (!attr) return null;
      const start = p;
      p += attr.length;
      while (isSpace(text[p])) p++;
      if (text[p] !== "=") return null;
      p++;
      while (isSpace(text[p])) p++;
      const quote = text[p];
      if (quote !== '"' && quote !== "'") return null;
      const close = text.indexOf(quote, p + 1);
      if (close < 0) return null;
      el.attrs.push({ name: attr, start, end: close + 1, valueStart: p + 1, valueEnd: close, quote });
      p = close + 1;
    }
    el.tagEnd = p;
    stack[stack.length - 1]?.children.push(el);
    if (el.selfClosing) {
      el.closeStart = el.end = p;
      if (stack.length === 0) root = el;
    } else stack.push(el);
    pos = p;
  }
  return stack.length === 0 ? root : null;
}

/** The child-index path of the innermost element around `offset`. */
export function pathAt(root: ElementSpan, offset: number): number[] {
  const path: number[] = [];
  let el = root;
  for (;;) {
    const i = el.children.findIndex((c) => c.start <= offset && offset <= c.end);
    if (i < 0) return path;
    path.push(i);
    el = el.children[i];
  }
}

export function spanAtPath(root: ElementSpan, path: readonly number[]): ElementSpan | null {
  let el: ElementSpan | undefined = root;
  for (const i of path) el = el?.children[i];
  return el ?? null;
}

/** The whitespace before `pos` on its line — `null` if something else precedes it there. */
function lineIndent(text: string, pos: number): string | null {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(start, pos);
  return /^[ \t]*$/.test(before) ? before : null;
}

/** Shifts every line after the first from `from` indentation to `to`. */
function reindent(s: string, from: string, to: string): string {
  if (from === to) return s;
  return s
    .split("\n")
    .map((line, i) => (i > 0 && line.startsWith(from) ? to + line.slice(from.length) : line))
    .join("\n");
}

/** Pairs the tree `prev` was parsed into with the elements of the text it came from. */
function align(node: YuiNode, span: ElementSpan, spans: Map<string, ElementSpan>, nodes: Map<string, YuiNode>): boolean {
  if (node.kind !== span.name || node.children.length !== span.children.length) return false;
  spans.set(node.uid, span);
  nodes.set(node.uid, node);
  return node.children.every((c, i) => align(c, span.children[i], spans, nodes));
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] === a[k]);
}

/**
 * `text` (which `prev` was parsed from) rewritten to say `next` — a designer
 * edit of `prev`. Elements the edit didn't touch keep their text byte for
 * byte; a changed value is replaced in place; a start tag that gained or
 * lost attributes is laid out again (`formatStartTag`); new elements are
 * written formatted; moved ones keep their text, re-indented. Falls back to
 * writing the whole document if the text and `prev` don't match up.
 */
export function patchYui(text: string, prev: YuiDoc, next: YuiDoc): string {
  const root = scanYui(text);
  const spans = new Map<string, ElementSpan>();
  const before = new Map<string, YuiNode>();
  if (!root || !align(prev.root, root, spans, before)) return serializeYui(next);
  const firstChild = root.children[0];
  const rootIndent = lineIndent(text, root.start) ?? "";
  const childIndent = firstChild ? lineIndent(text, firstChild.start) : null;
  const unit = childIndent && childIndent.length > rootIndent.length ? childIndent.slice(rootIndent.length) : INDENT;

  const startTag = (node: YuiNode, old: YuiNode, span: ElementSpan, indent: string, close: ">" | " />"): string => {
    const raw = (a: AttrSpan) => {
      const value = text.slice(a.valueStart, a.valueEnd);
      return a.quote === "'" ? value.replace(/"/g, "&quot;") : value;
    };
    const oldKeys = Object.keys(old.attrs);
    const sameKeys = oldKeys.length === Object.keys(node.attrs).length && oldKeys.every((k) => k in node.attrs);
    if (sameKeys) {
      // Only values changed: replace them where they are.
      let tag = text.slice(span.start, span.tagEnd);
      for (const a of [...span.attrs].reverse()) {
        if (node.attrs[a.name] === old.attrs[a.name]) continue;
        const value = a.quote === "'" ? escapeAttr(node.attrs[a.name]).replace(/&quot;/g, '"').replace(/'/g, "&apos;") : escapeAttr(node.attrs[a.name]);
        tag = tag.slice(0, a.valueStart - span.start) + value + tag.slice(a.valueEnd - span.start);
      }
      if (close === " />" && !span.selfClosing) return tag.replace(/\s*>$/, " />");
      return close === ">" && span.selfClosing ? tag.replace(/\s*\/>$/, ">") : tag;
    }
    // Attributes came or went: keep the written order, slot new ones in by `ATTR_ORDER`.
    const list: [string, string][] = span.attrs
      .filter((a) => a.name in node.attrs)
      .map((a): [string, string] => [a.name, node.attrs[a.name] === old.attrs[a.name] ? raw(a) : escapeAttr(node.attrs[a.name])]);
    for (const [k, v] of orderedAttrs(node.attrs)) {
      if (k in old.attrs) continue;
      let at = 0;
      list.forEach(([name], i) => {
        if (attrRank(name) <= attrRank(k)) at = i + 1;
      });
      list.splice(at, 0, [k, escapeAttr(v)]);
    }
    return formatStartTag(node.kind, list, indent, close);
  };

  const render = (node: YuiNode, indent: string): string => {
    const span = spans.get(node.uid);
    const old = before.get(node.uid);
    if (!span || !old) return writeYuiNode(node, indent);
    const at = lineIndent(text, span.start) ?? indent;
    return reindent(renderAt(node, old, span, at), at, indent);
  };

  /** `node` (`old` before the edit, at `span`) written for its old indentation `at`. */
  const renderAt = (node: YuiNode, old: YuiNode, span: ElementSpan, at: string): string => {
    if (node === old) return text.slice(span.start, span.end);
    const kids = node.children.length > 0;
    const close = !kids && (span.selfClosing || old.children.length > 0) ? " />" : ">";
    let open: string;
    if (sameAttrs(old.attrs, node.attrs)) {
      open = text.slice(span.start, span.tagEnd);
      if (close === ">" && span.selfClosing) open = open.replace(/\s*\/>$/, ">");
      else if (close === " />" && !span.selfClosing) open = open.replace(/\s*>$/, " />");
    } else open = startTag(node, old, span, at, close);
    if (close === " />") return open;
    if (!kids) return open + text.slice(span.tagEnd, span.end);
    const firstOld = span.children[0];
    const kidIndent = (firstOld && lineIndent(text, firstOld.start)) || at + unit;
    if (old.children.length === 0) {
      return `${open}${node.children.map((c) => `\n${kidIndent}${render(c, kidIndent)}`).join("")}\n${at}</${node.kind}>`;
    }
    // The text between children (whitespace, comments) goes with the child after it.
    const gapBefore = (i: number) => text.slice(i === 0 ? span.tagEnd : span.children[i - 1].end, span.children[i].start);
    const oldIndex = new Map<string, number>();
    old.children.forEach((o, i) => oldIndex.has(o.uid) || oldIndex.set(o.uid, i));
    let inner = "";
    for (const c of node.children) {
      const k = oldIndex.get(c.uid) ?? -1;
      inner += (k >= 0 ? gapBefore(k) : `\n${kidIndent}`) + render(c, kidIndent);
    }
    const tail = text.slice(span.children[span.children.length - 1].end, span.closeStart);
    return open + inner + tail + text.slice(span.closeStart, span.end);
  };

  return text.slice(0, root.start) + render(next.root, rootIndent) + text.slice(root.end);
}

/**
 * Format Document for `.yui`: Visual Studio's XAML layout (`formatStartTag`,
 * four-space indentation, attributes in `ATTR_ORDER`), keeping the prolog,
 * comments, and single blank lines between elements. Throws on invalid markup.
 */
export function formatYui(text: string): string {
  parseYui(text);
  const xml = parseYuiXml(text);
  const span = scanYui(text);
  const prolog = span ? text.slice(0, span.start).trim() : "";
  const epilogue = span ? text.slice(span.end).trim() : "";
  const out: string[] = [];
  writeElement(xml.documentElement, "", out);
  return `${prolog ? `${prolog}\n` : ""}${out.join("\n")}\n${epilogue ? `${epilogue}\n` : ""}`;
}

function writeElement(el: Element, indent: string, out: string[]) {
  const attrs = orderedAttrs(Object.fromEntries(Array.from(el.attributes).filter((a) => !isImplicitXmlns(a)).map((a) => [a.name, a.value]))).map(([k, v]): [string, string] => [k, escapeAttr(v)]);
  const nodes = Array.from(el.childNodes).filter((n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim() !== "" || /\n[ \t]*\r?\n/.test(n.textContent ?? ""));
  if (!nodes.some((n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim())) {
    out.push(indent + formatStartTag(el.tagName, attrs, indent, " />"));
    return;
  }
  out.push(indent + formatStartTag(el.tagName, attrs, indent, ">"));
  const inner = indent + INDENT;
  let wrote = false;
  let blank = false;
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim()) {
      blank = wrote;
      continue;
    }
    if (blank) out.push("");
    blank = false;
    wrote = true;
    if (n.nodeType === Node.ELEMENT_NODE) writeElement(n as Element, inner, out);
    else if (n.nodeType === Node.COMMENT_NODE) out.push(`${inner}<!--${(n as Comment).data}-->`);
    else if (n.nodeType === Node.TEXT_NODE) out.push(inner + (n.textContent ?? "").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  }
  out.push(`${indent}</${el.tagName}>`);
}
