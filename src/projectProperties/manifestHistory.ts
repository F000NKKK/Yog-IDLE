import { joinPath, pushDocumentStep, t } from "substrate-platform-ui";
import { files } from "../files";
import { reportError } from "../reportError";

/**
 * Runs an edit of mod `root`'s yog.toml as a step of history `scope`: the
 * text as it was is written back on Undo, as it became on Redo; then
 * `restored` re-reads what shows it. Every writer of yog.toml (Project
 * Properties, Properties) goes through here.
 */
export async function editManifest<T>(scope: string, root: string, edit: () => Promise<T>, restored: () => void): Promise<T> {
  const manifest = joinPath(root, "yog.toml");
  const before = await files.read(manifest);
  const result = await edit();
  const after = await files.read(manifest);
  if (after !== before) {
    const write = (text: string) =>
      files
        .write(manifest, text)
        .then(restored)
        .catch((err) => reportError(t("Couldn't write yog.toml: {error}", { error: String(err) })));
    pushDocumentStep(scope, { undo: () => void write(before), redo: () => void write(after) });
  }
  return result;
}
