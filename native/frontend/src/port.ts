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
  arguments_: { documentNonce: string; generation: number; request: string },
) => Promise<string>;
export type RequestIdFactory = () => string;
export interface RendererAuthority {
  documentNonce: string;
  generation: number;
}
export type AuthorityProvider = () => Promise<RendererAuthority>;

declare const __KEIKO_EXPECTED_SOURCE_REVISION__: string;
const AUTHORITY_EVENT = "keiko-renderer-authority";
export const expectedSourceRevision = __KEIKO_EXPECTED_SOURCE_REVISION__;

export async function rendererAuthority(): Promise<RendererAuthority> {
  const existing = Reflect.get(window, "__KEIKO_RENDERER_AUTHORITY");
  if (isRendererAuthority(existing)) return existing;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener(AUTHORITY_EVENT, receive);
      reject(new Error("renderer-authority-unavailable"));
    }, 1000);
    const receive = (event: Event) => {
      const authority = event instanceof CustomEvent ? event.detail : null;
      if (!isRendererAuthority(authority)) return;
      window.clearTimeout(timer);
      window.removeEventListener(AUTHORITY_EVENT, receive);
      resolve(authority);
    };
    window.addEventListener(AUTHORITY_EVENT, receive);
  });
}

export function createRendererPort(
  invoke: Invoke,
  requestId: RequestIdFactory = () => `request-${crypto.randomUUID()}`,
  authorityProvider: AuthorityProvider = rendererAuthority,
) {
  let sequence = 0;

  async function health(signal?: AbortSignal): Promise<HealthResponse> {
    if (signal?.aborted) throw new Error("application-health-cancelled");
    const authority = await authorityProvider();
    if (signal?.aborted) throw new Error("application-health-cancelled");
    const request: HealthRequest = {
      schemaVersion: 1,
      requestId: requestId(),
      sequence: (sequence += 1),
      timeoutMs: 1000,
      operation: { kind: "application-health" },
    };
    return new Promise((resolve, reject) => {
      let terminal = false;
      const finish = () => signal?.removeEventListener("abort", cancel);
      const fail = (message: string) => {
        if (terminal) return;
        terminal = true;
        finish();
        reject(new Error(message));
      };
      const cancel = () => {
        if (terminal) return;
        const cancellation: CancelRequest = {
          schemaVersion: 1,
          requestId: request.requestId,
        };
        void invoke("application_cancel", {
          generation: authority.generation,
          documentNonce: authority.documentNonce,
          request: JSON.stringify(cancellation),
        }).catch(() => undefined);
        fail("application-health-cancelled");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void invoke("application_request", {
        documentNonce: authority.documentNonce,
        generation: authority.generation,
        request: JSON.stringify(request),
      }).then(
        (encoded) => {
          if (terminal) return;
          let response: unknown;
          try {
            response = JSON.parse(encoded);
          } catch {
            fail("application-health-failed");
            return;
          }
          if (
            !isHealthResponse(response, expectedSourceRevision) ||
            response.requestId !== request.requestId
          ) {
            fail("application-health-failed");
            return;
          }
          terminal = true;
          finish();
          resolve(response);
        },
        () => fail("application-health-failed"),
      );
      if (signal?.aborted) cancel();
    });
  }

  return { health };
}

function isRendererAuthority(value: unknown): value is RendererAuthority {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["documentNonce", "generation"]) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0 &&
    /^[0-9a-f]{64}$/u.test(String(value.documentNonce))
  );
}

export function isHealthResponse(
  value: unknown,
  expectedRevision: string = expectedSourceRevision,
): value is HealthResponse {
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
    build.sourceRevision === expectedRevision &&
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
