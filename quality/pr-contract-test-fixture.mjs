import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessComment } from "./issue-readiness-action.mjs";

const taskHeadings = [
  "Planning contract",
  "Purpose and observable outcome",
  "Acceptance journey",
  "Change classification and planning authority",
  "Scope",
  "Execution Authority",
  "Planning and architecture alignment",
  "Interface contracts",
  "Quality Plan",
  "Acceptance criteria",
  "Verification commands",
  "Audit plan",
  "Definition of Ready",
  "Completion and review settlement",
  "Stop conditions",
];

const attestations = new Map([
  [
    "Product and architecture alignment",
    [
      "The implemented contract version and fingerprint match the automated readiness record.",
      "The change follows the Decision Addendum.",
      "Existing Keiko material was used only after a recorded Reuse Assessment.",
      "This greenfield change creates no mandatory build-time or runtime dependency.",
      "Product authority, policy, evidence, and privileged effects remain in their owning layer.",
      "Any durable architecture change is recorded in an ADR.",
    ],
  ],
  [
    "Quality Plan settlement",
    [
      "Applicable positive, negative, boundary, failure, cancellation, and recovery behavior is covered.",
      "The actually wired production composition was tested.",
      "Applicable security, accessibility, performance, resource, visual, and platform evidence exists.",
      "Excluded quality areas retain the rationale.",
      "Secrets, credentials, raw customer content, private endpoints, and PII are absent.",
    ],
  ],
  [
    "Verification",
    [
      "`npm ci --ignore-scripts`",
      "`npm run quality`",
      "`npm audit --audit-level=high`",
      "Every declared native target-specific gate passed.",
      "I reviewed the complete diff against requirements.",
    ],
  ],
  [
    "Independent audit and findings",
    [
      "Findings are evidence-cited.",
      "Every confirmed finding is resolved.",
      "Verification and audit were repeated.",
    ],
  ],
  [
    "Delivery",
    [
      "The target branch matches the delivery path.",
      "Commits are signed and every required check is current.",
      "Advisory tools are not treated as required merge authority.",
      "Documentation, ADRs, contracts, known limitations, and follow-ups are current.",
      "A draft pull request was not promoted prematurely.",
    ],
  ],
]);

function validTaskBody(target = "dev") {
  return taskHeadings
    .map((heading) => {
      if (heading === "Planning contract")
        return `## ${heading}\n\n- Contract version: \`v1\``;
      if (heading === "Acceptance journey")
        return `## ${heading}\n\n- Applicability: Required\n- Actor: Developer`;
      if (heading === "Execution Authority")
        return `## ${heading}\n\n- Exact delivery target: ${target}`;
      if (heading === "Acceptance criteria")
        return `## ${heading}\n\n- [ ] AC1 — The result is observable with expected test evidence.`;
      if (heading === "Verification commands")
        return `## ${heading}\n\n\`\`\`text\nnpm run quality\n\`\`\``;
      if (heading === "Definition of Ready")
        return `## ${heading}\n\n- [x] Scope and verification are complete.`;
      return `## ${heading}\n\nComplete governed content for ${heading}.`;
    })
    .join("\n\n");
}

function checkedLines(heading) {
  return (attestations.get(heading) ?? [])
    .map((attestation) => `- [x] ${attestation}`)
    .join("\n");
}

export function validPullRequestBody(target = "dev") {
  const epicLines = target.startsWith("epic/")
    ? [
        "- [x] The accepted issue authorizes this epic-branch target.",
        "- [x] Acceptance and audit evidence is complete.",
      ].join("\n")
    : "";
  return [
    "## Scope",
    "",
    "- Accepted issue: #42",
    "- Accepted planning-contract version: v1",
    "- Automated readiness record: https://github.com/keiko/Keiko-Native/issues/42#issuecomment-99",
    "- Actual source branch: codex/42-governed-workspace",
    `- Accepted target branch: ${target}`,
    "- Parent epic and Quality Envelope rows: Not applicable — standalone governance slice",
    "- Change classification: architecture/governance",
    "- Product decision, finding, or incident: Repository governance baseline",
    "- In scope: Contract enforcement",
    "- Out of scope: Productive application source",
    "- Native targets, contracts, or trust boundaries affected: Repository contract only",
    "",
    "## Product and architecture alignment",
    "",
    checkedLines("Product and architecture alignment"),
    "",
    "## Acceptance criteria and evidence",
    "",
    "| Acceptance criterion | Evidence | Exact head or artifact | Result |",
    "| --- | --- | --- | --- |",
    "| AC1 | quality/pr-contract.test.mjs | abc123 | Pass |",
    "",
    "## Acceptance journey evidence",
    "",
    "- Applicability: Required",
    "",
    "| Journey and checkpoint | Automated evidence and command | Manual or platform evidence | Result |",
    "| --- | --- | --- | --- |",
    "| J1.1 | npm test | Not applicable — repository contract | Pass |",
    "",
    "- [x] Automated checks exercise user-visible outcomes.",
    "- [x] Required failure, recovery, accessibility, visual, and platform observations are settled.",
    "",
    "## Quality Plan settlement",
    "",
    checkedLines("Quality Plan settlement"),
    "",
    "## Verification",
    "",
    checkedLines("Verification"),
    "",
    "```text",
    "npm run quality — passed",
    "```",
    "",
    "## Independent audit and findings",
    "",
    "| Confirmed finding | Evidence | Disposition | Settlement evidence or follow-up |",
    "| --- | --- | --- | --- |",
    "| None | Audit completed | No finding | Not applicable |",
    "",
    checkedLines("Independent audit and findings"),
    "",
    "## Integrated epic acceptance",
    "",
    "- Applicability: Not applicable — standalone repository governance slice",
    "- Production-composition result: Not applicable",
    "",
    "## Delivery",
    "",
    "- Target path: standalone -> dev",
    checkedLines("Delivery"),
    epicLines,
    "",
    "## Residual risks and follow-ups",
    "",
    "- None.",
  ].join("\n");
}

export function validPullRequestFixture(target = "dev") {
  const issueBody = validTaskBody(target);
  const issueTitle = "Implement governed workspace opening";
  const validation = {
    failures: [],
    fingerprint: semanticIssueFingerprint(issueBody, issueTitle),
    version: "v1",
  };
  return {
    comments: [
      {
        body: readinessComment({
          actor: "planner",
          decision: { outcome: "accept", reasons: [] },
          now: "2026-07-16T12:00:00.000Z",
          validation,
        }),
        id: 99,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    issue: {
      body: issueBody,
      labels: [{ name: "type: task" }, { name: "status: ready" }],
      number: 42,
      state: "open",
      title: issueTitle,
    },
    pullRequest: {
      base: { ref: target },
      body: validPullRequestBody(target),
      head: { ref: "codex/42-governed-workspace", sha: "c".repeat(40) },
      number: 7,
      title: "Enforce the pull request contract",
    },
    repository: "keiko/Keiko-Native",
  };
}
