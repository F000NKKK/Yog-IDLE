import { useState, useSyncExternalStore } from "react";
import { QuickPick, useT, type EditorProvider, type QuickPickItem } from "substrate-platform-ui";

/**
 * "Open With → Full List…": every editor that can open the file, in a
 * searchable popup — Visual Studio's Open With dialog, without a menu that
 * grows with every editor. Requested from anywhere (`openWithPicker`),
 * rendered once by the app (`OpenWithPickerHost`).
 */
interface Request {
  providers: { provider: EditorProvider; label: string }[];
  current: string | undefined;
  pick: (view: string) => void;
}

let request: Request | null = null;
const subscribers = new Set<() => void>();

function set(r: Request | null) {
  request = r;
  subscribers.forEach((notify) => notify());
}

export function openWithPicker(r: Request): void {
  set(r);
}

interface Item extends QuickPickItem {
  view: string;
}

export function OpenWithPickerHost() {
  const r = useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => request,
  );
  return r ? <Picker request={r} onClose={() => set(null)} /> : null;
}

function Picker({ request: r, onClose }: { request: Request; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items: Item[] = r.providers
    .filter(({ label }) => !q || label.toLowerCase().includes(q))
    .map(({ provider, label }) => ({
      key: provider.id,
      view: provider.id,
      label,
      description: provider.id === r.current ? t("current") : undefined,
    }));
  return (
    <QuickPick
      query={query}
      onQueryChange={setQuery}
      placeholder={t("Open with…")}
      items={items}
      onAccept={(item) => {
        onClose();
        r.pick(item.view);
      }}
      onClose={onClose}
      emptyText={t("No editor matches")}
    />
  );
}
