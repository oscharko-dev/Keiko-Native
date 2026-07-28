import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";

const operationIdentity = (value) =>
  typeof value === "string" && /^op_[0-9a-f]{64}$/u.test(value);
const claimIdentity = (value) =>
  typeof value === "string" && /^clm_[0-9a-f]{64}$/u.test(value);
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(
    Object.keys(value).toSorted(compareCodeUnits),
    keys.toSorted(compareCodeUnits),
  );

function validPreparation(input) {
  const { claim, operation } = input ?? {};
  return (
    exactKeys(input, ["claim", "operation"]) &&
    exactKeys(claim, [
      "base",
      "claimId",
      "key",
      "operationId",
      "repository",
      "state",
      "target",
    ]) &&
    claimIdentity(claim.claimId) &&
    operationIdentity(claim.operationId) &&
    digest(claim.key) &&
    claim.state === "claimed" &&
    exactKeys(operation, [
      "base",
      "claimId",
      "contractFingerprint",
      "contractVersion",
      "createdAt",
      "evidenceDigest",
      "head",
      "headTree",
      "issue",
      "mode",
      "operationId",
      "pullRequest",
      "policyDigest",
      "policyRevision",
      "policyState",
      "repository",
      "requestId",
      "source",
      "state",
      "submitted",
      "target",
    ]) &&
    operation.operationId === claim.operationId &&
    operation.claimId === claim.claimId &&
    operation.base === claim.base &&
    operation.repository === claim.repository &&
    operation.target === claim.target &&
    operation.state === "prepared" &&
    operation.submitted === false &&
    typeof operation.source === "string"
  );
}

function parse(row, key) {
  return row === undefined ? null : JSON.parse(row[key]);
}

function rollback(database) {
  try {
    database.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

export function createEpicMergeOperationStore(path) {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS epic_operations (
      operation_id TEXT PRIMARY KEY,
      claim_key TEXT NOT NULL,
      claim_json TEXT NOT NULL,
      operation_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS epic_active_claims (
      claim_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS epic_settlements (
      operation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      settlement_json TEXT NOT NULL,
      PRIMARY KEY (operation_id, sequence)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS epic_submissions (
      operation_id TEXT PRIMARY KEY,
      submission_json TEXT NOT NULL
    ) STRICT;
  `);
  const operationById = database.prepare(
    "SELECT claim_json, operation_json FROM epic_operations WHERE operation_id = ?",
  );
  const settlementById = database.prepare(
    "SELECT settlement_json FROM epic_settlements WHERE operation_id = ? ORDER BY sequence DESC LIMIT 1",
  );
  const settlementsById = database.prepare(
    "SELECT settlement_json FROM epic_settlements WHERE operation_id = ? ORDER BY sequence",
  );
  const submissionById = database.prepare(
    "SELECT submission_json FROM epic_submissions WHERE operation_id = ?",
  );
  const activeClaimByOperation = database.prepare(
    "SELECT operation_id FROM epic_active_claims WHERE operation_id = ?",
  );

  function prepareOperation(input) {
    if (!validPreparation(input)) return { state: "invalid" };
    database.exec("BEGIN IMMEDIATE");
    try {
      if (operationById.get(input.operation.operationId) !== undefined) {
        database.exec("ROLLBACK");
        return { state: "replayed" };
      }
      const active = database
        .prepare(
          "SELECT operation_id FROM epic_active_claims WHERE claim_key = ?",
        )
        .get(input.claim.key);
      if (active !== undefined) {
        database.exec("ROLLBACK");
        return { state: "contended" };
      }
      database
        .prepare("INSERT INTO epic_operations VALUES (?, ?, ?, ?)")
        .run(
          input.operation.operationId,
          input.claim.key,
          JSON.stringify(input.claim),
          JSON.stringify(input.operation),
        );
      database
        .prepare("INSERT INTO epic_active_claims VALUES (?, ?)")
        .run(input.claim.key, input.operation.operationId);
      database.exec("COMMIT");
      return structuredClone({ ...input, state: "prepared" });
    } catch (error) {
      if (!rollback(database))
        throw new Error("epic_merge_store_rollback_failed");
      throw error;
    }
  }

  function readPreparation(operationId) {
    if (!operationIdentity(operationId)) return null;
    const row = operationById.get(operationId);
    if (row === undefined) return null;
    return {
      claim: parse(row, "claim_json"),
      operation: parse(row, "operation_json"),
      state: "prepared",
    };
  }

  function readOperation(operationId) {
    const prepared = readPreparation(operationId);
    if (prepared === null) return null;
    const settlement = parse(
      settlementById.get(operationId),
      "settlement_json",
    );
    const submitted = submissionById.get(operationId) !== undefined;
    return {
      ...prepared.operation,
      state: settlement?.result ?? (submitted ? "submitted" : "prepared"),
      submitted,
    };
  }

  function markOperationSubmitted(submission) {
    if (
      !exactKeys(submission, ["claimId", "operationId", "state"]) ||
      !claimIdentity(submission.claimId) ||
      !operationIdentity(submission.operationId) ||
      submission.state !== "submitted"
    )
      return { submitted: false };
    database.exec("BEGIN IMMEDIATE");
    try {
      const operation = operationById.get(submission.operationId);
      const claim = parse(operation, "claim_json");
      if (
        operation === undefined ||
        claim?.claimId !== submission.claimId ||
        activeClaimByOperation.get(submission.operationId) === undefined ||
        submissionById.get(submission.operationId) !== undefined ||
        settlementById.get(submission.operationId) !== undefined
      ) {
        database.exec("ROLLBACK");
        return { submitted: false };
      }
      database
        .prepare("INSERT INTO epic_submissions VALUES (?, ?)")
        .run(submission.operationId, JSON.stringify(submission));
      database.exec("COMMIT");
      return { submitted: true };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function readSettlements(operationId) {
    if (!operationIdentity(operationId)) return [];
    return settlementsById
      .all(operationId)
      .map((row) => parse(row, "settlement_json"));
  }

  function settleOperation(settlement) {
    if (
      !exactKeys(
        settlement,
        settlement?.result === "merged"
          ? [
              "claimId",
              "mergeCommit",
              "operationId",
              "releaseSerialization",
              "result",
            ]
          : ["claimId", "operationId", "releaseSerialization", "result"],
      ) ||
      !claimIdentity(settlement.claimId) ||
      !operationIdentity(settlement.operationId) ||
      (settlement.result === "merged" &&
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(settlement.mergeCommit)) ||
      !["cancelled", "indeterminate", "merged", "rejected"].includes(
        settlement.result,
      ) ||
      typeof settlement.releaseSerialization !== "boolean" ||
      (settlement.result === "indeterminate" &&
        settlement.releaseSerialization !== false)
    )
      return { settled: false };
    database.exec("BEGIN IMMEDIATE");
    try {
      const operation = operationById.get(settlement.operationId);
      const claim = parse(operation, "claim_json");
      if (
        operation === undefined ||
        claim?.claimId !== settlement.claimId ||
        settlementById.get(settlement.operationId) !== undefined
      ) {
        database.exec("ROLLBACK");
        return { settled: false };
      }
      database
        .prepare("INSERT INTO epic_settlements VALUES (?, 1, ?)")
        .run(settlement.operationId, JSON.stringify(settlement));
      if (settlement.releaseSerialization)
        database
          .prepare("DELETE FROM epic_active_claims WHERE operation_id = ?")
          .run(settlement.operationId);
      database.exec("COMMIT");
      return { settled: true };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function settleReconciliation(settlement) {
    const merged = settlement?.result === "merged";
    if (
      !exactKeys(
        settlement,
        merged
          ? [
              "claimId",
              "from",
              "mergeCommit",
              "operationId",
              "releaseSerialization",
              "result",
            ]
          : [
              "claimId",
              "from",
              "operationId",
              "releaseSerialization",
              "result",
            ],
      ) ||
      !claimIdentity(settlement.claimId) ||
      !operationIdentity(settlement.operationId) ||
      !["prepared", "submitted", "indeterminate"].includes(settlement.from) ||
      !["cancelled", "merged"].includes(settlement.result) ||
      settlement.releaseSerialization !== true ||
      (merged &&
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(settlement.mergeCommit))
    )
      return { settled: false };
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = operationById.get(settlement.operationId);
      const claim = parse(row, "claim_json");
      const latest = parse(
        settlementById.get(settlement.operationId),
        "settlement_json",
      );
      const submitted =
        submissionById.get(settlement.operationId) !== undefined;
      const state = latest?.result ?? (submitted ? "submitted" : "prepared");
      const permitted =
        settlement.from === state &&
        ((merged &&
          submitted &&
          ["submitted", "indeterminate"].includes(state)) ||
          (!merged &&
            !submitted &&
            ["prepared", "indeterminate"].includes(state)));
      if (
        row === undefined ||
        claim?.claimId !== settlement.claimId ||
        activeClaimByOperation.get(settlement.operationId) === undefined ||
        !permitted
      ) {
        database.exec("ROLLBACK");
        return { settled: false };
      }
      const sequence = latest === null ? 1 : 2;
      database
        .prepare("INSERT INTO epic_settlements VALUES (?, ?, ?)")
        .run(settlement.operationId, sequence, JSON.stringify(settlement));
      database
        .prepare("DELETE FROM epic_active_claims WHERE operation_id = ?")
        .run(settlement.operationId);
      database.exec("COMMIT");
      return { settled: true };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  return {
    close: () => database.close(),
    markOperationSubmitted,
    prepareOperation,
    readOperation,
    readPreparation,
    readSettlements,
    settleOperation,
    settleReconciliation,
  };
}
