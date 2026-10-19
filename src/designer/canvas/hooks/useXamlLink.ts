// The split view's XAML pane: edits, selection and cursor kept in step both ways.

import { useEffect } from "react";
import { notifyDocumentCommands } from "substrate-platform-ui";
import type { ScreenDesignerProps } from "../../ScreenDesigner";
import { clearActiveDesigner, setActiveDesigner } from "../../activeDesigner";
import { adoptUids, findNode, nodeAtPath, pathOf } from "../../yui";
import { type Session, sessions } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { CommandRegistry } from "./useCommandRegistry";
import type { PropertyPublishing } from "./usePropertyPublishing";

/** The split view's XAML pane: edits, selection and cursor kept in step both ways. */
export function useXamlLink(props: ScreenDesignerProps, designerDocument: DesignerDocument, propertyPublishing: PropertyPublishing, commandRegistry: CommandRegistry) {
  const { path, link } = props;
  const { isActive, canvasRef, setRevision, setError, sessionRef, fromTextRef, doc, selection } = designerDocument;
  const { publishRef } = propertyPublishing;
  const { commands } = commandRegistry;
  // ── The split view's XAML pane ────────────────────────────────────────────

  useEffect(
    () =>
      link?.attach({
        receive: (doc, text) => {
          const s = sessionRef.current;
          if (s) {
            // Same nodes, same uids: the selection survives the re-parse —
            // and a text undo/redo brought back gets the selection it had.
            s.doc = { ...doc, root: adoptUids(s.doc.root, doc.root) };
            s.text = text;
            const remembered = s.selectionByText.get(text);
            s.selection = remembered
              ? remembered.map((p) => nodeAtPath(s.doc.root, p)?.uid).filter((uid): uid is string => !!uid)
              : s.selection.filter((uid) => findNode(s.doc.root, uid));
          } else {
            const session: Session = { text, doc, selection: [], selectionByText: new Map() };
            sessionRef.current = session;
            sessions.set(path, session);
          }
          setError(null);
          setRevision((r) => r + 1);
          notifyDocumentCommands();
        },
        selectPath: (at) => {
          const s = sessionRef.current;
          const node = s ? nodeAtPath(s.doc.root, at) : null;
          if (!s || !node || (s.selection.length === 1 && s.selection[0] === node.uid)) return;
          fromTextRef.current = true;
          commands.current.select([node.uid]);
          publishRef.current();
        },
        publish: () => publishRef.current(),
      }),
    [link, path]
  );

  // The XAML marks what's selected here (and follows edits), and its cursor
  // goes to a newly selected element — unless the selection came from there.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (link && doc) link.selected(selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, doc]);
  useEffect(() => {
    const reveal = !fromTextRef.current;
    fromTextRef.current = false;
    if (link && doc) link.selected(selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p), reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, selectionKey]);

  useEffect(() => {
    if (!isActive || !doc) return;
    setActiveDesigner({
      path,
      doc,
      selection,
      select: (uids) => {
        commands.current.select(uids);
        publishRef.current();
      },
      addWidget: (kind) => commands.current.addWidget(kind),
      focus: () => (canvasRef.current?.querySelector(".sp-design-surface") as HTMLElement | null)?.focus(),
    });
  }, [isActive, path, doc, selection]);
  useEffect(() => () => clearActiveDesigner(path), [path]);
  useEffect(() => {
    if (!isActive) clearActiveDesigner(path);
  }, [isActive, path]);

  return { selectionKey };
}

/** What `useXamlLink` gives. */
export type XamlLink = ReturnType<typeof useXamlLink>;
