// What a tab shows its file with: the views remembered per file, Open With,
// asking to save, regenerating a screen's code.

import { type EditorProvider, editorProviderById, editorProvidersFor, extensionOf, fileNameOf, generalEditorProviders, notify, showDialog, t } from "substrate-platform-ui";
import { serveMethod } from "../data/yogIds.generated";
import { openWithPicker } from "../OpenWithPicker";
import { cli } from "../cli";
import { setSavedFileDiagnostics } from "../diagnostics/buildDiagnostics";
import type { FileTab } from "../OpenFilesContext";

/** Ctrl+Shift+V flips between a file's source and its preview/designer; Ctrl+K V opens the preview to the side (VS Code's Markdown keys). */
export const TOGGLE_PREVIEW_KEYS = "Ctrl+Shift+V";
export const PREVIEW_SIDE_KEYS = "Ctrl+K V";
/** The icon of a provider that previews to the side. */
export const PREVIEW_SIDE_ICON = "previewSide";

export const VIEWS_KEY = "editor.views";

export function isViewMap(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.values(value).every((v) => typeof v === "string");
}


/**
 * The views a tab can show — its file's own editors, plus one picked through
 * "Open With…" that isn't among them (labelled by its full name, to tell it
 * from the file's own "Code") — and the one it shows: its own choice, else
 * the one last chosen for its extension, else the default.
 */
export function tabViews(tab: FileTab, remembered: Record<string, string>): { providers: EditorProvider[]; active: EditorProvider } {
  const matching = editorProvidersFor(tab.path);
  const view = tab.view ?? remembered[extensionOf(tab.name)];
  const picked = tab.view && !matching.some((p) => p.id === tab.view) ? editorProviderById(tab.view) : undefined;
  const providers = picked ? [...matching, { ...picked, label: picked.name ?? picked.label }] : matching;
  return { providers, active: providers.find((p) => p.id === view) ?? providers[0] };
}

/** Plain enough to be both a dock tab's `ContextMenuItem` and Project Explorer's `FileTreeMenuItem`. */
export interface OpenWithItem {
  label: string;
  checked: boolean;
  separatorBefore: boolean;
  onSelect: () => void;
}

/** How many editors "Open With" lists before "Full List…". */
export const OPEN_WITH_SHOWN = 5;

/**
 * "Open With…" entries for `path`, the likeliest first: the editors made
 * for it (the default marked), then plain text, then the other general
 * editors — any text editor can open any file; designers and viewers made
 * for one format only appear for their own files. At most
 * {@link OPEN_WITH_SHOWN} of them, then "Full List…" with all of them (and
 * the one in use, if it isn't among the first).
 */
export function openWithItems(path: string, current: string | undefined, pick: (view: string) => void): OpenWithItem[] {
  const matching = editorProvidersFor(path);
  const general = generalEditorProviders().filter((p) => !matching.includes(p));
  // Plain text is the likeliest of the general ones; the rest by name.
  general.sort((a, b) => Number(b.id === "substrate.text") - Number(a.id === "substrate.text"));
  const all = [
    ...matching.map((p, i) => ({ provider: p, label: i === 0 ? t("{name} (default)", { name: t(p.name ?? p.label) }) : t(p.name ?? p.label) })),
    ...general.map((p) => ({ provider: p, label: t(p.name ?? p.label) })),
  ];
  const shown = all.slice(0, OPEN_WITH_SHOWN);
  const items: OpenWithItem[] = shown.map(({ provider, label }, i) => ({
    label,
    checked: provider.id === current,
    // A line between the file's own editors and the general ones.
    separatorBefore: i > 0 && i === matching.length,
    onSelect: () => pick(provider.id),
  }));
  if (all.length > shown.length) {
    items.push({
      label: t("Full List…"),
      checked: !shown.some((s) => s.provider.id === current) && all.some((a) => a.provider.id === current),
      separatorBefore: true,
      onSelect: () => openWithPicker({ providers: all, current, pick }),
    });
  }
  return items;
}

let lastTabId = 0;
let lastRevealSeq = 0;

/** A new tab's id. */
export const newTabId = (): string => `file-${++lastTabId}`;

/** The next reveal's sequence number (a new reveal of the same place still scrolls). */
export const nextRevealSeq = (): number => ++lastRevealSeq;

/** Save / Don't Save / Cancel about `names` — resolves `"save"`, `"discard"` or `"cancel"`. */
export async function askToSave(names: string[]): Promise<string> {
  const many = names.length > 1;
  const result = await showDialog({
    title: t("Unsaved Changes"),
    message: many ? (
      <>
        {t("Save changes to the following files?")}
        <ul>
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </>
    ) : (
      t("Save changes to {name}?", { name: names[0] })
    ),
    buttons: [
      { id: "cancel", label: t("Cancel"), cancel: true },
      { id: "discard", label: t("Don't Save") },
      { id: "save", label: many ? t("Save All") : t("Save"), variant: "primary" },
    ],
  });
  return result.button;
}

/**
 * A saved `.yui` screen, `.yres` resource file or `.yblock`/`.yitem`: regenerate its
 * `.yog-build/generated/**` code (`yog ui gen` / `yog res check` / `yog content check`),
 * so the code-behind sees it without a build.
 */
export function regenerateScreen(path: string) {
  const fail = (error: string) =>
    notify({ level: "warn", message: t("Couldn't generate the code for {name}: {error}", { name: fileNameOf(path), error }) });
  cli<{ error: string | null; log: string; root: string }>(serveMethod.YUI_CODEGEN, { path })
    .then(({ error, log, root }) => {
      setSavedFileDiagnostics(path, root, log);
      if (error) fail(error);
    })
    .catch((err) => fail(String(err)));
}

/**
 * Owns every open file tab — subscribes to Substrate's `onOpenFileRequest` (since Project
 * Explorer, the debugger and others request opens from unrelated parts of
 * the component tree), and hands out one real dock `PanelDef` per tab so
 * the shell's own center-dock tab strip *is* the file tab strip, with no
 * extra nesting.
 *
 * Unsaved work is never dropped silently: closing a dirty tab (or the
 * window) asks first, a failed save keeps the tab dirty, and a file changed
 * on disk only reloads into a tab without edits (checked whenever the
 * window regains focus).
 */
