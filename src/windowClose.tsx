import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * What runs when the window is asked to close (the title bar's close
 * button, File > Exit, Alt+F4): every `guard` first — any resolving `false`
 * (e.g. the user cancelled a "save changes?" prompt) keeps the window open
 * — then every `flush` (writing remembered state to disk), then the window
 * closes. Handlers live outside React so any provider can register one.
 */
type CloseGuard = () => Promise<boolean> | boolean;
type CloseFlush = () => Promise<void> | void;

const guards = new Set<CloseGuard>();
const flushes = new Set<CloseFlush>();

export function addCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

export function addCloseFlush(flush: CloseFlush): () => void {
  flushes.add(flush);
  return () => flushes.delete(flush);
}

/** Installs the one `onCloseRequested` listener running the handlers above — call once, at the app root. */
export function installCloseHandler(): () => void {
  let closing = false;
  const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
    // A second request while the first is still asking — let the first decide.
    if (closing) {
      event.preventDefault();
      return;
    }
    closing = true;
    try {
      for (const guard of [...guards]) {
        if (!(await guard())) {
          event.preventDefault();
          return;
        }
      }
      for (const flush of [...flushes]) {
        try {
          await flush();
        } catch {
          // Never let failing to save UI state keep the window open.
        }
      }
    } finally {
      closing = false;
    }
  });
  return () => {
    unlisten.then((un) => un());
  };
}
