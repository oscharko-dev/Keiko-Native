import type { FoundationView, LinkDestination } from "./foundation";

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

export interface FoundationResponse {
  schemaVersion: 1;
  requestId: string;
  result: FoundationView;
}

type FoundationOperation =
  | { kind: "foundation-load" }
  | { kind: "dismiss-welcome" }
  | { kind: "show-canvas" }
  | { kind: "show-about" }
  | { kind: "show-internal-update" }
  | { kind: "commit-canvas-text"; committedText: string }
  | { kind: "open-foundation-link"; destination: LinkDestination }
  | { kind: "quit-application" };

export type Invoke = (
  command: string,
  arguments_: { documentNonce: string; generation: number; request: string },
) => Promise<string>;
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
  authorityProvider: AuthorityProvider = rendererAuthority,
) {
  let sequence = 0;

  async function health(signal?: AbortSignal): Promise<HealthResponse> {
    if (signal?.aborted) throw new Error("application-health-cancelled");
    const authority = await authorityProvider();
    if (signal?.aborted) throw new Error("application-health-cancelled");
    sequence += 1;
    const request: HealthRequest = {
      schemaVersion: 1,
      requestId: canonicalRequestId(authority.generation, sequence),
      sequence,
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
        // Best-effort fire-and-forget: the abort outcome is surfaced to the
        // caller by fail() below, so a failed cancel dispatch must not reject.
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

  async function foundation(
    operation: FoundationOperation,
    signal?: AbortSignal,
  ): Promise<FoundationResponse> {
    if (signal?.aborted) throw new Error("foundation-request-cancelled");
    const authority = await authorityProvider();
    if (signal?.aborted) throw new Error("foundation-request-cancelled");
    sequence += 1;
    const request = {
      schemaVersion: 1 as const,
      requestId: canonicalRequestId(authority.generation, sequence),
      sequence,
      timeoutMs: 1000,
      operation,
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
        // Best-effort fire-and-forget: the abort outcome is surfaced to the
        // caller by fail() below, so a failed cancel dispatch must not reject.
        void invoke("application_cancel", {
          generation: authority.generation,
          documentNonce: authority.documentNonce,
          request: JSON.stringify(cancellation),
        }).catch(() => undefined);
        fail("foundation-request-cancelled");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void invoke("foundation_request", {
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
            fail("foundation-request-failed");
            return;
          }
          if (
            !isFoundationResponse(response, expectedSourceRevision) ||
            response.requestId !== request.requestId
          ) {
            fail("foundation-request-failed");
            return;
          }
          terminal = true;
          finish();
          resolve(response);
        },
        () => fail("foundation-request-failed"),
      );
      if (signal?.aborted) cancel();
    });
  }

  return {
    health,
    loadFoundation: (signal?: AbortSignal) =>
      foundation({ kind: "foundation-load" }, signal),
    dismissWelcome: () => foundation({ kind: "dismiss-welcome" }),
    showCanvas: () => foundation({ kind: "show-canvas" }),
    showAbout: () => foundation({ kind: "show-about" }),
    showUpdate: () => foundation({ kind: "show-internal-update" }),
    commitCanvasText: (committedText: string) =>
      foundation({ kind: "commit-canvas-text", committedText }),
    openLink: (destination: LinkDestination) =>
      foundation({ kind: "open-foundation-link", destination }),
    quit: () => foundation({ kind: "quit-application" }),
  };
}

export function canonicalRequestId(generation: number, sequence: number) {
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  ) {
    throw new Error("request-id-boundary");
  }
  return `request-${String(generation).padStart(16, "0")}-${String(sequence).padStart(16, "0")}`;
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

export function isFoundationResponse(
  value: unknown,
  expectedRevision: string = expectedSourceRevision,
): value is FoundationResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "requestId", "result"]) ||
    value.schemaVersion !== 1 ||
    typeof value.requestId !== "string" ||
    !isRecord(value.result)
  ) {
    return false;
  }
  const result = value.result;
  switch (result.kind) {
    case "welcome":
      return (
        hasExactKeys(result, ["kind", "title", "explanation"]) &&
        typeof result.title === "string" &&
        typeof result.explanation === "string"
      );
    case "canvas":
      return (
        hasExactKeys(result, ["kind", "committedText"]) &&
        typeof result.committedText === "string" &&
        new TextEncoder().encode(result.committedText).length <= 2048
      );
    case "about": {
      if (
        !hasExactKeys(result, [
          "kind",
          "productName",
          "channel",
          "version",
          "sourceRevision",
          "repositoryUrl",
          "licenseUrl",
          "statement",
        ]) ||
        result.productName !== "Keiko Native" ||
        result.channel !== "internal" ||
        typeof result.version !== "string" ||
        result.sourceRevision !== expectedRevision ||
        result.repositoryUrl !==
          "https://github.com/oscharko-dev/Keiko-Native" ||
        result.licenseUrl !==
          `https://github.com/oscharko-dev/Keiko-Native/blob/${expectedRevision}/LICENSE` ||
        typeof result.statement !== "string"
      ) {
        return false;
      }
      return true;
    }
    case "internal-update":
      return (
        hasExactKeys(result, ["kind", "message"]) &&
        result.message === "Update-Prüfung für interne Builds nicht verfügbar."
      );
    default:
      return false;
  }
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
