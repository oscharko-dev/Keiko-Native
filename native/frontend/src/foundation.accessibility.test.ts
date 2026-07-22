// @vitest-environment happy-dom

import axe from "axe-core";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  renderFoundation,
  type FoundationController,
  type FoundationView,
} from "./foundation";

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
});
