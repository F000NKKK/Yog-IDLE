// The selection in Properties, kept current.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { activatePropertyContext, type PropertySet, setPropertyContext, tn } from "substrate-platform-ui";
import { designText } from "../../../lang/designResources";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import { findComponent } from "../../model/components";
import { imageSourcesVersion, subscribeImageSources } from "../../resources/imageSources";
import { widgetProperties } from "../../model/properties";
import { findNode, findParent, isGrid, KIND_INFO, mapNode, type YuiKind, type YuiNode } from "../../model/yui";
import { newEventName } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerEdits } from "../useDesignerEdits";
import type { DesignerPicture } from "../useDesignerPicture";
import type { HandlerOpening } from "./useHandlerOpening";

/** The selection in Properties, kept current. */
export function usePropertyPublishing(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture, designerEdits: DesignerEdits, handlerOpening: HandlerOpening) {
  const { path } = props;
  const { t, sessionRef, commit } = designerDocument;
  const { components } = designerPicture;
  const { applyAttr } = designerEdits;
  const { openHandlerRef } = handlerOpening;
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

  return { propertySet, publish, publishRef };
}

/** What `usePropertyPublishing` gives. */
export type PropertyPublishing = ReturnType<typeof usePropertyPublishing>;
