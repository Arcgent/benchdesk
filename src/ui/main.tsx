import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./rustig/index.css";
import "./browser";
import { App } from "./App";
import { applyDesign, applyTheme, storedDesign } from "./Theme";
applyTheme(localStorage.getItem("benchdesk-theme") || "light");
applyDesign(storedDesign());
// macOS window chrome (hiddenInset title bar): the traffic lights sit on top of the page, so the shell keeps
// room for them and offers a drag strip. Decided here, before the first render and without waiting for
// `app.info`, so neither Electron nor the browser preview ever jumps.
document.documentElement.dataset.chrome =
  /Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform)
    ? "mac"
    : "plain";
createRoot(document.getElementById("root")!).render(<App />);
