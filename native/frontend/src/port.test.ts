import { describe, expect, it, vi } from "vitest";
import {
  canonicalRequestId,
  createRendererPort,
  expectedSourceRevision,
  isFoundationResponse,
  isHealthResponse,
  isRuntimeReadinessResponse,
  isTurnResponse,
  isTurnView,
  isWorkspaceResponse,
  rendererAuthority,
  type HealthRequest,
  type RendererAuthority,
  type TurnState,
  type TurnView,
} from "./port";

async function drainCancellationDispatch(): Promise<void> {
  // Drain the cancel dispatch chain: invoke -> then -> projectStopping.
  for (let step = 0; step < 3; step += 1) await Promise.resolve();
}

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

describe("closed runtime-readiness port", () => {
  const ready = {
    schemaVersion: 1,
    requestId: "request-0000000000000007-0000000000000001",
    result: {
      kind: "runtime-readiness",
      state: {
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
    },
  } as const;

  it("sends only the path-free readiness intent with the bounded runtime deadline", async () => {
    const invoke = vi.fn(
      async (command: string, arguments_: { request: string }) => {
        const request = JSON.parse(arguments_.request) as {
          requestId: string;
          timeoutMs: number;
          operation: unknown;
        };
        expect(command).toBe("runtime_request");
        expect(request.timeoutMs).toBe(5000);
        expect(request.operation).toEqual({ kind: "runtime-readiness" });
        expect(JSON.stringify(request)).not.toMatch(
          /path|root|environment|repository/iu,
        );
        return JSON.stringify({ ...ready, requestId: request.requestId });
      },
    );
    await expect(
      createRendererPort(invoke, async () => authority).runtimeReadiness(),
    ).resolves.toMatchObject({
      result: { state: { state: "ready" } },
    });
  });

  it("accepts only canonical redacted states and the exact fresh-start descriptor", () => {
    expect(isRuntimeReadinessResponse(ready)).toBe(true);
    for (const state of [
      "checking",
      "unavailable",
      "incompatible",
      "authentication-required",
      "containment-failed",
      "timed-out",
      "cancelled",
      "cleanup-failed",
    ]) {
      expect(
        isRuntimeReadinessResponse({
          ...ready,
          result: {
            kind: "runtime-readiness",
            state: { state, quarantinedEvents: 0 },
          },
        }),
      ).toBe(true);
    }
    for (const hostileState of [
      { ...ready.result.state, path: "/private/sensitive" },
      { ...ready.result.state, email: "redacted" },
      { ...ready.result.state, quarantinedEvents: 65 },
      {
        ...ready.result.state,
        descriptor: { ...ready.result.state.descriptor, version: "0.146.0" },
      },
      {
        state: "unavailable",
        quarantinedEvents: 0,
        descriptor: ready.result.state.descriptor,
      },
    ]) {
      expect(
        isRuntimeReadinessResponse({
          ...ready,
          result: { kind: "runtime-readiness", state: hostileState },
        }),
      ).toBe(false);
    }
  });

  it("cancels an in-flight check and ignores late ready output", async () => {
    let resolveCheck: ((value: string) => void) | undefined;
    const invoke = vi.fn(
      (command: string, arguments_: { request: string }): Promise<string> => {
        if (command === "application_cancel") return Promise.resolve("{}");
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return new Promise((resolve) => {
          resolveCheck = () =>
            resolve(JSON.stringify({ ...ready, requestId: request.requestId }));
        });
      },
    );
    const cancellation = new AbortController();
    const pending = createRendererPort(
      invoke,
      async () => authority,
    ).runtimeReadiness(cancellation.signal);
    await Promise.resolve();
    cancellation.abort();
    resolveCheck?.("");
    await expect(pending).rejects.toThrow("runtime-readiness-cancelled");
    expect(invoke).toHaveBeenCalledWith(
      "application_cancel",
      expect.objectContaining({ generation: authority.generation }),
    );
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

describe("closed workspace port", () => {
  const bound = {
    kind: "workspace",
    state: {
      kind: "bound",
      generation: 3,
      displayLabel: "Keiko Native",
    },
  } as const;

  it("sends only path-free workspace intents through the workspace command", async () => {
    const operations: unknown[] = [];
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
          operation: unknown;
        };
        operations.push(request.operation);
        expect(command).toBe("workspace_request");
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result: bound,
        });
      },
    );
    const port = createRendererPort(invoke, async () => authority);

    await port.workspaceStatus();
    await port.selectWorkspace();
    await port.clearWorkspace();

    expect(operations).toEqual([
      { kind: "workspace-status" },
      { kind: "workspace-select" },
      { kind: "workspace-clear" },
    ]);
    expect(JSON.stringify(operations)).not.toMatch(/path|root|repository/iu);
  });

  it("accepts only bounded semantic workspace responses", () => {
    const response = {
      schemaVersion: 1,
      requestId: "request-0000000000000001-0000000000000001",
      result: bound,
    };
    for (const state of [
      { kind: "empty", generation: 0 },
      { kind: "selecting", generation: 1 },
      bound.state,
      { kind: "closed", generation: 4, reason: "cancelled" },
      { kind: "closed", generation: 4, reason: "permission-denied" },
      { kind: "closed", generation: 4, reason: "invalid" },
      { kind: "closed", generation: 4, reason: "unavailable" },
      { kind: "closed", generation: 4, reason: "unsafe" },
    ]) {
      expect(
        isWorkspaceResponse({
          ...response,
          result: { kind: "workspace", state },
        }),
      ).toBe(true);
    }
    for (const hostile of [
      { ...bound, path: "/private/sensitive" },
      { ...bound, state: { ...bound.state, root: "secret" } },
      { ...bound, state: { ...bound.state, generation: 0 } },
      { ...bound, state: { ...bound.state, displayLabel: "x".repeat(129) } },
      { ...bound, state: { ...bound.state, displayLabel: "unsafe\nlabel" } },
      { kind: "workspace", state: { kind: "closed", generation: 4 } },
      {
        kind: "workspace",
        state: { kind: "closed", generation: 4, reason: "unexpected" },
      },
    ]) {
      expect(isWorkspaceResponse({ ...response, result: hostile })).toBe(false);
    }
    for (const invalid of [
      null,
      [],
      {},
      { ...response, schemaVersion: 2 },
      { ...response, requestId: 1 },
      { ...response, result: null },
      { ...response, result: { kind: "workspace", state: null } },
      {
        ...response,
        result: {
          kind: "workspace",
          state: { kind: "unknown", generation: 1 },
        },
      },
    ]) {
      expect(isWorkspaceResponse(invalid)).toBe(false);
    }
  });

  it("cancels pre-authority and in-flight selection without accepting late success", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const unused = vi.fn(async () => "unused");
    await expect(
      createRendererPort(unused, async () => authority).selectWorkspace(
        preAborted.signal,
      ),
    ).rejects.toThrow("workspace-request-cancelled");
    expect(unused).not.toHaveBeenCalled();

    let provideAuthority: ((value: RendererAuthority) => void) | undefined;
    const authorityAbort = new AbortController();
    const pendingAuthority = createRendererPort(
      unused,
      () =>
        new Promise<RendererAuthority>((resolve) => {
          provideAuthority = resolve;
        }),
    ).selectWorkspace(authorityAbort.signal);
    authorityAbort.abort();
    provideAuthority?.(authority);
    await expect(pendingAuthority).rejects.toThrow(
      "workspace-request-cancelled",
    );

    let resolveSelection: ((value: string) => void) | undefined;
    const raced = vi.fn(
      (command: string, arguments_: { request: string }): Promise<string> => {
        if (command === "application_cancel")
          return Promise.reject(new Error("redacted"));
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return new Promise((resolve) => {
          resolveSelection = () =>
            resolve(
              JSON.stringify({
                schemaVersion: 1,
                requestId: request.requestId,
                result: bound,
              }),
            );
        });
      },
    );
    const controller = new AbortController();
    const pending = createRendererPort(
      raced,
      async () => authority,
    ).selectWorkspace(controller.signal);
    await Promise.resolve();
    controller.abort();
    resolveSelection?.("");
    await expect(pending).rejects.toThrow("workspace-request-cancelled");
    expect(raced).toHaveBeenCalledWith(
      "application_cancel",
      expect.objectContaining({ generation: authority.generation }),
    );
  });

  it("fails closed on workspace transport, JSON and correlation errors", async () => {
    for (const reply of [
      () => Promise.reject(new Error("transport")),
      () => Promise.resolve("not-json"),
      () =>
        Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            requestId: "wrong",
            result: bound,
          }),
        ),
      (_command: string, arguments_: { request: string }) => {
        const request = JSON.parse(arguments_.request) as { requestId: string };
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            result: { ...bound, path: "/private/sensitive" },
          }),
        );
      },
    ]) {
      await expect(
        createRendererPort(
          vi.fn(reply),
          async () => authority,
        ).workspaceStatus(),
      ).rejects.toThrow("workspace-request-failed");
    }
  });
});

describe("closed streamed Codex turn port", () => {
  const turn = (
    state: TurnState,
    agentText = "",
    reason?: TurnView["reason"],
  ): TurnView => ({
    taskId: "task-0000000000000007-0000000000000001",
    runId: "run-0000000000000007-0000000000000001",
    workspaceGeneration: 3,
    state,
    ...(reason === undefined ? {} : { reason }),
    agentText,
    providerThreadEstablished: state !== "preflighting",
    providerTurnEstablished: state !== "preflighting",
    evidence: {
      runtimeVersion: "0.145.0",
      runtimeArtifactSha256:
        "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
      containmentProfile: "keiko-codex-readiness-v1",
      authorityProfile: "keiko-codex-no-effect-v1",
      messageBytes: new TextEncoder().encode(agentText).length,
      quarantinedEvents: state === "preflighting" ? 0 : 1,
      acceptedEffects: 0,
      cleanupComplete:
        !["preflighting", "streaming", "stopping"].includes(state) &&
        state !== "cleanup-failed",
      terminalState: state,
    },
  });

  it("submits only the bounded identity and text task then projects monotonic canonical updates", async () => {
    const updates: TurnView[] = [];
    const preflight = turn("preflighting");
    const streaming = turn("streaming", "Bounded ");
    const completed = turn("completed", "Bounded answer.");
    const invoke = vi.fn(
      async (
        command: string,
        arguments_: {
          request: string;
          onEvent?: { onmessage: (value: TurnView) => void };
        },
      ) => {
        const request = JSON.parse(arguments_.request) as {
          requestId: string;
          timeoutMs: number;
          operation: Record<string, unknown>;
        };
        expect(command).toBe("codex_turn_request");
        expect(request.timeoutMs).toBe(120_000);
        expect(request.operation).toEqual({
          kind: "codex-turn-start",
          workspaceGeneration: 3,
          task: "Explain one invariant.",
        });
        expect(JSON.stringify(request)).not.toMatch(
          /repositoryPath|runtimeRoot|tool|command|credential/iu,
        );
        arguments_.onEvent?.onmessage(preflight);
        arguments_.onEvent?.onmessage(streaming);
        arguments_.onEvent?.onmessage(completed);
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result: { kind: "codex-turn", state: completed },
        });
      },
    );
    const channel = { onmessage: (_value: TurnView) => undefined };
    const response = await createRendererPort(
      invoke,
      async () => authority,
      () => channel,
    ).codexTurn(3, "Explain one invariant.", (update) => updates.push(update));
    expect(response.result.state).toEqual(completed);
    expect(updates).toEqual([preflight, streaming, completed, completed]);
  });

  it("accepts only body-bounded zero-effect terminal evidence", () => {
    const completed = turn("completed", "Bounded answer.");
    const response = {
      schemaVersion: 1,
      requestId: "request-0000000000000007-0000000000000001",
      result: { kind: "codex-turn", state: completed },
    };
    expect(isTurnView(completed)).toBe(true);
    expect(isTurnResponse(response)).toBe(true);
    expect(isTurnView(turn("cleanup-failed", "", "cleanup-failed"))).toBe(true);
    for (const hostile of [
      { ...completed, path: "/private/repository" },
      { ...completed, taskId: completed.runId },
      { ...completed, agentText: "x".repeat(256 * 1024 + 1) },
      {
        ...completed,
        evidence: { ...completed.evidence, acceptedEffects: 1 },
      },
      {
        ...completed,
        evidence: { ...completed.evidence, cleanupComplete: false },
      },
      {
        ...completed,
        evidence: { ...completed.evidence, messageBytes: 1 },
      },
      { ...completed, state: "failed", reason: undefined },
      {
        ...completed,
        evidence: { ...completed.evidence, quarantinedEvents: 65 },
      },
    ]) {
      expect(isTurnView(hostile)).toBe(false);
      expect(
        isTurnResponse({
          ...response,
          result: { kind: "codex-turn", state: hostile },
        }),
      ).toBe(false);
    }
  });

  it("rejects invalid tasks, out-of-order streams and correlation drift", async () => {
    const unused = vi.fn(async () => "");
    const port = createRendererPort(
      unused,
      async () => authority,
      () => ({ onmessage: () => undefined }),
    );
    for (const task of ["", " \n", "\u0000", "x".repeat(4097)]) {
      await expect(port.codexTurn(3, task, () => undefined)).rejects.toThrow(
        "codex-turn-invalid",
      );
    }
    expect(unused).not.toHaveBeenCalled();

    for (const badUpdate of [
      turn("streaming", "early"),
      { ...turn("preflighting"), workspaceGeneration: 4 },
      { ...turn("preflighting"), taskId: "task-wrong" },
    ]) {
      const invoke = vi.fn(
        async (
          command: string,
          arguments_: {
            request?: string;
            onEvent?: { onmessage: (value: TurnView) => void };
          },
        ) => {
          if (command === "application_cancel") return "{}";
          arguments_.onEvent?.onmessage(badUpdate as TurnView);
          return "late";
        },
      );
      await expect(
        createRendererPort(
          invoke,
          async () => authority,
          () => ({ onmessage: () => undefined }),
        ).codexTurn(3, "Bounded.", () => undefined),
      ).rejects.toThrow("codex-turn-failed");
      expect(invoke).toHaveBeenCalledWith(
        "application_cancel",
        expect.objectContaining({
          documentNonce: authority.documentNonce,
          generation: authority.generation,
          request: JSON.stringify({
            schemaVersion: 1,
            requestId: "request-0000000000000007-0000000000000001",
          }),
        }),
      );
    }
  });

  it("requests cancellation but waits for the authoritative cleaned terminal", async () => {
    const updates: TurnView[] = [];
    const preflight = turn("preflighting");
    const stopping: TurnView = {
      ...preflight,
      state: "stopping",
      reason: "user-cancelled",
      evidence: { ...preflight.evidence, terminalState: "stopping" },
    };
    const cancelled: TurnView = {
      ...stopping,
      state: "cancelled",
      evidence: {
        ...stopping.evidence,
        cleanupComplete: true,
        terminalState: "cancelled",
      },
    };
    let resolveTurn: ((value: string) => void) | undefined;
    let requestId = "";
    const channel = { onmessage: (_value: TurnView) => undefined };
    const raced = vi.fn(
      (command: string, arguments_: { request: string }): Promise<string> => {
        if (command === "application_cancel") {
          const cancellation = JSON.parse(arguments_.request) as {
            requestId: string;
          };
          return Promise.resolve(
            JSON.stringify({
              schemaVersion: 1,
              requestId: cancellation.requestId,
              result: {
                kind: "application-cancel",
                status: "cancelled",
              },
            }),
          );
        }
        requestId = (JSON.parse(arguments_.request) as { requestId: string })
          .requestId;
        channel.onmessage(preflight);
        return new Promise((resolve) => {
          resolveTurn = resolve;
        });
      },
    );
    const cancellation = new AbortController();
    const pending = createRendererPort(
      raced,
      async () => authority,
      () => channel,
    ).codexTurn(
      3,
      "Bounded.",
      (update) => updates.push(update),
      cancellation.signal,
    );
    await Promise.resolve();
    cancellation.abort();
    await drainCancellationDispatch();
    expect(updates).toEqual([preflight, stopping]);
    channel.onmessage(cancelled);
    resolveTurn?.(
      JSON.stringify({
        schemaVersion: 1,
        requestId,
        result: { kind: "codex-turn", state: cancelled },
      }),
    );
    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        result: { kind: "codex-turn", state: cancelled },
      }),
    );
    expect(updates).toEqual([preflight, stopping, cancelled, cancelled]);
    expect(raced).toHaveBeenCalledWith(
      "application_cancel",
      expect.objectContaining({ generation: authority.generation }),
    );
  });

  it.each([
    ["malformed", () => Promise.resolve("{}")],
    ["rejected", () => Promise.reject(new Error("ipc unavailable"))],
  ])(
    "keeps cancellation retryable after a %s acknowledgement",
    async (_case, firstCancellation) => {
      const updates: TurnView[] = [];
      const preflight = turn("preflighting");
      const stopping: TurnView = {
        ...preflight,
        state: "stopping",
        reason: "user-cancelled",
        evidence: { ...preflight.evidence, terminalState: "stopping" },
      };
      const cancelled: TurnView = {
        ...stopping,
        state: "cancelled",
        evidence: {
          ...stopping.evidence,
          cleanupComplete: true,
          terminalState: "cancelled",
        },
      };
      let cancellationAttempts = 0;
      let resolveTurn: ((value: string) => void) | undefined;
      let requestId = "";
      const channel = { onmessage: (_value: TurnView) => undefined };
      const invoke = vi.fn(
        (command: string, arguments_: { request: string }): Promise<string> => {
          if (command === "application_cancel") {
            cancellationAttempts += 1;
            if (cancellationAttempts === 1) return firstCancellation();
            const cancellation = JSON.parse(arguments_.request) as {
              requestId: string;
            };
            return Promise.resolve(
              JSON.stringify({
                schemaVersion: 1,
                requestId: cancellation.requestId,
                result: {
                  kind: "application-cancel",
                  status: "cancelled",
                },
              }),
            );
          }
          requestId = (JSON.parse(arguments_.request) as { requestId: string })
            .requestId;
          channel.onmessage(preflight);
          return new Promise((resolve) => {
            resolveTurn = resolve;
          });
        },
      );
      const cancellation = new AbortController();
      const port = createRendererPort(
        invoke,
        async () => authority,
        () => channel,
      );
      const pending = port.codexTurn(
        3,
        "Bounded.",
        (update) => updates.push(update),
        cancellation.signal,
      );
      await Promise.resolve();

      cancellation.abort();
      await drainCancellationDispatch();
      expect(updates).toEqual([preflight]);

      port.retryCodexTurnCancellation();
      await drainCancellationDispatch();
      expect(cancellationAttempts).toBe(2);
      expect(updates).toEqual([preflight, stopping]);

      channel.onmessage(cancelled);
      resolveTurn?.(
        JSON.stringify({
          schemaVersion: 1,
          requestId,
          result: { kind: "codex-turn", state: cancelled },
        }),
      );
      await expect(pending).resolves.toEqual(
        expect.objectContaining({
          result: { kind: "codex-turn", state: cancelled },
        }),
      );
    },
  );
});
