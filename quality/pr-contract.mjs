import { markdownSections, validateIssueContract } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import {
  issueNumberFromReference,
  readinessCommentReference,
} from "./github-reference.mjs";
import {
  fieldValue,
  hasAnglePlaceholder,
  hasInlineOptionList,
  logicalListItems,
  markdownLines,
  splitFencedMarkdown,
} from "./markdown-contract.mjs";

const requiredHeadings = [
  "Scope",
  "Product and architecture alignment",
  "Acceptance criteria and evidence",
  "Acceptance journey evidence",
  "Quality Plan settlement",
  "Verification",
  "Independent audit and findings",
  "Integrated epic acceptance",
  "Delivery",
  "Residual risks and follow-ups",
];

const requiredCheckboxesBySection = new Map(
  Object.entries({
    "Acceptance journey evidence":
      "Automated checks exercise user-visible outcomes|Required failure, recovery, accessibility, visual, and platform observations",
    Delivery:
      "target branch matches the delivery path|Commits are signed and every required check|Advisory tools are not treated as required merge authority|Documentation, ADRs, contracts, known limitations, and follow-ups are current|draft pull request was not promoted",
    "Independent audit and findings":
      "Findings are evidence-cited|Every confirmed finding is resolved|Verification and audit were repeated",
    "Product and architecture alignment":
      "implemented contract version and fingerprint match|change follows the Decision Addendum|Existing Keiko material was used only after|greenfield change creates no mandatory build-time or runtime dependency|Product authority, policy, evidence, and privileged effects remain|durable architecture change is recorded in an ADR",
    "Quality Plan settlement":
      "Applicable positive, negative, boundary, failure, cancellation, and recovery behavior|actually wired production composition was tested|Applicable security, accessibility, performance, resource, visual, and platform evidence|Excluded quality areas retain the rationale|Secrets, credentials, raw customer content, private endpoints, and PII are absent",
    Verification:
      "`npm ci --ignore-scripts`|`npm run quality`|`npm audit --audit-level=high`|Every declared native target-specific gate passed|reviewed the complete diff against requirements",
  }).map(([section, checks]) => [section, checks.split("|")]),
);

const epicBranchCheckboxes = [
  "accepted issue authorizes this epic-branch target",
  "Acceptance and audit evidence is complete",
];
const deliveryEligibleLifecycleStates = new Set([
  "status: pr open",
  "status: ready for human review",
]);

function labelsToNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) =>
    typeof label === "string" ? label : (label?.name ?? ""),
  );
}

function optionValue(value) {
  return value?.replace(/^`|`$/gu, "").trim();
}

function tableRows(section) {
  if (typeof section !== "string") return [];
  return markdownLines(section)
    .filter((line) => line.startsWith("|") && line.trimEnd().endsWith("|"))
    .map((line) =>
      line
        .slice(line.indexOf("|") + 1, line.lastIndexOf("|"))
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/u.test(cell)));
}

function hasCompleteEvidenceRow(section, firstCell) {
  return tableRows(section).some(
    (cells) =>
      cells.length >= 4 &&
      firstCell.test(cells[0]) &&
      cells.slice(0, 4).every((cell) => cell.length > 0),
  );
}

function checkboxIsChecked(body, phrase) {
  return body
    .split("\n")
    .some(
      (line) =>
        /^- \[[xX]\]\s+/u.test(line) &&
        line.toLowerCase().includes(phrase.toLowerCase()),
    );
}

function unresolvedPrFailures(body) {
  const failures = [];
  if (hasAnglePlaceholder(body))
    failures.push("Template angle-bracket placeholders remain.");
  const { blocks, prose: proseOnly } = splitFencedMarkdown(body);
  if (hasInlineOptionList(proseOnly))
    failures.push("An unresolved inline option list remains.");
  if (logicalListItems(proseOnly).some((item) => /:\s*$/u.test(item)))
    failures.push("A required pull-request field is empty.");
  if (blocks.some((block) => block.trim() === ""))
    failures.push("A verification evidence block is empty.");
  return failures;
}

function applicabilityFailures(section, name) {
  const applicability = optionValue(fieldValue(section, "Applicability"));
  if (applicability === "Required") return [];
  if (
    applicability?.startsWith("Not applicable") &&
    applicability.length >= "Not applicable — rationale".length
  )
    return [];
  return [
    `${name} applicability must be Required or a reasoned Not applicable value.`,
  ];
}

function issueDeliveryTarget(issueBody, kind) {
  const sections = markdownSections(issueBody);
  const value =
    kind === "epic"
      ? fieldValue(sections.get("Planning contract"), "Final delivery target")
      : fieldValue(
          sections.get("Execution Authority"),
          "Exact delivery target",
        );
  return optionValue(value);
}

function sourceContainsIssueNumber(source, issueNumber) {
  return source.split(/[/_-]/u).includes(String(issueNumber));
}

function requiredSectionFailures(sections) {
  return requiredHeadings.flatMap((heading) => {
    if (!sections.has(heading)) return [`Missing section: ${heading}.`];
    if (sections.get(heading) === undefined)
      return [`Duplicate section: ${heading}.`];
    return sections.get(heading) === "" ? [`Empty section: ${heading}.`] : [];
  });
}

function pullRequestScope(sections) {
  const scope = sections.get("Scope");
  return {
    acceptedIssueNumber: issueNumberFromReference(
      optionValue(fieldValue(scope, "Accepted issue")),
    ),
    acceptedTarget: optionValue(fieldValue(scope, "Accepted target branch")),
    acceptedVersion: optionValue(
      fieldValue(scope, "Accepted planning-contract version"),
    ),
    actualSource: optionValue(fieldValue(scope, "Actual source branch")),
    recordReference: readinessCommentReference(
      optionValue(fieldValue(scope, "Automated readiness record")),
    ),
  };
}

function scopeContractFailures(scope, pullRequest) {
  const failures = [];
  if (scope.acceptedIssueNumber === undefined)
    failures.push(
      "Accepted issue must be #<number> or an exact GitHub issue URL.",
    );
  if (!/^v[1-9]\d*$/u.test(scope.acceptedVersion ?? ""))
    failures.push(
      "Accepted planning-contract version must use v1, v2, and so on.",
    );
  if (scope.recordReference === undefined)
    failures.push(
      "Automated readiness record must be an exact GitHub issue-comment URL.",
    );
  if (scope.actualSource !== pullRequest?.head?.ref)
    failures.push(
      "Actual source branch does not match the pull-request head branch.",
    );
  if (scope.acceptedTarget !== pullRequest?.base?.ref)
    failures.push(
      "Accepted target branch does not match the pull-request base branch.",
    );
  if (
    scope.acceptedTarget !== "dev" &&
    !/^epic\/[A-Za-z\d][A-Za-z\d._/-]*$/u.test(scope.acceptedTarget ?? "")
  )
    failures.push(
      "Accepted target branch must be dev or a concrete epic branch.",
    );
  if (
    typeof scope.actualSource === "string" &&
    scope.acceptedIssueNumber !== undefined &&
    !sourceContainsIssueNumber(scope.actualSource, scope.acceptedIssueNumber)
  )
    failures.push("The source branch must include the accepted issue number.");
  return failures;
}

function evidenceFailures(sections) {
  const failures = [];
  if (
    !hasCompleteEvidenceRow(
      sections.get("Acceptance criteria and evidence"),
      /^AC[1-9]\d*\b/u,
    )
  )
    failures.push("Acceptance-criteria evidence has no complete result row.");

  const journey = sections.get("Acceptance journey evidence");
  failures.push(...applicabilityFailures(journey, "Acceptance Journey"));
  if (
    optionValue(fieldValue(journey, "Applicability")) === "Required" &&
    !hasCompleteEvidenceRow(journey, /^J[1-9]\d*(?:\.[1-9]\d*)?\b/u)
  )
    failures.push(
      "Required Acceptance Journey evidence has no complete result row.",
    );
  failures.push(
    ...applicabilityFailures(
      sections.get("Integrated epic acceptance"),
      "Integrated epic acceptance",
    ),
  );
  return failures;
}

function attestationFailures(sections, acceptedTarget) {
  const requiredFailures = [...requiredCheckboxesBySection].flatMap(
    ([heading, phrases]) =>
      phrases
        .filter(
          (phrase) => !checkboxIsChecked(sections.get(heading) ?? "", phrase),
        )
        .map(
          (phrase) =>
            `Required pull-request attestation is unchecked in ${heading}: ${phrase}.`,
        ),
  );
  const epicFailures = acceptedTarget?.startsWith("epic/")
    ? epicBranchCheckboxes
        .filter(
          (phrase) =>
            !checkboxIsChecked(sections.get("Delivery") ?? "", phrase),
        )
        .map(
          (phrase) =>
            `Required epic-branch attestation is unchecked: ${phrase}.`,
        )
    : [];
  return [...requiredFailures, ...epicFailures];
}

function acceptedIssueFailures(issue, acceptedIssueNumber, acceptedVersion) {
  const failures = [];
  if (acceptedIssueNumber !== issue.number)
    failures.push(
      "The loaded issue does not match the accepted issue reference.",
    );
  if (issue.state !== "open")
    failures.push("The accepted issue must remain open.");
  const issueLabels = labelsToNames(issue.labels);
  const lifecycleLabels = issueLabels.filter((label) =>
    label.startsWith("status: "),
  );
  if (lifecycleLabels.length !== 1)
    failures.push(
      "The accepted issue must have exactly one lifecycle status label.",
    );
  else if (!deliveryEligibleLifecycleStates.has(lifecycleLabels[0]))
    failures.push("The accepted issue lifecycle is not pull-request eligible.");
  const validation = validateIssueContract({
    body: issue.body,
    labels: issue.labels,
    title: issue.title,
  });
  failures.push(
    ...validation.failures.map(
      (failure) => `Accepted issue contract: ${failure}`,
    ),
  );
  if (acceptedVersion !== validation.version)
    failures.push(
      "The pull request cites a different planning-contract version.",
    );
  return { failures, validation };
}

function readinessFailures({
  comments,
  issue,
  issueValidation,
  recordReference,
  repository,
}) {
  const failures = [];
  const latestRecord = readinessRecordFromComments(
    Array.isArray(comments) ? comments : [],
  );
  if (
    latestRecord?.status !== "accepted" ||
    latestRecord.version !== issueValidation.version ||
    latestRecord.fingerprint !== issueValidation.fingerprint
  )
    failures.push(
      "The issue does not have a current matching accepted readiness record.",
    );
  if (
    recordReference !== undefined &&
    (recordReference.repository.toLowerCase() !== repository?.toLowerCase() ||
      recordReference.issueNumber !== issue.number ||
      recordReference.commentId !== latestRecord?.commentId)
  )
    failures.push(
      "The cited readiness URL is not the latest matching readiness record.",
    );
  return failures;
}

export function pullRequestIssueNumber(body) {
  const sections = markdownSections(typeof body === "string" ? body : "");
  return issueNumberFromReference(
    optionValue(fieldValue(sections.get("Scope"), "Accepted issue")),
  );
}

export function validatePullRequestContract({
  comments,
  issue,
  pullRequest,
  repository,
}) {
  const failures = [];
  const body = pullRequest?.body;
  if (
    typeof pullRequest?.title !== "string" ||
    pullRequest.title.trim().length < 8
  )
    failures.push("Pull-request title is missing or not descriptive.");
  if (typeof body !== "string" || body.trim() === "")
    return { failures: [...failures, "Pull-request body is empty."] };

  const sections = markdownSections(body);
  const scope = pullRequestScope(sections);
  failures.push(
    ...requiredSectionFailures(sections),
    ...unresolvedPrFailures(body),
    ...scopeContractFailures(scope, pullRequest),
    ...evidenceFailures(sections),
    ...attestationFailures(sections, scope.acceptedTarget),
  );

  if (issue === undefined) {
    failures.push("The accepted issue could not be loaded.");
    return { failures: [...new Set(failures)] };
  }
  const issueContract = acceptedIssueFailures(
    issue,
    scope.acceptedIssueNumber,
    scope.acceptedVersion,
  );
  failures.push(
    ...issueContract.failures,
    ...readinessFailures({
      comments,
      issue,
      issueValidation: issueContract.validation,
      recordReference: scope.recordReference,
      repository,
    }),
  );

  const target = issueDeliveryTarget(issue.body, issueContract.validation.kind);
  if (target !== pullRequest?.base?.ref)
    failures.push(
      "The pull-request target differs from the accepted issue delivery target.",
    );

  return { failures: [...new Set(failures)] };
}
