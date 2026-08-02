import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { githubRequestFor, githubSha256Subject } from "./github-api.mjs";
import {
  digestAuxiliaryIdentity,
  encodeAuxiliaryPreimage,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";
import {
  hasExactLifecycleStaticWorkflowGraph,
  lifecycleProtectedRunRef,
  lifecycleAnchorArtifactName,
  lifecycleAnchorSubject,
} from "./lifecycle-record-auth.mjs";

const BOT = Object.freeze({
  appId: 15368,
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const REPOSITORY = "oscharko-dev/Keiko-Native";
const CALLER_PATH = ".github/workflows/lifecycle-wakeup.yml";
const request = githubRequestFor("keiko-native-lifecycle-record-writer");

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(
      Object.keys(value).toSorted((left, right) => left.localeCompare(right)),
    ) ===
      JSON.stringify(
        [...keys].toSorted((left, right) => left.localeCompare(right)),
      )
  );
}

export function decodeLifecycleRecordPlan(encoded) {
  if (typeof encoded !== "string" || encoded.length > 64 * 1024)
    throw new TypeError("record plan is unavailable");
  let plan;
  try {
    plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("record plan is malformed");
  }
  if (
    !exactKeys(plan, ["issueNumber", "recordBody", "repository"]) ||
    plan.repository !== REPOSITORY ||
    !Number.isSafeInteger(plan.issueNumber) ||
    plan.issueNumber <= 0 ||
    typeof plan.recordBody !== "string"
  )
    throw new TypeError("record plan is invalid");
  const parsed = parseRecordEnvelope(plan.recordBody);
  if (
    parsed.fields.repository !== plan.repository ||
    parsed.fields.issue_number !== plan.issueNumber
  )
    throw new TypeError("record plan identity mismatch");
  return Object.freeze({ ...plan, parsed });
}

function trustedComment(comment, expectedBody) {
  return (
    Number.isSafeInteger(comment?.id) &&
    comment.id > 0 &&
    comment.body === expectedBody &&
    comment.user?.login === BOT.login &&
    comment.user?.id === BOT.id &&
    comment.user?.type === BOT.type &&
    comment.performed_via_github_app?.id === BOT.appId
  );
}

function anchorFields(plan, comment) {
  const fields = plan.parsed.fields;
  return {
    repository: plan.repository,
    issue_number: plan.issueNumber,
    record_type: plan.parsed.recordType,
    record_digest: plan.parsed.recordDigest,
    comment_id: comment.id,
    comment_body_sha256: createHash("sha256")
      .update(Buffer.from(comment.body, "utf8"))
      .digest("hex"),
    generation_identity: fields.generation_identity,
    attempt: fields.attempt,
    workflow_path: fields.workflow_path ?? fields.owner_workflow_path,
    workflow_run_id: fields.workflow_run_id ?? fields.owner_run_id,
    workflow_run_attempt:
      fields.workflow_run_attempt ?? fields.owner_run_attempt,
    protected_dev_sha: fields.protected_dev_sha,
  };
}

async function providerComment(plan, providerRequest) {
  const created = await providerRequest(
    `/repos/${plan.repository}/issues/${plan.issueNumber}/comments`,
    { method: "POST", payload: { body: plan.recordBody } },
  );
  if (!Number.isSafeInteger(created?.id) || created.id <= 0)
    throw new Error("record comment identity is invalid");
  const reread = await providerRequest(
    `/repos/${plan.repository}/issues/comments/${created.id}`,
  );
  if (!trustedComment(reread, plan.recordBody))
    throw new Error("record comment read-back mismatch");
  return reread;
}

function outputLines(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export async function prepareLifecycleRecordPublication({
  encodedPlan,
  outputDirectory,
  providerRequest = request,
}) {
  const plan = decodeLifecycleRecordPlan(encodedPlan);
  const comment = await providerComment(plan, providerRequest);
  const fields = anchorFields(plan, comment);
  const anchorBytes = encodeAuxiliaryPreimage("artifact anchor", fields);
  const anchorIdentity = digestAuxiliaryIdentity("artifact anchor", fields);
  const subject = lifecycleAnchorSubject(fields);
  await mkdir(outputDirectory, { recursive: true });
  const anchorPath = join(outputDirectory, "artifact-anchor.bin");
  const checksumsPath = join(outputDirectory, "anchor-subjects.txt");
  await writeFile(anchorPath, anchorBytes);
  await writeFile(checksumsPath, `${anchorIdentity}  ${subject}\n`, "utf8");
  return Object.freeze({
    anchorIdentity,
    anchorPath,
    artifactName: lifecycleAnchorArtifactName(plan.issueNumber),
    checksumsPath,
    commentId: comment.id,
    fields: Object.freeze(fields),
    subject,
  });
}

function exactArtifact(artifacts, prepared) {
  const matches = (artifacts?.artifacts ?? []).filter(
    (artifact) =>
      artifact.name === prepared.artifactName &&
      artifact.expired === false &&
      artifact.workflow_run?.id === prepared.fields.workflow_run_id,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function validatePreparedPublication(plan, prepared) {
  const preparedKeys = [
    "anchorIdentity",
    "anchorPath",
    "artifactName",
    "checksumsPath",
    "commentId",
    "fields",
    "subject",
  ];
  const fieldKeys = [
    "repository",
    "issue_number",
    "record_type",
    "record_digest",
    "comment_id",
    "comment_body_sha256",
    "generation_identity",
    "attempt",
    "workflow_path",
    "workflow_run_id",
    "workflow_run_attempt",
    "protected_dev_sha",
  ];
  if (
    !exactKeys(prepared, preparedKeys) ||
    !exactKeys(prepared.fields, fieldKeys) ||
    !Number.isSafeInteger(prepared.commentId) ||
    prepared.commentId <= 0 ||
    !Number.isSafeInteger(prepared.fields.workflow_run_id) ||
    prepared.fields.workflow_run_id <= 0 ||
    !/^[0-9a-f]{64}$/u.test(prepared.anchorIdentity ?? "") ||
    typeof prepared.anchorPath !== "string" ||
    typeof prepared.checksumsPath !== "string"
  )
    throw new TypeError("prepared lifecycle publication is invalid");
  const expectedFields = anchorFields(plan, {
    body: plan.recordBody,
    id: prepared.commentId,
  });
  if (
    !isDeepStrictEqual(prepared.fields, expectedFields) ||
    prepared.artifactName !== lifecycleAnchorArtifactName(plan.issueNumber) ||
    prepared.anchorIdentity !==
      digestAuxiliaryIdentity("artifact anchor", expectedFields) ||
    prepared.subject !== lifecycleAnchorSubject(expectedFields)
  )
    throw new TypeError("prepared lifecycle publication identity mismatch");
  return prepared;
}

export async function verifyLifecycleRecordPublication({
  encodedPlan,
  prepared,
  providerRequest = request,
}) {
  const plan = decodeLifecycleRecordPlan(encodedPlan);
  validatePreparedPublication(plan, prepared);
  const comment = await providerRequest(
    `/repos/${plan.repository}/issues/comments/${prepared.commentId}`,
  );
  if (!trustedComment(comment, plan.recordBody))
    throw new Error("record comment final read-back mismatch");
  const artifacts = await providerRequest(
    `/repos/${plan.repository}/actions/runs/${prepared.fields.workflow_run_id}/artifacts?per_page=100`,
  );
  if (exactArtifact(artifacts, prepared) === undefined)
    throw new Error("record anchor artifact unavailable");
  const attestationSubject = githubSha256Subject(prepared.anchorIdentity);
  const attestations = await providerRequest(
    `/repos/${plan.repository}/attestations/${attestationSubject}`,
  );
  if (
    !Array.isArray(attestations?.attestations) ||
    attestations.attestations.length !== 1
  )
    throw new Error("record anchor attestation unavailable");
  const run = await providerRequest(
    `/repos/${plan.repository}/actions/runs/${prepared.fields.workflow_run_id}`,
  );
  if (
    run?.id !== prepared.fields.workflow_run_id ||
    run?.run_attempt !== prepared.fields.workflow_run_attempt ||
    lifecycleProtectedRunRef(run, prepared.fields.protected_dev_sha) !==
      "refs/heads/dev" ||
    run?.path !== CALLER_PATH ||
    !hasExactLifecycleStaticWorkflowGraph(
      run?.referenced_workflows,
      plan.repository,
      prepared.fields.protected_dev_sha,
    )
  )
    throw new Error("record writer run mismatch");
  return Object.freeze({
    artifactAnchorIdentity: prepared.anchorIdentity,
    commentId: prepared.commentId,
    outcome: plan.parsed.fields.outcome ?? "recorded",
    recordDigest: plan.parsed.recordDigest,
  });
}

async function prepareCli(encodedPlan, githubOutput, outputDirectory) {
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan,
    outputDirectory,
  });
  await writeFile(
    join(outputDirectory, "prepared.json"),
    JSON.stringify(prepared),
    "utf8",
  );
  await appendFile(
    githubOutput,
    outputLines({
      "anchor-identity": prepared.anchorIdentity,
      "anchor-path": prepared.anchorPath,
      "comment-id": prepared.commentId,
      "subject-checksums": prepared.checksumsPath,
    }),
    "utf8",
  );
}

async function verifyCli(encodedPlan, githubOutput, outputDirectory) {
  const prepared = JSON.parse(
    await readFile(join(outputDirectory, "prepared.json"), "utf8"),
  );
  const result = await verifyLifecycleRecordPublication({
    encodedPlan,
    prepared,
  });
  await appendFile(
    githubOutput,
    `observation=${Buffer.from(JSON.stringify(result)).toString("base64url")}\n`,
    "utf8",
  );
}

export async function runLifecycleRecordWriterCli(command = process.argv[2]) {
  const encodedPlan = process.env.KEIKO_LIFECYCLE_RECORD_PLAN;
  const githubOutput = process.env.GITHUB_OUTPUT;
  const outputDirectory = join(
    process.env.RUNNER_TEMP ?? process.cwd(),
    "keiko-lifecycle-anchor",
  );
  if (typeof githubOutput !== "string" || githubOutput === "")
    throw new Error("GITHUB_OUTPUT is required");
  if (command === "prepare")
    return prepareCli(encodedPlan, githubOutput, outputDirectory);
  if (command === "verify")
    return verifyCli(encodedPlan, githubOutput, outputDirectory);
  throw new Error("unknown lifecycle record writer command");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await runLifecycleRecordWriterCli();
