import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invokeCommand, type StateStore, StateStoreProvider, useStoredState } from "substrate-platform-ui";
import { useProject } from "./ProjectContext";
import { addCloseFlush } from "./windowClose";
import { yog } from "./plugins.generated";

/**
 * A `StateStore` backed by one JSON file: reads come from memory, writes
 * are debounced (`SAVE_DELAY_MS`) into a single atomic file write. Before
 * each write, every registered collector gets a chance to `set` state it
 * only gathers lazily (e.g. each open file's cursor position).
 */
interface FileStateStore extends StateStore {
  /** Writes any pending change now — on project switch and window close. */
  flush(): Promise<void>;
}

const SAVE_DELAY_MS = 500;

type Collector = (store: StateStore) => void;
const collectors = new Set<Collector>();

/** Registers state to gather right before every workspace/app-state write — for values too chatty to `set` on each change (cursor positions). */
export function addWorkspaceCollector(collector: Collector): () => void {
  collectors.add(collector);
  return () => collectors.delete(collector);
}

function createFileStore(scope: string, initial: unknown, write: (data: Record<string, unknown>) => Promise<unknown>): FileStateStore {
  const data: Record<string, unknown> = initial && typeof initial === "object" && !Array.isArray(initial) ? { ...(initial as object) } : {};
  let timer: number | undefined;
  let pending = false;
  let collecting = false;

  const store: FileStateStore = {
    scope,
    get: (key) => data[key],
    set(key, value) {
      // Unchanged values (a widget re-saving what it just restored) cost nothing.
      if (JSON.stringify(data[key]) === JSON.stringify(value)) return;
      if (value === undefined) delete data[key];
      else data[key] = value;
      pending = true;
      if (collecting) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => store.flush(), SAVE_DELAY_MS);
    },
    async flush() {
      window.clearTimeout(timer);
      collecting = true;
      try {
        collectors.forEach((collect) => collect(store));
      } finally {
        collecting = false;
      }
      if (!pending) return;
      pending = false;
      // A failed write (read-only folder, ...) just means this state won't
      // be remembered — never an error dialog.
      await write({ ...data }).catch((err) => console.warn(`failed to save UI state (${scope}):`, err));
    },
  };
  return store;
}

/** Until the app-wide state file has loaded — nothing to restore yet, nothing worth saving. */
const loadingStore: StateStore = { scope: "loading", get: () => undefined, set: () => {} };

const GlobalStateContext = createContext<StateStore>(loadingStore);

/**
 * Remembered UI state, Visual-Studio-`.vs`-style: everything a widget
 * stores through `useWorkspaceState` (or the platform's own
 * `useStoredState` — dock layout, terminals, expanded folders, ...) goes to
 * the open project's `.yog-idle/workspace.json`, so each project reopens
 * the way it was left; with no project open, to the app-wide
 * `state.json` in the app config dir. `useGlobalState` always uses the
 * latter (e.g. for the recent projects list). Saves are debounced and
 * flushed on project switch and window close; a missing or corrupt file
 * just means defaults.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { project } = useProject();
  const [globalStore, setGlobalStore] = useState<FileStateStore | null>(null);
  const [workspace, setWorkspace] = useState<FileStateStore | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeCommand<unknown>(yog.app.appStateLoad)
      .catch(() => ({}))
      .then((data) => {
        if (!cancelled) setGlobalStore(createFileStore("global", data, (value) => invokeCommand(yog.app.appStateSave, { value })));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const root = project?.root ?? null;
  useEffect(() => {
    if (!root) {
      setWorkspace(null);
      return;
    }
    // Until its file is read, the new project gets an empty store of its
    // own — never the previous project's (or the app-wide) one, which
    // widgets re-keyed to the new root would otherwise save into.
    setWorkspace({ scope: `loading:${root}`, get: () => undefined, set: () => {}, flush: async () => {} });
    let cancelled = false;
    let loaded: FileStateStore | null = null;
    invokeCommand<unknown>(yog.app.workspaceLoad, { projectRoot: root })
      .catch(() => ({}))
      .then((data) => {
        if (cancelled) return;
        loaded = createFileStore(root, data, (value) => invokeCommand(yog.app.workspaceSave, { projectRoot: root, value }));
        setWorkspace(loaded);
      });
    return () => {
      cancelled = true;
      // Switching away — write the outgoing project's state before its
      // store is dropped (collectors still see its tabs at this point).
      loaded?.flush();
    };
  }, [root]);

  useEffect(
    () =>
      addCloseFlush(async () => {
        await workspace?.flush();
        await globalStore?.flush();
      }),
    [workspace, globalStore]
  );

  const store = workspace ?? globalStore ?? loadingStore;
  const globalValue = useMemo(() => globalStore ?? loadingStore, [globalStore]);

  return (
    <GlobalStateContext.Provider value={globalValue}>
      <StateStoreProvider store={store}>{children}</StateStoreProvider>
    </GlobalStateContext.Provider>
  );
}

/**
 * `useState`, remembered per project in `.yog-idle/workspace.json` (or
 * app-wide while no project is open) — the value is restored when the
 * project is reopened. `key` is any string (namespace it, e.g.
 * `"debugger.breakpoints"`); the value must be JSON-serializable. Pass
 * `isValid` to reject a stored value of the wrong shape (falls back to
 * `defaultValue`). Re-reads when another project is opened.
 */
export function useWorkspaceState<T>(
  key: string,
  defaultValue: T,
  isValid?: (value: unknown) => boolean
): [T, Dispatch<SetStateAction<T>>] {
  return useStoredState(key, defaultValue, isValid);
}

/** The app-wide store (`state.json` in the app config dir), whichever project is open — a store, not a hook value, so it can be read/written from callbacks too. Its `scope` is `"loading"` until the file has been read. */
export function useGlobalStateStore(): StateStore {
  return useContext(GlobalStateContext);
}

/** Like `useWorkspaceState`, but app-wide (not per project) — for e.g. the recent projects list. */
export function useGlobalState<T>(
  key: string,
  defaultValue: T,
  isValid?: (value: unknown) => boolean
): [T, Dispatch<SetStateAction<T>>] {
  const store = useGlobalStateStore();
  const read = (): T => {
    const stored = store.get(key);
    return stored !== undefined && (!isValid || isValid(stored)) ? (stored as T) : defaultValue;
  };
  const [state, setState] = useState(() => ({ scope: store.scope, value: read() }));
  // Re-read once the file has loaded (scope "loading" -> "global").
  let current = state;
  if (state.scope !== store.scope) {
    current = { scope: store.scope, value: read() };
    setState(current);
  }
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) =>
      setState((prev) => {
        const value = typeof action === "function" ? (action as (prev: T) => T)(prev.value) : action;
        store.set(key, value);
        return { ...prev, value };
      }),
    [store, key]
  );
  return [current.value, set];
}
