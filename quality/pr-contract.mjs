import { markdownSections, validateIssueContract } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";

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

const requiredCheckboxesBySection = new Map([
  [
    "Product and architecture alignment",
    [
      "implemented contract version and fingerprint match",
      "change follows the Decision Addendum",
      "Existing Keiko material was used only after",
      "greenfield change creates no mandatory build-time or runtime dependency",
      "Product authority, policy, evidence, and privileged effects remain",
      "durable architecture change is recorded in an ADR",
    ],
  ],
  [
    "Acceptance journey evidence",
    [
      "Automated checks exercise user-visible outcomes",
      "Required failure, recovery, accessibility, visual, and platform observations",
    ],
  ],
  [
    "Quality Plan settlement",
    [
      "Applicable positive, negative, boundary, failure, cancellation, and recovery behavior",
      "actually wired production composition was tested",
      "Applicable security, accessibility, performance, resource, visual, and platform evidence",
      "Excluded quality areas retain the rationale",
      "Secrets, credentials, raw customer content, private endpoints, and PII are absent",
    ],
  ],
  [
    "Verification",
    [
      "`npm ci --ignore-scripts`",
      "`npm run quality`",
      "`npm audit --audit-level=high`",
      "Every declared native target-specific gate passed",
      "reviewed the complete diff against requirements",
    ],
  ],
  [
    "Independent audit and findings",
    [
      "Findings are evidence-cited",
      "Every confirmed finding is resolved",
      "Verification and audit were repeated",
    ],
  ],
  [
    "Delivery",
    [
      "target branch matches the delivery path",
      "Commits are signed and every required check",
      "Advisory tools are not treated as required merge authority",
      "Documentation, ADRs, contracts, known limitations, and follow-ups are current",
      "draft pull request was not promoted",
    ],
  ],
]);

const epicBranchCheckboxes = [
  "accepted issue authorizes this epic-branch target",
  "Acceptance and audit evidence is complete",
];

function labelsToNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) =>
    typeof label === "string" ? label : (label?.name ?? ""),
  );
}

function fieldValue(section, field) {
  if (typeof section !== "string") return undefined;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^- ${escaped}:\\s*(.+?)\\s*$`, "mu").exec(section)?.[1];
}

function optionValue(value) {
  return value?.replace(/^`|`$/gu, "").trim();
}

function issueNumberFromReference(value) {
  const candidate = optionValue(value) ?? "";
  const short = /^#([1-9][0-9]*)$/u.exec(candidate)?.[1];
  if (short !== undefined) return Number(short);
  const url =
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/([1-9][0-9]*)\/?$/u.exec(
      candidate,
    )?.[1];
  return url === undefined ? undefined : Number(url);
}

function readinessCommentReference(value) {
  const candidate = optionValue(value) ?? "";
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/u.exec(
      candidate,
    );
  if (match === null) return undefined;
  return {
    commentId: Number(match[3]),
    issueNumber: Number(match[2]),
    repository: match[1],
  };
}

function tableRows(section) {
  if (typeof section !== "string") return [];
  return section
    .split("\n")
    .filter((line) => /^\|.*\|\s*$/u.test(line))
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
  if (/<[^>\n]+>/u.test(body))
    failures.push("Template angle-bracket placeholders remain.");
  const proseOnly = body.replace(/```[\s\S]*?```/gu, "");
  if (/`[^`]*\|[^`]*`/u.test(proseOnly))
    failures.push("An unresolved inline option list remains.");
  if (logicalListItems(proseOnly).some((item) => /:\s*$/u.test(item)))
    failures.push("A required pull-request field is empty.");
  if (/```(?:text|bash|sh)?\s*\n\s*```/gu.test(body))
    failures.push("A verification evidence block is empty.");
  return failures;
}

function logicalListItems(body) {
  const items = [];
  let current;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const start = /^- (?!\[[ xX]\]\s)(.*)$/u.exec(line)?.[1];
    if (start !== undefined) {
      if (current !== undefined) items.push(current);
      current = start.trim();
      continue;
    }
    if (current !== undefined && /^\s{2,}\S/u.test(line)) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    if (current !== undefined) {
      items.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) items.push(current);
  return items;
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
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[\\/_-])${escaped}([\\/_-]|$)`, "u").test(source);
}

export function pullRequestIssueNumber(body) {
  const sections = markdownSections(typeof body === "string" ? body : "");
  return issueNumberFromReference(
    fieldValue(sections.get("Scope"), "Accepted issue"),
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
  for (const heading of requiredHeadings) {
    if (!sections.has(heading)) failures.push(`Missing section: ${heading}.`);
    else if (sections.get(heading) === undefined)
      failures.push(`Duplicate section: ${heading}.`);
    else if (sections.get(heading) === "")
      failures.push(`Empty section: ${heading}.`);
  }
  failures.push(...unresolvedPrFailures(body));

  const scope = sections.get("Scope");
  const acceptedIssueNumber = issueNumberFromReference(
    fieldValue(scope, "Accepted issue"),
  );
  const acceptedVersion = optionValue(
    fieldValue(scope, "Accepted planning-contract version"),
  );
  const recordReference = readinessCommentReference(
    fieldValue(scope, "Automated readiness record"),
  );
  const actualSource = optionValue(fieldValue(scope, "Actual source branch"));
  const acceptedTarget = optionValue(
    fieldValue(scope, "Accepted target branch"),
  );

  if (acceptedIssueNumber === undefined)
    failures.push(
      "Accepted issue must be #<number> or an exact GitHub issue URL.",
    );
  if (!/^v[1-9][0-9]*$/u.test(acceptedVersion ?? ""))
    failures.push(
      "Accepted planning-contract version must use v1, v2, and so on.",
    );
  if (recordReference === undefined)
    failures.push(
      "Automated readiness record must be an exact GitHub issue-comment URL.",
    );
  if (actualSource !== pullRequest?.head?.ref)
    failures.push(
      "Actual source branch does not match the pull-request head branch.",
    );
  if (acceptedTarget !== pullRequest?.base?.ref)
    failures.push(
      "Accepted target branch does not match the pull-request base branch.",
    );
  if (
    acceptedTarget !== "dev" &&
    !/^epic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(acceptedTarget ?? "")
  )
    failures.push(
      "Accepted target branch must be dev or a concrete epic branch.",
    );
  if (
    typeof actualSource === "string" &&
    acceptedIssueNumber !== undefined &&
    !sourceContainsIssueNumber(actualSource, acceptedIssueNumber)
  )
    failures.push("The source branch must include the accepted issue number.");

  const acceptance = sections.get("Acceptance criteria and evidence");
  if (!hasCompleteEvidenceRow(acceptance, /^AC[1-9][0-9]*\b/u))
    failures.push("Acceptance-criteria evidence has no complete result row.");

  const journey = sections.get("Acceptance journey evidence");
  failures.push(...applicabilityFailures(journey, "Acceptance Journey"));
  if (
    optionValue(fieldValue(journey, "Applicability")) === "Required" &&
    !hasCompleteEvidenceRow(journey, /^J[1-9][0-9]*(?:\.[1-9][0-9]*)?\b/u)
  )
    failures.push(
      "Required Acceptance Journey evidence has no complete result row.",
    );

  const integrated = sections.get("Integrated epic acceptance");
  failures.push(
    ...applicabilityFailures(integrated, "Integrated epic acceptance"),
  );

  for (const [heading, phrases] of requiredCheckboxesBySection) {
    const section = sections.get(heading) ?? "";
    for (const phrase of phrases) {
      if (!checkboxIsChecked(section, phrase))
        failures.push(
          `Required pull-request attestation is unchecked in ${heading}: ${phrase}.`,
        );
    }
  }
  if (
    typeof acceptedTarget === "string" &&
    acceptedTarget.startsWith("epic/")
  ) {
    for (const phrase of epicBranchCheckboxes) {
      if (!checkboxIsChecked(sections.get("Delivery") ?? "", phrase))
        failures.push(
          `Required epic-branch attestation is unchecked: ${phrase}.`,
        );
    }
  }

  if (issue === undefined) {
    failures.push("The accepted issue could not be loaded.");
    return { failures: [...new Set(failures)] };
  }
  if (acceptedIssueNumber !== issue.number)
    failures.push(
      "The loaded issue does not match the accepted issue reference.",
    );
  if (issue.state !== "open")
    failures.push("The accepted issue must remain open.");
  const issueLabels = labelsToNames(issue.labels);
  if (!issueLabels.includes("status: ready"))
    failures.push("The accepted issue is not status: ready.");
  if (
    issueLabels.some(
      (label) => label.startsWith("status: ") && label !== "status: ready",
    )
  )
    failures.push(
      "The accepted issue has a conflicting lifecycle status label.",
    );
  const issueValidation = validateIssueContract({
    body: issue.body,
    labels: issue.labels,
    title: issue.title,
  });
  for (const failure of issueValidation.failures)
    failures.push(`Accepted issue contract: ${failure}`);
  if (acceptedVersion !== issueValidation.version)
    failures.push(
      "The pull request cites a different planning-contract version.",
    );

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

  const target = issueDeliveryTarget(issue.body, issueValidation.kind);
  if (target !== pullRequest?.base?.ref)
    failures.push(
      "The pull-request target differs from the accepted issue delivery target.",
    );

  return { failures: [...new Set(failures)] };
}
