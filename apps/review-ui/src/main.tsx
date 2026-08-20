import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("Review UI root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
