export interface HealthRequest {
  schemaVersion: 1;
  requestId: string;
  sequence: number;
  timeoutMs: number;
  operation: { kind: "application-health" };
}

export interface CancelRequest {
  schemaVersion: 1;
  requestId: string;
}

export interface HealthResponse {
  schemaVersion: 1;
  requestId: string;
  result: {
    kind: "application-health";
    status: "healthy";
    build: {
      version: string;
      sourceRevision: string;
      targetTriple: "aarch64-apple-darwin";
    };
  };
}

export type Invoke = (
  command: string,
  arguments_: { request: string },
) => Promise<string>;
export type RequestIdFactory = () => string;

export function createRendererPort(
  invoke: Invoke,
  requestId: RequestIdFactory = () => `request-${crypto.randomUUID()}`,
) {
  let sequence = 0;

  async function health(signal?: AbortSignal): Promise<HealthResponse> {
    const request: HealthRequest = {
      schemaVersion: 1,
      requestId: requestId(),
      sequence: (sequence += 1),
      timeoutMs: 1000,
      operation: { kind: "application-health" },
    };
    const cancel = () => {
      const cancellation: CancelRequest = {
        schemaVersion: 1,
        requestId: request.requestId,
      };
      void invoke("application_cancel", {
        request: JSON.stringify(cancellation),
      });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const encoded = await invoke("application_request", {
        request: JSON.stringify(request),
      });
      const response: unknown = JSON.parse(encoded);
      if (
        !isHealthResponse(response) ||
        response.requestId !== request.requestId
      ) {
        throw new Error("application-health-failed");
      }
      return response;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  return { health };
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "requestId", "result"])
  ) {
    return false;
  }
  const result = value.result;
  if (!isRecord(result) || !hasExactKeys(result, ["kind", "status", "build"]))
    return false;
  const build = result.build;
  return (
    isRecord(build) &&
    hasExactKeys(build, ["version", "sourceRevision", "targetTriple"]) &&
    value.schemaVersion === 1 &&
    typeof value.requestId === "string" &&
    result.kind === "application-health" &&
    result.status === "healthy" &&
    typeof build.version === "string" &&
    /^[0-9a-f]{40}$/u.test(String(build.sourceRevision)) &&
    build.targetTriple === "aarch64-apple-darwin"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => key === actual[index])
  );
}
