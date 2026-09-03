// @vitest-environment happy-dom

import axe from "axe-core";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  renderFoundation,
  type FoundationController,
  type FoundationView,
  type TurnController,
} from "./foundation";
import type { TurnView } from "./port";

const controller: FoundationController = {
  dismissWelcome: async () => ({ kind: "canvas", committedText: "" }),
  showCanvas: async () => ({ kind: "canvas", committedText: "" }),
  showAbout: async () => about,
  showUpdate: async () => update,
  openLink: async () => undefined,
  commitCanvasText: async (committedText) => ({
    kind: "canvas",
    committedText,
  }),
  quit: async () => undefined,
};

const welcome: FoundationView = {
  kind: "welcome",
  title: "Willkommen bei Keiko Native v0.1.",
  explanation: "Interne barrierefreie Grundlage.",
};
const canvas: FoundationView = { kind: "canvas", committedText: "" };
const about: FoundationView = {
  kind: "about",
  productName: "Keiko Native",
  channel: "internal",
  version: "0.1.0",
  sourceRevision: "a".repeat(40),
  repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
  licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${"a".repeat(40)}/LICENSE`,
  statement: "Interner Foundation-Build. Bewusst ohne produktive Features.",
};
const update: FoundationView = {
  kind: "internal-update",
  message: "Update-Prüfung für interne Builds nicht verfügbar.",
};

describe("rendered Foundation accessibility", () => {
  it.each([
    [
      "cancelled",
      "user-cancelled",
      true,
      "Der Codex-Lauf wurde abgebrochen und vollständig beendet.",
    ],
    [
      "cleanup-failed",
      "cleanup-failed",
      false,
      "Die Laufzeit konnte nicht vollständig bereinigt werden. Beenden Sie Keiko Native.",
    ],
    [
      "containment-failed",
      "internal-failure",
      true,
      "Keiko hat einen internen Laufzeitfehler erkannt; die Laufzeit wurde beendet.",
    ],
    [
      "containment-failed",
      "protocol-rejected",
      true,
      "Eine nicht erlaubte Anbieteraktivität wurde abgefangen; die Laufzeit wurde beendet.",
    ],
    [
      "containment-failed",
      "internal-failure",
      false,
      "Keiko konnte die Beendigung des Codex-Laufs nicht bestätigen. Starten Sie keinen neuen Lauf.",
    ],
  ] as const)(
    "uses one exact stable polite atomic status node from stopping through %s",
    (state, reason, cleanupComplete, terminalText) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const terminal: TurnView = {
        taskId: "task-0000000000000003-0000000000000001",
        runId: "run-0000000000000003-0000000000000001",
        workspaceGeneration: 3,
        state,
        reason,
        agentText: "",
        providerThreadEstablished: true,
        providerTurnEstablished: true,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete,
          terminalState: state,
        },
      };
      const startTurn = vi.fn(async () => undefined);
      const checkRuntime = vi.fn(async () => undefined);
      const render = () =>
        renderFoundation(
          canvas,
          controller,
          { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
          undefined,
          {
            state: "ready",
            quarantinedEvents: 0,
            descriptor: {
              version: "0.145.0",
              artifactSha256:
                "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
              containmentProfile: "keiko-codex-readiness-v1",
              freshStartRequired: true,
            },
          },
          { checkRuntime },
          terminal,
          { startTurn, cancelTurn: vi.fn() },
        );

      const stopping = {
        ...terminal,
        state: "stopping" as const,
        reason: "user-cancelled" as const,
        evidence: {
          ...terminal.evidence,
          cleanupComplete: false,
          terminalState: "stopping" as const,
        },
      };
      flushSync(() =>
        root.render(
          renderFoundation(
            canvas,
            controller,
            { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
            undefined,
            undefined,
            undefined,
            stopping,
            { startTurn: vi.fn(), cancelTurn: vi.fn() },
          ),
        ),
      );
      const status = container.querySelector(".turn-status");
      expect(status?.getAttribute("role")).toBe("status");
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(status?.getAttribute("aria-atomic")).toBe("true");
      expect(status?.textContent).toBe("Keiko beendet den Codex-Lauf sicher.");
      expect(container.querySelectorAll(".turn-status")).toHaveLength(1);
      flushSync(() => root.render(render()));
      expect(container.querySelector(".turn-status")).toBe(status);
      expect(status?.textContent).toBe(terminalText);
      expect(status?.getAttribute("role")).toBe("status");
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(status?.getAttribute("aria-atomic")).toBe("true");
      expect(container.querySelectorAll(".turn-status")).toHaveLength(1);
      if (
        state === "containment-failed" &&
        reason === "internal-failure" &&
        !cleanupComplete
      ) {
        const task =
          container.querySelector<HTMLTextAreaElement>("#codex-task");
        const submit = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "Begrenzten Auftrag starten",
        );
        const readiness = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "Prüfung wiederholen",
        );
        expect(task?.disabled).toBe(true);
        expect(submit?.disabled).toBe(true);
        expect(readiness?.disabled).toBe(false);
        expect(container.textContent).toContain(
          "Die Bereinigung ist nicht bestätigt. Prüfen Sie die Codex-Bereitschaft erneut, bevor Sie fortfahren.",
        );
        task?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
        submit?.click();
        readiness?.click();
        expect(startTurn).not.toHaveBeenCalled();
        expect(checkRuntime).toHaveBeenCalledOnce();
      }

      root.unmount();
      container.remove();
    },
  );

  it("passes axe against the rendered DOM in every closed state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    for (const view of [welcome, canvas, about, update]) {
      flushSync(() => root.render(renderFoundation(view, controller)));
      const result = await axe.run(container, {
        rules: {
          // The test DOM has no layout engine; target-platform evidence owns contrast.
          "color-contrast": { enabled: false },
        },
      });
      expect(result.violations, view.kind).toEqual([]);
    }

    root.unmount();
    container.remove();
  });

  it("moves keyboard focus to the title when the visible surface changes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() => root.render(renderFoundation(welcome, controller)));
    const dismissal = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Foundation öffnen",
    );
    dismissal?.focus();
    expect(document.activeElement).toBe(dismissal);

    for (const view of [canvas, about, update]) {
      flushSync(() => root.render(renderFoundation(view, controller)));
      expect(document.activeElement).toBe(container.querySelector("h1"));
    }

    root.unmount();
    container.remove();
  });

  it("does not steal focus when committed canvas text rerenders", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() => root.render(renderFoundation(canvas, controller)));
    const textarea = container.querySelector("textarea");
    textarea?.focus();
    expect(document.activeElement).toBe(textarea);

    flushSync(() =>
      root.render(
        renderFoundation(
          { kind: "canvas", committedText: "Grüße かな" },
          controller,
        ),
      ),
    );
    expect(document.activeElement).toBe(textarea);

    root.unmount();
    container.remove();
  });

  it("starts a ready turn from a real rendered button activation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const startTurn = vi.fn<TurnController["startTurn"]>(async () => undefined);
    const cancelTurn = vi.fn<TurnController["cancelTurn"]>();

    flushSync(() =>
      root.render(
        renderFoundation(
          canvas,
          controller,
          { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
          undefined,
          {
            state: "ready",
            quarantinedEvents: 0,
            descriptor: {
              version: "0.145.0",
              artifactSha256:
                "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
              containmentProfile: "keiko-codex-readiness-v1",
              freshStartRequired: true,
            },
          },
          undefined,
          null,
          { startTurn, cancelTurn },
        ),
      ),
    );

    const textarea =
      container.querySelector<HTMLTextAreaElement>("#codex-task");
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Begrenzten Auftrag starten",
    );
    expect(textarea).not.toBeNull();
    expect(submit).not.toBeUndefined();

    textarea!.value =
      "In two short sentences, explain why cancellation needs one terminal state.";
    textarea!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(submit!.disabled).toBe(false);

    submit!.click();
    await Promise.resolve();

    expect(startTurn).toHaveBeenCalledExactlyOnceWith(textarea!.value);
    expect(textarea!.disabled).toBe(true);
    expect(submit!.disabled).toBe(true);

    const streaming: TurnView = {
      taskId: "task-0000000000000007-0000000000000001",
      runId: "run-0000000000000007-0000000000000001",
      workspaceGeneration: 3,
      state: "streaming",
      agentText: "Partial",
      providerThreadEstablished: true,
      providerTurnEstablished: true,
      evidence: {
        runtimeVersion: "0.145.0",
        runtimeArtifactSha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
        containmentProfile: "keiko-codex-readiness-v1",
        authorityProfile: "keiko-codex-no-effect-v1",
        messageBytes: 7,
        quarantinedEvents: 0,
        acceptedEffects: 0,
        repositoryContextBytesToRuntime: 0,
        cleanupComplete: false,
        terminalState: "streaming",
      },
    };
    flushSync(() =>
      root.render(
        renderFoundation(
          canvas,
          controller,
          { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
          undefined,
          {
            state: "ready",
            quarantinedEvents: 0,
            descriptor: {
              version: "0.145.0",
              artifactSha256:
                "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
              containmentProfile: "keiko-codex-readiness-v1",
              freshStartRequired: true,
            },
          },
          undefined,
          streaming,
          { startTurn, cancelTurn },
        ),
      ),
    );
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Codex-Lauf abbrechen",
    );
    expect(cancel?.disabled).toBe(false);
    cancel?.focus();
    expect(document.activeElement).toBe(cancel);
    cancel?.click();
    expect(cancelTurn).toHaveBeenCalledOnce();

    const stopping: TurnView = {
      ...streaming,
      state: "stopping",
      reason: "user-cancelled",
      evidence: { ...streaming.evidence, terminalState: "stopping" },
    };
    flushSync(() =>
      root.render(
        renderFoundation(
          canvas,
          controller,
          { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
          undefined,
          {
            state: "ready",
            quarantinedEvents: 0,
            descriptor: {
              version: "0.145.0",
              artifactSha256:
                "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
              containmentProfile: "keiko-codex-readiness-v1",
              freshStartRequired: true,
            },
          },
          undefined,
          stopping,
          { startTurn, cancelTurn },
        ),
      ),
    );
    const stoppingCancel = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Codex-Lauf wird beendet");
    expect(stoppingCancel).toBe(cancel);
    expect(document.activeElement).toBe(stoppingCancel);
    expect(stoppingCancel?.getAttribute("aria-disabled")).toBe("true");

    const cancelled: TurnView = {
      ...stopping,
      state: "cancelled",
      evidence: {
        ...stopping.evidence,
        cleanupComplete: true,
        terminalState: "cancelled",
      },
    };
    const renderCancelled = () =>
      renderFoundation(
        canvas,
        controller,
        { kind: "bound", generation: 3, displayLabel: "Sanitized fixture" },
        undefined,
        {
          state: "ready",
          quarantinedEvents: 0,
          descriptor: {
            version: "0.145.0",
            artifactSha256:
              "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
            containmentProfile: "keiko-codex-readiness-v1",
            freshStartRequired: true,
          },
        },
        undefined,
        cancelled,
        { startTurn, cancelTurn },
      );
    flushSync(() => root.render(renderCancelled()));
    const terminalStatus = container.querySelector(".turn-status");
    expect(terminalStatus?.getAttribute("role")).toBe("status");
    expect(terminalStatus?.getAttribute("aria-live")).toBe("polite");
    expect(terminalStatus?.getAttribute("aria-atomic")).toBe("true");
    expect(container.querySelectorAll(".turn-status")).toHaveLength(1);
    flushSync(() => root.render(renderCancelled()));
    expect(container.querySelector(".turn-status")).toBe(terminalStatus);
    expect(container.querySelectorAll(".turn-status")).toHaveLength(1);

    root.unmount();
    container.remove();
  });
});
