# Yog-IDLE

An IDE for [Yog](https://github.com/F000NKKK/Yog-Mod-Loader) Minecraft
mods — edit, build, run, debug, and hot-reload a mod from a Visual
Studio–style layout (Project Explorer, editor tabs, Output log, integrated
Terminal, Debug panel), with a visual `yog-ui` screen designer (Toolbox,
Properties, a central canvas with live preview in the running game) planned
on top.

Built with [Tauri](https://tauri.app/) (Rust backend, web frontend) on top
of [Substrate Platform](https://github.com/F000NKKK/Substrate-Platform), a
brand-neutral IDE core (task runner, log sink, generic project/build
plumbing, plus its own docking/tool-window shell and widget set) —
Yog-IDLE is its first product. The terminal uses
[xterm.js](https://xtermjs.org/) (backed by a real PTY via
`portable-pty` on the Rust side) — the same terminal tech VS Code itself
uses.

## Development

```sh
npm install
npm run tauri dev
```

## Status

Works today:

- **Projects** — open a folder or a `yog.toml`; the last project is
  reopened on startup and recent ones are listed in the File menu. Project
  Explorer with create/rename/delete, multi-tab code editor with Save All.
- **Build & publish** — Build (`yog build`) and saved publish profiles
  (package as `.yog`, or `yog publish exports`), with output streamed to
  the Output panel.
- **Run** — `[run.<name>]` targets from `yog.toml` (`yog run <name>`),
  Release or Debug mode; Stop/Restart from the toolbar. On Linux the game
  reports in over `yog-runtime`'s control socket, driving the status bar
  (pid, loaded mods).
- **Hot reload** (Linux) — rebuilds the mod and swaps the new `.yog` into
  the running game over the control socket; only works while the ABI
  version is unchanged.
- **Native debugging** (Linux, `ptrace`) — Debug-mode runs attach
  `yog-debugger` to the game: gutter breakpoints (settable before or during
  a session), Continue/Step, and a call stack in the Debug panel.
  Experimental: only the game's main thread is traced so far.
- Integrated terminal(s), settings window, and the Substrate docking shell.

Planned:

- The visual `yog-ui` designer — Toolbox, Properties, a design canvas, and
  live preview in the running client (the Toolbox/Properties panels are
  placeholders today).
- Editor commands (Undo/Redo/Format/Toggle Comment) wired to the focused
  editor.
- Debugging and hot reload on Windows and macOS.

## License

Dual-licensed: **AGPL-3.0-only** (see [LICENSE](LICENSE)) — free for any
use, provided you comply with the AGPL — or a **Commercial License** for
closed-source use, free below $1,000/mo net profit and a sliding royalty
above that. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for details.
