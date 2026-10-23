import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "substrate-platform-ui";
import App from "./App";
import "./editors";
import "./project/markdownLinks";
import "./locales/ru";

// The webview's own menu (Back / Reload / Inspect) is no IDE's — every
// surface offers its own; text fields keep the native one for spelling.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
