import { emit } from "@tauri-apps/api/event";
import { notify } from "substrate-platform-ui";

/**
 * Surfaces a failure the user should know about — as an `[error]` line in
 * Output (where build errors already land, so it's still there after the
 * toast fades) and as an error notification.
 */
export function reportError(message: string): void {
  emit("workflow-output", `[error] ${message}`).catch(() => {});
  notify({ level: "error", message });
}
