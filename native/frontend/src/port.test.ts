import { describe, expect, it, vi } from "vitest";
import {
  canonicalRequestId,
  createRendererPort,
  expectedSourceRevision,
  isHealthResponse,
  rendererAuthority,
  type HealthRequest,
  type RendererAuthority,
} from "./port";

const build = {
  version: "0.1.0",
  sourceRevision: expectedSourceRevision,
  targetTriple: "aarch64-apple-darwin",
} as const;
const authority = {
  documentNonce: "a".repeat(64),
  generation: 7,
} as const;

function healthy(request: HealthRequest): string {
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    result: { kind: "application-health", status: "healthy", build },
  });
}

describe("renderer health port", () => {
  it("composes the identifier from authenticated generation and sequence", () => {
    expect(canonicalRequestId(1, 1)).toBe(
      "request-0000000000000001-0000000000000001",
    );
    expect(
      canonicalRequestId(9_007_199_254_740_991, 9_007_199_254_740_991),
    ).toBe("request-9007199254740991-9007199254740991");
    expect(() => canonicalRequestId(0, 1)).toThrow("request-id-boundary");
  });

  it("uses the host-installed generation and waits for its exact event", async () => {
    const originalWindow = Reflect.get(globalThis, "window");
    const fakeWindow = Object.assign(new EventTarget(), {
      clearTimeout,
      setTimeout,
    });
    Reflect.set(globalThis, "window", fakeWindow);
    try {
      Reflect.set(fakeWindow, "__KEIKO_RENDERER_AUTHORITY", authority);
      await expect(rendererAuthority()).resolves.toEqual(authority);
      Reflect.deleteProperty(fakeWindow, "__KEIKO_RENDERER_AUTHORITY");
      const pending = rendererAuthority();
      fakeWindow.dispatchEvent(
        new CustomEvent("keiko-renderer-authority", {
          detail: { ...authority, documentNonce: "bad" },
        }),
      );
      fakeWindow.dispatchEvent(
        new CustomEvent("keiko-renderer-authority", {
          detail: { ...authority, generation: 6 },
        }),
      );
      await expect(pending).resolves.toEqual({ ...authority, generation: 6 });
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
      const pending = rendererAuthority();
      const rejection = expect(pending).rejects.toThrow(
        "renderer-authority-unavailable",
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
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
        },
      ) => {
        const request = JSON.parse(arguments_.request) as HealthRequest;
        requests.push(request);
        return healthy(request);
      },
    );
    const port = createRendererPort(invoke, async () => authority);

    await port.health();
    await port.health();

    expect(
      requests.map(({ requestId, sequence }) => ({ requestId, sequence })),
    ).toEqual([
      {
        requestId: "request-0000000000000007-0000000000000001",
        sequence: 1,
      },
      {
        requestId: "request-0000000000000007-0000000000000002",
        sequence: 2,
      },
    ]);
    expect(requests.map(({ timeoutMs }) => timeoutMs)).toEqual([1000, 1000]);
  });

  it("sends only the closed cancellation request when aborted", async () => {
    let resolveRequest: ((value: string) => void) | undefined;
    const invoke = vi.fn(
      (
        command: string,
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
        },
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
    const pending = createRendererPort(invoke, async () => authority).health(
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    resolveRequest?.("");
    await expect(pending).rejects.toThrow("application-health-cancelled");

    expect(invoke).toHaveBeenCalledWith("application_cancel", {
      documentNonce: authority.documentNonce,
      generation: 7,
      request: JSON.stringify({
        schemaVersion: 1,
        requestId: "request-0000000000000007-0000000000000001",
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
        createRendererPort(invoke, async () => authority).health(),
      ).rejects.toThrow("application-health-failed");
    }
    expect(() => JSON.parse("not-json") as unknown).toThrow();
  });

  it("rejects pre-abort and consumes cancellation failure while discarding late success", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const invoke = vi.fn(async () => "unused");
    await expect(
      createRendererPort(invoke, async () => authority).health(
        preAborted.signal,
      ),
    ).rejects.toThrow("application-health-cancelled");
    expect(invoke).not.toHaveBeenCalled();

    let provideAuthority: ((authority: RendererAuthority) => void) | undefined;
    const duringGeneration = new AbortController();
    const generationPending = createRendererPort(
      invoke,
      () =>
        new Promise<RendererAuthority>((resolve) => {
          provideAuthority = resolve;
        }),
    ).health(duringGeneration.signal);
    duringGeneration.abort();
    provideAuthority?.(authority);
    await expect(generationPending).rejects.toThrow(
      "application-health-cancelled",
    );

    let resolveRequest: ((encoded: string) => void) | undefined;
    const racedInvoke = vi.fn(
      (
        command: string,
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
        },
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
      async () => authority,
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
        createRendererPort(vi.fn(failure), async () => authority).health(),
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
    expect(
      isHealthResponse(
        {
          ...response,
          result: {
            ...response.result,
            build: { ...response.result.build, sourceRevision: "f".repeat(40) },
          },
        },
        expectedSourceRevision,
      ),
    ).toBe(false);
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
