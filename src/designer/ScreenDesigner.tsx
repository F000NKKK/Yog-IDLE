import { useTyped } from "../data/typed";
import {
  ContextMenu,
  DesignSurface,
  type EditorProps,
  pt,
  Toolbar,
  ToolbarButton,
  ToolbarCheck,
  ToolbarGroup,
  ToolbarLabel,
  ToolbarSelect,
  type ContextMenuItem,
} from "substrate-platform-ui";
import { TOOLBOX_MIME } from "./activeDesigner";
import { findNode, findParent, isGrid, mapNode, type YuiDoc } from "./yui";
import { type GridGeo, GridLines, GridRails } from "./GridAdorner";
import "./ScreenDesigner.css";
import { BookPagePreview, isBookPage } from "./BookPagePreview";
import { clipboard, defaultEvent, GRID, nodeLabel, RESOLUTIONS, ZOOMS } from "./canvas/designerModel";
import { box, DesignOutlines, McWidget } from "./canvas/overlays";
import { useDesignerDocument } from "./canvas/useDesignerDocument";
import { useDesignerPicture } from "./canvas/useDesignerPicture";
import { useDesignerEdits } from "./canvas/useDesignerEdits";
import { useDesignerCommands } from "./canvas/useDesignerCommands";
import { useDesignerPreview } from "./canvas/useDesignerPreview";

/**
 * The XAML pane of the split view, as the designer sees it (`YuiSplitEditor`):
 * there the text is the document — the designer's edits are written into it
 * (and undone there), and edits typed there come back re-parsed.
 */
export interface DesignerLink {
  /** Writes a designer edit (`prev` → `next`) into the XAML as one undo step; the new text, or `null` when the edit can't be made now (the markup there is invalid or not parsed yet). */
  write: (prev: YuiDoc, next: YuiDoc) => string | null;
  /** The designer's selection as child-index paths, primary first — the XAML marks it, and moves its cursor there when `reveal`. */
  selected: (paths: number[][], reveal: boolean) => void;
  /** The designer was focused more recently than the XAML — the Edit menu acts on it. */
  preferred: () => boolean;
  /** Called by the designer while it's mounted; returns the detach. */
  attach: (designer: LinkedDesigner) => () => void;
}

/** What the split view can ask of its designer. */
export interface LinkedDesigner {
  /** A valid parse of the XAML after it was edited there. */
  receive: (doc: YuiDoc, text: string) => void;
  /** The XAML cursor is in the element at `path`. */
  selectPath: (path: number[]) => void;
  /** Shows the selection in Properties (focus moved into the XAML). */
  publish: () => void;
}

export interface ScreenDesignerProps extends EditorProps {
  /** Set by the split view — see `DesignerLink`. */
  link?: DesignerLink;
}

/**
 * The designer of a `.yui`: a book page component (`<Component book_page>`)
 * is drawn as the book shows it ({@link BookPagePreview}); any other
 * screen or component on the GUI canvas.
 */
export function ScreenDesigner(props: ScreenDesignerProps) {
  // Typed values (`@item:…`) classified by the CLI come in: draw again.
  useTyped();
  return isBookPage(props.content) ? <BookPagePreview path={props.path} content={props.content} /> : <CanvasDesigner {...props} />;
}

function CanvasDesigner(props: ScreenDesignerProps) {
  const { readOnly, link } = props;
  const designerDocument = useDesignerDocument(props);
  const designerPicture = useDesignerPicture(props, designerDocument);
  const designerEdits = useDesignerEdits(designerDocument, designerPicture);
  const designerCommands = useDesignerCommands(props, designerDocument, designerPicture, designerEdits);
  const designerPreview = useDesignerPreview(props, designerDocument, designerPicture, designerCommands);
  const { t, canvasRef, view, error, sessionRef, draggingRef, menu, railMenu, setRailMenu, doc, selection, commit, select } = designerDocument;
  const { res, layout, previewing, focusedBox, setFocusedBox, hovered, setHovered, pressed, setPressed, lastEvent, rendered, renderError, picture, geo, items } = designerPicture;
  const { gridGeo, addWidget, movable, deleteSelection, copySelection, paste, duplicate, reorder, onCommit } = designerEdits;
  const { publish, publishRef, openHandlerRef } = designerCommands;
  const { pageRef, sendEvent, togglePreview, guiPoint, fmt, textBoxAt, onPreviewKey, updateView } = designerPreview;

  if (error !== null || !doc || !layout) {
    return (
      <div className="yui-designer-error">
        <p>{t("The designer can't show this file:")}</p>
        <pre>{error ?? t("Loading…")}</pre>
        <p>{link ? t("Fix the markup in the XAML pane — the designer follows as soon as it's valid.") : t("Fix it in the XAML view (the XAML button on the tab strip), then come back.")}</p>
      </div>
    );
  }

  const canEdit = !readOnly;
  const hasMovable = movable(doc, selection).length > 0;
  const contextItems: ContextMenuItem[] = [
    { label: t("Cut"), shortcut: "Ctrl+X", disabled: !canEdit || !hasMovable, onSelect: () => copySelection() && deleteSelection() },
    { label: t("Copy"), shortcut: "Ctrl+C", disabled: !hasMovable, onSelect: () => void copySelection() },
    { label: t("Paste"), shortcut: "Ctrl+V", disabled: !canEdit || !clipboard, onSelect: () => paste() },
    { label: t("Duplicate"), shortcut: "Ctrl+D", disabled: !canEdit || !hasMovable, onSelect: duplicate },
    { label: t("Delete"), shortcut: "Delete", disabled: !canEdit || !hasMovable, destructive: true, onSelect: deleteSelection },
    { label: t("Bring to Front"), disabled: !canEdit || !hasMovable, onSelect: () => reorder(true), separatorBefore: true },
    { label: t("Send to Back"), disabled: !canEdit || !hasMovable, onSelect: () => reorder(false) },
    {
      label: t("Select Parent"),
      shortcut: "Escape",
      disabled: selection.length === 0 || selection[0] === doc.root.uid,
      onSelect: () => {
        const parent = findParent(doc.root, selection[0]);
        select(parent ? [parent.uid] : []);
      },
      separatorBefore: true,
    },
  ];

  const primary = selection[0] ? findNode(doc.root, selection[0]) : null;
  const notice = renderError
    ? t("The real renderer failed ({error}) — showing an approximation.", { error: renderError })
    : rendered && !rendered.assets
      ? t("Minecraft's client jar wasn't found (in ~/.minecraft/versions or a loader's Gradle caches) — showing an approximation instead of the game's font and textures. Once the game has been installed or a loader built, the designer uses them.")
      : null;
  const primaryGeo = primary ? geo?.get(primary.uid) : undefined;
  // Visual Studio's grid rails: on the selected grid, or the grid the selected widget is in.
  const primaryParent = primary ? findParent(doc.root, primary.uid) : null;
  const railGrid = primary && isGrid(primary) ? primary : primaryParent && isGrid(primaryParent) ? primaryParent : null;
  const railGeo = railGrid ? gridGeo(railGrid.uid) : null;
  const allGrids: GridGeo[] = [];
  if (geo) for (const [uid, g] of geo) if (g.grid) allGrids.push(gridGeo(uid)!);

  return (
    <div
      className="yui-designer"
      onFocus={(e) => {
        // Not the file: the widgets are what Properties shows while in here.
        e.stopPropagation();
        if (!(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)) publish();
      }}
    >
      <Toolbar>
        <ToolbarGroup>
          <ToolbarSelect label="GUI size" value={String(view.res)} options={RESOLUTIONS.map((r, i) => ({ value: String(i), label: r.label }))} onChange={(v) => updateView({ res: Number(v) })} />
          <ToolbarSelect label="Zoom" value={String(view.zoom)} options={ZOOMS.map((z) => ({ value: String(z), label: `${z * 100}%` }))} onChange={(v) => updateView({ zoom: Number(v) })} />
          <ToolbarCheck label="Snap" checked={view.snap} onChange={(snap) => updateView({ snap })} />
          <ToolbarCheck label="Grid" checked={view.showGrid} onChange={(showGrid) => updateView({ showGrid })} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton label="Bring to Front" disabled={!canEdit || !hasMovable} onClick={() => reorder(true)} />
          <ToolbarButton label="Send to Back" disabled={!canEdit || !hasMovable} onClick={() => reorder(false)} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton
            icon="play"
            showLabel
            label={pt("designer", "Preview")}
            tooltip={previewing ? "Back to designing: select, move and resize widgets." : "Try the screen as in game: hover and press buttons, type into text boxes, scroll lists. Events are shown, not run."}
            active={previewing}
            onClick={togglePreview}
          />
        </ToolbarGroup>
        <span title={picture?.assets ? t("Drawn by yog-ui with Minecraft {version}'s font and textures ({jar})", { version: picture.assets.version, jar: picture.assets.jar }) : undefined}>
          <ToolbarLabel>
            {previewing
              ? (lastEvent ?? t("Preview — events appear here and in Output (General)."))
              : primary && primaryGeo
              ? `${nodeLabel(primary)} · ${Math.round(primaryGeo.rect.x)}, ${Math.round(primaryGeo.rect.y)} · ${Math.round(primaryGeo.rect.w)} × ${Math.round(primaryGeo.rect.h)}`
              : doc.root.attrs.id}
          </ToolbarLabel>
        </span>
      </Toolbar>
      {notice && <div className="yui-designer-notice">{notice}</div>}
      <div
        className="yui-designer-canvas"
        ref={canvasRef}
        onDoubleClick={(e) => {
          // Double-clicking a button opens its click handler, as in Visual Studio.
          if (previewing || !(e.target instanceof Element) || !e.target.closest(".sp-design-surface-page")) return;
          const node = selection[0] ? findNode(doc.root, selection[0]) : null;
          const attr = node && defaultEvent(node);
          if (node && attr) void openHandlerRef.current(node.uid, attr);
        }}
      >
        {previewing ? (
          <div className="yui-preview" tabIndex={0} onKeyDown={onPreviewKey}>
            <div className="yui-preview-canvas" style={{ width: res.w * view.zoom + 64, height: res.h * view.zoom + 64 }}>
              <div
                ref={pageRef}
                className="yui-preview-page"
                data-pointer={hovered ? "button" : focusedBox ? "text" : undefined}
                style={{ width: res.w * view.zoom, height: res.h * view.zoom }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  (e.currentTarget.closest(".yui-preview") as HTMLElement | null)?.focus();
                  const p = guiPoint(e);
                  setFocusedBox(textBoxAt(p.x, p.y)?.uid ?? null);
                  sendEvent(`click:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerMove={(e) => {
                  const p = guiPoint(e);
                  sendEvent(`${e.buttons & 1 ? "drag" : "move"}:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerUp={(e) => {
                  if (e.button !== 0) return;
                  const p = guiPoint(e);
                  setPressed(null);
                  sendEvent(`release:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerLeave={() => setHovered(null)}
                onWheel={(e) => {
                  if (e.deltaY === 0) return;
                  const p = guiPoint(e);
                  sendEvent(`scroll:${e.deltaY < 0 ? 1 : -1}`, p.x, p.y);
                }}
              >
                <div className="yui-world" />
                {rendered && rendered.w === res.w && rendered.h === res.h && rendered.assets ? (
                  <img className="yui-picture" src={rendered.image} alt="" draggable={false} />
                ) : (
                  <McWidget widget={layout.widget} node={layout.tree} zoom={view.zoom} />
                )}
                {hovered && rendered?.geo.get(hovered) && (
                  <div className={`yui-box yui-preview-hot${pressed === hovered ? " pressed" : ""}`} style={box(rendered.geo.get(hovered)!.rect, view.zoom)} />
                )}
              </div>
            </div>
          </div>
        ) : (
        <DesignSurface
          width={res.w}
          height={res.h}
          scale={view.zoom}
          items={items}
          selection={selection}
          onSelectionChange={(uids) => {
            select(uids);
            setTimeout(() => publishRef.current());
          }}
          onPreview={(change) => {
            draggingRef.current = change !== null;
          }}
          onCommit={(change) => !readOnly && onCommit(change)}
          grid={view.snap ? GRID : 0}
          snaplines={view.snap}
          showGrid={view.showGrid}
          externalDrop={
            readOnly
              ? undefined
              : {
                  mime: TOOLBOX_MIME,
                  onDrop: (kind, point, target) => {
                    addWidget(kind, point, target ?? doc.root.uid);
                    setTimeout(() => publishRef.current());
                  },
                }
          }
          onContextMenu={(e) => menu.openAtPoint(undefined, e)}
          adorners={
            railGrid && railGeo ? (
              <GridRails
                grid={railGrid}
                geo={railGeo}
                zoom={view.zoom}
                editable={canEdit}
                onChange={(next) => {
                  const s = sessionRef.current;
                  if (s) commit({ ...s.doc, root: mapNode(s.doc.root, railGrid.uid, () => next) });
                }}
                onMenu={(e, items) => setRailMenu({ x: e.clientX, y: e.clientY, items })}
              />
            ) : undefined
          }
        >
          <div className="yui-world" />
          {picture ? (
            <>
              <img className="yui-picture" src={picture.image} alt="" draggable={false} />
              <DesignOutlines root={doc.root} geo={geo ?? layout.geo} zoom={view.zoom} />
            </>
          ) : (
            <McWidget widget={layout.widget} node={layout.tree} zoom={view.zoom} />
          )}
          <GridLines grids={allGrids} zoom={view.zoom} />
        </DesignSurface>
        )}
      </div>
      <ContextMenu target={menu.target ? { mode: "viewport", x: menu.target.mode === "viewport" ? menu.target.x : 0, y: menu.target.mode === "viewport" ? menu.target.y : 0 } : null} items={contextItems} onClose={menu.close} />
      <ContextMenu target={railMenu ? { mode: "viewport", x: railMenu.x, y: railMenu.y } : null} items={railMenu?.items ?? []} onClose={() => setRailMenu(null)} />
    </div>
  );
}

