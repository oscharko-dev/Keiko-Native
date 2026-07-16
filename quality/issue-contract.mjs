import { createHash } from "node:crypto";

const schemaByTypeLabel = new Map([
  [
    "type: epic",
    {
      kind: "epic",
      requiredHeadings: [
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
      ],
      journeyHeading: "Primary acceptance journey",
      verificationHeading: "Integrated verification",
    },
  ],
  [
    "type: task",
    {
      kind: "task",
      requiredHeadings: [
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
      ],
      journeyHeading: "Acceptance journey",
      verificationHeading: "Verification commands",
    },
  ],
  [
    "type: decision",
    {
      kind: "decision",
      requiredHeadings: [
        "Planning contract",
        "Decision question and authority",
        "Constraints and non-negotiables",
        "Evaluation journey",
        "Options",
        "Evaluation plan",
        "Execution Authority",
        "Decision matrix",
        "Acceptance criteria",
        "Verification commands",
        "Definition of Ready",
        "Definition of Done",
        "Stop conditions",
      ],
      journeyHeading: "Evaluation journey",
      verificationHeading: "Verification commands",
    },
  ],
  [
    "type: defect",
    {
      kind: "defect",
      requiredHeadings: [
        "Planning contract",
        "Finding and accepted behavior",
        "Reproduction contract",
        "Scope",
        "Execution Authority",
        "Quality Plan",
        "Acceptance criteria",
        "Verification commands",
        "Audit plan",
        "Definition of Ready",
        "Completion and review settlement",
        "Stop conditions",
      ],
      verificationHeading: "Verification commands",
    },
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
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line)?.[1];
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

function fieldValue(section, field) {
  if (typeof section !== "string") return undefined;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^- ${escaped}:\\s*(.+?)\\s*$`, "mu").exec(section)?.[1];
}

function unresolvedTemplateFailures(body) {
  const failures = [];
  if (/<[^>\n]+>/u.test(body))
    failures.push("Template angle-bracket placeholders remain.");
  if (/\.\.\./u.test(body)) failures.push("Ellipsis placeholders remain.");
  const proseOnly = body.replace(/```[\s\S]*?```/gu, "");
  if (/`[^`]*\|[^`]*`/u.test(proseOnly))
    failures.push("An unresolved inline option list remains.");
  if (/^-\s*$/mu.test(body))
    failures.push("An empty list placeholder remains.");
  if (logicalListItems(proseOnly).some((item) => /:\s*$/u.test(item)))
    failures.push("A required bullet field is empty.");
  if (/^Parent Epic:\s*$/mu.test(body))
    failures.push("The Parent Epic field is empty.");
  if (/^- \[[ xX]\] AC\d+\s+[—-]\s+Evidence:\s*$/gmu.test(body))
    failures.push(
      "An acceptance criterion still contains placeholder evidence.",
    );
  if (hasEmptyTableRow(body))
    failures.push("A Markdown table still contains an empty placeholder row.");
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

function hasEmptyTableRow(body) {
  return body.split("\n").some((line) => {
    if (!/^\|.*\|\s*$/u.test(line)) return false;
    const cells = line
      .slice(line.indexOf("|") + 1, line.lastIndexOf("|"))
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return false;
    if (cells.length < 2) return false;
    return cells.some((cell) => cell === "");
  });
}

function definitionOfReadyFailures(section) {
  if (typeof section !== "string" || section === "")
    return ["Definition of Ready is empty."];
  const checkboxes = [...section.matchAll(/^- \[([ xX])\]\s+.+$/gmu)];
  if (checkboxes.length === 0)
    return ["Definition of Ready has no checkable criteria."];
  if (checkboxes.some((match) => match[1] === " "))
    return ["Definition of Ready contains unchecked criteria."];
  return [];
}

function verificationFailures(section) {
  if (typeof section !== "string")
    return ["Verification commands are missing."];
  const blocks = [
    ...section.matchAll(/```(?:text|bash|sh)?\s*\n([\s\S]*?)```/gu),
  ];
  if (
    blocks.length === 0 ||
    blocks.every((match) => match[1].trim().length === 0)
  )
    return ["Verification commands contain no executable command."];
  return [];
}

function acceptanceCriteriaFailures(section) {
  if (typeof section !== "string") return [];
  const criteria = [
    ...section.matchAll(/^- \[[ xX]\] AC\d+\s+[—-]\s+(.+)$/gmu),
  ];
  if (criteria.length === 0)
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
  const selected = [...section.matchAll(/^- \[[xX]\]\s+`[^`]+`\s*$/gmu)];
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
  const normalized = body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      heading = /^##\s+(.+?)\s*$/u.exec(line)?.[1] ?? heading;
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
  for (const heading of schema.requiredHeadings) {
    if (!sections.has(heading)) failures.push(`Missing section: ${heading}.`);
    else if (sections.get(heading) === undefined)
      failures.push(`Duplicate section: ${heading}.`);
    else if (sections.get(heading) === "")
      failures.push(`Empty section: ${heading}.`);
  }
  failures.push(...unresolvedTemplateFailures(body));
  failures.push(
    ...definitionOfReadyFailures(sections.get("Definition of Ready")),
  );
  failures.push(
    ...verificationFailures(sections.get(schema.verificationHeading)),
  );
  failures.push(
    ...acceptanceCriteriaFailures(sections.get("Acceptance criteria")),
  );
  if (schema.journeyHeading !== undefined)
    failures.push(...journeyFailures(sections.get(schema.journeyHeading)));
  failures.push(...changeClassificationFailures(schema, sections));

  const version = contractVersion(sections);
  if (!/^v[1-9][0-9]*$/u.test(version ?? ""))
    failures.push("Planning contract version must use v1, v2, and so on.");

  return {
    failures: [...new Set(failures)],
    fingerprint: semanticIssueFingerprint(body, title),
    kind: schema.kind,
    version,
  };
}
