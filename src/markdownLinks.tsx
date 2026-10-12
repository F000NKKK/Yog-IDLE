import { openUrl } from "@tauri-apps/plugin-opener";
import { setMarkdownLinkHandler } from "substrate-platform-ui";
import { openFile } from "./fileOpenBus";
import { reportError } from "./reportError";

// Links clicked in a Markdown preview: local files open in a tab, anything
// else in the system browser — imported once for its side effect.

setMarkdownLinkHandler((target, kind) => {
  if (kind === "file") openFile({ path: target });
  else openUrl(target).catch((err) => reportError(`Couldn't open ${target}: ${err}`));
});
