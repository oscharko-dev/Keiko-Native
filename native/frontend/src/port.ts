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
  arguments_: { generation: number; request: string },
) => Promise<string>;
export type RequestIdFactory = () => string;
export type GenerationProvider = () => Promise<number>;

const GENERATION_EVENT = "keiko-renderer-generation";

export async function rendererGeneration(): Promise<number> {
  const existing = Reflect.get(window, "__KEIKO_RENDERER_GENERATION");
  if (validGeneration(existing)) return existing;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener(GENERATION_EVENT, receive);
      reject(new Error("renderer-generation-unavailable"));
    }, 1000);
    const receive = (event: Event) => {
      const generation = event instanceof CustomEvent ? event.detail : null;
      if (!validGeneration(generation)) return;
      window.clearTimeout(timer);
      window.removeEventListener(GENERATION_EVENT, receive);
      resolve(generation);
    };
    window.addEventListener(GENERATION_EVENT, receive);
  });
}

export function createRendererPort(
  invoke: Invoke,
  requestId: RequestIdFactory = () => `request-${crypto.randomUUID()}`,
  generationProvider: GenerationProvider = rendererGeneration,
) {
  let sequence = 0;

  async function health(signal?: AbortSignal): Promise<HealthResponse> {
    if (signal?.aborted) throw new Error("application-health-cancelled");
    const generation = await generationProvider();
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
          generation,
          request: JSON.stringify(cancellation),
        }).catch(() => undefined);
        fail("application-health-cancelled");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void invoke("application_request", {
        generation,
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
            !isHealthResponse(response) ||
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

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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
