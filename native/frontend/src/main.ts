import * as tauriCore from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  renderFoundation,
  requiresCodexReadinessRecovery,
  type FoundationController,
  type FoundationView,
  type RuntimeController,
  type TurnController,
  type WorkspaceController,
} from "./foundation";
import "./foundation.css";
import {
  createRendererPort,
  rendererAuthority,
  type AuthorityProvider,
  type Invoke,
  type RuntimeReadiness,
  type TurnView,
  type WorkspaceState,
} from "./port";

export async function startRenderer(
  invokeCommand: Invoke = tauriCore.invoke,
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
  const port = createRendererPort(
    invokeCommand,
    authorityProvider,
    () => new tauriCore.Channel<TurnView>(),
  );
  let initial: Awaited<ReturnType<typeof port.loadFoundation>>;
  try {
    await port.health();
    await port.health();
    initial = await port.loadFoundation();
  } catch {
    root?.render(renderFoundation(unavailable, unavailableController));
    return;
  }
  let initialWorkspace: WorkspaceState;
  try {
    initialWorkspace = (await port.workspaceStatus()).result.state;
  } catch {
    initialWorkspace = {
      kind: "closed",
      generation: 1,
      reason: "unavailable",
    };
  }
  let controller: FoundationController;
  let workspaceController: WorkspaceController;
  let runtimeController: RuntimeController;
  let turnController: TurnController;
  let currentView = initial.result;
  let workspaceState: WorkspaceState = initialWorkspace;
  let runtimeState: RuntimeReadiness | null = null;
  let turnState: TurnView | null = null;
  const present = (view: FoundationView): FoundationView => {
    currentView = view;
    root?.render(
      renderFoundation(
        currentView,
        controller,
        workspaceState,
        workspaceController,
        runtimeState,
        runtimeController,
        turnState,
        turnController,
      ),
    );
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
  const presentWorkspace = (state: WorkspaceState): void => {
    const recoveryRequired = requiresCodexReadinessRecovery(turnState);
    if (recoveryRequired) {
      runtimeState = null;
    }
    if (state.generation !== workspaceState.generation) {
      runtimeState = null;
      if (!recoveryRequired) {
        turnState = null;
      }
    }
    workspaceState = state;
    present(currentView);
  };
  workspaceController = {
    selectWorkspace: async () => {
      const previousWorkspace = workspaceState;
      presentWorkspace({
        kind: "selecting",
        generation:
          previousWorkspace.kind === "bound"
            ? previousWorkspace.generation
            : Math.max(1, previousWorkspace.generation + 1),
      });
      try {
        presentWorkspace((await port.selectWorkspace()).result.state);
      } catch {
        if (previousWorkspace.kind === "bound") {
          workspaceState = previousWorkspace;
          present(currentView);
        } else {
          presentWorkspace({
            kind: "closed",
            generation: workspaceState.generation,
            reason: "unavailable",
          });
        }
      }
    },
    clearWorkspace: async () => {
      try {
        presentWorkspace((await port.clearWorkspace()).result.state);
      } catch {
        presentWorkspace({
          kind: "closed",
          generation: Math.max(1, workspaceState.generation),
          reason: "unavailable",
        });
      }
    },
  };
  runtimeController = {
    checkRuntime: async () => {
      const workspaceGeneration = workspaceState.generation;
      const recoveringWatchdog = requiresCodexReadinessRecovery(turnState);
      runtimeState = {
        state: "checking",
        quarantinedEvents: 0,
      };
      present(currentView);
      try {
        const readiness = (await port.runtimeReadiness()).result.state;
        if (workspaceState.generation !== workspaceGeneration) return;
        runtimeState = readiness;
        if (
          recoveringWatchdog &&
          readiness.state === "ready" &&
          requiresCodexReadinessRecovery(turnState)
        ) {
          turnState = null;
        }
      } catch {
        if (workspaceState.generation !== workspaceGeneration) return;
        runtimeState = {
          state: "unavailable",
          quarantinedEvents: 0,
        };
      }
      present(currentView);
    },
  };
  let activeTurnCancellation: AbortController | null = null;
  turnController = {
    startTurn: async (task) => {
      if (
        activeTurnCancellation !== null ||
        workspaceState.kind !== "bound" ||
        runtimeState?.state !== "ready" ||
        requiresCodexReadinessRecovery(turnState)
      ) {
        return;
      }
      const workspaceGeneration = workspaceState.generation;
      const cancellation = new AbortController();
      activeTurnCancellation = cancellation;
      try {
        await port.codexTurn(
          workspaceGeneration,
          task,
          (state) => {
            if (workspaceState.generation !== state.workspaceGeneration) {
              return;
            }
            turnState = state;
            if (requiresCodexReadinessRecovery(state)) {
              runtimeState = null;
            }
            if (
              state.state === "failed" &&
              state.reason === "stale-workspace"
            ) {
              workspaceState = {
                kind: "closed",
                generation: state.workspaceGeneration,
                reason: "unavailable",
              };
              runtimeState = null;
            }
            const requiresSynchronousCommit =
              state.state === "stopping" ||
              (state.state === "containment-failed" &&
                state.reason === "internal-failure" &&
                !state.evidence.cleanupComplete);
            if (requiresSynchronousCommit) {
              flushSync(() => present(currentView));
            } else {
              present(currentView);
            }
          },
          cancellation.signal,
        );
      } catch {
        if (turnState?.workspaceGeneration === workspaceGeneration) {
          turnState = null;
        }
        console.error(
          "Codex turn ended before a verified terminal state; retry is available.",
        );
        present(currentView);
      } finally {
        if (activeTurnCancellation === cancellation) {
          activeTurnCancellation = null;
          present(currentView);
        }
      }
    },
    cancelTurn: () => {
      if (activeTurnCancellation === null) return;
      if (activeTurnCancellation.signal.aborted) {
        port.retryCodexTurnCancellation();
      } else {
        activeTurnCancellation.abort();
      }
    },
  };
  present(initial.result);
}

await startRenderer();
