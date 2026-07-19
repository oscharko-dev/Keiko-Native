import { invoke } from "@tauri-apps/api/core";
import { Fragment, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererPort,
  rendererAuthority,
  type AuthorityProvider,
  type Invoke,
} from "./port";

export async function startRenderer(
  invokeCommand: Invoke = invoke,
  authorityProvider: AuthorityProvider = rendererAuthority,
): Promise<void> {
  const root = document.getElementById("root");
  if (root !== null) createRoot(root).render(createElement(Fragment));

  const port = createRendererPort(invokeCommand, authorityProvider);
  await port.health();
  await port.health();
}

await startRenderer();
