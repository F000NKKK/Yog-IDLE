// The designer's document: its tree, the edit session, selection, history and view settings.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { type ContextMenuItem, notifyDocumentCommands, useContextMenu, useT } from "substrate-platform-ui";
import { useActiveFileTab } from "../../OpenFilesContext";
import { modRootOf } from "../../paths";
import { adoptUids, findNode, newScreen, nodeAtPath, parseYui, serializeYui, withAttrs, type YuiDoc } from "../yui";
import { patchYui } from "../yuiText";
import { rememberSelection, screenIdOf, type Session, sessions, settings, type ViewSettings } from "./designerModel";
import type { ScreenDesignerProps } from "../ScreenDesigner";

/** The designer's document: its tree, the edit session, selection, history and view settings. */
export function useDesignerDocument(props: ScreenDesignerProps) {
  const { path, content, onChange, readOnly, contentVersion, link } = props;
  const t = useT();
  const activeTab = useActiveFileTab();
  const isActive = activeTab?.path === path;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewSettings>(settings);
  const [, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const draggingRef = useRef(false);
  /** The next selection change came from the XAML cursor — don't send the cursor back there. */
  const fromTextRef = useRef(false);
  const menu = useContextMenu();
  /** The menu of a grid rail (Auto / * / pixels, insert, delete). */
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  // ── Document & history ────────────────────────────────────────────────────

  const load = useCallback(
    (text: string) => {
      const kept = sessions.get(path);
      if (kept && kept.text === text) {
        sessionRef.current = kept;
        setError(null);
        return;
      }
      if (text.trim() === "") {
        const doc = newScreen(`mymod:${screenIdOf(path)}`);
        const session: Session = { text: serializeYui(doc), doc, selection: [], selectionByText: new Map() };
        sessionRef.current = session;
        sessions.set(path, session);
        setError(null);
        // A new file: name the screen after its mod, and write it out.
        const root = modRootOf(path);
        const finish = (modId: string | null) => {
          const s = sessionRef.current;
          if (!s || s !== session || s.text !== serializeYui(session.doc)) return;
          if (modId) s.doc = { ...s.doc, root: withAttrs(s.doc.root, { id: `${modId}:${screenIdOf(path)}` }) };
          s.text = serializeYui(s.doc);
          setRevision((r) => r + 1);
          if (!readOnly) onChange(s.text);
        };
        if (root)
          invoke<{ fields: { id?: string } }>("mod_manifest_read", { projectRoot: root })
            .then((m) => finish(m.fields.id ?? null))
            .catch(() => finish(null));
        else void Promise.resolve().then(() => finish(null));
        return;
      }
      try {
        const doc = parseYui(text);
        const session: Session = { text, doc, selection: [], selectionByText: new Map() };
        sessionRef.current = session;
        sessions.set(path, session);
        setError(null);
      } catch (err) {
        sessionRef.current = null;
        setError(String(err instanceof Error ? err.message : err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path]
  );

  // Linked, the XAML editor takes reloads and passes them on (`receive`).
  const loadedVersion = useRef<number | undefined>(-1);
  if (loadedVersion.current !== contentVersion && !(link && loadedVersion.current !== -1)) {
    loadedVersion.current = contentVersion;
    load(content);
  }

  // A text that isn't the designer's own (Undo/Redo): it takes it, with
  // the selection that went with it. Linked, the XAML passes it on.
  if (!link && sessionRef.current && content !== sessionRef.current.text) {
    const s = sessionRef.current;
    try {
      const parsed = parseYui(content);
      s.doc = { ...parsed, root: adoptUids(s.doc.root, parsed.root) };
      s.text = content;
      const remembered = s.selectionByText.get(content);
      s.selection = remembered
        ? remembered.map((p) => nodeAtPath(s.doc.root, p)?.uid).filter((uid): uid is string => !!uid)
        : s.selection.filter((uid) => findNode(s.doc.root, uid));
    } catch {
      /* the text was ours once: it parses */
    }
  }

  const session = sessionRef.current;
  const doc = session?.doc ?? null;
  const selection = session?.selection ?? [];

  const commit = useCallback(
    (next: YuiDoc, nextSelection?: string[]) => {
      const s = sessionRef.current;
      if (!s || readOnly || next === s.doc) return;
      const before = s.text;
      rememberSelection(s, before, s.doc, s.selection);
      if (link) {
        const text = link.write(s.doc, next);
        if (text === null) return;
        s.text = text;
      } else {
        // Only what changed is rewritten — the rest of the file stays as the
        // user wrote it. Undo is the platform's history of the text.
        s.text = patchYui(s.text, s.doc, next);
        onChange(s.text);
      }
      s.doc = next;
      if (nextSelection) s.selection = nextSelection;
      s.selection = s.selection.filter((uid) => findNode(next.root, uid));
      rememberSelection(s, s.text, next, s.selection);
      setRevision((r) => r + 1);
      notifyDocumentCommands();
    },
    [onChange, readOnly, link]
  );

  const select = useCallback((uids: string[]) => {
    const s = sessionRef.current;
    if (!s) return;
    s.selection = uids;
    setRevision((r) => r + 1);
    notifyDocumentCommands();
  }, []);

  return { t, activeTab, isActive, canvasRef, view, setView, setRevision, error, setError, sessionRef, draggingRef, fromTextRef, menu, railMenu, setRailMenu, load, loadedVersion, session, doc, selection, commit, select };
}

/** What `useDesignerDocument` gives the component. */
export type DesignerDocument = ReturnType<typeof useDesignerDocument>;
