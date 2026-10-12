// Project > Properties can be asked for from the menu bar, Alt+Enter, or the
// Project Explorer's context menu on the project node — none of which share
// a prop channel with `App`, which owns the window. Like `fileOpenBus`.

/** The page ids of the Project Properties window. */
export type ProjectPropertiesPage = "application" | "build" | "debug" | "dependencies" | "publish";

type Listener = (page?: ProjectPropertiesPage) => void;

const listeners = new Set<Listener>();

/** Opens (or brings forward) the open project's Properties window, optionally on `page`. */
export function openProjectProperties(page?: ProjectPropertiesPage): void {
  listeners.forEach((listener) => listener(page));
}

export function onOpenProjectProperties(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
