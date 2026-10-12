import { useEffect, useRef } from "react";
import { getEditorView, setChangeBaseline, useEditorView, useKeybinding, useShell } from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { BranchPickerHost } from "./BranchPicker";
import { GIT_CHANGES_PANEL } from "./GitChangesWindow";
import { gitApi } from "./gitApi";
import { openGitRepository, useRevealedGitDocument } from "./gitDocuments";
import { gitState, refreshGit, setGitRoot, useGit } from "./gitStore";

const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 400;

/**
 * Keeps the Git store pointed at the open project and fresh — on window
 * focus, after saves, and on a slow poll while the window has focus — and
 * does the shell-side work for it: the Git windows' keybindings, bringing
 * a requested Git document to the front, reloading files a Git operation
 * changed on disk, and the editors' change markers against HEAD.
 */
export function GitHost() {
  const { project } = useProject();
  const { tabs, recheckDisk } = useOpenFiles();
  const shell = useShell();
  const git = useGit();

  useEffect(() => setGitRoot(project?.root ?? null), [project?.root]);

  // Focus and a slow poll catch what changed outside (a terminal, another tool).
  useEffect(() => {
    const onFocus = () => void refreshGit();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.hasFocus() && !gitState().busy) void refreshGit();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, []);

  // A save (any tab's disk content changing) — debounced, a Save All is one refresh.
  const diskKey = tabs.map((tab) => `${tab.path}\u0000${tab.diskContent.length}\u0000${hash(tab.diskContent)}`).join("\u0001");
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshGit(), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [diskKey]);

  // A checkout, pull, stash or undo rewrote files — reload the open ones.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !git.busy) void recheckDisk();
    wasBusy.current = !!git.busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.busy]);

  // Visual Studio: Ctrl+0, Ctrl+G — Git Changes; Ctrl+0, Ctrl+R — Git Repository.
  useKeybinding("Ctrl+0 Ctrl+G", () => shell.showToolWindow(GIT_CHANGES_PANEL), { id: "git.changes" });
  useKeybinding("Ctrl+0 Ctrl+R", () => openGitRepository(), { id: "git.repository", enabled: !!git.status });

  const revealed = useRevealedGitDocument();
  useEffect(() => {
    // After the shell has the new panel.
    if (revealed) window.setTimeout(() => shell.activateCenterPanel(revealed.id), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed?.seq]);

  return (
    <>
      <BranchPickerHost />
      <ChangeMarkers paths={tabs.map((tab) => tab.path)} />
    </>
  );
}

/** A cheap content fingerprint, so an unchanged save doesn't refresh. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += Math.max(1, Math.floor(text.length / 512))) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/** HEAD's text per file, for the commit it was read at. */
const headTexts = new Map<string, { head: string; text: string | null }>();
/** What each editor's markers were last set against (`head` + path) — editors are re-created when a tab moves, so per view. */
const applied = new WeakMap<object, string>();
/** Tags whose HEAD text is being read. */
const pending = new Set<string>();

/**
 * The editors' change markers (`changeGutter`) against HEAD — Visual
 * Studio's green/blue/red margin marks. Re-read when HEAD moves; set again
 * on an editor that's newly mounted. Outside a repository, or for a file
 * Git doesn't track, there are no markers.
 */
function ChangeMarkers({ paths }: { paths: string[] }) {
  const { root, status } = useGit();
  // Re-render when any editor mounts (or changes) — cheap: the work below is skipped when nothing's new.
  useEditorView(null);
  const head = status?.head ?? null;
  const key = paths.join("\n");

  useEffect(() => {
    for (const path of paths) {
      const view = getEditorView(path);
      if (!view) continue;
      const tag = `${head ?? ""}\u0000${path}`;
      if (applied.get(view) === tag) continue;
      if (!root || !head) {
        setChangeBaseline(view, null);
        applied.set(view, tag);
        continue;
      }
      const cached = headTexts.get(path);
      if (cached && cached.head === head) {
        setChangeBaseline(view, cached.text);
        applied.set(view, tag);
        continue;
      }
      if (pending.has(tag)) continue;
      pending.add(tag);
      gitApi
        .headText(root, path)
        .then((text) => {
          headTexts.set(path, { head, text });
          const current = getEditorView(path);
          // Still the same HEAD — a commit meanwhile asks again.
          if (!current || gitState().status?.head !== head) return;
          setChangeBaseline(current, text);
          applied.set(current, tag);
        })
        .catch(() => {})
        .finally(() => pending.delete(tag));
    }
  });

  // Forget files no longer open.
  useEffect(() => {
    const open = new Set(paths);
    for (const path of headTexts.keys()) if (!open.has(path)) headTexts.delete(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
