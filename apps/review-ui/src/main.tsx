import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("Review UI root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
