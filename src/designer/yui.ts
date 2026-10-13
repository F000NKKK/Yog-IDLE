// The `.yui` screen format — a XAML-like XML form of a `yog-ui` widget tree
// (see docs/yui.md). `yog build` / `yog ui gen` turn it into Rust builder
// code; this module is the designer's side: parse, edit as a tree of nodes,
// write back.

/** Every element the format knows, in Toolbox order. */
export const KINDS = ["Screen", "Grid", "Canvas", "Column", "Row", "ScrollView", "Label", "Button", "TextBox", "Spacer", "ItemSlot", "InvSlot", "Slot", "PlayerInventory", "Image"] as const;
export type YuiKind = (typeof KINDS)[number];

export interface YuiNode {
  /** Designer-only identity, stable while the document is edited (never written). */
  uid: string;
  /** The element name — a `YuiKind`, or something unknown kept as written. */
  kind: string;
  /** Attributes, as written (strings); an absent attribute means the default. */
  attrs: Record<string, string>;
  children: YuiNode[];
}

export interface YuiDoc {
  /** Everything before the root element (XML declaration, comments), kept verbatim. */
  prolog: string;
  root: YuiNode;
}

export const CONTAINER_KINDS: ReadonlySet<string> = new Set(["Screen", "Grid", "Canvas", "Column", "Row", "ScrollView"]);
/** Containers that position every child absolutely (a missing x/y is 0). */
export const CANVAS_KINDS: ReadonlySet<string> = new Set(["Screen", "Canvas"]);

export const isContainer = (n: YuiNode) => CONTAINER_KINDS.has(n.kind);
export const isCanvas = (n: YuiNode) => CANVAS_KINDS.has(n.kind);
export const isGrid = (n: YuiNode) => n.kind === "Grid";
/** A property element (`<Grid.RowDefinitions>`): part of its parent, not a widget. */
export const isPropertyElement = (n: YuiNode) => n.kind.includes(".");
/** The children that are widgets (property elements skipped). */
export const widgetChildren = (n: YuiNode) => n.children.filter((c) => !isPropertyElement(c));

let nextUid = 0;
export const newUid = () => `n${++nextUid}`;

/** Where attributes go when written — anything else follows in its own order. */
const ATTR_ORDER = [
  "name",
  "display_name",
  "description",
  "icon",
  "category",
  "toolbox",
  "design_w",
  "design_h",
  "type",
  "default",
  "options",
  "doc",
  "id",
  "x",
  "y",
  "w",
  "h",
  "width",
  "height",
  "anchor",
  "rows",
  "columns",
  "row_spacing",
  "column_spacing",
  "Grid.Row",
  "Grid.Column",
  "Grid.RowSpan",
  "Grid.ColumnSpan",
  "min_height",
  "max_height",
  "min_width",
  "max_width",
  "modal",
  "pause",
  "text",
  "placeholder",
  "max_length",
  "item",
  "count",
  "min_w",
  "min_h",
  "flex",
  "dock",
  "halign",
  "valign",
  "margin",
  "gap",
  "padding",
  "align",
  "bg",
  "color",
  "font",
  "font_scale",
  "shadow",
  "no_wrap",
  "ellipsis",
  "focus_style",
  "focus_color",
  "enabled",
  "on_click",
  "on_change",
  "on_submit",
];

/** Namespace given to prefixes `.yui` uses without declaring them (`x:Name`, `x:Bind`, ...). */
const IMPLICIT_NS = "urn:yog-yui:implicit:";

/** An attribute `parseYuiXml` added — not part of the document. */
export function isImplicitXmlns(a: Attr): boolean {
  return a.name.startsWith("xmlns:") && a.value.startsWith(IMPLICIT_NS);
}

/**
 * Parses `.yui` text as XML. Like XAML's `x:`, `.yui` prefixes need no
 * `xmlns` declaration (`yog` doesn't require one), so every undeclared prefix
 * is declared on the root first — flagged by `isImplicitXmlns` so it never
 * reaches the document.
 */
export function parseYuiXml(text: string): Document {
  const declared = new Set(Array.from(text.matchAll(/\sxmlns:([A-Za-z_][\w.-]*)\s*=/g), (m) => m[1]));
  const used = new Set(Array.from(text.matchAll(/[<\s]([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*/g), (m) => m[1]));
  const missing = [...used].filter((p) => p !== "xml" && p !== "xmlns" && !declared.has(p));
  const root = missing.length ? /<(?![?!])[A-Za-z_][\w.:-]*/.exec(text) : null;
  if (root) {
    const at = root.index + root[0].length;
    text = text.slice(0, at) + missing.map((p) => ` xmlns:${p}="${IMPLICIT_NS}${p}"`).join("") + text.slice(at);
  }
  return new DOMParser().parseFromString(text, "application/xml");
}

function fromElement(el: Element): YuiNode {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (!isImplicitXmlns(a)) attrs[a.name] = a.value;
  return { uid: newUid(), kind: el.tagName, attrs, children: Array.from(el.children).map(fromElement) };
}

/** Parses a `.yui` document — throws with the parser's message when it isn't well-formed XML. */
export function parseYui(text: string): YuiDoc {
  const xml = parseYuiXml(text);
  const error = xml.getElementsByTagName("parsererror")[0];
  if (error) throw new Error((error.textContent ?? "").trim().split("\n").slice(0, 2).join(" "));
  const root = xml.documentElement;
  const start = text.search(new RegExp(`<${root.tagName}[\\s/>]`));
  return { prolog: start > 0 ? text.slice(0, start) : "", root: fromElement(root) };
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

/** Where an attribute goes in `ATTR_ORDER` — unknown ones after every known one. */
export function attrRank(name: string): number {
  return ATTR_RANK.get(name) ?? ATTR_ORDER.length;
}

const ATTR_RANK = new Map(ATTR_ORDER.map((k, i) => [k, i]));

export function orderedAttrs(attrs: Record<string, string>): [string, string][] {
  // A stable sort keeps unknown attributes in their written order.
  return Object.keys(attrs)
    .sort((a, b) => attrRank(a) - attrRank(b))
    .map((k) => [k, attrs[k]]);
}

// ── Writing (Visual Studio's XAML formatting) ────────────────────────────────

/** One level of indentation — Visual Studio's XAML default. */
export const INDENT = "    ";
/** More attributes than this, or a longer line, and each attribute gets its own line. */
const MAX_INLINE_ATTRS = 3;
const MAX_LINE = 110;

/**
 * A start tag laid out like Visual Studio's "Position each attribute on a
 * separate line" XAML formatting: short ones on one line, else the first
 * attribute beside the name and every other one on its own line, aligned
 * under it. `attrs` values are already escaped; `indent` is where the tag
 * starts (for the alignment and the line length).
 */
export function formatStartTag(kind: string, attrs: [string, string][], indent: string, close: ">" | " />"): string {
  if (attrs.length === 0) return `<${kind}${close}`;
  const parts = attrs.map(([k, v]) => `${k}="${v}"`);
  const inline = `<${kind} ${parts.join(" ")}${close}`;
  if (parts.length <= MAX_INLINE_ATTRS && indent.length + inline.length <= MAX_LINE) return inline;
  return `<${kind} ${parts.join(`\n${indent}${" ".repeat(kind.length + 2)}`)}${close}`;
}

function writeNode(node: YuiNode, indent: string, out: string[]) {
  const attrs = orderedAttrs(node.attrs).map(([k, v]): [string, string] => [k, escapeAttr(v)]);
  if (node.children.length === 0) {
    out.push(indent + formatStartTag(node.kind, attrs, indent, " />"));
    return;
  }
  out.push(indent + formatStartTag(node.kind, attrs, indent, ">"));
  for (const child of node.children) writeNode(child, indent + INDENT, out);
  out.push(`${indent}</${node.kind}>`);
}

/** `node` written as markup starting at `indent` — the first line without the indent (it's where the caller already is). */
export function writeYuiNode(node: YuiNode, indent: string): string {
  const out: string[] = [];
  writeNode(node, indent, out);
  return out.join("\n").slice(indent.length);
}

/** Writes a document out whole: its prolog as it was, then the tree, formatted (see `formatStartTag`). */
export function serializeYui(doc: YuiDoc): string {
  const out: string[] = [];
  writeNode(doc.root, "", out);
  return doc.prolog + out.join("\n") + "\n";
}

/** Nodes as an XML fragment (for the clipboard). */
export function serializeNodes(nodes: YuiNode[]): string {
  const out: string[] = [];
  for (const n of nodes) writeNode(n, "", out);
  return out.join("\n");
}

/** The inverse of `serializeNodes` — `null` if the text isn't such a fragment. */
export function parseNodes(text: string): YuiNode[] | null {
  try {
    const doc = parseYui(`<Fragment>${text}</Fragment>`);
    return doc.root.children.length > 0 ? doc.root.children : null;
  } catch {
    return null;
  }
}

/**
 * `next` (a fresh parse of edited text) with `prev`'s uids wherever it still
 * has the same node — matched by id, else by position and kind — so the
 * designer's selection survives typing in the XAML.
 */
export function adoptUids(prev: YuiNode, next: YuiNode): YuiNode {
  if (prev.kind !== next.kind) return next;
  const used = new Set<YuiNode>();
  const matches = next.children.map((c) => {
    const match = c.attrs.id ? prev.children.find((p) => !used.has(p) && p.kind === c.kind && p.attrs.id === c.attrs.id) : undefined;
    if (match) used.add(match);
    return match;
  });
  const children = next.children.map((c, i) => {
    let match = matches[i];
    if (!match) {
      const at = prev.children[i];
      if (at && !used.has(at) && at.kind === c.kind && (!at.attrs.id || !c.attrs.id)) {
        used.add(at);
        match = at;
      }
    }
    return match ? adoptUids(match, c) : c;
  });
  return { ...next, uid: prev.uid, children };
}

/** Child indices from the root down to `uid` — `null` if it isn't in the tree. */
export function pathOf(root: YuiNode, uid: string): number[] | null {
  if (root.uid === uid) return [];
  for (let i = 0; i < root.children.length; i++) {
    const rest = pathOf(root.children[i], uid);
    if (rest) return [i, ...rest];
  }
  return null;
}

export function nodeAtPath(root: YuiNode, path: readonly number[]): YuiNode | null {
  let node: YuiNode | undefined = root;
  for (const i of path) node = node?.children[i];
  return node ?? null;
}

/** A copy with fresh uids throughout (pasting, duplicating). */
export function cloneFresh(node: YuiNode): YuiNode {
  return { uid: newUid(), kind: node.kind, attrs: { ...node.attrs }, children: node.children.map(cloneFresh) };
}

// ── Tree helpers (immutable) ─────────────────────────────────────────────────

export function findNode(root: YuiNode, uid: string): YuiNode | null {
  if (root.uid === uid) return root;
  for (const c of root.children) {
    const found = findNode(c, uid);
    if (found) return found;
  }
  return null;
}

export function findParent(root: YuiNode, uid: string): YuiNode | null {
  for (const c of root.children) {
    if (c.uid === uid) return root;
    const found = findParent(c, uid);
    if (found) return found;
  }
  return null;
}

export function isDescendant(root: YuiNode, ancestor: string, uid: string): boolean {
  const a = findNode(root, ancestor);
  return !!a && a.uid !== uid && !!findNode(a, uid);
}

/** `root` with `fn` applied to the node `uid` (returning its replacement). */
export function mapNode(root: YuiNode, uid: string, fn: (n: YuiNode) => YuiNode): YuiNode {
  if (root.uid === uid) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const next = mapNode(c, uid, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function removeNodes(root: YuiNode, uids: ReadonlySet<string>): YuiNode {
  const children = root.children.filter((c) => !uids.has(c.uid)).map((c) => removeNodes(c, uids));
  return children.length === root.children.length && children.every((c, i) => c === root.children[i]) ? root : { ...root, children };
}

export function insertNodes(root: YuiNode, parent: string, index: number, nodes: YuiNode[]): YuiNode {
  return mapNode(root, parent, (p) => {
    const children = [...p.children];
    children.splice(Math.max(0, Math.min(index, children.length)), 0, ...nodes);
    return { ...p, children };
  });
}

/** Sets (or, for `""`/`undefined`, removes) attributes. */
export function withAttrs(node: YuiNode, changes: Record<string, string | undefined>): YuiNode {
  const attrs = { ...node.attrs };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === "") delete attrs[k];
    else attrs[k] = v;
  }
  return { ...node, attrs };
}

// ── Values ────────────────────────────────────────────────────────────────────

/** `#RRGGBB` / `#AARRGGBB` / `0xAARRGGBB` → ARGB, or `null`. */
export function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(?:#|0x)([0-9a-f_]+)$/i);
  if (!m) return null;
  const hex = m[1].replace(/_/g, "");
  if (hex.length === 6) return (0xff000000 | parseInt(hex, 16)) >>> 0;
  if (hex.length === 8) return parseInt(hex, 16) >>> 0;
  return null;
}

/** ARGB → a CSS color. */
export function cssColor(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${a.toFixed(3)})`;
}

export function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** Writes a number as the format expects — integers plainly, others trimmed. */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

// ── Kinds (Toolbox + Properties) ─────────────────────────────────────────────

export interface KindInfo {
  kind: YuiKind;
  /** English, shown through `t`. */
  label: string;
  group: "Containers" | "Common Controls" | "Minecraft";
  description: string;
  /** Attributes a new one starts with. */
  defaults: Record<string, string>;
}

export const KIND_INFO: Record<YuiKind, KindInfo> = {
  Screen: { kind: "Screen", label: "Screen", group: "Containers", description: "The screen itself — the root of a .yui file.", defaults: {} },
  Grid: {
    kind: "Grid",
    label: "Grid Panel",
    group: "Containers",
    description: "Rows and columns like WPF's Grid: children sit in cells (Grid.Row / Grid.Column); rows and columns are Auto, * or pixels.",
    defaults: { w: "120", h: "80", rows: "Auto,*", columns: "*,*" },
  },
  Canvas: {
    kind: "Canvas",
    label: "Canvas",
    group: "Containers",
    description: "A panel whose children are placed freely at x/y.",
    defaults: { w: "80", h: "60", bg: "#40000000" },
  },
  Column: {
    kind: "Column",
    label: "Stack Panel (Column)",
    group: "Containers",
    description: "Stacks its children top to bottom (flex column).",
    defaults: { w: "80", h: "60", gap: "2", padding: "2" },
  },
  Row: {
    kind: "Row",
    label: "Stack Panel (Row)",
    group: "Containers",
    description: "Lays its children out left to right (flex row).",
    defaults: { w: "100", h: "20", gap: "2", padding: "2" },
  },
  ScrollView: {
    kind: "ScrollView",
    label: "Scroll Viewer",
    group: "Containers",
    description: "A column that clips its children and scrolls them, with a scrollbar when they overflow (scroll_y in code).",
    defaults: { w: "80", h: "60", gap: "2", padding: "2", bg: "#40000000" },
  },
  Label: { kind: "Label", label: "Label", group: "Common Controls", description: "Static text.", defaults: { text: "Label", no_wrap: "true" } },
  Button: {
    kind: "Button",
    label: "Button",
    group: "Common Controls",
    description: "Clickable text that raises an on_click event.",
    defaults: { w: "80", h: "20", text: "Button", bg: "#FF555555", color: "#FFFFFF" },
  },
  TextBox: {
    kind: "TextBox",
    label: "Text Box",
    group: "Common Controls",
    description: "A one-line text input: click to focus, type, Enter raises on_submit; each edit raises on_change (TextBoxState in code).",
    defaults: { w: "100", h: "16", placeholder: "Text" },
  },
  Spacer: { kind: "Spacer", label: "Spacer", group: "Common Controls", description: "Invisible space; give it flex to push siblings apart.", defaults: { w: "8", h: "8" } },
  ItemSlot: {
    kind: "ItemSlot",
    label: "Item Slot",
    group: "Minecraft",
    description: "An item icon in an 18×18 slot.",
    defaults: { item: "minecraft:diamond" },
  },
  InvSlot: {
    kind: "InvSlot",
    label: "Inventory Slot",
    group: "Minecraft",
    description: "A vanilla-looking inventory slot with an item and a stack count.",
    defaults: { item: "minecraft:diamond", count: "1" },
  },
  Slot: {
    kind: "Slot",
    label: "Container Slot",
    group: "Minecraft",
    description: "A real slot of the block's inventory (by index): the game draws its item and handles dragging. Where it is in the layout is where the slot is.",
    defaults: { index: "0" },
  },
  PlayerInventory: {
    kind: "PlayerInventory",
    label: "Player Inventory",
    group: "Minecraft",
    description: "The player's inventory on an inventory screen: 3 rows of 9 and the hotbar, real slots.",
    defaults: {},
  },
  Image: {
    kind: "Image",
    label: "Image",
    group: "Minecraft",
    description: "An image: an item or block icon, a GUI sprite or a mod texture (a Yog image source).",
    defaults: { source: "item:apple", w: "16", h: "16" },
  },
};

/** A new widget — a built-in kind or one of the mod's components (no defaults: its properties have their own). */
export function newNode(kind: string): YuiNode {
  return { uid: newUid(), kind, attrs: { ...(KIND_INFO[kind as YuiKind]?.defaults ?? {}) }, children: [] };
}

/** What an empty `.yui` file starts as. */
export function newScreen(id: string): YuiDoc {
  return {
    prolog: "",
    root: { uid: newUid(), kind: "Screen", attrs: { id, width: "176", height: "166", anchor: "center", bg: "#C0101010", padding: "4" }, children: [] },
  };
}
