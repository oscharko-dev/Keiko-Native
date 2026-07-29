import {
  createElement,
  type CompositionEvent,
  type FocusEvent,
  type ReactElement,
} from "react";
import type { RuntimeReadiness, WorkspaceState } from "./port";

export const closedSurfaceKinds = [
  "welcome",
  "canvas",
  "about",
  "internal-update",
] as const;

export type FoundationView =
  | { kind: "welcome"; title: string; explanation: string }
  | { kind: "canvas"; committedText: string }
  | {
      kind: "about";
      productName: string;
      channel: "internal";
      version: string;
      sourceRevision: string;
      repositoryUrl: string;
      licenseUrl: string;
      statement: string;
    }
  | { kind: "internal-update"; message: string };

export type LinkDestination = "repository" | "license";

export interface FoundationController {
  dismissWelcome(): Promise<FoundationView>;
  showCanvas(): Promise<FoundationView>;
  showAbout(): Promise<FoundationView>;
  showUpdate(): Promise<FoundationView>;
  openLink(destination: LinkDestination): Promise<void>;
  commitCanvasText(value: string): Promise<FoundationView>;
  quit(): Promise<void>;
}

export interface WorkspaceController {
  selectWorkspace(): Promise<void>;
  clearWorkspace(): Promise<void>;
}

export interface RuntimeController {
  checkRuntime(): Promise<void>;
}

const MAX_COMMITTED_TEXT_BYTES = 2048;
const EMPTY_WORKSPACE: WorkspaceState = { kind: "empty", generation: 0 };
const INERT_WORKSPACE_CONTROLLER: WorkspaceController = {
  selectWorkspace: async () => undefined,
  clearWorkspace: async () => undefined,
};
const INERT_RUNTIME_CONTROLLER: RuntimeController = {
  checkRuntime: async () => undefined,
};

export class ImeHarnessState {
  committed: string;
  transient = "";

  constructor(committed: string) {
    this.committed = boundedUnicode(committed);
  }

  get preview(): string {
    return this.committed + this.transient;
  }

  compositionStart(): void {
    this.transient = "";
  }

  compositionUpdate(value: string): void {
    this.transient = boundedUnicode(value);
  }

  compositionCommit(value: string): void {
    this.committed = boundedUnicode(this.committed + value);
    this.transient = "";
  }

  compositionCancel(): void {
    this.transient = "";
  }

  focusLost(): void {
    this.compositionCancel();
  }
}

export function renderFoundation(
  view: FoundationView,
  controller: FoundationController,
  workspace: WorkspaceState = EMPTY_WORKSPACE,
  workspaceController: WorkspaceController = INERT_WORKSPACE_CONTROLLER,
  runtime: RuntimeReadiness | null = null,
  runtimeController: RuntimeController = INERT_RUNTIME_CONTROLLER,
): ReactElement {
  return createElement(
    "main",
    { className: "foundation-shell", "aria-labelledby": "surface-title" },
    createElement(
      "header",
      { className: "foundation-header" },
      createElement(
        "div",
        { className: "brand", "aria-label": "Keiko Native" },
        createElement(
          "span",
          { className: "brand-mark", "aria-hidden": "true" },
          "K",
        ),
        createElement("span", null, "Keiko Native"),
      ),
      createElement(
        "nav",
        { "aria-label": "Foundation-Ansichten" },
        navButton("Leere Fläche", () => controller.showCanvas()),
        navButton("Über Keiko Native", () => controller.showAbout()),
        navButton("Update-Status", () => controller.showUpdate()),
      ),
    ),
    createElement(
      "section",
      { className: `surface surface-${view.kind}`, "aria-live": "polite" },
      surface(
        view,
        controller,
        workspace,
        workspaceController,
        runtime,
        runtimeController,
      ),
    ),
    createElement(
      "footer",
      null,
      createElement("span", null, "Interner Foundation-Build · v0.1"),
      createElement(
        "button",
        {
          type: "button",
          className: "quiet",
          onClick: () => void controller.quit(),
        },
        "Keiko Native beenden",
      ),
    ),
  );
}

function surface(
  view: FoundationView,
  controller: FoundationController,
  workspace: WorkspaceState,
  workspaceController: WorkspaceController,
  runtime: RuntimeReadiness | null,
  runtimeController: RuntimeController,
): ReactElement {
  switch (view.kind) {
    case "welcome":
      return createElement(
        "div",
        { className: "welcome-card" },
        createElement(
          "p",
          { className: "eyebrow" },
          "FOUNDATION v0.1 · INTERN",
        ),
        surfaceTitle(view.kind, view.title),
        createElement("p", { className: "lede" }, view.explanation),
        createElement(
          "button",
          { type: "button", onClick: () => void controller.dismissWelcome() },
          "Foundation öffnen",
        ),
      );
    case "canvas":
      return canvasSurface(
        view,
        controller,
        workspace,
        workspaceController,
        runtime,
        runtimeController,
      );
    case "about":
      return createElement(
        "div",
        { className: "content-card" },
        createElement("p", { className: "eyebrow" }, "ÜBER DIESE VERSION"),
        surfaceTitle(view.kind, view.productName),
        createElement("p", { className: "lede" }, view.statement),
        createElement(
          "dl",
          { className: "metadata-list" },
          metadata("Kanal", view.channel),
          metadata("Version", view.version),
          metadata("Revision", view.sourceRevision),
          metadata("Repository", view.repositoryUrl),
          metadata("Lizenz", view.licenseUrl),
        ),
        createElement(
          "div",
          { className: "button-row" },
          createElement(
            "button",
            {
              type: "button",
              onClick: () => void controller.openLink("repository"),
            },
            "Repository öffnen",
          ),
          createElement(
            "button",
            {
              type: "button",
              onClick: () => void controller.openLink("license"),
            },
            "Lizenz öffnen",
          ),
        ),
      );
    case "internal-update":
      return createElement(
        "div",
        { className: "content-card" },
        createElement("p", { className: "eyebrow" }, "UPDATE-STATUS"),
        surfaceTitle(view.kind, "Interner Build"),
        createElement("p", { className: "lede" }, view.message),
        createElement(
          "p",
          null,
          "Diese Ansicht prüft weder das Netzwerk noch ein Update-System.",
        ),
      );
  }
}

function canvasSurface(
  view: Extract<FoundationView, { kind: "canvas" }>,
  controller: FoundationController,
  workspace: WorkspaceState,
  workspaceController: WorkspaceController,
  runtime: RuntimeReadiness | null,
  runtimeController: RuntimeController,
): ReactElement {
  const model = new ImeHarnessState(view.committedText);
  let composing = false;
  let compositionGeneration = 0;

  const onCompositionStart = (): void => {
    compositionGeneration += 1;
    composing = true;
    model.compositionStart();
  };
  const onCompositionUpdate = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ): void => {
    model.compositionUpdate(event.data);
  };
  const onCompositionEnd = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ): void => {
    const generation = compositionGeneration;
    const target = event.currentTarget;
    const committedText = event.data;
    globalThis.setTimeout(() => {
      if (!composing || generation !== compositionGeneration) return;
      composing = false;
      model.compositionCommit(committedText);
      target.value = model.committed;
      void controller.commitCanvasText(model.committed);
    }, 0);
  };
  const onBlur = (event: FocusEvent<HTMLTextAreaElement>): void => {
    compositionGeneration += 1;
    model.focusLost();
    composing = false;
    event.currentTarget.value = model.committed;
  };

  return createElement(
    "div",
    { className: "canvas-card" },
    createElement("p", { className: "eyebrow" }, "LEERE FOUNDATION-FLÄCHE"),
    surfaceTitle(view.kind, "Die Grundlage läuft."),
    createElement(
      "p",
      { className: "lede" },
      "Keine Coding-, Wissens- oder Agentenfunktion ist in diesem internen Meilenstein enthalten.",
    ),
    workspacePanel(workspace, workspaceController),
    runtimePanel(runtime, runtimeController),
    createElement(
      "label",
      { htmlFor: "ime-harness" },
      "Unicode- und IME-Prüffeld",
    ),
    createElement("textarea", {
      id: "ime-harness",
      rows: 4,
      defaultValue: model.committed,
      "aria-describedby": "ime-description",
      onChange: (event: { currentTarget: HTMLTextAreaElement }) => {
        event.currentTarget.value = boundedUnicode(event.currentTarget.value);
        if (!composing) {
          model.committed = event.currentTarget.value;
          void controller.commitCanvasText(model.committed);
        }
      },
      onCompositionStart,
      onCompositionUpdate,
      onCompositionEnd,
      onBlur,
    }),
    createElement(
      "p",
      { id: "ime-description", className: "hint" },
      "Nur ein interner Eingabe-Test. Der Text startet keine Produktfunktion.",
    ),
  );
}

function runtimePanel(
  runtime: RuntimeReadiness | null,
  controller: RuntimeController,
): ReactElement {
  const checking = runtime?.state === "checking";
  return createElement(
    "section",
    {
      className: "runtime-card",
      "aria-labelledby": "runtime-title",
    },
    createElement("p", { className: "eyebrow" }, "CODEX-LAUFZEIT"),
    createElement("h2", { id: "runtime-title" }, "Lokale Bereitschaft"),
    createElement(
      "p",
      {
        className: `runtime-status runtime-status-${runtime?.state ?? "unchecked"}`,
        role: "status",
        "aria-live": "polite",
        "data-runtime-state": runtime?.state ?? "unchecked",
      },
      runtimePresentation(runtime),
    ),
    createElement(
      "p",
      { className: "hint" },
      "Die Prüfung startet keinen Coding-Auftrag. Sie beendet die Laufzeit anschließend vollständig.",
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: checking,
        onClick: () => observeRuntimeAction(controller.checkRuntime()),
      },
      checking
        ? "Codex wird geprüft"
        : runtime === null
          ? "Codex-Bereitschaft prüfen"
          : "Prüfung wiederholen",
    ),
  );
}

function observeRuntimeAction(action: Promise<void>): void {
  action.catch(() => {
    console.error("Runtime readiness action failed after controller recovery.");
  });
}

function runtimePresentation(runtime: RuntimeReadiness | null): string {
  if (runtime === null) {
    return "Noch nicht geprüft.";
  }
  return {
    checking: "Die verifizierte Codex-Laufzeit wird sicher geprüft.",
    ready:
      "Codex 0.145.0 ist protokollbereit. Für einen Auftrag wird später ein neuer Prozess gestartet.",
    unavailable:
      "Die freigegebene Codex-Laufzeit ist nicht verfügbar. Prüfen Sie die lokale Bereitstellung und versuchen Sie es erneut.",
    incompatible:
      "Die lokale Codex-Laufzeit stimmt nicht mit der freigegebenen Version oder dem Protokoll überein.",
    "authentication-required":
      "Die separate ChatGPT-Anmeldung fehlt. Melden Sie Codex außerhalb von Keiko an und prüfen Sie erneut.",
    "containment-failed":
      "Die Sicherheitsgrenze konnte nicht bestätigt werden. Codex wurde nicht freigegeben.",
    "timed-out":
      "Die Codex-Prüfung hat das Zeitlimit erreicht. Der Prozess wurde beendet.",
    cancelled: "Die Codex-Prüfung wurde abgebrochen und der Prozess beendet.",
    "cleanup-failed":
      "Codex konnte nicht vollständig beendet werden. Beenden Sie Keiko Native, bevor Sie fortfahren.",
  }[runtime.state];
}

function workspacePanel(
  workspace: WorkspaceState,
  controller: WorkspaceController,
): ReactElement {
  const presentation = workspacePresentation(workspace);
  const selecting = workspace.kind === "selecting";
  return createElement(
    "section",
    {
      className: "workspace-card",
      "aria-labelledby": "workspace-title",
    },
    createElement("p", { className: "eyebrow" }, "ARBEITSBEREICH"),
    createElement("h2", { id: "workspace-title" }, "Lokales Repository"),
    createElement(
      "p",
      {
        className: `workspace-status workspace-status-${workspace.kind}`,
        role: "status",
        "aria-live": "polite",
        "data-workspace-state": workspace.kind,
      },
      presentation,
    ),
    createElement(
      "p",
      { className: "hint" },
      "Nur die Sitzungsidentität bleibt in Keiko. Codex erhält weder Pfad noch Repository-Inhalte.",
    ),
    createElement(
      "div",
      { className: "button-row" },
      createElement(
        "button",
        {
          type: "button",
          disabled: selecting,
          onClick: () => observeWorkspaceAction(controller.selectWorkspace()),
        },
        selecting
          ? "Systemdialog geöffnet"
          : workspace.kind === "bound"
            ? "Anderes Repository auswählen"
            : "Repository auswählen",
      ),
      workspace.kind === "bound"
        ? createElement(
            "button",
            {
              type: "button",
              className: "quiet",
              onClick: () =>
                observeWorkspaceAction(controller.clearWorkspace()),
            },
            "Auswahl aufheben",
          )
        : null,
    ),
  );
}

function observeWorkspaceAction(action: Promise<void>): void {
  action.catch(() => {
    console.error("Workspace action failed after controller recovery.");
  });
}

function workspacePresentation(workspace: WorkspaceState): string {
  switch (workspace.kind) {
    case "empty":
      return "Kein Repository ausgewählt.";
    case "selecting":
      return "Der macOS-Systemdialog wartet auf Ihre Auswahl.";
    case "bound":
      return `Ausgewählt: ${workspace.displayLabel}`;
    case "closed":
      return {
        cancelled: "Auswahl abgebrochen. Es wurde kein Repository gebunden.",
        "permission-denied":
          "Zugriff verweigert. Wählen Sie das Repository erneut und erlauben Sie den Zugriff.",
        invalid: "Der gewählte Ordner ist kein unterstütztes Git-Repository.",
        unavailable:
          "Das Repository ist nicht mehr verfügbar. Wählen Sie es erneut aus.",
        unsafe:
          "Die Auswahl wurde aus Sicherheitsgründen abgelehnt. Wählen Sie den echten Repository-Ordner.",
      }[workspace.reason];
  }
}

function navButton(
  label: string,
  action: () => Promise<FoundationView>,
): ReactElement {
  return createElement(
    "button",
    { type: "button", className: "nav-button", onClick: () => void action() },
    label,
  );
}

function surfaceTitle(
  kind: FoundationView["kind"],
  title: string,
): ReactElement {
  return createElement(
    "h1",
    { id: "surface-title", key: kind, tabIndex: -1, ref: focusSurfaceTitle },
    title,
  );
}

function focusSurfaceTitle(title: HTMLHeadingElement | null): void {
  title?.focus();
}

function metadata(label: string, value: string): ReactElement {
  return createElement(
    "div",
    { className: "metadata-row" },
    createElement("dt", null, label),
    createElement("dd", null, value),
  );
}

function boundedUnicode(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= MAX_COMMITTED_TEXT_BYTES) return value;
  let bounded = "";
  for (const codePoint of value) {
    if (encoder.encode(bounded + codePoint).length > MAX_COMMITTED_TEXT_BYTES)
      break;
    bounded += codePoint;
  }
  return bounded;
}
