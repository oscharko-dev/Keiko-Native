import { describe, expect, it, vi } from "vitest";
import {
  ImeHarnessState,
  closedSurfaceKinds,
  renderFoundation,
  type FoundationController,
  type FoundationView,
} from "./foundation";

const controller: FoundationController = {
  dismissWelcome: async () => ({ kind: "canvas", committedText: "" }),
  showAbout: async () => ({
    kind: "about",
    productName: "Keiko Native",
    channel: "internal",
    version: "0.1.0",
    sourceRevision: "a".repeat(40),
    repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
    licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${"a".repeat(40)}/LICENSE`,
    statement: "Interner Foundation-Build. Bewusst ohne produktive Features.",
  }),
  showCanvas: async () => ({ kind: "canvas", committedText: "" }),
  showUpdate: async () => ({
    kind: "internal-update",
    message: "Update-Prüfung für interne Builds nicht verfügbar.",
  }),
  openLink: async () => undefined,
  commitCanvasText: async (committedText) => ({
    kind: "canvas",
    committedText,
  }),
  quit: async () => undefined,
};

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join(" ");
  if (typeof value !== "object" || value === null) return "";
  const props = Reflect.get(value, "props") as
    | { children?: unknown }
    | undefined;
  return textContent(props?.children);
}

function elements(
  value: unknown,
): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== "object" || value === null) return [];
  const type = Reflect.get(value, "type");
  const props = Reflect.get(value, "props") as
    | Record<string, unknown>
    | undefined;
  if (props === undefined) return [];
  return [{ type, props }, ...elements(props.children)];
}

describe("closed Foundation presentation", () => {
  it("contains exactly the four accepted surface kinds", () => {
    expect(closedSurfaceKinds).toEqual([
      "welcome",
      "canvas",
      "about",
      "internal-update",
    ]);
  });

  it("renders truthful German welcome and update copy", () => {
    const welcome: FoundationView = {
      kind: "welcome",
      title: "Willkommen bei Keiko Native v0.1.",
      explanation:
        "Diese interne Version enthält bewusst keine Coding- oder Wissensfunktionen. Sie belegt, dass die barrierefreie, stabile Grundlage läuft.",
    };
    const update: FoundationView = {
      kind: "internal-update",
      message: "Update-Prüfung für interne Builds nicht verfügbar.",
    };
    expect(textContent(renderFoundation(welcome, controller))).toContain(
      welcome.title,
    );
    expect(textContent(renderFoundation(welcome, controller))).toContain(
      "keine Coding- oder Wissensfunktionen",
    );
    expect(textContent(renderFoundation(update, controller))).toContain(
      update.message,
    );
  });

  it("exposes exact internal About identity and only typed link actions", () => {
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
    const rendered = renderFoundation(about, controller);
    const text = textContent(rendered);
    expect(text).toContain(about.statement);
    expect(text).toContain(about.sourceRevision);
    expect(text).toContain(about.repositoryUrl);
    expect(text).toContain(about.licenseUrl);
    const buttons = elements(rendered).filter(({ type }) => type === "button");
    (buttons.at(-2)?.props.onClick as () => void)();
    (buttons.at(-1)?.props.onClick as () => void)();
  });

  it("wires keyboard-sized navigation, dismissal and quit actions", async () => {
    const tracked: FoundationController = {
      ...controller,
      dismissWelcome: vi.fn(controller.dismissWelcome),
      showCanvas: vi.fn(controller.showCanvas),
      showAbout: vi.fn(controller.showAbout),
      showUpdate: vi.fn(controller.showUpdate),
      quit: vi.fn(controller.quit),
    };
    const rendered = renderFoundation(
      {
        kind: "welcome",
        title: "Willkommen bei Keiko Native v0.1.",
        explanation: "Intern und ohne produktive Features.",
      },
      tracked,
    );
    for (const button of elements(rendered).filter(
      ({ type }) => type === "button",
    )) {
      (button.props.onClick as () => void)();
    }
    await Promise.resolve();
    expect(tracked.showCanvas).toHaveBeenCalledOnce();
    expect(tracked.showAbout).toHaveBeenCalledOnce();
    expect(tracked.showUpdate).toHaveBeenCalledOnce();
    expect(tracked.dismissWelcome).toHaveBeenCalledOnce();
    expect(tracked.quit).toHaveBeenCalledOnce();
  });

  it("keeps the automated semantic contract complete in every state", () => {
    const views: FoundationView[] = [
      {
        kind: "welcome",
        title: "Willkommen bei Keiko Native v0.1.",
        explanation: "Interne barrierefreie Grundlage.",
      },
      { kind: "canvas", committedText: "" },
      {
        kind: "about",
        productName: "Keiko Native",
        channel: "internal",
        version: "0.1.0",
        sourceRevision: "a".repeat(40),
        repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
        licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${"a".repeat(40)}/LICENSE`,
        statement:
          "Interner Foundation-Build. Bewusst ohne produktive Features.",
      },
      {
        kind: "internal-update",
        message: "Update-Prüfung für interne Builds nicht verfügbar.",
      },
    ];
    for (const view of views) {
      const tree = elements(renderFoundation(view, controller));
      expect(tree.filter(({ type }) => type === "main")).toHaveLength(1);
      expect(tree.filter(({ type }) => type === "h1")).toHaveLength(1);
      expect(tree.find(({ type }) => type === "nav")?.props["aria-label"]).toBe(
        "Foundation-Ansichten",
      );
      for (const button of tree.filter(({ type }) => type === "button")) {
        expect(String(button.props.children).trim().length).toBeGreaterThan(0);
      }
      const textarea = tree.find(({ type }) => type === "textarea");
      if (view.kind === "canvas") {
        expect(textarea?.props.id).toBe("ime-harness");
        expect(
          tree.some(
            ({ type, props }) =>
              type === "label" && props.htmlFor === "ime-harness",
          ),
        ).toBe(true);
      } else {
        expect(textarea).toBeUndefined();
      }
    }
  });

  it("drives composition, commit, cancellation and focus loss through the textarea", async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn(controller.commitCanvasText);
      const rendered = renderFoundation(
        { kind: "canvas", committedText: "bereit" },
        { ...controller, commitCanvasText: commit },
      );
      const textarea = elements(rendered).find(
        ({ type }) => type === "textarea",
      )?.props as Record<string, (event?: unknown) => void>;
      const target = { value: "bereit" };
      textarea.onCompositionStart();
      textarea.onCompositionUpdate({ data: "かな", currentTarget: target });
      textarea.onCompositionEnd({ data: "かな", currentTarget: target });
      vi.runAllTimers();
      expect(target.value).toBe("bereitかな");
      expect(commit).toHaveBeenLastCalledWith("bereitかな");

      textarea.onCompositionStart();
      textarea.onCompositionUpdate({ data: "discard", currentTarget: target });
      target.value = "bereitかなdiscard";
      textarea.onCompositionEnd({ data: "discard", currentTarget: target });
      textarea.onChange({ currentTarget: target });
      textarea.onBlur({ currentTarget: target });
      vi.runAllTimers();
      expect(target.value).toBe("bereitかな");
      expect(commit).toHaveBeenCalledTimes(1);

      target.value = "x".repeat(3000);
      textarea.onChange({ currentTarget: target });
      expect(new TextEncoder().encode(target.value).length).toBe(2048);
      expect(commit).toHaveBeenLastCalledWith(target.value);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not commit when WebKit reports composition end before a later focus loss", async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn(controller.commitCanvasText);
      const rendered = renderFoundation(
        { kind: "canvas", committedText: "bereit" },
        { ...controller, commitCanvasText: commit },
      );
      const textarea = elements(rendered).find(
        ({ type }) => type === "textarea",
      )?.props as Record<string, (event?: unknown) => void>;
      const target = { value: "bereitかな" };

      textarea.onCompositionStart();
      textarea.onCompositionUpdate({ data: "かな", currentTarget: target });
      textarea.onCompositionEnd({ data: "かな", currentTarget: target });
      textarea.onChange({ currentTarget: target });

      // WebKit can move blur into the next event turn. A microtask commit is
      // therefore too early to distinguish a real commit from focus loss.
      await Promise.resolve();
      textarea.onBlur({ currentTarget: target });
      vi.runAllTimers();

      expect(target.value).toBe("bereit");
      expect(commit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a superseded composition commit when a new composition starts without focus loss", async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn(controller.commitCanvasText);
      const rendered = renderFoundation(
        { kind: "canvas", committedText: "bereit" },
        { ...controller, commitCanvasText: commit },
      );
      const textarea = elements(rendered).find(
        ({ type }) => type === "textarea",
      )?.props as Record<string, (event?: unknown) => void>;
      const target = { value: "bereit" };

      textarea.onCompositionStart();
      textarea.onCompositionUpdate({ data: "かな", currentTarget: target });
      textarea.onCompositionEnd({ data: "かな", currentTarget: target });

      // Rapid IME input can start the next composition before the deferred
      // commit runs, with no intervening blur. `composing` therefore stays
      // true, so only the generation guard can discard the superseded commit.
      textarea.onCompositionStart();
      vi.runAllTimers();

      expect(target.value).toBe("bereit");
      expect(commit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("IME harness state", () => {
  it("keeps committed text and discards transient composition on cancellation or focus loss", () => {
    const state = new ImeHarnessState("bereit");
    state.compositionStart();
    state.compositionUpdate("かな");
    expect(state.preview).toBe("bereitかな");
    state.compositionCancel();
    expect(state.committed).toBe("bereit");
    expect(state.preview).toBe("bereit");

    state.compositionStart();
    state.compositionUpdate("漢字");
    state.compositionCommit("漢字");
    expect(state.committed).toBe("bereit漢字");
    state.compositionStart();
    state.compositionUpdate("discarded");
    state.focusLost();
    expect(state.committed).toBe("bereit漢字");
  });

  it("bounds committed Unicode input without splitting code points", () => {
    const state = new ImeHarnessState("😀".repeat(600));
    expect(
      new TextEncoder().encode(state.committed).length,
    ).toBeLessThanOrEqual(2048);
    expect(state.committed.endsWith("😀")).toBe(true);
  });
});
