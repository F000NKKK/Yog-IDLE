# Yog-IDLE

A visual UI editor for [Yog](https://github.com/F000NKKK/Yog-Mod-Loader)
Minecraft mods — design `yog-ui` screens with a Visual Studio–style
layout (Toolbox, Solution Explorer, Properties, a central Designer canvas,
Output log, integrated Terminal) and preview them live in a running game
client, with no restart required.

Built with [Tauri](https://tauri.app/) (Rust backend, web frontend) on top
of [Substrate Platform](https://github.com/F000NKKK/Substrate-Platform), a
brand-neutral IDE core (task runner, log sink, generic project/build
plumbing) — Yog-IDLE is its first product. Docking uses
[dockview](https://dockview.dev/) and the terminal uses
[xterm.js](https://xtermjs.org/) (backed by a real PTY via
`portable-pty` on the Rust side) — the same terminal tech VS Code itself
uses.

## Development

```sh
npm install
npm run tauri dev
```

## Status

Early scaffold (default Tauri + React + TypeScript template). Docking,
terminal, and the `yog-ui-spec` widget editor are not wired up yet.

## License

Dual-licensed: **AGPL-3.0-only** (see [LICENSE](LICENSE)) — free for any
use, provided you comply with the AGPL — or a **Commercial License** for
closed-source use, free below $1,000/mo net profit and a sliding royalty
above that. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for details.
