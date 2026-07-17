import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    // `substrate-platform-ui` is symlinked in via `file:`, and (despite
    // declaring react/react-dom as peerDependencies only) has its own
    // installed copies under its real (symlink-target) node_modules.
    // `preserveSymlinks` makes Vite resolve its imports against that real
    // location, so without this, its code can end up calling hooks against
    // a different React module instance than the one actually rendering —
    // "Invalid hook call" despite both copies being the same version.
    dedupe: ["react", "react-dom"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. WebKitGTK's on-disk HTTP cache has repeatedly served stale modules
    // across `tauri dev` restarts during development (a hook's return shape
    // changing, a component's JSX not reflecting recent edits) even after
    // clearing Vite's own cache — force every dev response uncached so the
    // webview can never serve anything but what's on disk right now.
    headers: {
      "Cache-Control": "no-store",
    },
  },
}));
