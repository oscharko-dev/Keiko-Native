import assert from "node:assert/strict";
import test from "node:test";

import { collectRepositoryControlEvidence } from "./repository-controls-probe.mjs";

test("turns denied or unavailable reads into closed source states", async () => {
  const unavailable = async () => {
    throw new Error("TOKEN endpoint provider body");
  };
  const result = await collectRepositoryControlEvidence(
    {
      admin: unavailable,
      brokerApp: unavailable,
      brokerInstallation: unavailable,
      callerApp: unavailable,
      callerInstallation: unavailable,
    },
    {
      epicRulesetId: 9191,
      repository: "oscharko-dev/Keiko-Native",
      sourceStatuses: { probes: "ok" },
    },
  );
  assert.deepEqual(result.sources, {
    administration: "unavailable",
    broker: "unavailable",
    caller: "unavailable",
    probes: "ok",
  });
  assert.doesNotMatch(JSON.stringify(result), /TOKEN|endpoint|provider body/u);
});
