import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "substrate-platform-ui";
import App from "./App";
import "./editors";
import "./markdownLinks";
import "./locales/ru";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
