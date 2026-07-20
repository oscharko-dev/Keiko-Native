import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import {
  renderFoundation,
  type FoundationController,
  type FoundationView,
} from "./foundation";
import "./foundation.css";
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
  const rootNode = document.getElementById("root");
  const root = rootNode === null ? null : createRoot(rootNode);
  const unavailable: FoundationView = {
    kind: "welcome",
    title: "Willkommen bei Keiko Native v0.1.",
    explanation:
      "Der lokale Foundation-Host ist gerade nicht verfügbar. Beenden Sie Keiko Native und starten Sie den internen Build erneut.",
  };
  const unavailableController: FoundationController = {
    dismissWelcome: async () => unavailable,
    showCanvas: async () => unavailable,
    showAbout: async () => unavailable,
    showUpdate: async () => unavailable,
    openLink: async () => undefined,
    commitCanvasText: async () => unavailable,
    quit: async () => undefined,
  };
  const port = createRendererPort(invokeCommand, authorityProvider);
  let initial: Awaited<ReturnType<typeof port.loadFoundation>>;
  try {
    await port.health();
    await port.health();
    initial = await port.loadFoundation();
  } catch {
    root?.render(renderFoundation(unavailable, unavailableController));
    return;
  }
  let controller: FoundationController;
  const present = (view: FoundationView): FoundationView => {
    root?.render(renderFoundation(view, controller));
    return view;
  };
  const recover = async (
    pending: Promise<{ result: FoundationView }>,
  ): Promise<FoundationView> => {
    try {
      return present((await pending).result);
    } catch {
      return present(unavailable);
    }
  };
  controller = {
    dismissWelcome: async () => recover(port.dismissWelcome()),
    showCanvas: async () => recover(port.showCanvas()),
    showAbout: async () => recover(port.showAbout()),
    showUpdate: async () => recover(port.showUpdate()),
    openLink: async (destination) => {
      await recover(port.openLink(destination));
    },
    commitCanvasText: async (committedText) =>
      recover(port.commitCanvasText(committedText)),
    quit: async () => {
      await recover(port.quit());
    },
  };
  present(initial.result);
}

await startRenderer();
