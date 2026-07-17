const deniedByAcl = "Command evaluation_dispatch not allowed by ACL";

function report(result: string) {
  window.location.replace(`/__keiko-probe-${result}__`);
}

async function verifyCapabilityDenial() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    report("bridge-unavailable");
    return;
  }
  try {
    await invoke("evaluation_dispatch", {
      envelope: {
        schemaVersion: 1,
        requestId: "probe-000000000001",
        operation: { kind: "ping" },
      },
    });
    report("unexpectedly-allowed");
  } catch (error: unknown) {
    report(
      String(error).endsWith(deniedByAcl) ? "acl-denied" : "non-acl-error",
    );
  }
}

void verifyCapabilityDenial();
