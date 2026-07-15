import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

/// Real PTY-backed terminal — spawns a shell via the Rust `pty_spawn`
/// command (see `substrate_platform::PtySession`) and streams its output
/// through `pty-output` events. Same terminal tech VS Code itself uses.
export function Terminal() {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new XTerm({
            fontFamily: "Cascadia Code, Consolas, monospace",
            fontSize: 13,
            theme: {
                background: "#1e1e1e",
                foreground: "#d4d4d4",
                cursor: "#d4d4d4",
            },
            cursorBlink: true,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();

        let disposed = false;
        const unlistenPromise = listen<string>("pty-output", (event) => {
            if (!disposed) term.write(event.payload);
        });

        invoke("pty_spawn", { cols: term.cols, rows: term.rows }).catch((err) =>
            term.writeln(`\r\n[failed to start shell: ${err}]`)
        );

        const onData = term.onData((data) => {
            invoke("pty_write", { data }).catch(() => {});
        });

        const resizeObserver = new ResizeObserver(() => {
            fitAddon.fit();
            invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            disposed = true;
            resizeObserver.disconnect();
            onData.dispose();
            unlistenPromise.then((unlisten) => unlisten());
            term.dispose();
        };
    }, []);

    return <div ref={containerRef} style={{ width: "100%", height: "100%", padding: 4 }} />;
}
