// The mod's own `.yui` components (docs/yui.md, "Components"): `.yui` files
// with a `<Component>` root. The backend lists them from their markup (no
// build) and tells whether the designer library — needed only for
// components whose bindings call code — is building, ready or broken.
// Polled while a designer is open, shared by the designer, Toolbox and
// Properties.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { YuiNode } from "./yui";

export interface ComponentProp {
  name: string;
  /** `text`, `number`, `int`, `bool`, `color`, `choice`, `image` or `event`. */
  kind: string;
  default: string;
  doc: string;
  /** The property grid category (empty: the component's own). */
  category: string;
  options: string[];
}

/** A component and its designer metadata — texts may be `@Set.key` (resolve with `designText`). */
export interface ComponentInfo {
  name: string;
  /** Toolbox tooltip and property grid description. */
  description: string;
  /** The toolbox label (empty: `name`). */
  display_name: string;
  /** A Yog image source or `@Icons.x` (empty: a glyph). */
  icon: string;
  /** The toolbox category (empty: "<mod> Components"). */
  category: string;
  /** Canvas size for editing it, and an instance's size when dropped (0: unset). */
  design_w: number;
  design_h: number;
  /** Whether the toolbox offers it. */
  toolbox: boolean;
  props: ComponentProp[];
  /** The `.yui` declaring it. */
  file?: string;
}

export interface ComponentsSnapshot {
  status: "none" | "building" | "ready" | "failed";
  error: string | null;
  components: ComponentInfo[];
  /** The ones drawn by the mod's library (their bindings call code). */
  compiled: string[];
  /** Changes whenever an instance's drawing may (a component edited, the library rebuilt). */
  revision: string;
  modName: string;
}

const POLL_MS = 1500;

const snapshots = new Map<string, ComponentsSnapshot>();
const keys = new Map<string, string>();
const pollers = new Map<string, { users: number; timer: ReturnType<typeof setInterval> }>();
const listeners = new Set<() => void>();

function poll(path: string) {
  invoke<ComponentsSnapshot>("yui_designer_components", { path })
    .then((s) => {
      const key = JSON.stringify(s);
      if (keys.get(path) === key) return;
      keys.set(path, key);
      snapshots.set(path, s);
      listeners.forEach((notify) => notify());
    })
    .catch(() => {
      if (!snapshots.has(path)) return;
      snapshots.delete(path);
      keys.delete(path);
      listeners.forEach((notify) => notify());
    });
}

function acquire(path: string) {
  const p = pollers.get(path);
  if (p) {
    p.users++;
    return;
  }
  poll(path);
  pollers.set(path, { users: 1, timer: setInterval(() => poll(path), POLL_MS) });
}

function release(path: string) {
  const p = pollers.get(path);
  if (!p || --p.users > 0) return;
  clearInterval(p.timer);
  pollers.delete(path);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** The components of the mod `path` (a `.yui` file) belongs to, kept fresh while used. */
export function useComponents(path: string | null | undefined): ComponentsSnapshot | null {
  useEffect(() => {
    if (!path) return;
    acquire(path);
    return () => release(path);
  }, [path]);
  return useSyncExternalStore(subscribe, () => (path ? (snapshots.get(path) ?? null) : null));
}

export function findComponent(snapshot: ComponentsSnapshot | null, kind: string): ComponentInfo | null {
  return snapshot?.components.find((c) => c.name === kind) ?? null;
}

// ── Component documents ────────────────────────────────────────────────────

/** Children of a `<Component>` that declare rather than draw. */
const DECLARATION_KINDS: ReadonlySet<string> = new Set(["Property", "Event"]);

export const isComponentDoc = (root: YuiNode) => root.kind === "Component";

/** A component document's body (its one drawn element), if it has one. */
export function componentBody(root: YuiNode): YuiNode | null {
  return isComponentDoc(root) ? (root.children.find((c) => !DECLARATION_KINDS.has(c.kind)) ?? null) : null;
}

/** The expression of a `{x:Bind expr[, options]}` value. */
function bindingExpr(value: string): string | null {
  const m = /^\s*\{x:Bind\s*(.*)\}\s*$/s.exec(value);
  if (!m) return null;
  let depth = 0;
  let quote = false;
  const inner = m[1];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") quote = !quote;
    else if (!quote && c === "(") depth++;
    else if (!quote && c === ")") depth--;
    else if (!quote && depth === 0 && c === ",") return inner.slice(0, i).trim();
  }
  return inner.trim();
}

function bindValues(node: YuiNode, values: Record<string, string>): YuiNode {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith("d:")) continue;
    const e = bindingExpr(v);
    if (e === null) attrs[k] = v;
    else if (e in values) attrs[k] = values[e];
    else if (k === "text" || k === "placeholder") attrs[k] = `{${e}}`;
  }
  for (const [k, v] of Object.entries(node.attrs)) if (k.startsWith("d:")) attrs[k.slice(2)] = v;
  return { ...node, attrs, children: node.children.map((c) => bindValues(c, values)) };
}

/**
 * A component document as the designer lays it out (mirrors the backend's
 * `design_root`): a screen of its design size holding the body, bound to
 * the properties' defaults. Uids are kept.
 */
export function designRoot(root: YuiNode): YuiNode {
  if (!isComponentDoc(root)) return root;
  const values: Record<string, string> = {};
  for (const c of root.children) if (c.kind === "Property" && c.attrs.name) values[c.attrs.name] = c.attrs.default ?? "";
  // A recipe layout is its own size; a component's design size is a preview's.
  const layout = root.attrs.recipe_layout !== undefined;
  const attrs: Record<string, string> = {
    width: (layout ? root.attrs.width : root.attrs.design_w) ?? "120",
    height: (layout ? root.attrs.height : root.attrs.design_h) ?? "40",
    anchor: "center",
  };
  if (root.attrs["d:bg"]) attrs.bg = root.attrs["d:bg"];
  return { uid: root.uid, kind: "Screen", attrs, children: root.children.filter((c) => !DECLARATION_KINDS.has(c.kind)).map((c) => bindValues(c, values)) };
}

/** `stat_bar` → `StatBar`. */
export function pascalName(stem: string): string {
  return stem
    .split(/[_-]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join("");
}
