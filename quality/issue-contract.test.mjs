import assert from "node:assert/strict";
import test from "node:test";

import {
  issueSchemaForLabels,
  markdownSections,
  semanticIssueFingerprint,
  validateIssueContract,
} from "./issue-contract.mjs";

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

const epicHeadings = [
  "Outcome",
  "Change classification",
  "Planning authority",
  "Planning contract",
  "In scope",
  "Non-goals",
  "Existing Keiko evidence and reuse",
  "Architecture and ownership",
  "Primary acceptance journey",
  "Platform matrix",
  "Surface and state matrix",
  "Quality Envelope",
  "Integrated verification",
  "Child slices and interface contracts",
  "Definition of Ready",
  "Definition of Done",
  "Stop conditions",
];

function validTaskBody() {
  return taskHeadings
    .map((heading) => {
      if (heading === "Planning contract")
        return `## ${heading}\n\n- Contract version: \`v1\``;
      if (heading === "Acceptance journey")
        return `## ${heading}\n\n- Applicability: Required\n- Actor: Developer`;
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

function validEpicBody() {
  return epicHeadings
    .map((heading) => {
      if (heading === "Planning contract")
        return `## ${heading}\n\n- Contract version: \`v1\`\n- Epic integration branch: epic/42-shell`;
      if (heading === "Change classification")
        return `## ${heading}\n\n- [x] \`architecture/governance\`\n- [ ] \`net-new\``;
      if (heading === "Primary acceptance journey")
        return `## ${heading}\n\n- Applicability: Required\n- Actor: Developer`;
      if (heading === "Definition of Ready")
        return `## ${heading}\n\n- [x] Scope and evidence are complete.`;
      if (heading === "Integrated verification")
        return `## ${heading}\n\n\`\`\`text\nnpm run quality\n\`\`\``;
      return `## ${heading}\n\nComplete governed content for ${heading}.`;
    })
    .join("\n\n");
}

test("selects exactly one supported issue schema", () => {
  assert.equal(issueSchemaForLabels(["type: task"])?.kind, "task");
  assert.equal(issueSchemaForLabels(["type: task", "type: defect"]), undefined);
  assert.equal(issueSchemaForLabels(["bug"]), undefined);
});

test("parses unique and duplicate Markdown sections", () => {
  const sections = markdownSections("## One\nA\n## Two\nB\n## One\nC");
  assert.equal(sections.get("Two"), "B");
  assert.equal(sections.get("One"), undefined);
});

test("accepts a complete implementation issue contract", () => {
  const result = validateIssueContract({
    body: validTaskBody(),
    labels: ["type: task", "status: ready"],
    title: "Implement governed workspace opening",
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.kind, "task");
  assert.equal(result.version, "v1");
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/u);
});

test("rejects incomplete placeholders and unchecked readiness", () => {
  const body = validTaskBody()
    .replace("- Actor: Developer", "- Actor:")
    .replace("- [x] Scope", "- [ ] Scope")
    .replace("Complete governed content for Scope.", "-")
    .replace("npm run quality", "");
  const failures = validateIssueContract({
    body,
    labels: ["type: task"],
    title: "Implement governed workspace opening",
  }).failures.join("\n");
  assert.match(failures, /required bullet field is empty/u);
  assert.match(failures, /empty list placeholder/u);
  assert.match(failures, /unchecked criteria/u);
  assert.match(failures, /no executable command/u);
});

test("accepts a reasoned journey exclusion and rejects an unresolved one", () => {
  const excluded = validTaskBody().replace(
    "- Applicability: Required",
    "- Applicability: Not applicable — repository-only governance change",
  );
  assert.deepEqual(
    validateIssueContract({
      body: excluded,
      labels: ["type: task"],
      title: "Harden the repository contract",
    }).failures,
    [],
  );
  assert.match(
    validateIssueContract({
      body: excluded.replace(
        "Not applicable — repository-only governance change",
        "Not applicable",
      ),
      labels: ["type: task"],
      title: "Harden the repository contract",
    }).failures.join("\n"),
    /Journey applicability/u,
  );
});

test("requires one epic classification and a non-empty contract", () => {
  assert.deepEqual(
    validateIssueContract({
      body: validEpicBody(),
      labels: ["type: epic"],
      title: "Select the native host foundation",
    }).failures,
    [],
  );
  assert.match(
    validateIssueContract({
      body: validEpicBody().replace("- [ ] `net-new`", "- [x] `net-new`"),
      labels: ["type: epic"],
      title: "Select the native host foundation",
    }).failures.join("\n"),
    /exactly one option/u,
  );
  const empty = validateIssueContract({
    body: "",
    labels: ["type: task"],
    title: "short",
  });
  assert.match(empty.failures.join("\n"), /title is missing/u);
  assert.match(empty.failures.join("\n"), /body is empty/u);
  assert.equal(empty.fingerprint, undefined);
});

test("rejects ambiguous options, empty table rows, and duplicate types", () => {
  const body = `${validTaskBody()}\n\n- Choice: \`one | two\`\n\n| A | B |\n| - | - |\n|   |   |`;
  const failures = validateIssueContract({
    body,
    labels: ["type: task", "type: defect"],
    title: "Implement governed workspace opening",
  }).failures.join("\n");
  assert.match(failures, /exactly one supported type/u);

  const contractFailures = validateIssueContract({
    body,
    labels: ["type: task"],
    title: "Implement governed workspace opening",
  }).failures.join("\n");
  assert.match(contractFailures, /inline option list/u);
  assert.match(contractFailures, /empty placeholder row/u);
});

test("rejects wrapped empty fields, multiline choices, and partial data rows", () => {
  const body = `${validTaskBody()}\n\n- Required negative and partial\n  failure paths to cover:\n\n- Choice: \`one |\n  two\`\n\n| Quality row | Evidence | Owner |\n| --- | --- | --- |\n| Security | | team |`;
  const failures = validateIssueContract({
    body,
    labels: ["type: task"],
    title: "Implement governed workspace opening",
  }).failures.join("\n");
  assert.match(failures, /required bullet field is empty/u);
  assert.match(failures, /inline option list/u);
  assert.match(failures, /empty placeholder row/u);
});

test("ignores shell pipes and list-like commands inside verification fences", () => {
  const body = validTaskBody().replace(
    "npm run quality",
    "printf result | sha256sum\n- diagnostic:",
  );
  assert.deepEqual(
    validateIssueContract({
      body,
      labels: ["type: task"],
      title: "Implement governed workspace opening",
    }).failures,
    [],
  );
});

test("normalizes checkbox state but detects semantic contract edits", () => {
  const body = validTaskBody();
  assert.equal(
    semanticIssueFingerprint(body),
    semanticIssueFingerprint(
      body.replace("[ ] AC1 — The result", "[x] AC1 — The result"),
    ),
  );
  assert.notEqual(
    semanticIssueFingerprint(body),
    semanticIssueFingerprint(body.replace("Developer", "Reviewer")),
  );
  assert.notEqual(
    semanticIssueFingerprint("## Change classification\n- [x] feature"),
    semanticIssueFingerprint("## Change classification\n- [ ] feature"),
  );
  assert.notEqual(
    semanticIssueFingerprint(body, "Original governed outcome"),
    semanticIssueFingerprint(body, "Different governed outcome"),
  );
});
