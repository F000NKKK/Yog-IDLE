import { emit } from "@tauri-apps/api/event";
import { notify } from "substrate-platform-ui";
import { IDE_OUTPUT_EVENT } from "./outputSource";

/**
 * Surfaces a failure the user should know about — as an `[error]` line in
 * Output's General source (so it's still there after the
 * toast fades) and as an error notification.
 */
export function reportError(message: string): void {
  emit(IDE_OUTPUT_EVENT, `[error] ${message}`).catch(() => {});
  notify({ level: "error", message });
}
