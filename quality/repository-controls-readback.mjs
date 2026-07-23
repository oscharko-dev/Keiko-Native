import { isDeepStrictEqual } from "node:util";

import { add } from "./repository-controls-policy.mjs";

export function configurationReadFailures(evidence) {
  const failures = [];
  const reads = evidence.configurationReads;
  for (const source of ["administration", "broker", "caller"]) {
    add(
      failures,
      !Array.isArray(reads[source]) ||
        reads[source].length !== 2 ||
        !isDeepStrictEqual(reads[source][0], reads[source][1]),
      `configuration_${source}_unstable`,
    );
  }
  if (failures.length > 0) return failures;
  const administration = reads.administration[1];
  add(
    failures,
    !isDeepStrictEqual(administration.actions, evidence.actions) ||
      !isDeepStrictEqual(
        administration.administration,
        evidence.administration,
      ) ||
      administration.devHeadSha !== evidence.devHeadSha ||
      !isDeepStrictEqual(
        administration.devProtection,
        evidence.devProtection,
      ) ||
      !isDeepStrictEqual(
        administration.epicProtection,
        evidence.epicProtection,
      ) ||
      !isDeepStrictEqual(administration.mergeQueue, evidence.mergeQueue),
    "configuration_administration_detached",
  );
  add(
    failures,
    !isDeepStrictEqual(reads.broker[1], evidence.broker.app),
    "configuration_broker_detached",
  );
  add(
    failures,
    !isDeepStrictEqual(reads.caller[1], evidence.caller.app),
    "configuration_caller_detached",
  );
  return failures;
}
