import { useEffect, useRef, type ComponentType } from "react";
import {
  type CodeEditorProps,
  EDITOR_KIND,
  type EditorProps,
  type EditorProvider,
  editorProviderIcon,
  extensionOf,
  getEditorView,
  MultiViewEditor,
  revealLine,
  useEditorProviders,
  useKeybinding,
  useShell,
} from "substrate-platform-ui";
import { useBreakpoints } from "../debugger/BreakpointsContext";
import { useDebugSessionContext } from "../debugger/DebugSessionContext";
import { addWatchItem, dataTipProvider } from "../debugger/DataTip";
import { useWatches } from "../debugger/WatchesContext";
import { selectDocument } from "../app/ideSelection";
import { isGeneratedCode, samePath } from "../project/paths";
import { GeneratedFileBar } from "./GeneratedFileBar";
import { type FileTab, useOpenFiles } from "./openFilesContext";
import { PREVIEW_SIDE_ICON, PREVIEW_SIDE_KEYS, tabViews, TOGGLE_PREVIEW_KEYS } from "./tabs/tabViews";

/** Only Rust source is debuggable: the debugger resolves breakpoints against a mod's own compiled native. */
const DEBUGGABLE_EXTENSION = "rs";
/** The tool window a new watch shows in. */
const DEBUG_WINDOW = "debug";

/** One open file's center-dock panel: its editor (in the view chosen for it), under a notice when it's generated code. */
export function FileEditorPanel({ tabId }: { tabId: string }) {
  const { tabs, updateContent, chooseView, rememberedViews } = useOpenFiles();
  const tab = tabs.find((t) => t.id === tabId);
  // Re-renders when editors are registered; the views themselves come from `tabViews`.
  useEditorProviders(tab?.path ?? "");
  const views = tab ? tabViews(tab, rememberedViews()) : null;
  useViewKeys(tab, views, chooseView);
  useRevealLine(tab, views);
  if (!tab || !views) return null;
  const debuggable = extensionOf(tab.name) === DEBUGGABLE_EXTENSION;
  const renderView = (provider: EditorProvider, props: EditorProps) =>
    provider.kind === EDITOR_KIND.text && debuggable ? <DebuggableCode provider={provider} props={props} path={tab.path} /> : <provider.component {...props} />;
  // Generated code (`.yog-build/generated/**.g.rs`) is shown read-only
  // under a notice naming its source, like Visual Studio's auto-generated files.
  const generated = isGeneratedCode(tab.path);
  const editor = (
    <MultiViewEditor
      providers={views.providers}
      view={views.active.id}
      onViewChange={(id) => chooseView(tab.id, id)}
      // The views are buttons in the tab strip (`viewActions`), as in VS Code.
      showSwitcher={false}
      renderView={renderView}
      path={tab.path}
      content={tab.content}
      contentVersion={tab.contentVersion}
      onChange={(next) => updateContent(tab.id, next)}
      readOnly={generated || undefined}
    />
  );
  return (
    // Focus anywhere in the editor shows it in Properties — its own context
    // (a designer's element) or its file; `display: contents` keeps the
    // wrapper out of the layout.
    <div style={{ display: "contents" }} onFocus={() => selectDocument(tab.path)}>
      {generated ? (
        <GeneratedFileBar path={tab.path} content={tab.content}>
          {editor}
        </GeneratedFileBar>
      ) : (
        editor
      )}
    </div>
  );
}

type Views = ReturnType<typeof tabViews>;

/**
 * VS Code's Markdown keys, for any file with more than one view:
 * Ctrl+Shift+V flips between the source and the preview/designer,
 * Ctrl+K V opens the preview to the side.
 */
function useViewKeys(tab: FileTab | undefined, views: Views | null, chooseView: (tabId: string, view: string) => void) {
  const { activeCenterId } = useShell();
  const providers = views?.providers ?? [];
  const active = views?.active;
  const textView = providers.find((p) => p.kind === EDITOR_KIND.text);
  const side = providers.find((p) => editorProviderIcon(p) === PREVIEW_SIDE_ICON);
  const multiView = !!tab && activeCenterId === tab.id && providers.length > 1;
  const showView = (target: EditorProvider | undefined) => {
    if (tab && target) chooseView(tab.id, target.id);
  };
  useKeybinding(TOGGLE_PREVIEW_KEYS, () => showView(active?.kind === EDITOR_KIND.text && active === textView ? providers.find((p) => p.kind !== EDITOR_KIND.text) : textView), {
    id: "editor.togglePreview",
    enabled: multiView,
  });
  useKeybinding(PREVIEW_SIDE_KEYS, () => showView(active === side ? textView : side), { id: "editor.previewToSide", enabled: multiView && !!side });
}

/** A tab's reveal request: brings it to the front and, with a line, moves the cursor there — switching a designer to its text view first. */
function useRevealLine(tab: FileTab | undefined, views: Views | null) {
  const { activateCenterPanel } = useShell();
  const { setView } = useOpenFiles();
  const reveal = tab?.reveal;
  const active = views?.active;
  const textView = views?.providers.find((p) => p.kind === EDITOR_KIND.text);
  // A line to go to, waiting for a text view to be mounted.
  const pendingLine = useRef<{ line: number; column?: number } | null>(null);

  useEffect(() => {
    if (!reveal || !tab) return;
    if (reveal.activate) activateCenterPanel(tab.id);
    if (reveal.line === undefined) return;
    pendingLine.current = { line: reveal.line, column: reveal.column };
    if (active?.kind !== EDITOR_KIND.text && textView) void setView(tab.id, textView.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  // Once the editor is laid out, move the cursor to the requested location.
  useEffect(() => {
    const target = pendingLine.current;
    if (!target || !tab || active?.kind !== EDITOR_KIND.text) return;
    const frame = requestAnimationFrame(() => {
      const editor = getEditorView(tab.path);
      if (!editor) return;
      pendingLine.current = null;
      revealLine(editor, target.line, target.column);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq, active?.id]);
}

/** A Rust file's text view, wired to the debugger: breakpoints, the execution line, DataTips and Add Watch while paused. */
function DebuggableCode({ provider, props, path }: { provider: EditorProvider; props: EditorProps; path: string }) {
  const { forFile, toggle } = useBreakpoints();
  const { executionLocation, debugging } = useDebugSessionContext();
  const watches = useWatches();
  const { showToolWindow } = useShell();
  const CodeComponent = provider.component as ComponentType<CodeEditorProps>;
  return (
    <CodeComponent
      {...props}
      breakpoints={forFile(path)}
      onToggleBreakpoint={(line) => toggle(path, line)}
      executionLine={executionLocation && samePath(executionLocation.file, path) ? executionLocation.line : null}
      // DataTips while paused, evaluated in the selected frame.
      hoverTip={executionLocation ? dataTipProvider(executionLocation.id) : undefined}
      contextMenu={(request) =>
        debugging
          ? [
              addWatchItem(request, (expr) => {
                watches.add(expr);
                showToolWindow(DEBUG_WINDOW);
              }),
            ]
          : []
      }
    />
  );
}
