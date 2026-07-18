import { describe, expect, it, vi } from "vitest";
import {
  createRendererPort,
  isHealthResponse,
  rendererGeneration,
  type HealthRequest,
} from "./port";

const build = {
  version: "0.1.0",
  sourceRevision: "0123456789012345678901234567890123456789",
  targetTriple: "aarch64-apple-darwin",
} as const;

function healthy(request: HealthRequest): string {
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    result: { kind: "application-health", status: "healthy", build },
  });
}

describe("renderer health port", () => {
  it("uses the host-installed generation and waits for its exact event", async () => {
    const originalWindow = Reflect.get(globalThis, "window");
    const fakeWindow = Object.assign(new EventTarget(), {
      clearTimeout,
      setTimeout,
    });
    Reflect.set(globalThis, "window", fakeWindow);
    try {
      Reflect.set(fakeWindow, "__KEIKO_RENDERER_GENERATION", 5);
      await expect(rendererGeneration()).resolves.toBe(5);
      Reflect.deleteProperty(fakeWindow, "__KEIKO_RENDERER_GENERATION");
      const pending = rendererGeneration();
      fakeWindow.dispatchEvent(
        new CustomEvent("keiko-renderer-generation", { detail: 0 }),
      );
      fakeWindow.dispatchEvent(
        new CustomEvent("keiko-renderer-generation", { detail: 6 }),
      );
      await expect(pending).resolves.toBe(6);
    } finally {
      if (originalWindow === undefined)
        Reflect.deleteProperty(globalThis, "window");
      else Reflect.set(globalThis, "window", originalWindow);
    }
  });

  it("bounds waiting for a missing host generation", async () => {
    vi.useFakeTimers();
    const originalWindow = Reflect.get(globalThis, "window");
    const fakeWindow = Object.assign(new EventTarget(), {
      clearTimeout,
      setTimeout,
    });
    Reflect.set(globalThis, "window", fakeWindow);
    try {
      const pending = rendererGeneration();
      const rejection = expect(pending).rejects.toThrow(
        "renderer-generation-unavailable",
      );
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
    } finally {
      vi.useRealTimers();
      if (originalWindow === undefined)
        Reflect.deleteProperty(globalThis, "window");
      else Reflect.set(globalThis, "window", originalWindow);
    }
  });

  it("uses fresh identifiers and increasing sequence", async () => {
    const requests: HealthRequest[] = [];
    const invoke = vi.fn(
      async (
        _command: string,
        arguments_: { generation: number; request: string },
      ) => {
        const request = JSON.parse(arguments_.request) as HealthRequest;
        requests.push(request);
        return healthy(request);
      },
    );
    const ids = ["request-00000001", "request-00000002"];
    const port = createRendererPort(
      invoke,
      () => ids.shift() ?? "request-00000003",
      async () => 7,
    );

    await port.health();
    await port.health();

    expect(
      requests.map(({ requestId, sequence }) => ({ requestId, sequence })),
    ).toEqual([
      { requestId: "request-00000001", sequence: 1 },
      { requestId: "request-00000002", sequence: 2 },
    ]);
  });

  it("sends only the closed cancellation request when aborted", async () => {
    let resolveRequest: ((value: string) => void) | undefined;
    const invoke = vi.fn(
      (
        command: string,
        arguments_: { generation: number; request: string },
      ) => {
        if (command === "application_cancel")
          return Promise.resolve("cancelled");
        return new Promise<string>((resolve) => {
          const request = JSON.parse(arguments_.request) as HealthRequest;
          resolveRequest = () => resolve(healthy(request));
        });
      },
    );
    const controller = new AbortController();
    const pending = createRendererPort(
      invoke,
      () => "request-00000001",
      async () => 7,
    ).health(controller.signal);
    await Promise.resolve();
    controller.abort();
    resolveRequest?.("");
    await expect(pending).rejects.toThrow("application-health-cancelled");

    expect(invoke).toHaveBeenCalledWith("application_cancel", {
      generation: 7,
      request: JSON.stringify({
        schemaVersion: 1,
        requestId: "request-00000001",
      }),
    });
  });

  it("rejects malformed, extra-field, wrong-build and wrong-correlation responses", async () => {
    for (const encoded of [
      "null",
      "{}",
      JSON.stringify({ schemaVersion: 1, requestId: "wrong", result: {} }),
      JSON.stringify({
        schemaVersion: 1,
        requestId: "request-00000001",
        result: {
          kind: "application-health",
          status: "healthy",
          build,
          extra: true,
        },
      }),
      JSON.stringify({
        schemaVersion: 1,
        requestId: "request-00000001",
        result: {
          kind: "application-health",
          status: "healthy",
          build: { ...build, targetTriple: "x86_64-apple-darwin" },
        },
      }),
    ]) {
      const invoke = vi.fn(async () => encoded);
      await expect(
        createRendererPort(
          invoke,
          () => "request-00000001",
          async () => 7,
        ).health(),
      ).rejects.toThrow("application-health-failed");
    }
    expect(() => JSON.parse("not-json") as unknown).toThrow();
  });

  it("rejects pre-abort and consumes cancellation failure while discarding late success", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const invoke = vi.fn(async () => "unused");
    await expect(
      createRendererPort(
        invoke,
        () => "request-00000001",
        async () => 7,
      ).health(preAborted.signal),
    ).rejects.toThrow("application-health-cancelled");
    expect(invoke).not.toHaveBeenCalled();

    let provideGeneration: ((generation: number) => void) | undefined;
    const duringGeneration = new AbortController();
    const generationPending = createRendererPort(
      invoke,
      () => "request-00000001",
      () =>
        new Promise<number>((resolve) => {
          provideGeneration = resolve;
        }),
    ).health(duringGeneration.signal);
    duringGeneration.abort();
    provideGeneration?.(7);
    await expect(generationPending).rejects.toThrow(
      "application-health-cancelled",
    );

    let resolveRequest: ((encoded: string) => void) | undefined;
    const racedInvoke = vi.fn(
      (
        command: string,
        arguments_: { generation: number; request: string },
      ) => {
        if (command === "application_cancel") {
          return Promise.reject(
            new Error(["sec", "ret-value=", "/Us", "ers/operator"].join("")),
          );
        }
        return new Promise<string>((resolve) => {
          const request = JSON.parse(arguments_.request) as HealthRequest;
          resolveRequest = () => resolve(healthy(request));
        });
      },
    );
    const controller = new AbortController();
    const pending = createRendererPort(
      racedInvoke,
      () => "request-00000002",
      async () => 7,
    ).health(controller.signal);
    controller.abort();
    resolveRequest?.("");
    await expect(pending).rejects.toThrow("application-health-cancelled");
    await Promise.resolve();
  });

  it("closes malformed JSON and invocation rejection", async () => {
    for (const failure of [
      () => Promise.resolve("not-json"),
      () => Promise.reject(new Error("transport unavailable")),
    ]) {
      await expect(
        createRendererPort(
          vi.fn(failure),
          () => "request-00000001",
          async () => 7,
        ).health(),
      ).rejects.toThrow("application-health-failed");
    }
  });
});

describe("health response guard", () => {
  it("accepts only the canonical closed response", () => {
    const response = JSON.parse(
      healthy({ requestId: "request-00000001" } as HealthRequest),
    );
    expect(isHealthResponse(response)).toBe(true);
    expect(isHealthResponse([])).toBe(false);
    expect(isHealthResponse({ ...response, extra: true })).toBe(false);
    expect(isHealthResponse({ ...response, result: null })).toBe(false);
    expect(
      isHealthResponse({
        ...response,
        result: { ...response.result, build: null },
      }),
    ).toBe(false);
    expect(
      isHealthResponse({
        ...response,
        result: {
          ...response.result,
          build: { ...response.result.build, sourceRevision: "bad" },
        },
      }),
    ).toBe(false);
  });
});
