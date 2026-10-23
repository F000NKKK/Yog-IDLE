import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand, showDialog, useT } from "substrate-platform-ui";
import { EVENT, emitTo, listenTo, type HotReloadEvent } from "../app/events";
import "../useHotReload.css";
import { yog } from "../host.generated";

/**
 * The toolbar's Hot Reload action — `mod_hot_reload` rebuilds the project
 * and swaps the new `.yog` into the running game over its control socket
 * (see `debugger::hot_reload` on the Rust side). `busy` covers the whole
 * build + reload, ending on the `hot-reload` event's `"done"` stage; the
 * outcome itself is reported in Output and the status bar.
 *
 * When the new build registers what only a restart applies — blocks,
 * items, entity types added, removed or changed — the `"confirm"` stage
 * asks what to do, as Visual Studio does for edits Hot Reload can't apply:
 * restart the game (`restart`), reload what can be anyway, or cancel.
 */
export function useHotReload(restart: () => void) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const restartRef = useRef(restart);
  restartRef.current = restart;

  useEffect(() => {
    const unlisten = listenTo(EVENT.hotReload, (reload) => {
      setBusy(reload.stage !== "done");
      if (reload.stage === "confirm") void confirm(reload);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm(reload: HotReloadEvent) {
    const changes = reload.changes ?? { added: [], removed: [], changed: [] };
    const groups: [string, string[]][] = [
      [t("New"), changes.added],
      [t("Changed"), changes.changed],
      [t("Removed"), changes.removed],
    ];
    const { button } = await showDialog({
      title: t("Hot Reload"),
      message: (
        <div className="hot-reload-changes">
          <p>{t("{mod} registers what the game only takes when it starts. Restart the game to apply it — or reload the code, resources and data now and leave these as they are.", { mod: reload.modId })}</p>
          {groups
            .filter(([, list]) => list.length > 0)
            .map(([label, list]) => (
              <section key={label}>
                <h4>{label}</h4>
                <ul>
                  {list.map((entry) => (
                    <li key={entry}>
                      <code>{entry}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      ),
      buttons: [
        { id: "restart", label: t("Restart Game"), variant: "primary", default: true },
        { id: "apply", label: t("Reload Code and Resources") },
        { id: "cancel", label: t("Cancel"), cancel: true },
      ],
    });
    await invokeCommand(yog.run.modHotReloadDecide, { choice: button }).catch((err) => emitTo(EVENT.buildOutput, `[error] hot reload: ${err}`));
    if (button === "restart") restartRef.current();
  }

  const trigger = useCallback((projectRoot: string) => {
    setBusy(true);
    invokeCommand(yog.run.modHotReload, { projectRoot }).catch((err) => {
      setBusy(false);
      // Refused before anything started (not running, already busy, ...) —
      // no `hot-reload` event will follow, so report it here.
      emitTo(EVENT.buildOutput, `[error] hot reload: ${err}`);
    });
  }, []);

  return { busy, trigger };
}
