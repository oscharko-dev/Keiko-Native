import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "../../shared/Shell";
import "../../shared/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell inputValue="ready" status="Stable shell" />
  </StrictMode>,
);
