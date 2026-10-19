import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { plugins } from "./plugins.generated";

/** One of Yog IDLE's plugins (`src-tauri/src/plugins.rs`), by its key. */
export type YogPlugin = keyof typeof plugins;

/** A command of one of Yog IDLE's plugins. */
export function invokeYog<T>(plugin: YogPlugin, command: string, args?: InvokeArgs): Promise<T> {
  return invoke<T>(`plugin:${plugins[plugin]}|${command}`, args);
}
