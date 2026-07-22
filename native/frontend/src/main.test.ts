import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectedSourceRevision } from "./port";

const authority = { documentNonce: "a".repeat(64), generation: 7 };

const invoke = vi.fn(
  async (
    _command: string,
    arguments_: { documentNonce: string; generation: number; request: string },
  ) => {
    const request = JSON.parse(arguments_.request) as {
      requestId: string;
      operation: { kind: string };
    };
    if (request.operation.kind !== "application-health") {
      const result =
        request.operation.kind === "foundation-load"
          ? {
              kind: "welcome",
              title: "Willkommen bei Keiko Native v0.1.",
              explanation:
                "Diese interne Version enthält bewusst keine Coding- oder Wissensfunktionen. Sie belegt, dass die barrierefreie, stabile Grundlage läuft.",
            }
          : request.operation.kind === "show-about" ||
              request.operation.kind === "open-foundation-link"
            ? {
                kind: "about",
                productName: "Keiko Native",
                channel: "internal",
                version: "0.1.0",
                sourceRevision: expectedSourceRevision,
                repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
                licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${expectedSourceRevision}/LICENSE`,
                statement:
                  "Interner Foundation-Build. Bewusst ohne produktive Features.",
              }
            : request.operation.kind === "show-internal-update"
              ? {
                  kind: "internal-update",
                  message: "Update-Prüfung für interne Builds nicht verfügbar.",
                }
              : {
                  kind: "canvas",
                  committedText:
                    request.operation.kind === "commit-canvas-text"
                      ? Reflect.get(request.operation, "committedText")
                      : "",
                };
      return JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        result,
      });
    }
    return JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      result: {
        kind: "application-health",
        status: "healthy",
        build: {
          version: "0.1.0",
          sourceRevision: expectedSourceRevision,
          targetTriple: "aarch64-apple-darwin",
        },
      },
    });
  },
);
const render = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));

describe("production renderer composition", () => {
  beforeEach(() => {
    invoke.mockClear();
    render.mockClear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __KEIKO_RENDERER_AUTHORITY: authority },
    });
  });

  it("validates two real-command roundtrips before startup completes", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke, async () => authority);

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalled();
  });

  it("does not require a presentation root", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => null },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke, async () => authority);

    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("connects every visible action to its narrow typed port operation", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();
    render.mockClear();
    await startRenderer(invoke, async () => authority);

    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        | Record<string, unknown>
        | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const tree = render.mock.calls.at(-1)?.[0];
      const button = all(tree).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    await click("Foundation öffnen");
    const canvas = all(render.mock.calls.at(-1)?.[0]).find(
      ({ type }) => type === "textarea",
    );
    const target = { value: "Grüße かな" };
    (canvas?.props.onChange as (event: unknown) => void)({
      currentTarget: target,
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await click("Über Keiko Native");
    await click("Repository öffnen");
    await click("Lizenz öffnen");
    await click("Update-Status");
    await click("Leere Fläche");
    await click("Keiko Native beenden");

    const kinds = invoke.mock.calls
      .filter(([command]) => command === "foundation_request")
      .map(([, arguments_]) =>
        Reflect.get(JSON.parse(String(arguments_.request)), "operation"),
      )
      .map((operation) => Reflect.get(operation, "kind"));
    expect(kinds).toEqual([
      "foundation-load",
      "dismiss-welcome",
      "commit-canvas-text",
      "show-about",
      "open-foundation-link",
      "open-foundation-link",
      "show-internal-update",
      "show-canvas",
      "quit-application",
    ]);
  });

  it("renders a redacted recoverable welcome substate when the host is unavailable", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    render.mockClear();
    await expect(
      startRenderer(
        vi.fn(async () => Promise.reject(new Error("raw host detail"))),
        async () => authority,
      ),
    ).resolves.toBeUndefined();
    const rendered = render.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(rendered)).toContain("Foundation-Host");
    expect(JSON.stringify(rendered)).not.toContain("raw host detail");
  });
});
