import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(
  async (_command: string, arguments_: { request: string }) => {
    const request = JSON.parse(arguments_.request) as { requestId: string };
    return JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      result: {
        kind: "application-health",
        status: "healthy",
        build: {
          version: "0.1.0",
          sourceRevision: "0123456789012345678901234567890123456789",
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
  });

  it("validates two real-command roundtrips before startup completes", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalled();
  });

  it("does not require a presentation root", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => null },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke);

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
