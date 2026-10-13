// Panels in this shell are independent components with no prop channel
// between them (each `PanelDef.component` takes none) — this is the small,
// app-specific glue that lets Project Explorer (or the debugger, a build
// error, ...) tell the editor area "open this file" despite living in
// entirely separate parts of the dock tree. Only one instance of this bus
// will ever exist in this app, so it's a plain module-level singleton rather
// than a generic reusable factory.

export interface FileOpenRequest {
  path: string;
  /** Tab title — defaults to the path's last segment. */
  name?: string;
  /** 1-based line to reveal and put the cursor on (also for an already-open file). */
  line?: number;
  /** 1-based column on `line` (default: the line's start). */
  column?: number;
  /** Editor provider id to show the file with ("Open With…") — omitted, the tab keeps its view (a new one opens in the default). */
  view?: string;
}

type Listener = (request: FileOpenRequest) => void;

const listeners = new Set<Listener>();

/**
 * Opens `path` in an editor tab — or activates its tab if it's already
 * open — and, given `line`, scrolls to it and puts the cursor there:
 * `openFile({ path, line: 42 })`. A file that can't be read is reported
 * (Output + a notification), never thrown.
 */
export function openFile(request: FileOpenRequest): void {
  listeners.forEach((listener) => listener(request));
}

export function onOpenFileRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
