import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "../../shared/Shell";
import "../../shared/styles.css";

function ReleaseShell() {
  const [inputValue, setInputValue] = useState("ready");
  return (
    <Shell
      inputValue={inputValue}
      onInput={(event) => setInputValue(event.currentTarget.value)}
      status="Stable shell"
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReleaseShell />
  </StrictMode>,
);
