import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";
import { EPIC_MERGE_REPOSITORY } from "./epic-merge-policy.mjs";

const [owner, name] = EPIC_MERGE_REPOSITORY.split("/");
const PAGE_LIMIT = 100;
const query = `query EpicMergeReviewThreads(
  $owner: String!
  $name: String!
  $number: Int!
  $first: Int!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(
    Object.keys(value).toSorted(compareCodeUnits),
    keys.toSorted(compareCodeUnits),
  );

function validPage(response) {
  const threads = response?.body?.data?.repository?.pullRequest?.reviewThreads;
  return (
    response?.status === 200 &&
    response.body?.errors === undefined &&
    Array.isArray(threads?.nodes) &&
    threads.nodes.length <= 100 &&
    threads.nodes.every(
      (node) =>
        exactKeys(node, ["isResolved"]) && typeof node.isResolved === "boolean",
    ) &&
    exactKeys(threads.pageInfo, ["endCursor", "hasNextPage"]) &&
    typeof threads.pageInfo.hasNextPage === "boolean" &&
    (threads.pageInfo.endCursor === null ||
      (typeof threads.pageInfo.endCursor === "string" &&
        threads.pageInfo.endCursor.length > 0))
  );
}

export async function listEpicMergeReviewThreads({
  page,
  pullRequest,
  request,
}) {
  if (
    page !== 1 ||
    !Number.isSafeInteger(pullRequest) ||
    pullRequest <= 0 ||
    typeof request !== "function"
  )
    return { items: [], nextPage: undefined };
  const items = [];
  const cursors = new Set();
  let after = null;
  for (let count = 0; count < PAGE_LIMIT; count += 1) {
    const response = await request({
      body: {
        query,
        variables: { after, first: 100, name, number: pullRequest, owner },
      },
      method: "POST",
      path: "/graphql",
    });
    if (!validPage(response)) return { items: [], nextPage: undefined };
    const threads = response.body.data.repository.pullRequest.reviewThreads;
    items.push(
      ...threads.nodes.map(({ isResolved }) => ({ resolved: isResolved })),
    );
    if (!threads.pageInfo.hasNextPage) return { items, nextPage: null };
    const cursor = threads.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursors.has(cursor))
      return { items: [], nextPage: undefined };
    cursors.add(cursor);
    after = cursor;
  }
  return { items: [], nextPage: undefined };
}
