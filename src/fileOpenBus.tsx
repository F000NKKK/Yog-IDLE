// Panels in this shell are independent components with no prop channel
// between them (each `PanelDef.component` takes none) — this is the small,
// app-specific glue that lets Project Explorer tell the Editor panel "open
// this file" despite living in entirely separate parts of the dock tree.
// Only one instance of this bus will ever exist in this app, so it's a plain
// module-level singleton rather than a generic reusable factory.

export interface FileOpenRequest {
  path: string;
  name: string;
}

type Listener = (request: FileOpenRequest) => void;

const listeners = new Set<Listener>();

export function requestOpenFile(request: FileOpenRequest): void {
  listeners.forEach((listener) => listener(request));
}

export function onOpenFileRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
