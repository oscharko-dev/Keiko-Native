"use strict";

const byId = (id) => document.getElementById(id);
const elements = {
  input: byId("international-input"),
  chooseFolder: byId("choose-folder"),
  folderState: byId("folder-state"),
  startFixture: byId("start-fixture"),
  stopFixture: byId("stop-fixture"),
  fixtureState: byId("fixture-state"),
  runProbes: byId("run-probes"),
  probeState: byId("probe-state"),
  simulateUnavailable: byId("simulate-unavailable"),
  rendererState: byId("renderer-state"),
  recoveryPanel: byId("recovery-panel"),
  recoverRenderer: byId("recover-renderer"),
  workspace: byId("workspace"),
  status: byId("status"),
  error: byId("error"),
};

let composing = false;
let compositionUpdates = 0;

async function invoke(command, payload = {}) {
  const bridge = window.__TAURI__?.core;
  if (!bridge?.invoke) {
    throw new Error("The trusted desktop bridge is unavailable.");
  }
  return bridge.invoke(command, payload);
}

function announce(message) {
  elements.status.textContent = message;
  elements.error.hidden = true;
}

function reportError(error) {
  const message =
    typeof error === "string" ? error : "The requested action failed safely.";
  elements.error.textContent = message;
  elements.error.hidden = false;
  elements.status.textContent = "Action rejected.";
}

function applySnapshot(snapshot) {
  const running = snapshot.fixture === "running";
  const available = snapshot.renderer === "available";
  elements.fixtureState.textContent = running ? "Running" : "Stopped";
  elements.startFixture.disabled = running || !available;
  elements.stopFixture.disabled = !running;
  elements.rendererState.textContent = available ? "Available" : "Unavailable";
  elements.rendererState.classList.toggle("badge-ok", available);
  elements.workspace.inert = !available;
  elements.recoveryPanel.hidden = available;
}

async function chooseFolder() {
  elements.chooseFolder.disabled = true;
  announce("Native folder picker opened.");
  try {
    const result = await invoke("choose_folder");
    const cancelled = result.outcome === "cancelled";
    elements.folderState.textContent = cancelled ? "Cancelled" : "Selected";
    announce(
      cancelled
        ? "Folder selection cancelled."
        : "Folder selected by the trusted host.",
    );
  } catch (error) {
    reportError(error);
  } finally {
    elements.chooseFolder.disabled = false;
    elements.chooseFolder.focus();
  }
}

async function updateFixture(command, message) {
  elements.startFixture.disabled = true;
  elements.stopFixture.disabled = true;
  try {
    const snapshot = await invoke(command);
    applySnapshot(snapshot);
    announce(message);
  } catch (error) {
    reportError(error);
    await refreshSnapshot();
  }
}

async function runProbes() {
  elements.runProbes.disabled = true;
  const probes = ["malformed", "oversized", "unauthorized"];
  try {
    const results = [];
    for (const probe of probes) {
      results.push(await invoke("run_rejection_probe", { probe }));
    }
    const rejected = results.every((result) => result.rejected);
    elements.probeState.textContent = rejected ? "3 rejected" : "Failed";
    announce(
      rejected
        ? "All hostile requests were rejected."
        : "A rejection probe failed.",
    );
  } catch (error) {
    reportError(error);
  } finally {
    elements.runProbes.disabled = false;
  }
}

async function simulateUnavailable() {
  try {
    const snapshot = await invoke("renderer_unavailable");
    applySnapshot(snapshot);
    announce(
      "Renderer unavailability injected; trusted host remains responsive.",
    );
    elements.recoverRenderer.focus();
  } catch (error) {
    reportError(error);
  }
}

async function recoverRenderer() {
  try {
    const snapshot = await invoke("renderer_recover");
    applySnapshot(snapshot);
    announce("Renderer recovered; the shell is usable.");
    elements.simulateUnavailable.focus();
  } catch (error) {
    reportError(error);
  }
}

async function refreshSnapshot() {
  try {
    applySnapshot(await invoke("shell_snapshot"));
  } catch (error) {
    reportError(error);
  }
}

function bindInputMethodEvents() {
  elements.input.addEventListener("compositionstart", () => {
    composing = true;
    compositionUpdates = 0;
    announce("Text composition started.");
  });
  elements.input.addEventListener("compositionupdate", () => {
    compositionUpdates += 1;
  });
  elements.input.addEventListener("compositionend", () => {
    composing = false;
    announce(
      `International text committed after ${compositionUpdates} composition updates.`,
    );
  });
  elements.input.addEventListener("input", () => {
    if (!composing) announce("Text input committed.");
  });
}

function bindActions() {
  elements.chooseFolder.addEventListener("click", chooseFolder);
  elements.startFixture.addEventListener("click", () =>
    updateFixture("fixture_start", "Fixture process started."),
  );
  elements.stopFixture.addEventListener("click", () =>
    updateFixture("fixture_stop", "Fixture process stopped cleanly."),
  );
  elements.runProbes.addEventListener("click", runProbes);
  elements.simulateUnavailable.addEventListener("click", simulateUnavailable);
  elements.recoverRenderer.addEventListener("click", recoverRenderer);
}

bindInputMethodEvents();
bindActions();
refreshSnapshot();
