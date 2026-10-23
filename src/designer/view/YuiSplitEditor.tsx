import { useEffect, useMemo, useRef, useState } from "react";
import {
  editorApplyText,
  editorRevealRange,
  editorSetLinkedRange,
  editorSyncListener,
  Icon,
  IconButton,
  linkedRangeHighlight,
  notifyDocumentCommands,
  pt,
  revealLine,
  SplitPane,
  TextEditor,
  useLocale,
  useStoredState,
  useT,
  xmlSchemaLanguage,
  type EditorProps,
  type EditorSyncUpdate,
  type EditorView,
} from "substrate-platform-ui";
import { yuiSchema } from "../model/properties";
import { ScreenDesigner, type DesignerLink, type LinkedDesigner } from "./ScreenDesigner";
import { parseYui } from "../model/yui";
import { pathAt, patchYui, scanYui, spanAtPath, type ElementSpan } from "../model/yuiText";
import "../YuiSplitEditor.css";

// `.yui` screens the way Visual Studio shows XAML: the designer and the
// markup in one tab, kept in step both ways.

/** XML with `.yui` completion (elements, attributes, enum values) — one per UI language, built once. */
const languages = new Map<string, ReturnType<typeof xmlSchemaLanguage>>();
function useYuiLanguage() {
  const locale = useLocale();
  let language = languages.get(locale);
  if (!language) {
    language = xmlSchemaLanguage(yuiSchema());
    languages.set(locale, language);
  }
  return language;
}

/** The XAML view on its own: the markup with `.yui` completion. */
export function YuiSourceEditor(props: EditorProps) {
  return <TextEditor {...props} language={useYuiLanguage()} />;
}

interface SplitLayout {
  /** `"column"`: designer over XAML (Visual Studio's default), `"row"`: side by side. */
  direction: "row" | "column";
  /** The first pane's share. */
  ratio: number;
  /** XAML first. */
  swapped: boolean;
  /** One pane shown alone, or both. */
  only: "design" | "xaml" | null;
}

const DEFAULT_LAYOUT: SplitLayout = { direction: "column", ratio: 0.6, swapped: false, only: null };

function isLayout(value: unknown): boolean {
  const v = value as SplitLayout | null;
  return !!v && (v.direction === "row" || v.direction === "column") && typeof v.ratio === "number" && typeof v.swapped === "boolean" && (v.only === null || v.only === "design" || v.only === "xaml");
}

/** Marks the designer's own writes into the XAML (`editorApplyText`), so they aren't parsed back. */
const DESIGNER = "yui.designer";
/** How long typing in the XAML pauses before the designer follows. */
const PARSE_DELAY = 300;

/** "…error on line 3 at column 5: …" → 3. */
function errorLine(message: string): number | null {
  const m = /line (\d+)/i.exec(message);
  return m ? Number(m[1]) : null;
}

/** The XML parser's message without the browser's page-rendering boilerplate around it. */
function cleanError(message: string): string {
  return message
    .replace(/^This page contains the following errors:\s*/i, "")
    .replace(/^error on /i, "")
    .replace(/\s*Below is a rendering of the page.*$/is, "")
    .trim();
}

/**
 * Design and XAML together, Visual Studio's split view: the designer above
 * (or beside) the markup, a Design/⇅/XAML bar on the boundary to swap them
 * or show one alone. The XAML is the document — designer edits are patched
 * into it as undoable steps (one undo history for both), and what's typed
 * there reaches the designer after a short pause, the last valid layout
 * staying up with an error bar while the markup is broken. Selecting an
 * element in either selects it in the other.
 */
export function YuiSplitEditor(props: EditorProps) {
  const { content, readOnly } = props;
  const t = useT();
  const language = useYuiLanguage();
  const [layout, setLayout] = useStoredState<SplitLayout>("yui.splitLayout", DEFAULT_LAYOUT, isLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [error, setError] = useState<string | null>(() => {
    if (content.trim() === "") return null; // a new file: the designer fills it in
    try {
      parseYui(content);
      return null;
    } catch (err) {
      return cleanError(String(err instanceof Error ? err.message : err));
    }
  });
  const [focusedPane, setFocusedPane] = useState<"design" | "xaml">("design");
  const viewRef = useRef<EditorView | null>(null);
  const designerRef = useRef<LinkedDesigner | null>(null);
  // The text the designer shows (its last valid parse, or its own last write) and where its elements are in it.
  const synced = useRef<{ text: string; root: ElementSpan | null }>({ text: content, root: scanYui(content) });
  const selectedPath = useRef<number[] | null>(null);
  const lastPane = useRef<"design" | "xaml">("design");
  const timer = useRef<number | undefined>(undefined);

  /** Marks the designer's primary selection in the XAML (when the text says what the designer shows); with `reveal`, moves the cursor there. */
  const mark = (reveal: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    const { root, text } = synced.current;
    const span = selectedPath.current && root && view.state.doc.toString() === text ? spanAtPath(root, selectedPath.current) : null;
    editorSetLinkedRange(view, span ? { from: span.start, to: span.tagEnd } : null);
    if (span && reveal && !view.hasFocus) editorRevealRange(view, span.start + 1, span.tagEnd, DESIGNER);
  };

  /** The XAML cursor's element → the designer's selection (only while the XAML has focus). */
  const followCursor = () => {
    const view = viewRef.current;
    const { root, text } = synced.current;
    if (!view || !view.hasFocus || !root || view.state.doc.toString() !== text) return;
    designerRef.current?.selectPath(pathAt(root, view.state.selection.main.head));
  };

  /** Hands the designer `text` if it's valid; otherwise keeps the last good layout and says what's wrong. */
  const parse = (text: string) => {
    window.clearTimeout(timer.current);
    if (text === synced.current.text) {
      setError(null);
      return;
    }
    try {
      const doc = parseYui(text);
      synced.current = { text, root: scanYui(text) };
      setError(null);
      designerRef.current?.receive(doc, text);
      followCursor();
    } catch (err) {
      setError(cleanError(String(err instanceof Error ? err.message : err)));
    }
  };

  const onSync = (u: EditorSyncUpdate) => {
    if (u.source === DESIGNER) return;
    // Never dispatch into the view from inside its update: react after it.
    if (u.docChanged) {
      window.clearTimeout(timer.current);
      if (u.typing) timer.current = window.setTimeout(() => viewRef.current && parse(viewRef.current.state.doc.toString()), PARSE_DELAY);
      else queueMicrotask(() => parse(u.text));
    } else if (u.focused) queueMicrotask(followCursor);
  };
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const extensions = useMemo(() => [linkedRangeHighlight, editorSyncListener((u) => onSyncRef.current(u))], []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const link = useMemo<DesignerLink>(
    () => ({
      write: (prev, next) => {
        const view = viewRef.current;
        if (!view || readOnlyRef.current) return null;
        const current = view.state.doc.toString();
        // Typed and not parsed yet: catch up instead — the edit was made on a stale layout.
        if (current !== synced.current.text) {
          parse(current);
          return null;
        }
        const text = patchYui(current, prev, next);
        synced.current = { text, root: scanYui(text) };
        editorApplyText(view, text, DESIGNER);
        return text;
      },
      selected: (paths, reveal) => {
        selectedPath.current = paths[0] ?? null;
        mark(reveal);
      },
      // The Edit menu acts on the designer when it was focused last — or is all that's shown.
      preferred: () => layoutRef.current.only === "design" || (layoutRef.current.only !== "xaml" && lastPane.current === "design"),
      attach: (designer) => {
        designerRef.current = designer;
        return () => {
          if (designerRef.current === designer) designerRef.current = null;
        };
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** The designer's own whole-text writes (a new file's first content). */
  const designerChange = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    synced.current = { text, root: scanYui(text) };
    editorApplyText(view, text, DESIGNER);
  };

  const focusPane = (pane: "design" | "xaml") => {
    if (lastPane.current === pane) return;
    lastPane.current = pane;
    setFocusedPane(pane);
    // The Edit menu now acts on the other pane.
    notifyDocumentCommands();
  };

  const showPane = (pane: "design" | "xaml") => {
    if (layout.only) setLayout({ ...layout, only: pane });
    focusPane(pane);
    if (pane === "xaml") viewRef.current?.focus();
  };

  const design = (
    <div className="yui-split-design" onFocusCapture={() => focusPane("design")}>
      <ScreenDesigner {...props} contentVersion={undefined} onChange={designerChange} link={link} />
      {error !== null && (
        <button
          type="button"
          className="yui-split-error"
          title={t("Go to the error")}
          onClick={() => {
            const line = errorLine(error);
            if (viewRef.current && line) revealLine(viewRef.current, line);
          }}
        >
          <Icon name="info" size={14} />
          <span>
            {t("Invalid markup")}: {error}
          </span>
        </button>
      )}
    </div>
  );
  const xaml = (
    <div
      className="yui-split-xaml"
      onFocus={(e) => {
        // Properties keeps showing the element at the cursor, not the file.
        e.stopPropagation();
        focusPane("xaml");
        designerRef.current?.publish();
      }}
    >
      <TextEditor
        {...props}
        language={language}
        extensions={extensions}
        onViewReady={(view) => {
          viewRef.current = view;
          // As CodeMirror holds it (line breaks normalized).
          const text = view.state.doc.toString();
          synced.current = { text, root: scanYui(text) };
        }}
      />
    </div>
  );

  const bar = (
    <div className="yui-split-bar" role="tablist">
      <button type="button" role="tab" className="yui-split-tab" data-active={(layout.only ?? focusedPane) === "design"} onClick={() => showPane("design")}>
        {pt("view", "Design")}
      </button>
      <IconButton title={t("Swap Panes")} onClick={() => setLayout({ ...layout, swapped: !layout.swapped })}>
        <Icon name="swap" />
      </IconButton>
      <button type="button" role="tab" className="yui-split-tab" data-active={(layout.only ?? focusedPane) === "xaml"} onClick={() => showPane("xaml")}>
        XAML
      </button>
      <span className="yui-split-bar-fill" />
      <IconButton title={t("Vertical Split")} data-active={layout.direction === "row" && !layout.only} onClick={() => setLayout({ ...layout, direction: "row", only: null })}>
        <Icon name="split" />
      </IconButton>
      <IconButton title={t("Horizontal Split")} data-active={layout.direction === "column" && !layout.only} onClick={() => setLayout({ ...layout, direction: "column", only: null })}>
        <Icon name="splitRows" />
      </IconButton>
      <IconButton
        title={layout.only ? t("Expand Pane") : t("Collapse Pane")}
        onClick={() => {
          setLayout({ ...layout, only: layout.only ? null : focusedPane });
          // Undo/redo and the clipboard now go to whatever stays visible.
          notifyDocumentCommands();
        }}
      >
        <Icon name={layout.only ? "expand" : "collapse"} />
      </IconButton>
    </div>
  );

  const first = layout.swapped ? "xaml" : "design";
  // On the boundary when stacked (as in Visual Studio); along the bottom otherwise.
  const barOnBoundary = layout.direction === "column" && !layout.only;
  return (
    <div className="yui-split">
      <div className="yui-split-body">
        <SplitPane
          direction={layout.direction}
          first={layout.swapped ? xaml : design}
          second={layout.swapped ? design : xaml}
          ratio={layout.ratio}
          onRatioChange={(ratio) => setLayout({ ...layout, ratio })}
          collapsed={layout.only ? (layout.only === first ? "second" : "first") : null}
          handle={barOnBoundary ? bar : undefined}
          minSize={80}
        />
      </div>
      {!barOnBoundary && bar}
    </div>
  );
}
