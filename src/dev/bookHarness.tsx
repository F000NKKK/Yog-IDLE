// The book designer alone in a browser, for checking it with Playwright:
// `invoke` goes to the designer bridge (`cargo run --example
// designer_bridge`, port 1421) instead of the Tauri shell.
// Open /book-harness.html?path=<absolute .ybook path>[&lang=ru].

const BRIDGE = "http://127.0.0.1:1421";

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: unknown) => {
    const r = await fetch(`${BRIDGE}/${cmd}`, { method: "POST", body: JSON.stringify(args ?? {}) });
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

const params = new URLSearchParams(location.search);
const path = params.get("path") ?? "";

async function main() {
  const React = await import("react");
  const ReactDOM = await import("react-dom/client");
  const ui = await import("substrate-platform-ui");
  await import("../locales/ru");
  const { BookEditor } = await import("../editors/BookEditor");
  const initial: string = (await (window as any).__TAURI_INTERNALS__.invoke("read_text", { path })) ?? "";
  if (params.get("lang")) ui.setLocale?.(params.get("lang")!);

  function Harness() {
    const [content, setContent] = React.useState(initial);
    (window as any).__bookContent = content;
    return React.createElement(BookEditor as any, { path, content, onChange: setContent, readOnly: false });
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    React.createElement(ui.ThemeProvider, null, React.createElement(Harness))
  );
}
main();
