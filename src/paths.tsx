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

/** Where `yog` generates screen code, under a mod project's root. */
export const GENERATED_DIR = ".yog-build/generated";

/**
 * The generated code of `path` in the project at `root`, or `null`:
 * - screen `src/foo/bar.yui` → `<root>/.yog-build/generated/foo/bar.g.rs`
 *   (what `yog ui gen` writes and `yog_api::ui_include!("foo/bar")` pulls in);
 * - resource set `resources/[…/]Strings.yres` (the neutral file, not a
 *   culture variant like `Strings.ru_ru.yres`) →
 *   `<root>/.yog-build/generated/resources/Strings.g.rs` (included by
 *   `yog_api::resources!()`).
 */
export function generatedCodePath(root: string, path: string): string | null {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[/\\]+$/, "");
  const join = (...parts: string[]) => [base, ...GENERATED_DIR.split("/"), ...parts].join(sep).replace(/[/\\]/g, sep);
  const ext = extensionOf(path);
  if (ext === "yres") {
    if (!isWithin(path, `${base}${sep}resources`)) return null;
    const set = /([^/\\]+)\.yres$/i.exec(path)?.[1];
    return set && !set.includes(".") ? join("resources", `${set}.g.rs`) : null;
  }
  const src = `${base}${sep}src`;
  if (!isWithin(path, src) || ext !== "yui") return null;
  const rel = path.slice(src.length + 1).replace(/\.yui$/i, "");
  return join(`${rel}.g.rs`);
}

/** Whether `path` is the generated code of a `.yres` resource set (`.yog-build/generated/resources/<Set>.g.rs`). */
export function isGeneratedResources(path: string): boolean {
  return /[/\\]\.yog-build[/\\]generated[/\\]resources[/\\][^/\\]+\.g\.rs$/i.test(path);
}

/** Whether `path` is generated code (`.yog-build/generated/**`), opened read-only with a notice. */
export function isGeneratedCode(path: string): boolean {
  return /[/\\]\.yog-build[/\\]generated[/\\].+\.g\.rs$/i.test(path);
}
