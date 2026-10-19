// The document loaded from the text, and reloaded when the text changes from outside.

import { useCallback, useRef } from "react";
import { invokeCommand } from "substrate-platform-ui";
import { yog } from "../../../host.generated";
import { modRootOf } from "../../../paths";
import type { ScreenDesignerProps } from "../../ScreenDesigner";
import { adoptUids, findNode, newScreen, nodeAtPath, parseYui, serializeYui, withAttrs } from "../../yui";
import { screenIdOf, type Session, sessions } from "../designerModel";
import type { DesignerState } from "./useDesignerState";

/** The document loaded from the text, and reloaded when the text changes from outside. */
export function useDocumentLoading(props: ScreenDesignerProps, designerState: DesignerState) {
  const { path, content, onChange, readOnly, contentVersion, link } = props;
  const { setRevision, setError, sessionRef } = designerState;
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
          invokeCommand<{ fields: { id?: string } }>(yog.project.modManifestRead, { projectRoot: root })
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

  return { load, loadedVersion };
}

/** What `useDocumentLoading` gives. */
export type DocumentLoading = ReturnType<typeof useDocumentLoading>;
