// The selection in Properties, the Edit menu and keys, the split view's XAML pane and the event handlers in code.

import type { DesignerDocument } from "canvas/useDesignerDocument";
import type { DesignerEdits } from "canvas/useDesignerEdits";
import type { DesignerPicture } from "canvas/useDesignerPicture";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { activatePropertyContext, notifyDocumentCommands, openFile, type PropertySet, registerDocumentCommands, reportError, setPropertyContext, tn } from "substrate-platform-ui";
import { cli } from "../../cli";
import { emitTo, EVENT } from "../../events";
import { designText } from "../../lang/designResources";
import { clearActiveDesigner, setActiveDesigner } from "../activeDesigner";
import { findComponent } from "../components";
import { imageSourcesVersion, subscribeImageSources } from "../imageSources";
import { widgetProperties } from "../properties";
import { adoptUids, findNode, findParent, isGrid, KIND_INFO, mapNode, nodeAtPath, pathOf, withAttrs, type YuiKind, type YuiNode } from "../yui";
import { clipboard, type HandlerLocation, newEventName, type Session, sessions } from "./designerModel";
import type { ScreenDesignerProps } from "../ScreenDesigner";

/** The selection in Properties, the Edit menu and keys, the split view's XAML pane and the event handlers in code. */
export function useDesignerCommands(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture, designerEdits: DesignerEdits) {
  const { path, readOnly, link } = props;
  const { t, isActive, canvasRef, setRevision, error, setError, sessionRef, fromTextRef, session, doc, selection, commit, select } = designerDocument;
  const { components } = designerPicture;
  const { addWidget, movable, deleteSelection, copySelection, paste, duplicate, reorder, nudge, applyAttr } = designerEdits;
  // ── Selection → Properties ────────────────────────────────────────────────

  // Image sources and previews load in the background: re-publish when they arrive.
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);

  /** The selected widgets' rows — the designer's property context (what Properties shows while it's active). */
  const propertySet = (): PropertySet | null => {
    const s = sessionRef.current;
    if (!s) return null;
    const uids = s.selection.length ? s.selection : [s.doc.root.uid];
    const nodes = uids.map((uid) => findNode(s.doc.root, uid)).filter((n): n is YuiNode => !!n);
    const first = nodes[0];
    if (!first) return null;
    const instanceOf = nodes.length === 1 ? findComponent(components, first.kind) : null;
    return {
      objectName: nodes.length > 1 ? tn(nodes.length, "{count} widget", "{count} widgets", { count: nodes.length }) : (first.attrs.id ?? first.attrs.name ?? ""),
      objectType:
        nodes.length > 1
          ? ""
          : KIND_INFO[first.kind as YuiKind]
            ? t(KIND_INFO[first.kind as YuiKind].label)
            : instanceOf
              ? t("{name} (component)", { name: designText(instanceOf.display_name || instanceOf.name) })
              : first.kind,
      objectDescription: instanceOf?.description ? designText(instanceOf.description) : undefined,
      objectKey: `${path}#${uids.join(",")}`,
      properties: widgetProperties(
        nodes,
        applyAttr,
        {
          suggest: (node, attr) => newEventName(s.doc.root, node, attr),
          open: (node, attr) => void openHandlerRef.current(node.uid, attr),
        },
        path,
        components,
        {
          inGrid: nodes.every((n) => {
            const parent = findParent(s.doc.root, n.uid);
            return !!parent && isGrid(parent);
          }),
          update: (fn) => {
            const cur = sessionRef.current;
            if (!cur) return null;
            let root = cur.doc.root;
            for (const uid of uids) root = mapNode(root, uid, fn);
            commit({ ...cur.doc, root });
            return null;
          },
        },
      ),
    };
  };
  /** Shows the designer's selection in Properties — a click on the surface, a pick in the XAML. */
  const publish = () => {
    setPropertyContext(path, propertySet());
    activatePropertyContext(path);
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // Kept current (shown at once while it's in Properties); gone with the designer.
  useEffect(() => setPropertyContext(path, propertySet()));
  useEffect(() => () => setPropertyContext(path, null), [path]);

  // ── Commands (Edit menu, Toolbox, keys) ───────────────────────────────────

  const commands = useRef({ deleteSelection, copySelection, paste, duplicate, addWidget, select, reorder, nudge });
  commands.current = { deleteSelection, copySelection, paste, duplicate, addWidget, select, reorder, nudge };

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => {
          const s = sessionRef.current;
          return !!s && movable(s.doc, s.selection).length > 0;
        },
        cut: () => commands.current.copySelection() && commands.current.deleteSelection(),
        copy: () => void commands.current.copySelection(),
        canPaste: () => !readOnly && !!clipboard,
        paste: () => commands.current.paste(),
        selectAll: () => {
          const s = sessionRef.current;
          if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
        },
        delete: () => commands.current.deleteSelection(),
        preferred: link?.preferred,
      }),
    [path, readOnly, link]
  );

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

  // ── Event handlers (code-behind) ──────────────────────────────────────────

  /**
   * As in Visual Studio: the handler of `node`'s `attr` event in the
   * screen's code-behind `.rs` — the event named first if it has none
   * (`<id>_click`), the handler added if missing — opened at its body.
   */
  const openHandler = async (uid: string, attr: string, name?: string) => {
    const s = sessionRef.current;
    const node = s ? findNode(s.doc.root, uid) : null;
    if (!s || !node) return;
    let event = node.attrs[attr];
    if (!event) {
      if (readOnly) return;
      event = name ?? newEventName(s.doc.root, node, attr);
      const before = s.doc;
      commit({ ...s.doc, root: mapNode(s.doc.root, uid, (n) => withAttrs(n, { [attr]: event })) });
      if (s.doc === before) return; // not written (the XAML can't take it now)
    }
    try {
      const at = await cli<HandlerLocation>("yui_event_handler", { path, event });
      openFile({ path: at.path, line: at.line, column: at.column });
      if (at.changed) emitTo(EVENT.ideOutput, `[designer] ${t("Added handler for {event} to {file}", { event, file: at.path })}`);
    } catch (err) {
      reportError(t("Couldn't open the handler for {event}: {error}", { event, error: String(err instanceof Error ? err.message : err) }));
    }
  };
  const openHandlerRef = useRef(openHandler);
  openHandlerRef.current = openHandler;

  return { propertySet, publish, publishRef, commands, selectionKey, openHandler, openHandlerRef };
}

/** What `useDesignerCommands` gives the component. */
export type DesignerCommands = ReturnType<typeof useDesignerCommands>;
