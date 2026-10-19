import { errorText, openLink, setMarkdownLinkHandler } from "substrate-platform-ui";
import { openFile } from "./fileOpenBus";
import { reportError } from "./reportError";

// Links clicked in a Markdown preview: local files open in a tab, anything
// else in the system browser — imported once for its side effect.

setMarkdownLinkHandler((target, kind) => {
  if (kind === "file") openFile({ path: target });
  else openLink(target).catch((err) => reportError(errorText(err)));
});
