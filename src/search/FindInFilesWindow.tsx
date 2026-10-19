import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  CheckField,
  confirmDialog,
  editorSetText,
  eventKey,
  getEditorView,
  invokeCommand,
  notify,
  reportError,
  SearchField,
  type SearchOptions,
  SelectField,
  t as translate,
  TextField,
  tn,
  ToolbarModes,
  useShell,
  useT,
} from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { useGlobalState } from "../WorkspaceContext";
import { runFind, showReplaceResults, type FindQuery, type LookIn, type OpenDocument, type ReplaceSummary } from "./findStore";
import { FIND_IN_FILES_PANEL, searchDrafts, useSearchUi, type FindWindowMode } from "./searchUi";
import "./search.css";
import { yog } from "../host.generated";

/** The Find Results tool window's id (declared in `App`). */
export const FIND_RESULTS_PANEL = "findResults";

interface Remembered extends SearchOptions {
  lookIn: LookIn;
  fileMask: string;
  /** Entire project also searches generated code (screens' `.g.rs` under `.yog-build/generated/`). */
  includeGenerated?: boolean;
}

const DEFAULTS: Remembered = { matchCase: false, wholeWord: false, regex: false, lookIn: "project", fileMask: "" };

function isRemembered(value: unknown): boolean {
  const v = value as Remembered | null;
  return !!v && typeof v === "object" && typeof v.matchCase === "boolean" && typeof v.fileMask === "string" && ["current", "open", "project"].includes(v.lookIn);
}

/** The editor's selection (one line of it), else the word at the cursor — what Find what starts with. */
function seedText(path: string | undefined): string {
  const view = path ? getEditorView(path) : null;
  if (!view) return "";
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) {
    const text = state.sliceDoc(range.from, range.to);
    return text.includes("\n") ? "" : text;
  }
  const word = state.wordAt(range.head);
  return word ? state.sliceDoc(word.from, word.to) : "";
}

/** A document's current text: its live editor's, else the tab's last known content. */
export function bufferText(tab: { path: string; content: string }): string {
  return getEditorView(tab.path)?.state.doc.toString() ?? tab.content;
}

function lookInLabel(lookIn: LookIn): string {
  return lookIn === "current" ? translate("Current document") : lookIn === "open" ? translate("All open documents") : translate("Entire project");
}

/**
 * Visual Studio's Find and Replace window (Find in Files / Replace in Files):
 * a tool window that opens floating and docks anywhere, like any other.
 * Find All lists every hit in Find Results; Replace All rewrites them —
 * open documents in their editors (undoable, left unsaved), every other
 * file on disk, after a confirmation.
 */
export function FindInFilesWindow() {
  const t = useT();
  const request = useSearchUi().find;
  const { project } = useProject();
  const { tabs, updateContent, recheckDisk } = useOpenFiles();
  const activeTab = useActiveFileTab();
  const shell = useShell();
  const [mode, setModeState] = useState(searchDrafts.findMode);
  const [remembered, setRemembered] = useGlobalState<Remembered>("search.findInFiles", DEFAULTS, isRemembered);
  const [pattern, setPatternState] = useState(searchDrafts.findPattern);
  const [replacement, setReplacement] = useGlobalState<string>("search.replaceWith", "", (v) => typeof v === "string");
  const [busy, setBusy] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  const textTabs = tabs.filter((tab) => tab.textLoaded);
  const hasCurrent = !!activeTab?.textLoaded;
  const available: Record<LookIn, boolean> = { current: hasCurrent, open: textTabs.length > 0, project: !!project };
  // A remembered choice that isn't possible right now falls back to the widest one that is.
  const lookIn: LookIn = available[remembered.lookIn] ? remembered.lookIn : project ? "project" : hasCurrent ? "current" : "open";

  function setMode(next: FindWindowMode) {
    searchDrafts.findMode = next;
    setModeState(next);
  }

  function setPattern(next: string) {
    searchDrafts.findPattern = next;
    setPatternState(next);
  }

  // Ctrl+Shift+F/H: switch tab, re-seed from the editor, focus. Only on a
  // new request — the window remounts whenever it's moved to another dock.
  useEffect(() => {
    if (!request || request.seq === searchDrafts.findSeq) return;
    searchDrafts.findSeq = request.seq;
    setMode(request.mode);
    const seed = seedText(activeTab?.path);
    if (seed) setPattern(seed);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);

  const options: SearchOptions = { matchCase: remembered.matchCase, wholeWord: remembered.wholeWord, regex: remembered.regex };
  const canRun = pattern !== "" && available[lookIn] && !busy;

  function query(): FindQuery {
    return { pattern, ...options, fileMask: remembered.fileMask, includeGenerated: mode === "find" && !!remembered.includeGenerated };
  }

  function documents(): OpenDocument[] {
    const scoped = lookIn === "current" ? textTabs.filter((tab) => tab.id === activeTab?.id) : textTabs;
    return scoped.map((tab) => ({ path: tab.path, text: bufferText(tab) }));
  }

  function caption(verb: string): string {
    const parts = [`${verb} "${pattern}"`];
    if (options.matchCase) parts.push(t("Match case"));
    if (options.wholeWord) parts.push(t("Whole word"));
    if (options.regex) parts.push(t("Regular expressions"));
    parts.push(lookInLabel(lookIn));
    if (remembered.fileMask.trim()) parts.push(`"${remembered.fileMask.trim()}"`);
    return parts.join(", ");
  }

  function findAll() {
    if (!canRun) return;
    shell.showToolWindow(FIND_RESULTS_PANEL);
    void runFind({ caption: caption(t("Find all")), root: project?.root ?? null, lookIn, query: query(), documents: documents() });
  }

  async function replaceAll() {
    if (!canRun) return;
    const where = lookInLabel(lookIn);
    const ok = await confirmDialog({
      title: t("Replace All"),
      message:
        t('Replace all occurrences of "{find}" with "{replace}" in {where}?', { find: pattern, replace: replacement, where }) +
        (lookIn === "project" ? "\n\n" + t("Files that aren't open are changed on disk; that can't be undone with Undo.") : ""),
      confirmLabel: t("Replace All"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const summary = await invokeCommand<ReplaceSummary>(yog.code.replaceInFiles, {
        request: { root: project?.root ?? null, scope: lookIn === "project" ? "project" : "documents", query: query(), replacement, documents: documents() },
      });
      for (const doc of summary.documents) {
        const view = getEditorView(doc.path);
        if (view) editorSetText(view, doc.text);
        else {
          const tab = tabs.find((tab) => tab.path === doc.path);
          if (tab) updateContent(tab.id, doc.text);
        }
      }
      if (summary.files.length > 0) await recheckDisk();
      summary.errors.forEach((err) => reportError(t("Replace in Files couldn't write {error}", { error: err })));
      shell.showToolWindow(FIND_RESULTS_PANEL);
      showReplaceResults(caption(t("Replace all")) + ` → "${replacement}"`, project?.root ?? null, summary);
      const files = summary.documents.length + summary.files.length;
      notify({
        message:
          summary.total === 0
            ? t("No occurrences were found.")
            : tn(summary.total, "{count} occurrence replaced", "{count} occurrences replaced") + ", " + tn(files, "{count} file", "{count} files"),
      });
    } catch (err) {
      reportError(t("Replace in Files failed: {error}", { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // Escape closes it while it floats, like a dialog; docked, it stays.
    if (e.key === "Escape" && shell.isToolWindowFloating(FIND_IN_FILES_PANEL)) {
      e.preventDefault();
      shell.hideToolWindow(FIND_IN_FILES_PANEL);
      return;
    }
    // Alt+C / Alt+W / Alt+E toggle the options, as in Quick Find.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = eventKey(e.nativeEvent);
      const option = key === "c" ? "matchCase" : key === "w" ? "wholeWord" : key === "e" ? "regex" : null;
      if (option) {
        e.preventDefault();
        setRemembered((r) => ({ ...r, [option]: !r[option] }));
        return;
      }
    }
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (mode === "replace") void replaceAll();
      else findAll();
    }
  }

  return (
    <div className="idle-fif-body" onKeyDown={onKeyDown}>
      <div className="idle-fif-modes">
        <ToolbarModes
          showLabels
          value={mode}
          onChange={setMode}
          modes={[
            { value: "find", label: "Find in Files" },
            { value: "replace", label: "Replace in Files" },
          ]}
        />
      </div>

      <label className="idle-fif-label" htmlFor="idle-fif-find">
        {t("Find what:")}
      </label>
      <SearchField
        id="idle-fif-find"
        inputRef={findRef}
        value={pattern}
        onValueChange={setPattern}
        options={options}
        onOptionsChange={(o) => setRemembered((r) => ({ ...r, ...o }))}
        placeholder={t("Search text")}
      />

      {mode === "replace" && (
        <>
          <label className="idle-fif-label" htmlFor="idle-fif-replace">
            {t("Replace with:")}
          </label>
          <TextField id="idle-fif-replace" className="idle-fif-input" value={replacement} spellCheck={false} onChange={(e) => setReplacement(e.target.value)} />
          {options.regex && <div className="idle-fif-hint">{t("$1, $2, ${name} insert the captured groups.")}</div>}
        </>
      )}

      <div className="idle-fif-row">
        <div className="idle-fif-col">
          <label className="idle-fif-label" htmlFor="idle-fif-lookin">
            {t("Look in:")}
          </label>
          <SelectField
            id="idle-fif-lookin"
            value={lookIn}
            onChange={(v) => setRemembered((r) => ({ ...r, lookIn: v as LookIn }))}
            options={[
              { value: "current", label: t("Current document"), disabled: !available.current },
              { value: "open", label: t("All open documents"), disabled: !available.open },
              { value: "project", label: t("Entire project"), disabled: !available.project },
            ]}
          />
        </div>
        <div className="idle-fif-col">
          <label className="idle-fif-label" htmlFor="idle-fif-mask">
            {t("File types:")}
          </label>
          <TextField
            id="idle-fif-mask"
            className="idle-fif-input"
            value={remembered.fileMask}
            spellCheck={false}
            placeholder="*.rs;*.toml;!*.lock"
            onChange={(e) => setRemembered((r) => ({ ...r, fileMask: e.target.value }))}
          />
        </div>
      </div>
      {lookIn === "project" && <div className="idle-fif-hint">{t("Includes subfolders; skips .gitignore'd files, target/, node_modules/ and binaries.")}</div>}
      {lookIn === "project" && mode === "find" && (
        <div className="idle-fif-hint">
          <CheckField
            checked={!!remembered.includeGenerated}
            onChange={(on) => setRemembered((r) => ({ ...r, includeGenerated: on }))}
            label={t("Include generated files (.yog-build/generated)")}
          />
        </div>
      )}

      <div className="idle-fif-buttons">
        {mode === "find" ? (
          <Button variant="primary" disabled={!canRun} onClick={findAll}>
            {t("Find All")}
          </Button>
        ) : (
          <>
            <Button disabled={!canRun} onClick={findAll}>
              {t("Find All")}
            </Button>
            <Button variant="primary" disabled={!canRun} onClick={() => void replaceAll()}>
              {t("Replace All")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
