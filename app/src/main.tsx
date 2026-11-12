import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserDeps, LiveData } from "./data.ts";
import { Live } from "./Live.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

const live = new LiveData(browserDeps());

createRoot(root).render(
  <StrictMode>
    <Live live={live} />
  </StrictMode>,
);
