import { t } from "substrate-platform-ui";

/** Whether `path` is `ancestor` itself or anywhere beneath it. */
export function isWithin(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  const base = ancestor.replace(/[/\\]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/** The last segment of `path` — a file's display name. */
export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** The lowercased extension of `path` (without the dot), or `""`. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether two paths name the same file — separators normalized, and a relative path (as debug info sometimes records, e.g. `src/lib.rs`) matches an absolute one ending in it. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** A name for a new/renamed file or folder: `null` if usable, else why not (`""` for blank — nothing worth saying). */
export function validateEntryName(value: string): string | null {
  const name = value.trim();
  if (!name) return "";
  if (/[/\\]/.test(name)) return t("A name can't contain / or \\.");
  if (name === "." || name === "..") return t("Not a valid name.");
  return null;
}

/** `path` with its last segment replaced by `name` — where a rename moves it. */
export function renamedPath(path: string, name: string): string {
  return path.replace(/[^/\\]+$/, name);
}
