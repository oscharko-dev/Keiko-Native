import {
  digestEpicMergeValue,
  isEpicMergeCommit,
} from "./epic-merge-policy.mjs";

const MARKER = "<!-- keiko-native-epic-merge-audit -->";
const PRODUCER = "maintainer-audit@adr-0009";
const WORKFLOW = "adr-0009-maintainer-audit-v1";
const maintainers = new Set(["niko4417", "oscharko"]);

function receipt(comment, head) {
  const match =
    /^<!-- keiko-native-epic-merge-audit -->\n- Status: `([^`]+)`\n- Head: `([^`]+)`\n- Findings: `([^`]+)`\n- Workflow: `([^`]+)`\n- Digest: `([^`]+)`$/u.exec(
      comment?.body ?? "",
    );
  const actor =
    typeof comment?.user?.login === "string"
      ? comment.user.login.toLowerCase()
      : null;
  const expected = digestEpicMergeValue({
    findings: 0,
    head,
    workflow: WORKFLOW,
  });
  const current =
    Number.isSafeInteger(comment?.id) &&
    comment.id > 0 &&
    Number.isSafeInteger(comment?.user?.id) &&
    comment.user.id > 0 &&
    comment.user.type === "User" &&
    maintainers.has(actor) &&
    comment.created_at === comment.updated_at &&
    match?.[1] === "accepted" &&
    match?.[2] === head &&
    match?.[3] === "0" &&
    match?.[4] === WORKFLOW &&
    match?.[5] === expected;
  return {
    actor,
    actorId: comment?.user?.id ?? null,
    commentId: comment?.id ?? null,
    complete: current,
    current,
    digest: match?.[5] ?? null,
    head: match?.[2] ?? null,
    producer: PRODUCER,
  };
}

export function buildEpicMergeEvidence({
  auditComments,
  pullRequest,
  results,
  resultsComplete,
}) {
  const acceptance = results.filter(
    (result) =>
      result?.context === "PR contract" &&
      result.producer === "github-actions[bot]@41898282",
  );
  const accepted =
    resultsComplete &&
    acceptance.length === 1 &&
    Number.isSafeInteger(acceptance[0].resultId) &&
    acceptance[0].resultId > 0 &&
    acceptance[0].status === "completed" &&
    acceptance[0].conclusion === "success" &&
    acceptance[0].head === pullRequest?.head?.sha &&
    acceptance[0].base === pullRequest?.base?.sha;
  const receipts = auditComments.items.filter((comment) =>
    comment?.body?.includes(MARKER),
  );
  const audit =
    receipts.length === 1
      ? receipt(receipts[0], pullRequest?.head?.sha)
      : receipt(null, pullRequest?.head?.sha);
  if (
    !auditComments.complete ||
    auditComments.truncated ||
    !isEpicMergeCommit(pullRequest?.head?.sha) ||
    receipts.length !== 1
  ) {
    audit.complete = false;
    audit.current = false;
  }
  return {
    acceptance: {
      complete: accepted,
      current: accepted,
      head: pullRequest?.head?.sha ?? null,
      producer: "github-actions[bot]@41898282",
      statusId: acceptance[0]?.resultId ?? null,
    },
    audit,
  };
}
