import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Shell } from "../../shared/Shell";
import "../../shared/styles.css";

type Reply = {
  code: string;
  requestId?: string;
  eventToken?: string;
  uiValue?: string;
};

type Invoke = (command: string, payload: unknown) => Promise<Reply>;

type FailureStage =
  | "startup"
  | "prepare-renderer"
  | "stable-shell"
  | "synthetic-input"
  | "runtime-event"
  | "request-validation"
  | "replay-protection"
  | "accessibility"
  | "bounded-work"
  | "native-dialog"
  | "fixture-process"
  | "renderer-cycle"
  | "finish";

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: Invoke } };
    __KEIKO_MANUAL_EVALUATION__?: boolean;
  }
}

function frame() {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

const requestSession = Array.from(
  crypto.getRandomValues(new Uint8Array(12)),
  (value) => value.toString(16).padStart(2, "0"),
).join("");
let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  if (requestSequence > 64) throw new Error("request budget exhausted");
  return `${requestSession}-${requestSequence.toString(36).padStart(2, "0")}`;
}

function envelope(kind: string, data?: unknown, requestId = nextRequestId()) {
  return {
    schemaVersion: 1,
    requestId,
    operation: data === undefined ? { kind } : { kind, data },
  };
}

async function axeSummary() {
  const { default: axe } = await import("axe-core");
  const result = await axe.run(document, {
    runOnly: {
      type: "tag",
      values: [
        "wcag2a",
        "wcag2aa",
        "wcag21a",
        "wcag21aa",
        "wcag22a",
        "wcag22aa",
      ],
    },
  });
  const ruleIds = result.violations.map(({ id }) => id);
  if (ruleIds.length > 32 || ruleIds.some((id) => id.length > 64)) {
    throw new Error("axe summary exceeded bounds");
  }
  return { violationCount: ruleIds.length, ruleIds };
}

function Evaluation() {
  const [inputValue, setInputValue] = useState("ready");
  const [manualMode, setManualMode] = useState(false);
  const [status, setStatus] = useState("Starting");
  const manualDispatch = useRef<
    ((kind: string, data?: unknown) => Promise<Reply>) | null
  >(null);
  const failureStage = useRef<FailureStage>("startup");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run().catch(async () => {
      const stage = failureStage.current;
      setStatus(`Evaluation failed closed: ${stage}`);
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return;
      try {
        const request = envelope("evaluation-failed", { stage });
        await invoke("evaluation_dispatch", { envelope: request });
      } catch {
        // The host watchdog remains the bounded fallback if failure reporting cannot dispatch.
      }
    });
  }, []);

  async function run() {
    if (window.__KEIKO_MANUAL_EVALUATION__ === true) {
      await runManual();
      return;
    }
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("evaluation bridge unavailable");
    const dispatch = async (kind: string, data?: unknown) => {
      const request = envelope(kind, data);
      const reply = await invoke("evaluation_dispatch", { envelope: request });
      if (reply.requestId !== request.requestId)
        throw new Error("response correlation failed");
      return reply;
    };

    failureStage.current = "prepare-renderer";
    const prepared = await dispatch("prepare-renderer");
    if (prepared.code !== "accepted")
      throw new Error("renderer preparation failed");
    await frame();
    await frame();
    failureStage.current = "stable-shell";
    const stable = await dispatch("stable-shell", { doubleRendered: true });
    if (stable.code !== "accepted") throw new Error("stable shell failed");

    failureStage.current = "synthetic-input";
    const input = document.querySelector<HTMLInputElement>("#synthetic-input");
    if (!input) throw new Error("input unavailable");
    input.focus();
    const focusDiagnostic = document.activeElement === input;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { data: "か" }),
    );
    input.value = "かな";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "かな",
        inputType: "insertCompositionText",
      }),
    );
    input.dispatchEvent(
      new CompositionEvent("compositionend", { data: "かな" }),
    );
    const compositionDiagnostic = input.value === "かな";

    const inputStart = performance.now();
    flushSync(() => setInputValue("かなa"));
    await frame();
    await frame();
    const inputDiagnosticMs = performance.now() - inputStart;

    failureStage.current = "runtime-event";
    const event = await dispatch("runtime-event");
    if (!event.eventToken || !event.uiValue)
      throw new Error("runtime event invalid");
    flushSync(() => setStatus(event.uiValue!));
    await frame();
    await frame();
    const committed = await dispatch("runtime-event-committed", {
      token: event.eventToken,
    });
    if (committed.code !== "accepted")
      throw new Error("runtime event commit failed");

    failureStage.current = "request-validation";
    const malformed = await invoke("evaluation_dispatch", {
      envelope: { ...envelope("ping"), unexpected: true },
    });
    if (malformed.code !== "invalid_request")
      throw new Error("malformed request accepted");
    const oversized = await invoke("evaluation_dispatch", {
      envelope: envelope("ping", { padding: "x".repeat(4_097) }),
    });
    if (oversized.code !== "payload_too_large")
      throw new Error("oversized request accepted");
    const unknownOperation = await invoke("evaluation_dispatch", {
      envelope: envelope("shell"),
    });
    if (unknownOperation.code !== "invalid_request")
      throw new Error("unknown operation accepted");

    failureStage.current = "replay-protection";
    const replayRequest = envelope("ping");
    const first = await invoke("evaluation_dispatch", {
      envelope: replayRequest,
    });
    if (
      first.code !== "accepted" ||
      first.requestId !== replayRequest.requestId
    ) {
      throw new Error("replay setup failed");
    }
    const replay = await invoke("evaluation_dispatch", {
      envelope: replayRequest,
    });
    if (
      replay.code !== "replayed_request" ||
      replay.requestId !== replayRequest.requestId
    ) {
      throw new Error("replay was not rejected");
    }

    failureStage.current = "accessibility";
    const accessibility = await dispatch(
      "accessibility-result",
      await axeSummary(),
    );
    if (accessibility.code !== "accepted")
      throw new Error("accessibility violations detected");
    failureStage.current = "bounded-work";
    const cancelled = await dispatch("bounded-work", {
      cancelAfterMs: 5,
      timeoutMs: 50,
      workMs: 40,
    });
    if (cancelled.code !== "cancelled")
      throw new Error("bounded cancellation failed");
    const timedOut = await dispatch("bounded-work", {
      timeoutMs: 5,
      workMs: 40,
    });
    if (timedOut.code !== "timed_out")
      throw new Error("bounded timeout failed");
    failureStage.current = "native-dialog";
    const dialog = await dispatch("native-dialog");
    if (dialog.code !== "accepted")
      throw new Error("native cancellation failed");
    failureStage.current = "fixture-process";
    const fixture = await dispatch("fixture-process");
    if (fixture.code !== "accepted") throw new Error("fixture cleanup failed");
    failureStage.current = "renderer-cycle";
    const renderer = await dispatch("renderer-cycle");
    if (renderer.code !== "accepted")
      throw new Error("renderer recovery failed");

    document.documentElement.dataset.evaluationTheme = "dark";
    await frame();
    await frame();
    failureStage.current = "finish";
    await dispatch("finish", {
      diagnostics: {
        appearanceDiagnostic: getComputedStyle(
          document.documentElement,
        ).colorScheme.includes("dark"),
        compositionDiagnostic,
        focusDiagnostic,
        inputDiagnosticMs,
        scaleFactorDiagnostic: window.devicePixelRatio,
      },
    });
  }

  async function runManual() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("manual evaluation bridge unavailable");
    const dispatch = async (kind: string, data?: unknown) => {
      const request = envelope(kind, data);
      const reply = await invoke("evaluation_dispatch", { envelope: request });
      if (reply.requestId !== request.requestId)
        throw new Error("manual response correlation failed");
      return reply;
    };
    const prepared = await dispatch("prepare-renderer");
    if (prepared.code !== "accepted")
      throw new Error("manual renderer preparation failed");
    manualDispatch.current = dispatch;
    setManualMode(true);
    setStatus("Manual evaluation ready");
  }

  async function nativeCancellation() {
    const dispatch = manualDispatch.current;
    if (!dispatch) return;
    setStatus("Native cancellation in progress");
    try {
      const reply = await dispatch("native-dialog");
      setStatus(
        reply.code === "accepted"
          ? "Native cancellation accepted"
          : "Native cancellation failed",
      );
    } catch {
      setStatus("Native cancellation failed closed");
    }
  }

  return (
    <Shell
      inputValue={inputValue}
      onInput={(event) => setInputValue(event.currentTarget.value)}
      onNativeCancel={manualMode ? () => void nativeCancellation() : undefined}
      status={status}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Evaluation />
  </StrictMode>,
);
