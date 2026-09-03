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

    root.unmount();
    container.remove();
  });
});
