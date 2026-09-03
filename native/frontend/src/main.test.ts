// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { expectedSourceRevision, type Invoke, type TurnView } from "./port";

const authority = { documentNonce: "a".repeat(64), generation: 7 };
const domWindow = globalThis.window;
const domDocument = globalThis.document;

const invoke = vi.fn(
  async (
    command: string,
    arguments_: { documentNonce: string; generation: number; request: string },
  ) => {
    const request = JSON.parse(arguments_.request) as {
      requestId: string;
      operation: { kind: string };
    };
    if (command === "workspace_request") {
      const state =
        request.operation.kind === "workspace-select"
          ? { kind: "bound", generation: 1, displayLabel: "Keiko Native" }
          : { kind: "empty", generation: 2 };
      return JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        result: { kind: "workspace", state },
      });
    }
    if (command === "runtime_request") {
      return JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
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
      });
    }
    if (request.operation.kind !== "application-health") {
      const result =
        request.operation.kind === "foundation-load"
          ? {
              kind: "welcome",
              title: "Willkommen bei Keiko Native v0.1.",
              explanation:
                "Diese interne Version enthält bewusst keine Coding- oder Wissensfunktionen. Sie belegt, dass die barrierefreie, stabile Grundlage läuft.",
            }
          : request.operation.kind === "show-about" ||
              request.operation.kind === "open-foundation-link"
            ? {
                kind: "about",
                productName: "Keiko Native",
                channel: "internal",
                version: "0.1.0",
                sourceRevision: expectedSourceRevision,
                repositoryUrl: "https://github.com/oscharko-dev/Keiko-Native",
                licenseUrl: `https://github.com/oscharko-dev/Keiko-Native/blob/${expectedSourceRevision}/LICENSE`,
                statement:
                  "Interner Foundation-Build. Bewusst ohne produktive Features.",
              }
            : request.operation.kind === "show-internal-update"
              ? {
                  kind: "internal-update",
                  message: "Update-Prüfung für interne Builds nicht verfügbar.",
                }
              : {
                  kind: "canvas",
                  committedText:
                    request.operation.kind === "commit-canvas-text"
                      ? Reflect.get(request.operation, "committedText")
                      : "",
                };
      return JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        result,
      });
    }
    return JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      result: {
        kind: "application-health",
        status: "healthy",
        build: {
          version: "0.1.0",
          sourceRevision: expectedSourceRevision,
          targetTriple: "aarch64-apple-darwin",
        },
      },
    });
  },
);
const render = vi.fn();
const rootFactory = vi.hoisted(() => ({
  current: null as null | ((container: Element | DocumentFragment) => unknown),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class<T> {
    onmessage = (_value: T): void => undefined;
  },
}));
vi.mock("react-dom/client", () => ({
  createRoot: (container: Element | DocumentFragment) =>
    rootFactory.current?.(container) ?? { render },
}));

describe("production renderer composition", () => {
  beforeEach(() => {
    rootFactory.current = null;
    invoke.mockClear();
    render.mockClear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __KEIKO_RENDERER_AUTHORITY: authority },
    });
  });

  it("validates two real-command roundtrips before startup completes", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke, async () => authority);

    expect(invoke).toHaveBeenCalledTimes(4);
    expect(render).toHaveBeenCalled();
  });

  it("does not require a presentation root", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => null },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();

    await startRenderer(invoke, async () => authority);

    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("connects every visible action to its narrow typed port operation", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    invoke.mockClear();
    render.mockClear();
    await startRenderer(invoke, async () => authority);

    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const tree = render.mock.calls.at(-1)?.[0];
      const button = all(tree).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    await click("Foundation öffnen");
    await click("Codex-Bereitschaft prüfen");
    await click("Repository auswählen");
    await click("Auswahl aufheben");
    const canvas = all(render.mock.calls.at(-1)?.[0]).find(
      ({ type }) => type === "textarea",
    );
    const target = { value: "Grüße かな" };
    (canvas?.props.onChange as (event: unknown) => void)({
      currentTarget: target,
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await click("Über Keiko Native");
    await click("Repository öffnen");
    await click("Lizenz öffnen");
    await click("Update-Status");
    await click("Leere Fläche");
    await click("Keiko Native beenden");

    const kinds = invoke.mock.calls
      .filter(([command]) => command === "foundation_request")
      .map(([, arguments_]) =>
        Reflect.get(JSON.parse(String(arguments_.request)), "operation"),
      )
      .map((operation) => Reflect.get(operation, "kind"));
    expect(kinds).toEqual([
      "foundation-load",
      "dismiss-welcome",
      "commit-canvas-text",
      "show-about",
      "open-foundation-link",
      "open-foundation-link",
      "show-internal-update",
      "show-canvas",
      "quit-application",
    ]);
    const workspaceKinds = invoke.mock.calls
      .filter(([command]) => command === "workspace_request")
      .map(([, arguments_]) =>
        Reflect.get(JSON.parse(String(arguments_.request)), "operation"),
      )
      .map((operation) => Reflect.get(operation, "kind"));
    expect(workspaceKinds).toEqual([
      "workspace-status",
      "workspace-select",
      "workspace-clear",
    ]);
    const runtimeKinds = invoke.mock.calls
      .filter(([command]) => command === "runtime_request")
      .map(([, arguments_]) =>
        Reflect.get(JSON.parse(String(arguments_.request)), "operation"),
      )
      .map((operation) => Reflect.get(operation, "kind"));
    expect(runtimeKinds).toEqual(["runtime-readiness"]);
    expect(JSON.stringify(render.mock.calls.at(-1)?.[0])).not.toContain(
      "redacted-account-value",
    );
  });

  it("discards readiness that resolves after a different workspace is selected", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    let resolveReadiness!: (value: string) => void;
    const readiness = new Promise<string>((resolve) => {
      resolveReadiness = resolve;
    });
    let selectedGeneration = 2;
    let readinessRequestId = "";
    const deferredInvoke = vi.fn<Invoke>(async (command, arguments_) => {
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { kind: string };
      };
      if (
        command === "workspace_request" &&
        request.operation.kind === "workspace-select"
      ) {
        selectedGeneration += 1;
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result: {
            kind: "workspace",
            state: {
              kind: "bound",
              generation: selectedGeneration,
              displayLabel: `Repository ${selectedGeneration}`,
            },
          },
        });
      }
      if (command === "runtime_request") {
        readinessRequestId = request.requestId;
        return readiness;
      }
      return invoke(command, arguments_);
    });
    render.mockClear();
    await startRenderer(deferredInvoke, async () => authority);

    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
    };

    click("Foundation öffnen");
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    click("Repository auswählen");
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    click("Codex-Bereitschaft prüfen");
    await Promise.resolve();
    click("Anderes Repository auswählen");
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    resolveReadiness(
      JSON.stringify({
        schemaVersion: 1,
        requestId: readinessRequestId,
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
      }),
    );
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const rendered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("Repository 4");
    expect(rendered).toContain("Codex-Bereitschaft prüfen");
    expect(rendered).toContain('data-runtime-state":"unchecked"');
    expect(rendered).not.toContain("Codex 0.145.0 ist protokollbereit");
  });

  it("preserves an active turn when workspace reselection is rejected", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    let selections = 0;
    let turnRequestId = "";
    let turnChannel: { onmessage: (value: TurnView) => void } | undefined;
    let resolveTurn: ((value: string) => void) | undefined;
    const rejectingReselection = vi.fn<Invoke>(async (command, arguments_) => {
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { kind: string; workspaceGeneration?: number };
      };
      if (
        command === "workspace_request" &&
        request.operation.kind === "workspace-select"
      ) {
        selections += 1;
        if (selections > 1) throw new Error("cleanup could not be proven");
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result: {
            kind: "workspace",
            state: {
              kind: "bound",
              generation: 3,
              displayLabel: "Retained Repository",
            },
          },
        });
      }
      if (command !== "codex_turn_request") {
        return invoke(command, arguments_);
      }
      turnRequestId = request.requestId;
      turnChannel = arguments_.onEvent;
      const streaming: TurnView = {
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration: request.operation.workspaceGeneration ?? 0,
        state: "streaming",
        agentText: "Bounded answer.",
        providerThreadEstablished: true,
        providerTurnEstablished: true,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 15,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: false,
          terminalState: "streaming",
        },
      };
      arguments_.onEvent?.onmessage({
        ...streaming,
        state: "preflighting",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          ...streaming.evidence,
          messageBytes: 0,
          terminalState: "preflighting",
        },
      });
      arguments_.onEvent?.onmessage(streaming);
      return new Promise<string>((resolve) => {
        resolveTurn = resolve;
      });
    });
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };

    render.mockClear();
    await startRenderer(rejectingReselection, async () => authority);
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");
    const elements = all(render.mock.calls.at(-1)?.[0]);
    const task = elements.find(({ props }) => props.id === "codex-task")?.props;
    const submit = elements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const taskNode = { disabled: false, value: "Bounded task." };
    const submitNode = { disabled: true };
    (task?.ref as (node: typeof taskNode) => void)(taskNode);
    (submit?.ref as (node: typeof submitNode) => void)(submitNode);
    (task?.onInput as () => void)();
    (submit?.onClick as () => void)();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    await click("Anderes Repository auswählen");

    const retained = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(retained).toContain("Retained Repository");
    expect(retained).toContain("Codex antwortet");
    expect(retained).toContain("Codex-Lauf abbrechen");
    expect(retained).toContain("Codex 0.145.0 ist protokollbereit");

    const cancelled: TurnView = {
      taskId: "task-0000000000000007-0000000000000001",
      runId: "run-0000000000000007-0000000000000001",
      workspaceGeneration: 3,
      state: "cancelled",
      reason: "user-cancelled",
      agentText: "Bounded answer.",
      providerThreadEstablished: true,
      providerTurnEstablished: true,
      evidence: {
        runtimeVersion: "0.145.0",
        runtimeArtifactSha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
        containmentProfile: "keiko-codex-readiness-v1",
        authorityProfile: "keiko-codex-no-effect-v1",
        messageBytes: 15,
        quarantinedEvents: 0,
        acceptedEffects: 0,
        repositoryContextBytesToRuntime: 0,
        cleanupComplete: true,
        terminalState: "cancelled",
      },
    };
    turnChannel?.onmessage(cancelled);
    resolveTurn?.(
      JSON.stringify({
        schemaVersion: 1,
        requestId: turnRequestId,
        result: { kind: "codex-turn", state: cancelled },
      }),
    );
    await Promise.resolve();
  });

  it("renders a redacted recoverable welcome substate when the host is unavailable", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    render.mockClear();
    await expect(
      startRenderer(
        vi.fn(async () => Promise.reject(new Error("raw host detail"))),
        async () => authority,
      ),
    ).resolves.toBeUndefined();
    const rendered = render.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(rendered)).toContain("Foundation-Host");
    expect(JSON.stringify(rendered)).not.toContain("raw host detail");
  });

  it("isolates workspace-status failure from the foundation surface", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    const workspaceUnavailable = vi.fn(
      async (
        command: string,
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
        },
      ) => {
        const operation = Reflect.get(
          JSON.parse(arguments_.request),
          "operation",
        ) as { kind: string };
        if (
          command === "workspace_request" &&
          operation.kind === "workspace-status"
        ) {
          throw new Error("raw workspace transport detail");
        }
        return invoke(command, arguments_);
      },
    );
    render.mockClear();

    await expect(
      startRenderer(workspaceUnavailable, async () => authority),
    ).resolves.toBeUndefined();

    const initialRendered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(initialRendered).toContain("Willkommen bei Keiko Native");
    expect(initialRendered).not.toContain("Foundation-Host");
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const open = all(render.mock.calls.at(-1)?.[0]).find(
      ({ type, props }) =>
        type === "button" && props.children === "Foundation öffnen",
    );
    (open?.props.onClick as () => void)();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    const rendered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("Die Grundlage läuft.");
    expect(rendered).toContain("nicht mehr verfügbar");
    expect(rendered).not.toContain("raw workspace transport detail");
  });

  it("clears a channel-only terminal turn after settlement fails", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failingTurn = vi.fn<Invoke>(
      async (
        command: string,
        arguments_: {
          documentNonce: string;
          generation: number;
          request: string;
          onEvent?: { onmessage: (value: TurnView) => void };
        },
      ) => {
        if (command !== "codex_turn_request") {
          return invoke(command, arguments_);
        }
        const request = JSON.parse(arguments_.request) as {
          operation: { workspaceGeneration: number };
        };
        arguments_.onEvent?.onmessage({
          taskId: "task-0000000000000007-0000000000000001",
          runId: "run-0000000000000007-0000000000000001",
          workspaceGeneration: request.operation.workspaceGeneration,
          state: "completed",
          agentText: "Channel-only answer.",
          providerThreadEstablished: true,
          providerTurnEstablished: true,
          evidence: {
            runtimeVersion: "0.145.0",
            runtimeArtifactSha256:
              "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
            containmentProfile: "keiko-codex-readiness-v1",
            authorityProfile: "keiko-codex-no-effect-v1",
            messageBytes: 20,
            quarantinedEvents: 0,
            acceptedEffects: 0,
            repositoryContextBytesToRuntime: 0,
            cleanupComplete: true,
            terminalState: "completed",
          },
        });
        throw new Error("raw provider detail");
      },
    );
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    render.mockClear();
    await startRenderer(failingTurn, async () => authority);
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");

    const turnElements = all(render.mock.calls.at(-1)?.[0]);
    const task = turnElements.find(
      ({ props }) => props.id === "codex-task",
    )?.props;
    const submit = turnElements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const taskNode = { disabled: false, value: "Bounded task." };
    const submitNode = { disabled: true };
    (task?.ref as (node: typeof taskNode) => void)(taskNode);
    (submit?.ref as (node: typeof submitNode) => void)(submitNode);
    (task?.onInput as () => void)();
    expect(submitNode.disabled).toBe(false);
    (submit?.onClick as () => void)();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const recovered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(recovered).toContain("Begrenzten Auftrag starten");
    expect(recovered).not.toContain("Codex antwortet");
    expect(consoleError).toHaveBeenCalledWith(
      "Codex turn ended before a verified terminal state; retry is available.",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "raw provider detail",
    );
    consoleError.mockRestore();
  });

  it("closes stale workspace state and readiness after host validation fails", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    const staleTurn = vi.fn<Invoke>(async (command, arguments_) => {
      if (command !== "codex_turn_request") {
        return invoke(command, arguments_);
      }
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { workspaceGeneration: number };
      };
      const state: TurnView = {
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration: request.operation.workspaceGeneration,
        state: "failed",
        reason: "stale-workspace",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: true,
          terminalState: "failed",
        },
      };
      const preflight: TurnView = {
        ...state,
        state: "preflighting",
        evidence: {
          ...state.evidence,
          cleanupComplete: false,
          terminalState: "preflighting",
        },
      };
      Reflect.deleteProperty(preflight, "reason");
      arguments_.onEvent?.onmessage(preflight);
      arguments_.onEvent?.onmessage(state);
      return JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        result: { kind: "codex-turn", state },
      });
    });
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    render.mockClear();
    await startRenderer(staleTurn, async () => authority);
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");
    const elements = all(render.mock.calls.at(-1)?.[0]);
    const task = elements.find(({ props }) => props.id === "codex-task")?.props;
    const submit = elements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const taskNode = { disabled: false, value: "Bounded task." };
    const submitNode = { disabled: true };
    (task?.ref as (node: typeof taskNode) => void)(taskNode);
    (submit?.ref as (node: typeof submitNode) => void)(submitNode);
    (task?.onInput as () => void)();
    (submit?.onClick as () => void)();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const rendered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("nicht mehr verfügbar");
    expect(rendered).not.toContain("Laufzeit ist bereit");
    const closedElements = all(render.mock.calls.at(-1)?.[0]);
    const closedTask = closedElements.find(
      ({ props }) => props.id === "codex-task",
    )?.props;
    const closedSubmit = closedElements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const closedTaskNode = { disabled: false, value: "Retry task." };
    const closedSubmitNode = { disabled: false };
    (closedTask?.ref as (node: typeof closedTaskNode) => void)(closedTaskNode);
    (closedSubmit?.ref as (node: typeof closedSubmitNode) => void)(
      closedSubmitNode,
    );
    (closedTask?.onInput as () => void)();
    expect(closedSubmitNode.disabled).toBe(true);
  });

  it("ignores a terminal update from an older workspace generation", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    let selectedGeneration = 2;
    let resolveTurn: ((value: string) => void) | undefined;
    let turnRequestId = "";
    let turnChannel: { onmessage: (value: TurnView) => void } | undefined;
    const changingWorkspace = vi.fn<Invoke>(async (command, arguments_) => {
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { kind: string; workspaceGeneration?: number };
      };
      if (
        command === "workspace_request" &&
        request.operation.kind === "workspace-select"
      ) {
        selectedGeneration += 1;
        return JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          result: {
            kind: "workspace",
            state: {
              kind: "bound",
              generation: selectedGeneration,
              displayLabel: selectedGeneration === 3 ? "Old Repo" : "New Repo",
            },
          },
        });
      }
      if (command !== "codex_turn_request") {
        return invoke(command, arguments_);
      }
      turnRequestId = request.requestId;
      turnChannel = arguments_.onEvent;
      const workspaceGeneration = request.operation.workspaceGeneration ?? 0;
      arguments_.onEvent?.onmessage({
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration,
        state: "preflighting",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: false,
          terminalState: "preflighting",
        },
      });
      return new Promise((resolve) => {
        resolveTurn = resolve;
      });
    });
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    render.mockClear();
    await startRenderer(changingWorkspace, async () => authority);
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");
    const elements = all(render.mock.calls.at(-1)?.[0]);
    const task = elements.find(({ props }) => props.id === "codex-task")?.props;
    const submit = elements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const taskNode = { disabled: false, value: "Bounded task." };
    const submitNode = { disabled: true };
    (task?.ref as (node: typeof taskNode) => void)(taskNode);
    (submit?.ref as (node: typeof submitNode) => void)(submitNode);
    (task?.onInput as () => void)();
    (submit?.onClick as () => void)();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    await click("Anderes Repository auswählen");
    const stale: TurnView = {
      taskId: "task-0000000000000007-0000000000000001",
      runId: "run-0000000000000007-0000000000000001",
      workspaceGeneration: 3,
      state: "failed",
      reason: "stale-workspace",
      agentText: "",
      providerThreadEstablished: false,
      providerTurnEstablished: false,
      evidence: {
        runtimeVersion: "0.145.0",
        runtimeArtifactSha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
        containmentProfile: "keiko-codex-readiness-v1",
        authorityProfile: "keiko-codex-no-effect-v1",
        messageBytes: 0,
        quarantinedEvents: 0,
        acceptedEffects: 0,
        repositoryContextBytesToRuntime: 0,
        cleanupComplete: true,
        terminalState: "failed",
      },
    };
    turnChannel?.onmessage(stale);
    resolveTurn?.(
      JSON.stringify({
        schemaVersion: 1,
        requestId: turnRequestId,
        result: { kind: "codex-turn", state: stale },
      }),
    );
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const rendered = JSON.stringify(render.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("New Repo");
    expect(rendered).not.toContain("Old Repo");
    expect(rendered).not.toContain("nicht mehr verfügbar");
    expect(rendered).not.toContain("Laufzeit ist bereit");
  });

  it("lets the cancel control retry after an unaccepted acknowledgement", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => ({}) },
    });
    const { startRenderer } = await import("./main");
    let cancellationAttempts = 0;
    let resolveTurn: ((value: string) => void) | undefined;
    let turnRequestId = "";
    let turnChannel: { onmessage: (value: TurnView) => void } | undefined;
    const cancellableTurn = vi.fn<Invoke>(async (command, arguments_) => {
      if (command === "application_cancel") {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) return "{}";
        const cancellation = JSON.parse(arguments_.request) as {
          requestId: string;
        };
        return JSON.stringify({
          schemaVersion: 1,
          requestId: cancellation.requestId,
          result: { kind: "application-cancel", status: "cancelled" },
        });
      }
      if (command !== "codex_turn_request") {
        return invoke(command, arguments_);
      }
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { workspaceGeneration: number };
      };
      turnRequestId = request.requestId;
      turnChannel = arguments_.onEvent;
      arguments_.onEvent?.onmessage({
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration: request.operation.workspaceGeneration,
        state: "preflighting",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: false,
          terminalState: "preflighting",
        },
      });
      return new Promise((resolve) => {
        resolveTurn = resolve;
      });
    });
    const all = (
      value: unknown,
    ): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(all);
      if (typeof value !== "object" || value === null) return [];
      const props = Reflect.get(value, "props") as
        Record<string, unknown> | undefined;
      if (props === undefined) return [];
      return [
        { type: Reflect.get(value, "type"), props },
        ...all(props.children),
      ];
    };
    const click = async (label: string) => {
      const button = all(render.mock.calls.at(-1)?.[0]).find(
        ({ type, props }) => type === "button" && props.children === label,
      );
      (button?.props.onClick as () => void)();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };

    render.mockClear();
    await startRenderer(cancellableTurn, async () => authority);
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");
    const taskElements = all(render.mock.calls.at(-1)?.[0]);
    const task = taskElements.find(
      ({ props }) => props.id === "codex-task",
    )?.props;
    const submit = taskElements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const taskNode = { disabled: false, value: "Bounded task." };
    const submitNode = { disabled: true };
    (task?.ref as (node: typeof taskNode) => void)(taskNode);
    (submit?.ref as (node: typeof submitNode) => void)(submitNode);
    (task?.onInput as () => void)();
    (submit?.onClick as () => void)();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    await click("Codex-Lauf abbrechen");
    expect(cancellationAttempts).toBe(1);
    expect(JSON.stringify(render.mock.calls.at(-1)?.[0])).toContain(
      "Codex-Lauf abbrechen",
    );
    await click("Codex-Lauf abbrechen");
    expect(cancellationAttempts).toBe(2);
    expect(JSON.stringify(render.mock.calls.at(-1)?.[0])).toContain(
      "Codex-Lauf wird beendet",
    );

    const cancelled: TurnView = {
      taskId: "task-0000000000000007-0000000000000001",
      runId: "run-0000000000000007-0000000000000001",
      workspaceGeneration: 1,
      state: "cancelled",
      reason: "user-cancelled",
      agentText: "",
      providerThreadEstablished: false,
      providerTurnEstablished: false,
      evidence: {
        runtimeVersion: "0.145.0",
        runtimeArtifactSha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
        containmentProfile: "keiko-codex-readiness-v1",
        authorityProfile: "keiko-codex-no-effect-v1",
        messageBytes: 0,
        quarantinedEvents: 0,
        acceptedEffects: 0,
        repositoryContextBytesToRuntime: 0,
        cleanupComplete: true,
        terminalState: "cancelled",
      },
    };
    turnChannel?.onmessage(cancelled);
    expect(JSON.stringify(render.mock.calls.at(-1)?.[0])).toContain(
      "Codex-Lauf wird beendet",
    );
    expect(JSON.stringify(render.mock.calls.at(-1)?.[0])).not.toContain(
      "Begrenzten Auftrag starten",
    );
    const terminalRenderCount = render.mock.calls.length;
    resolveTurn?.(
      JSON.stringify({
        schemaVersion: 1,
        requestId: turnRequestId,
        result: { kind: "codex-turn", state: cancelled },
      }),
    );
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(terminalRenderCount + 2);
    const recoveredElements = all(render.mock.calls.at(-1)?.[0]);
    const recoveredTask = recoveredElements.find(
      ({ props }) => props.id === "codex-task",
    )?.props;
    const recoveredSubmit = recoveredElements.find(
      ({ type, props }) =>
        type === "button" && props.children === "Begrenzten Auftrag starten",
    )?.props;
    const recoveredTaskNode = { disabled: false, value: "Retry task." };
    const recoveredSubmitNode = { disabled: true };
    (recoveredTask?.ref as (node: typeof recoveredTaskNode) => void)(
      recoveredTaskNode,
    );
    (recoveredSubmit?.ref as (node: typeof recoveredSubmitNode) => void)(
      recoveredSubmitNode,
    );
    (recoveredTask?.onInput as () => void)();
    expect(recoveredSubmitNode.disabled).toBe(false);
  });

  it("commits stopping to the real stable live region before a pending terminal", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: domWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: domDocument,
    });
    Object.defineProperty(domWindow, "__KEIKO_RENDERER_AUTHORITY", {
      configurable: true,
      value: authority,
    });
    domDocument.body.innerHTML = '<div id="root"></div>';
    const { startRenderer } = await import("./main");
    const actualClient =
      await vi.importActual<typeof import("react-dom/client")>(
        "react-dom/client",
      );
    rootFactory.current = actualClient.createRoot;
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    let resolveCancellation!: (value: string) => void;
    let resolveTurn!: (value: string) => void;
    let turnRequestId = "";
    let turnChannel: { onmessage: (value: TurnView) => void } | undefined;
    const terminalBeforeAck = vi.fn<Invoke>(async (command, arguments_) => {
      const request = JSON.parse(arguments_.request) as {
        requestId: string;
        operation: { kind: string; workspaceGeneration?: number };
      };
      if (command === "application_cancel") {
        return new Promise<string>((resolve) => {
          resolveCancellation = resolve;
        });
      }
      if (command !== "codex_turn_request") {
        return invoke(command, arguments_);
      }
      turnRequestId = request.requestId;
      turnChannel = arguments_.onEvent;
      arguments_.onEvent?.onmessage({
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration: request.operation.workspaceGeneration ?? 0,
        state: "preflighting",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: false,
          terminalState: "preflighting",
        },
      });
      return new Promise<string>((resolve) => {
        resolveTurn = resolve;
      });
    });
    await act(async () => {
      await startRenderer(terminalBeforeAck, async () => authority);
    });
    const click = async (label: string) => {
      const button = Array.from(domDocument.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    };
    await click("Foundation öffnen");
    await click("Repository auswählen");
    await click("Codex-Bereitschaft prüfen");
    const task = domDocument.querySelector<HTMLTextAreaElement>("#codex-task");
    expect(task).not.toBeNull();
    await act(async () => {
      if (task !== null) {
        task.value = "Bounded task.";
        task.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      }
    });
    await click("Begrenzten Auftrag starten");
    const status = domDocument.querySelector(".turn-status");
    expect(status).not.toBeNull();
    const oldValues: Array<string | null> = [];
    const observer = new domWindow.MutationObserver((records) => {
      oldValues.push(...records.map((record) => record.oldValue));
    });
    observer.observe(status as Node, {
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    });
    await click("Codex-Lauf abbrechen");
    const cancelled: TurnView = {
      taskId: "task-0000000000000007-0000000000000001",
      runId: "run-0000000000000007-0000000000000001",
      workspaceGeneration: 1,
      state: "cancelled",
      reason: "user-cancelled",
      agentText: "",
      providerThreadEstablished: false,
      providerTurnEstablished: false,
      evidence: {
        runtimeVersion: "0.145.0",
        runtimeArtifactSha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
        containmentProfile: "keiko-codex-readiness-v1",
        authorityProfile: "keiko-codex-no-effect-v1",
        messageBytes: 0,
        quarantinedEvents: 0,
        acceptedEffects: 0,
        repositoryContextBytesToRuntime: 0,
        cleanupComplete: true,
        terminalState: "cancelled",
      },
    };
    turnChannel?.onmessage(cancelled);
    resolveTurn(
      JSON.stringify({
        schemaVersion: 1,
        requestId: turnRequestId,
        result: { kind: "codex-turn", state: cancelled },
      }),
    );
    await act(async () => {
      resolveCancellation(
        JSON.stringify({
          schemaVersion: 1,
          requestId: turnRequestId,
          result: { kind: "application-cancel", status: "cancelled" },
        }),
      );
    });
    observer.disconnect();

    expect(domDocument.querySelector(".turn-status")).toBe(status);
    expect(oldValues).toContain("Keiko beendet den Codex-Lauf sicher.");
    expect(status?.textContent).toBe(
      "Der Codex-Lauf wurde abgebrochen und vollständig beendet.",
    );
  });

  it("commits one fail-closed terminal to the stable live region at the cleanup reserve", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: domWindow,
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: domDocument,
      });
      Object.defineProperty(domWindow, "__KEIKO_RENDERER_AUTHORITY", {
        configurable: true,
        value: authority,
      });
      domDocument.body.innerHTML = '<div id="root"></div>';
      const { startRenderer } = await import("./main");
      const actualClient =
        await vi.importActual<typeof import("react-dom/client")>(
          "react-dom/client",
        );
      rootFactory.current = actualClient.createRoot;
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      let resolveTurn!: (value: string) => void;
      let turnRequestId = "";
      let turnChannel: { onmessage: (value: TurnView) => void } | undefined;
      let readinessRequests = 0;
      let workspaceSelections = 0;
      const withheldTerminal = vi.fn<Invoke>(async (command, arguments_) => {
        const request = JSON.parse(arguments_.request) as {
          requestId: string;
          operation: { kind: string; workspaceGeneration?: number };
        };
        if (command === "runtime_request") {
          readinessRequests += 1;
          if (readinessRequests === 2) {
            throw new Error("readiness IPC failed");
          }
          if (readinessRequests === 3) {
            return JSON.stringify({
              schemaVersion: 1,
              requestId: request.requestId,
              result: {
                kind: "runtime-readiness",
                state: { state: "unavailable", quarantinedEvents: 0 },
              },
            });
          }
          return invoke(command, arguments_);
        }
        if (command === "workspace_request") {
          const selecting = request.operation.kind === "workspace-select";
          if (selecting) {
            workspaceSelections += 1;
          }
          const state = selecting
            ? {
                kind: "bound",
                generation: workspaceSelections === 3 ? 4 : workspaceSelections,
                displayLabel: `Keiko Native ${workspaceSelections}`,
              }
            : { kind: "empty", generation: 3 };
          return JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            result: { kind: "workspace", state },
          });
        }
        if (command === "application_cancel") {
          return JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            result: { kind: "application-cancel", status: "cancelled" },
          });
        }
        if (command !== "codex_turn_request") {
          return invoke(command, arguments_);
        }
        turnRequestId = request.requestId;
        turnChannel = arguments_.onEvent;
        arguments_.onEvent?.onmessage({
          taskId: "task-0000000000000007-0000000000000001",
          runId: "run-0000000000000007-0000000000000001",
          workspaceGeneration: request.operation.workspaceGeneration ?? 0,
          state: "preflighting",
          agentText: "",
          providerThreadEstablished: false,
          providerTurnEstablished: false,
          evidence: {
            runtimeVersion: "0.145.0",
            runtimeArtifactSha256:
              "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
            containmentProfile: "keiko-codex-readiness-v1",
            authorityProfile: "keiko-codex-no-effect-v1",
            messageBytes: 0,
            quarantinedEvents: 0,
            acceptedEffects: 0,
            repositoryContextBytesToRuntime: 0,
            cleanupComplete: false,
            terminalState: "preflighting",
          },
        });
        return new Promise<string>((resolve) => {
          resolveTurn = resolve;
        });
      });
      await act(async () => {
        await startRenderer(withheldTerminal, async () => authority);
      });
      const click = async (label: string) => {
        const button = Array.from(domDocument.querySelectorAll("button")).find(
          (candidate) => candidate.textContent === label,
        );
        expect(button, label).toBeDefined();
        await act(async () => button?.click());
      };
      await click("Foundation öffnen");
      await click("Repository auswählen");
      await click("Codex-Bereitschaft prüfen");
      const task =
        domDocument.querySelector<HTMLTextAreaElement>("#codex-task");
      await act(async () => {
        if (task !== null) {
          task.value = "Bounded task.";
          task.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
        }
      });
      await click("Begrenzten Auftrag starten");
      const status = domDocument.querySelector(".turn-status");
      expect(status).not.toBeNull();
      const terminalText =
        "Keiko konnte die Beendigung des Codex-Laufs nicht bestätigen. Starten Sie keinen neuen Lauf.";
      const observed: string[] = [];
      const observer = new domWindow.MutationObserver(() => {
        observed.push(status?.textContent ?? "");
      });
      observer.observe(status as Node, {
        characterData: true,
        childList: true,
        subtree: true,
      });

      await click("Codex-Lauf abbrechen");
      await act(async () => vi.advanceTimersByTimeAsync(4_499));
      expect(status?.textContent).toBe("Keiko beendet den Codex-Lauf sicher.");
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(domDocument.querySelector(".turn-status")).toBe(status);
      expect(status?.getAttribute("role")).toBe("status");
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(status?.getAttribute("aria-atomic")).toBe("true");
      expect(status?.textContent).toBe(terminalText);
      expect(domDocument.body.textContent).toContain(
        "Die Bereinigung ist nicht bestätigt. Prüfen Sie die Codex-Bereitschaft erneut, bevor Sie fortfahren.",
      );
      const blockedTask =
        domDocument.querySelector<HTMLTextAreaElement>("#codex-task");
      const blockedSubmit = Array.from(
        domDocument.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (candidate) => candidate.textContent === "Begrenzten Auftrag starten",
      );
      expect(blockedTask?.disabled).toBe(true);
      expect(blockedSubmit?.disabled).toBe(true);
      await act(async () => {
        blockedTask?.dispatchEvent(
          new domWindow.KeyboardEvent("keydown", {
            bubbles: true,
            key: "Enter",
          }),
        );
      });
      await act(async () => blockedSubmit?.click());
      expect(
        withheldTerminal.mock.calls.filter(
          ([command]) => command === "codex_turn_request",
        ),
      ).toHaveLength(1);

      await click("Anderes Repository auswählen");
      expect(status?.textContent).toBe(terminalText);
      expect(blockedTask?.disabled).toBe(true);
      expect(domDocument.body.textContent).toContain("Noch nicht geprüft.");

      await click("Auswahl aufheben");
      expect(status?.textContent).toBe(terminalText);
      expect(blockedTask?.disabled).toBe(true);
      expect(domDocument.body.textContent).toContain(
        "Kein Repository ausgewählt.",
      );

      await click("Repository auswählen");
      expect(status?.textContent).toBe(terminalText);
      expect(blockedTask?.disabled).toBe(true);
      expect(domDocument.body.textContent).toContain("Keiko Native 3");

      await click("Codex-Bereitschaft prüfen");
      expect(status?.textContent).toBe(terminalText);
      expect(blockedTask?.disabled).toBe(true);
      expect(domDocument.body.textContent).toContain(
        "Die Bereinigung ist nicht bestätigt. Prüfen Sie die Codex-Bereitschaft erneut, bevor Sie fortfahren.",
      );

      await click("Prüfung wiederholen");
      expect(status?.textContent).toBe(terminalText);
      expect(blockedTask?.disabled).toBe(true);
      expect(domDocument.body.textContent).toContain(
        "Die Bereinigung ist nicht bestätigt. Prüfen Sie die Codex-Bereitschaft erneut, bevor Sie fortfahren.",
      );

      await click("Prüfung wiederholen");
      expect(domDocument.querySelector(".turn-status")).toBeNull();
      expect(blockedTask?.disabled).toBe(false);
      expect(blockedSubmit?.disabled).toBe(false);
      expect(domDocument.body.textContent).not.toContain(terminalText);

      const cancelled: TurnView = {
        taskId: "task-0000000000000007-0000000000000001",
        runId: "run-0000000000000007-0000000000000001",
        workspaceGeneration: 1,
        state: "cancelled",
        reason: "user-cancelled",
        agentText: "",
        providerThreadEstablished: false,
        providerTurnEstablished: false,
        evidence: {
          runtimeVersion: "0.145.0",
          runtimeArtifactSha256:
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
          containmentProfile: "keiko-codex-readiness-v1",
          authorityProfile: "keiko-codex-no-effect-v1",
          messageBytes: 0,
          quarantinedEvents: 0,
          acceptedEffects: 0,
          repositoryContextBytesToRuntime: 0,
          cleanupComplete: true,
          terminalState: "cancelled",
        },
      };
      turnChannel?.onmessage(cancelled);
      resolveTurn(
        JSON.stringify({
          schemaVersion: 1,
          requestId: turnRequestId,
          result: { kind: "codex-turn", state: cancelled },
        }),
      );
      await act(async () => Promise.resolve());
      observer.disconnect();

      expect(domDocument.querySelectorAll(".turn-status")).toHaveLength(0);
      expect(observed.filter((value) => value === terminalText)).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
