import {
  inheritedWorkflowControlFailures,
  workflowJobs,
  workflowStepShapeFailures,
} from "./workflow-structure.mjs";

const requiredMarkers = [
  "name: Internal macOS release",
  "pull_request:",
  "workflow_dispatch:",
  "- epic/9-foundation-v0.1",
  "runs-on: macos-14",
  "runs-on: macos-26",
  "npm run release:verify",
  "subject-checksums: ${{ runner.temp }}/release-subjects.txt",
  "create-storage-record: false",
  "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "retention-days: 14",
  "gh attestation verify",
  "--deny-self-hosted-runners",
  "--signer-digest",
  "--signer-workflow",
  "--source-digest",
  "--source-ref",
  "--predicate-type https://oscharko.dev/keiko-native/internal-release/v1",
  "node quality/attestation-policy.mjs",
  "--verify-only",
  '--expected-head "$RELEASE_REVISION"',
];

const prohibitedMarkers = [
  "pull_request_target:",
  "push:",
  "contents: write",
  "release: write",
  "releases: write",
  "packages: write",
  "actions: write",
  "checks: write",
  "issues: write",
  "pull-requests: write",
  "security-events: write",
  "environment:",
  "APPLE_",
  "notary",
  "staple",
  "refs/tags/",
];

const expectedPermissions = Object.freeze({
  build: Object.freeze({
    attestations: "write",
    contents: "read",
    "id-token": "write",
  }),
  verify: Object.freeze({ contents: "read" }),
});
const expectedWorkflowSha256 =
  "f00cad8153d0a476cfc924d97e30676be61919fbce3a0259d820d7da555d72bd";

export function internalReleaseWorkflowFailures(workflow) {
  if (typeof workflow !== "string") return ["release-workflow-source"];
  const canonical = workflow.replaceAll("\r", "");
  const semantic = uncommentWorkflow(canonical);
  const failures = [
    ...(createHash("sha256").update(canonical).digest("hex") ===
    expectedWorkflowSha256
      ? []
      : ["release-workflow-allowlist"]),
    ...requiredMarkers
      .filter((marker) => !semantic.includes(marker))
      .map((marker) => `release-workflow-marker:${marker}`),
    ...prohibitedMarkers
      .filter((marker) => semantic.includes(marker))
      .map((marker) => `release-workflow-prohibited:${marker}`),
  ];
  failures.push(...permissionFailures(semantic));
  failures.push(...inheritedWorkflowControlFailures(semantic));
  failures.push(...workflowStepShapeFailures(semantic));
  failures.push(...stepControlFailures(semantic));
  failures.push(...stepEnvironmentFailures(semantic));
  failures.push(...structureFailures(semantic));
  return failures;
}

function stepEnvironmentFailures(workflow) {
  const allowed = new Set([
    JSON.stringify({
      PULL_REQUEST_HEAD: "${{ github.event.pull_request.head.sha }}",
    }),
    JSON.stringify({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_REVISION: "${{ steps.identity.outputs.revision }}",
      SOURCE_DIGEST: "${{ github.sha }}",
      SOURCE_REF: "${{ github.ref }}",
      WORKFLOW_DIGEST: "${{ github.workflow_sha }}",
    }),
    JSON.stringify({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_REVISION: "${{ needs.build.outputs.revision }}",
      SOURCE_DIGEST: "${{ github.sha }}",
      SOURCE_REF: "${{ github.ref }}",
      WORKFLOW_DIGEST: "${{ github.workflow_sha }}",
    }),
    JSON.stringify({
      RELEASE_REVISION: "${{ needs.build.outputs.revision }}",
    }),
  ]);
  const environments = workflowJobs(workflow).flatMap(({ steps }) =>
    steps.flatMap((step) => parseStepEnvironment(step)),
  );
  return environments.some(
    (environment) => !allowed.has(JSON.stringify(environment)),
  )
    ? ["release-workflow-step-environment"]
    : [];
}

function parseStepEnvironment(step) {
  const lines = step.split("\n");
  const indexes = lines.flatMap((line, index) =>
    /^        env:/u.test(line) ? [index] : [],
  );
  if (indexes.length === 0) return [];
  if (indexes.length !== 1 || !/^        env:\s*$/u.test(lines[indexes[0]]))
    return [{ invalid: "shape" }];
  const [index] = indexes;
  const entries = {};
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const entry = indentedEnvironmentEntry(lines[cursor]);
    if (!entry) break;
    if (entries[entry.key] !== undefined) return [{ invalid: "duplicate" }];
    entries[entry.key] = entry.value;
  }
  return [entries];
}

function indentedEnvironmentEntry(line) {
  if (!line.startsWith("          ") || line[10] === " ") return undefined;
  const content = line.slice(10);
  const separator = content.indexOf(":");
  if (separator < 1) return undefined;
  const key = content.slice(0, separator);
  const value = content.slice(separator + 1).trimStart();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || !value) return undefined;
  return { key, value };
}

function stepControlFailures(workflow) {
  const prohibited = /^(?:continue-on-error|if|shell|working-directory):/u;
  return workflowJobs(workflow).some(({ steps }) =>
    steps.some((step) =>
      step
        .split("\n")
        .some((line) => prohibited.test(line.slice(8).trimStart())),
    ),
  )
    ? ["release-workflow-step-control"]
    : [];
}

function permissionFailures(workflow) {
  const failures = [];
  const root = permissionMapping(workflow, 0);
  if (!root.valid || Object.keys(root.entries).length !== 0)
    failures.push("release-workflow-root-permissions");
  const jobs = workflowJobs(workflow);
  if (
    jobs.length !== 2 ||
    jobs.some(({ id }) => expectedPermissions[id] === undefined)
  )
    failures.push("release-workflow-jobs");
  for (const { id, source } of jobs) {
    const actual = permissionMapping(source, 4);
    if (
      !actual.valid ||
      JSON.stringify(actual.entries) !==
        JSON.stringify(expectedPermissions[id] ?? null)
    )
      failures.push(`release-workflow-permissions:${id}`);
  }
  return failures;
}

function permissionMapping(source, indentation) {
  const lines = source.split("\n");
  const prefix = " ".repeat(indentation);
  const matches = lines.flatMap((line, index) => {
    if (!line.startsWith(prefix) || line[indentation] === " ") return [];
    const content = line.slice(indentation);
    if (!content.startsWith("permissions:")) return [];
    return [{ index, value: content.slice("permissions:".length).trim() }];
  });
  if (matches.length !== 1) return { entries: {}, valid: false };
  const [{ index, value }] = matches;
  if (value === "{}") return { entries: {}, valid: true };
  if (value) return { entries: {}, valid: false };
  const entries = {};
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim()) continue;
    const width = /^ */u.exec(line)[0].length;
    if (width <= indentation) break;
    const match = new RegExp(
      `^ {${indentation + 2}}([A-Za-z][A-Za-z0-9-]*):\\s*(read|write|none)\\s*$`,
      "u",
    ).exec(line);
    if (!match || entries[match[1]] !== undefined)
      return { entries, valid: false };
    entries[match[1]] = match[2];
  }
  return { entries, valid: Object.keys(entries).length > 0 };
}

function structureFailures(workflow) {
  const failures = [];
  const actionReferences = [
    ...workflow.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/gu),
  ];
  if (
    actionReferences.length === 0 ||
    actionReferences.some((match) =>
      match[1].startsWith("./") ? false : !/^[0-9a-f]{40}$/u.test(match[2]),
    )
  )
    failures.push("release-workflow-action-pin");
  const verify = workflow.indexOf("npm run release:verify");
  const attest = workflow.indexOf("actions/attest@");
  const upload = workflow.indexOf("actions/upload-artifact@");
  if (!(verify >= 0 && verify < attest && attest < upload))
    failures.push("release-workflow-order");
  if (
    !workflow.includes(
      "name: keiko-native-internal-${{ steps.identity.outputs.revision }}",
    ) ||
    !workflow.includes("ref: ${{ steps.identity.outputs.revision }}")
  )
    failures.push("release-workflow-head-binding");
  return failures;
}

function uncommentWorkflow(workflow) {
  return workflow
    .split("\n")
    .map((line) => uncommentLine(line))
    .join("\n");
}

function uncommentLine(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote && (quote === "'" || line[index - 1] !== "\\"))
        quote = "";
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#") return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}
import { createHash } from "node:crypto";
