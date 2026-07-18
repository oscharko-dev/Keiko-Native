import { describe, expect, it, vi } from "vitest";
import {
  createRendererPort,
  isHealthResponse,
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
  it("uses fresh identifiers and increasing sequence", async () => {
    const requests: HealthRequest[] = [];
    const invoke = vi.fn(
      async (_command: string, arguments_: { request: string }) => {
        const request = JSON.parse(arguments_.request) as HealthRequest;
        requests.push(request);
        return healthy(request);
      },
    );
    const ids = ["request-00000001", "request-00000002"];
    const port = createRendererPort(
      invoke,
      () => ids.shift() ?? "request-00000003",
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
    const invoke = vi.fn((command: string, arguments_: { request: string }) => {
      if (command === "application_cancel") return Promise.resolve("cancelled");
      return new Promise<string>((resolve) => {
        const request = JSON.parse(arguments_.request) as HealthRequest;
        resolveRequest = () => resolve(healthy(request));
      });
    });
    const controller = new AbortController();
    const pending = createRendererPort(invoke, () => "request-00000001").health(
      controller.signal,
    );
    controller.abort();
    resolveRequest?.("");
    await pending;

    expect(invoke).toHaveBeenCalledWith("application_cancel", {
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
        createRendererPort(invoke, () => "request-00000001").health(),
      ).rejects.toThrow("application-health-failed");
    }
    expect(() => JSON.parse("not-json") as unknown).toThrow();
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
