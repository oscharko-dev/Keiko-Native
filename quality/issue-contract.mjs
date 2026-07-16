import { createHash } from "node:crypto";

import {
  fieldValue,
  hasAnglePlaceholder,
  hasInlineOptionList,
  logicalListItems,
  markdownHeading,
  markdownLines,
  splitFencedMarkdown,
} from "./markdown-contract.mjs";

function issueSchema(kind, headings, verificationHeading, journeyHeading) {
  return {
    journeyHeading,
    kind,
    requiredHeadings: headings
      .trim()
      .split("\n")
      .map((heading) => heading.trim()),
    verificationHeading,
  };
}

const schemaByTypeLabel = new Map([
  [
    "type: epic",
    issueSchema(
      "epic",
      `Outcome
Change classification
Planning authority
Planning contract
In scope
Non-goals
Existing Keiko evidence and reuse
Architecture and ownership
Primary acceptance journey
Platform matrix
Surface and state matrix
Quality Envelope
Integrated verification
Child slices and interface contracts
Definition of Ready
Definition of Done
Stop conditions`,
      "Integrated verification",
      "Primary acceptance journey",
    ),
  ],
  [
    "type: task",
    issueSchema(
      "task",
      `Planning contract
Purpose and observable outcome
Acceptance journey
Change classification and planning authority
Scope
Execution Authority
Planning and architecture alignment
Interface contracts
Quality Plan
Acceptance criteria
Verification commands
Audit plan
Definition of Ready
Completion and review settlement
Stop conditions`,
      "Verification commands",
      "Acceptance journey",
    ),
  ],
  [
    "type: decision",
    issueSchema(
      "decision",
      `Planning contract
Decision question and authority
Constraints and non-negotiables
Evaluation journey
Options
Evaluation plan
Execution Authority
Decision matrix
Acceptance criteria
Verification commands
Definition of Ready
Definition of Done
Stop conditions`,
      "Verification commands",
      "Evaluation journey",
    ),
  ],
  [
    "type: defect",
    issueSchema(
      "defect",
      `Planning contract
Finding and accepted behavior
Reproduction contract
Scope
Execution Authority
Quality Plan
Acceptance criteria
Verification commands
Audit plan
Definition of Ready
Completion and review settlement
Stop conditions`,
      "Verification commands",
    ),
  ],
]);

function labelsToNames(labels) {
  return labels.map((label) =>
    typeof label === "string" ? label : (label?.name ?? ""),
  );
}

export function issueSchemaForLabels(labels) {
  const names = new Set(labelsToNames(Array.isArray(labels) ? labels : []));
  const matches = [...schemaByTypeLabel].filter(([label]) => names.has(label));
  if (matches.length !== 1) return undefined;
  return matches[0][1];
}

export function markdownSections(body) {
  const sections = new Map();
  let current;
  for (const line of markdownLines(body)) {
    const heading = markdownHeading(line);
    if (heading !== undefined) {
      if (sections.has(heading)) sections.set(heading, undefined);
      else sections.set(heading, []);
      current = heading;
    } else if (current !== undefined && sections.get(current) !== undefined) {
      sections.get(current).push(line);
    }
  }
  return new Map(
    [...sections].map(([heading, lines]) => [
      heading,
      lines === undefined ? undefined : lines.join("\n").trim(),
    ]),
  );
}

function unresolvedTemplateFailures(body) {
  const failures = [];
  if (hasAnglePlaceholder(body))
    failures.push("Template angle-bracket placeholders remain.");
  if (/\.\.\./u.test(body)) failures.push("Ellipsis placeholders remain.");
  const { prose: proseOnly } = splitFencedMarkdown(body);
  if (hasInlineOptionList(proseOnly))
    failures.push("An unresolved inline option list remains.");
  if (/^-\s*$/mu.test(body))
    failures.push("An empty list placeholder remains.");
  if (logicalListItems(proseOnly).some((item) => /:\s*$/u.test(item)))
    failures.push("A required bullet field is empty.");
  if (/^Parent Epic:\s*$/mu.test(body))
    failures.push("The Parent Epic field is empty.");
  if (
    markdownLines(body).some(
      (line) => acceptanceCriterion(line)?.description === "Evidence:",
    )
  )
    failures.push(
      "An acceptance criterion still contains placeholder evidence.",
    );
  if (hasEmptyTableRow(body))
    failures.push("A Markdown table still contains an empty placeholder row.");
  return failures;
}

function hasEmptyTableRow(body) {
  return markdownLines(body).some((line) => {
    if (!line.startsWith("|") || !line.trimEnd().endsWith("|")) return false;
    const cells = line
      .slice(line.indexOf("|") + 1, line.lastIndexOf("|"))
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return false;
    if (cells.length < 2) return false;
    return cells.includes("");
  });
}

function checkbox(line) {
  if (
    !line.startsWith("- [") ||
    line[4] !== "]" ||
    !/\s/u.test(line[5] ?? "") ||
    ![" ", "x", "X"].includes(line[3])
  )
    return undefined;
  const text = line.slice(6).trim();
  return text === "" ? undefined : { checked: line[3] !== " ", text };
}

function acceptanceCriterion(line) {
  const parsed = checkbox(line);
  if (parsed === undefined) return undefined;
  const identityEnd = parsed.text.search(/\s/u);
  if (identityEnd < 0) return undefined;
  const identity = parsed.text.slice(0, identityEnd);
  const remainder = parsed.text.slice(identityEnd).trimStart();
  if (!["—", "-"].includes(remainder[0])) return undefined;
  const afterSeparator = remainder.slice(1);
  if (afterSeparator === afterSeparator.trimStart()) return undefined;
  const description = afterSeparator.trim();
  if (!/^AC\d+$/u.test(identity) || description === "") return undefined;
  return { ...parsed, description, identity };
}

function definitionOfReadyFailures(section) {
  if (typeof section !== "string" || section === "")
    return ["Definition of Ready is empty."];
  const checkboxes = markdownLines(section)
    .map(checkbox)
    .filter((value) => value !== undefined);
  if (checkboxes.length === 0)
    return ["Definition of Ready has no checkable criteria."];
  if (checkboxes.some((item) => !item.checked))
    return ["Definition of Ready contains unchecked criteria."];
  return [];
}

function verificationFailures(section) {
  if (typeof section !== "string")
    return ["Verification commands are missing."];
  const { blocks } = splitFencedMarkdown(section);
  if (blocks.every((block) => block.trim().length === 0))
    return ["Verification commands contain no executable command."];
  return [];
}

function acceptanceCriteriaFailures(section) {
  if (typeof section !== "string") return [];
  if (
    !markdownLines(section).some(
      (line) => acceptanceCriterion(line) !== undefined,
    )
  )
    return ["Acceptance criteria contain no observable criterion."];
  return [];
}

function journeyFailures(section) {
  const applicability = fieldValue(section, "Applicability")
    ?.replace(/^`|`$/gu, "")
    .trim();
  if (applicability === "Required") return [];
  if (
    applicability?.startsWith("Not applicable") &&
    applicability.length >= "Not applicable — rationale".length
  )
    return [];
  return [
    "Journey applicability must be Required or a reasoned Not applicable value.",
  ];
}

function changeClassificationFailures(schema, sections) {
  if (schema.kind !== "epic") return [];
  const section = sections.get("Change classification") ?? "";
  const selected = markdownLines(section)
    .map(checkbox)
    .filter(
      (item) =>
        item?.checked === true &&
        item.text.startsWith("`") &&
        item.text.endsWith("`") &&
        item.text.length > 2,
    );
  return selected.length === 1
    ? []
    : ["Epic change classification must select exactly one option."];
}

function contractVersion(sections) {
  return fieldValue(sections.get("Planning contract"), "Contract version")
    ?.replaceAll("`", "")
    .trim();
}

export function semanticIssueFingerprint(body, title = "") {
  const mutableCheckboxSections = new Set([
    "Acceptance criteria",
    "Completion and review settlement",
    "Definition of Done",
  ]);
  let heading;
  const normalized = markdownLines(body)
    .map((line) => {
      heading = markdownHeading(line) ?? heading;
      const normalizedLine = mutableCheckboxSections.has(heading)
        ? line.replace(/\[[xX ]\]/gu, "[ ]")
        : line;
      return normalizedLine.trimEnd();
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const contract = `${title.trim()}\n\n${normalized}`;
  return createHash("sha256").update(contract, "utf8").digest("hex");
}

export function validateIssueContract({ body, labels, title }) {
  const failures = [];
  const schema = issueSchemaForLabels(labels);
  if (schema === undefined) {
    failures.push("Issue must have exactly one supported type label.");
    return {
      failures,
      fingerprint: undefined,
      kind: undefined,
      version: undefined,
    };
  }
  if (typeof title !== "string" || title.trim().length < 8)
    failures.push("Issue title is missing or not descriptive.");
  if (typeof body !== "string" || body.trim() === "") {
    failures.push("Issue body is empty.");
    return {
      failures,
      fingerprint: undefined,
      kind: schema.kind,
      version: undefined,
    };
  }

  const sections = markdownSections(body);
  const requiredHeadingFailures = schema.requiredHeadings.flatMap((heading) => {
    if (!sections.has(heading)) return [`Missing section: ${heading}.`];
    if (sections.get(heading) === undefined)
      return [`Duplicate section: ${heading}.`];
    return sections.get(heading) === "" ? [`Empty section: ${heading}.`] : [];
  });
  const journeyContractFailures =
    schema.journeyHeading === undefined
      ? []
      : journeyFailures(sections.get(schema.journeyHeading));
  failures.push(
    ...requiredHeadingFailures,
    ...unresolvedTemplateFailures(body),
    ...definitionOfReadyFailures(sections.get("Definition of Ready")),
    ...verificationFailures(sections.get(schema.verificationHeading)),
    ...acceptanceCriteriaFailures(sections.get("Acceptance criteria")),
    ...journeyContractFailures,
    ...changeClassificationFailures(schema, sections),
  );

  const version = contractVersion(sections);
  if (!/^v[1-9]\d*$/u.test(version ?? ""))
    failures.push("Planning contract version must use v1, v2, and so on.");

  return {
    failures: [...new Set(failures)],
    fingerprint: semanticIssueFingerprint(body, title),
    kind: schema.kind,
    version,
  };
}
