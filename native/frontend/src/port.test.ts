import { describe, expect, it, vi } from "vitest";
import {
  canonicalRequestId,
  createRendererPort,
  expectedSourceRevision,
  isFoundationResponse,
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

describe("closed Foundation port", () => {
  const welcome = {
    kind: "welcome",
    title: "Willkommen bei Keiko Native v0.1.",
    explanation: "Interne barrierefreie Grundlage.",
  } as const;
  const canvas = { kind: "canvas", committedText: "Grüße かな 😀" } as const;
  const about = {
    kind: "about",
    productName: "Keiko Native",
    channel: "internal",
    version: "0.1.0",
    sourceRevision: expectedSourceRevision,
    repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
    licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${expectedSourceRevision}/LICENSE`,
    statement: "Interner Foundation-Build. Bewusst ohne produktive Features.",
  } as const;
  const update = {
    kind: "internal-update",
    message: "Update-Prüfung für interne Builds nicht verfügbar.",
  } as const;

  it("sends every accepted typed intent through only the Foundation command", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const invoke = vi.fn(
      async (
        command: string,
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
        },
      ) => {
        const request = JSON.parse(arguments_.request) as {
          requestId: string;
          operation: Record<string, unknown>;
        };
        if (command === "application_cancel") return "cancelled";
        operations.push(request.operation);
        const result =
          request.operation.kind === "foundation-load"
            ? welcome
            : request.operation.kind === "show-about" ||
                request.operation.kind === "open-foundation-link"
              ? about
              : request.operation.kind === "show-internal-update"
                ? update
                : canvas;
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result,
        });
      },
    );
    const port = createRendererPort(invoke, async () => authority);

    await expect(port.loadFoundation()).resolves.toMatchObject({
      result: welcome,
    });
    await port.dismissWelcome();
    await port.showCanvas();
    await expect(port.showAbout()).resolves.toMatchObject({ result: about });
    await expect(port.showUpdate()).resolves.toMatchObject({ result: update });
    await port.commitCanvasText(canvas.committedText);
    await port.openLink("repository");
    await port.openLink("license");
    await port.quit();

    expect(operations).toEqual([
      { kind: "foundation-load" },
      { kind: "dismiss-welcome" },
      { kind: "show-canvas" },
      { kind: "show-about" },
      { kind: "show-internal-update" },
      { kind: "commit-canvas-text", committedText: canvas.committedText },
      { kind: "open-foundation-link", destination: "repository" },
      { kind: "open-foundation-link", destination: "license" },
      { kind: "quit-application" },
    ]);
    expect(
      invoke.mock.calls.every(([command]) => command === "foundation_request"),
    ).toBe(true);
  });

  it("cancels pre-authority, in-flight and raced Foundation work without accepting late success", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const unused = vi.fn(async () => "unused");
    await expect(
      createRendererPort(unused, async () => authority).loadFoundation(
        preAborted.signal,
      ),
    ).rejects.toThrow("foundation-request-cancelled");
    expect(unused).not.toHaveBeenCalled();

    let provideAuthority: ((value: RendererAuthority) => void) | undefined;
    const authorityAbort = new AbortController();
    const pendingAuthority = createRendererPort(
      unused,
      () =>
        new Promise<RendererAuthority>((resolve) => {
          provideAuthority = resolve;
        }),
    ).loadFoundation(authorityAbort.signal);
    authorityAbort.abort();
    provideAuthority?.(authority);
    await expect(pendingAuthority).rejects.toThrow(
      "foundation-request-cancelled",
    );

    let resolveRequest: ((value: string) => void) | undefined;
    const raced = vi.fn(
      (command: string, arguments_: { request: string }): Promise<string> => {
        if (command === "application_cancel")
          return Promise.reject(new Error("redacted"));
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return new Promise((resolve) => {
          resolveRequest = () =>
            resolve(
              JSON.stringify({
                schemaVersion: 1,
                requestId: request.requestId,
                result: welcome,
              }),
            );
        });
      },
    );
    const controller = new AbortController();
    const pending = createRendererPort(
      raced,
      async () => authority,
    ).loadFoundation(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    resolveRequest?.("");
    await expect(pending).rejects.toThrow("foundation-request-cancelled");
    expect(raced).toHaveBeenCalledWith(
      "application_cancel",
      expect.objectContaining({ generation: authority.generation }),
    );
  });

  it("fails closed on transport, JSON, correlation, extra fields and a fifth state", async () => {
    for (const reply of [
      () => Promise.reject(new Error("transport")),
      () => Promise.resolve("not-json"),
      () =>
        Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            requestId: "wrong",
            result: welcome,
          }),
        ),
      (_command: string, arguments_: { request: string }) => {
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            result: { ...welcome, extra: true },
          }),
        );
      },
      (_command: string, arguments_: { request: string }) => {
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            result: { kind: "productive-editor" },
          }),
        );
      },
    ]) {
      await expect(
        createRendererPort(
          vi.fn(reply),
          async () => authority,
        ).loadFoundation(),
      ).rejects.toThrow("foundation-request-failed");
    }
  });

  it("guards every exact view shape and rejects hostile metadata", () => {
    const response = (result: unknown) => ({
      schemaVersion: 1,
      requestId: "request-0000000000000001-0000000000000001",
      result,
    });
    for (const result of [welcome, canvas, about, update]) {
      expect(isFoundationResponse(response(result))).toBe(true);
    }
    for (const value of [
      null,
      [],
      {},
      { ...response(welcome), schemaVersion: 2 },
      { ...response(welcome), requestId: 1 },
      response(null),
      response({ ...welcome, title: 1 }),
      response({ ...welcome, explanation: 1 }),
      response({ ...canvas, committedText: 1 }),
      response({ ...canvas, committedText: "😀".repeat(600) }),
      response({ ...about, productName: "Keiko" }),
      response({ ...about, channel: "stable" }),
      response({ ...about, version: 1 }),
      response({ ...about, sourceRevision: "f".repeat(40) }),
      response({ ...about, repositoryUrl: "https://example.com" }),
      response({ ...about, licenseUrl: "https://example.com/LICENSE" }),
      response({ ...about, statement: 1 }),
      response({ ...update, message: "checking" }),
      response({ kind: "fifth-state" }),
    ]) {
      expect(isFoundationResponse(value)).toBe(false);
    }
  });
});
