import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectedSourceRevision, type Invoke, type TurnView } from "./port";

const authority = { documentNonce: "a".repeat(64), generation: 7 };

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class<T> {
    onmessage = (_value: T): void => undefined;
  },
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));

describe("production renderer composition", () => {
  beforeEach(() => {
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

  it("clears a non-terminal turn after a redacted request failure", async () => {
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
            cleanupComplete: false,
            terminalState: "preflighting",
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
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
});
