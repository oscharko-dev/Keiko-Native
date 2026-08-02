import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { githubGraphqlRequestFor, githubRequestFor } from "./github-api.mjs";
import { pullRequestIssueNumber } from "./pr-contract.mjs";
import { contractSha256, parseContractPath } from "./repository-contract.mjs";

const graphqlRequest = githubGraphqlRequestFor(
  "keiko-native-migration-dry-run",
);
const jsonRequest = githubRequestFor("keiko-native-migration-dry-run");
const exactStatusContexts = ["Issue contract current", "PR contract"];
const repositoryPattern = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;

const LABELS_QUERY = `query MigrationLabels($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    labels(first: 100, after: $after, orderBy: {field: NAME, direction: ASC}) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes { name }
    }
  }
}`;

const ISSUES_QUERY = `query MigrationIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name target { ... on Commit { oid } } }
    issues(first: 50, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        number title body state stateReason updatedAt
        labels(first: 100) { totalCount nodes { name } }
        assignees(first: 100) { totalCount nodes { login } }
        comments(first: 100) {
          totalCount
          pageInfo { endCursor hasNextPage }
          nodes {
            databaseId body
            author {
              __typename login
              ... on User { databaseId }
              ... on Bot { databaseId }
            }
          }
        }
      }
    }
  }
}`;

const COMMENTS_QUERY = `query MigrationComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      comments(first: 100, after: $after) {
        totalCount
        pageInfo { endCursor hasNextPage }
        nodes {
          databaseId body
          author {
            __typename login
            ... on User { databaseId }
            ... on Bot { databaseId }
          }
        }
      }
    }
  }
}`;

const PULL_REQUESTS_QUERY = `query MigrationPullRequests($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: 10, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        number state merged body baseRefName baseRefOid headRefName headRefOid
        mergedBy { login }
        labels(first: 100) { totalCount nodes { name } }
        mergeCommit {
          oid
          signature { isValid state }
          parents(first: 2) { totalCount nodes { oid } }
        }
        commits(last: 1) {
          totalCount
          nodes {
            commit {
              oid
              signature { isValid state }
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
}`;

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function providerFailure(code) {
  throw new Error(code);
}

function connectionPage(connection, cursor, map) {
  if (
    !record(connection) ||
    !Number.isSafeInteger(connection.totalCount) ||
    connection.totalCount < 0 ||
    !record(connection.pageInfo) ||
    typeof connection.pageInfo.hasNextPage !== "boolean" ||
    !Array.isArray(connection.nodes) ||
    (connection.pageInfo.hasNextPage &&
      typeof connection.pageInfo.endCursor !== "string")
  ) {
    providerFailure("migration-provider-connection-invalid");
  }
  return {
    cursor,
    endCursor: connection.pageInfo.endCursor ?? null,
    hasNextPage: connection.pageInfo.hasNextPage,
    nodes: connection.nodes.map(map),
    totalCount: connection.totalCount,
  };
}

function author(comment) {
  const actor = comment?.author;
  if (
    !Number.isSafeInteger(comment?.databaseId) ||
    !record(actor) ||
    !Number.isSafeInteger(actor.databaseId) ||
    !["Bot", "User"].includes(actor.__typename) ||
    typeof actor.login !== "string" ||
    typeof comment.body !== "string"
  ) {
    providerFailure("migration-provider-comment-invalid");
  }
  return {
    body: comment.body,
    id: comment.databaseId,
    user: {
      id: actor.databaseId,
      login:
        actor.__typename === "Bot" &&
        actor.databaseId === 41898282 &&
        actor.login === "github-actions"
          ? "github-actions[bot]"
          : actor.login,
      type: actor.__typename,
    },
  };
}

function completeSmallConnection(connection, map, code) {
  if (
    !record(connection) ||
    !Array.isArray(connection.nodes) ||
    connection.totalCount !== connection.nodes.length ||
    connection.nodes.length > 100
  ) {
    providerFailure(code);
  }
  return connection.nodes.map(map);
}

function issueNode(issue) {
  if (
    !Number.isSafeInteger(issue?.number) ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    !["OPEN", "CLOSED"].includes(issue.state) ||
    typeof issue.updatedAt !== "string"
  ) {
    providerFailure("migration-provider-issue-invalid");
  }
  const labels = completeSmallConnection(
    issue.labels,
    (label) => label?.name,
    "migration-provider-issue-labels-incomplete",
  );
  const assignees = completeSmallConnection(
    issue.assignees,
    (actor) => actor?.login,
    "migration-provider-assignees-incomplete",
  );
  return {
    assignees,
    body: issue.body,
    labels,
    number: issue.number,
    state: issue.state.toLowerCase(),
    stateReason: issue.stateReason?.toLowerCase() ?? null,
    title: issue.title,
    updatedAt: issue.updatedAt,
  };
}

function commitVerification(signature) {
  return {
    reason: signature?.state === "VALID" ? "valid" : "invalid",
    verified: signature?.isValid === true && signature?.state === "VALID",
  };
}

function pullRequestNode(pullRequest) {
  const commit = pullRequest?.commits?.nodes?.[0]?.commit;
  const rollupState = commit?.statusCheckRollup?.state;
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    !["OPEN", "CLOSED", "MERGED"].includes(pullRequest.state) ||
    typeof pullRequest.merged !== "boolean" ||
    typeof pullRequest.body !== "string" ||
    !Array.isArray(pullRequest.commits?.nodes)
  ) {
    providerFailure("migration-provider-pull-request-invalid");
  }
  const labels = completeSmallConnection(
    pullRequest.labels,
    (label) => label?.name,
    "migration-provider-pr-labels-incomplete",
  );
  const checksComplete = typeof rollupState === "string";
  let mergeCommit = null;
  if (pullRequest.merged) {
    const merge = pullRequest.mergeCommit;
    mergeCommit = {
      parents: Array.isArray(merge?.parents?.nodes)
        ? merge.parents.nodes.map((parent) => parent.oid)
        : [],
      ...commitVerification(merge?.signature),
      sha: merge?.oid ?? null,
    };
  }
  const headOid = pullRequest.headRefOid ?? commit?.oid ?? null;
  return {
    base: {
      ref: pullRequest.baseRefName ?? null,
      sha: pullRequest.baseRefOid ?? null,
    },
    body: pullRequest.body,
    checks: {
      allPassing: rollupState === "SUCCESS",
      complete: checksComplete,
      head: commit?.oid ?? null,
      required: [],
    },
    head: { ref: pullRequest.headRefName ?? null, sha: headOid },
    headCommit: commitVerification(commit?.signature),
    labels,
    mergeCommit,
    merged: pullRequest.merged,
    mergedBy: pullRequest.mergedBy?.login ?? null,
    number: pullRequest.number,
    state: pullRequest.state === "OPEN" ? "open" : "closed",
  };
}

async function allPages(load, query, variables, select, map) {
  const pages = [];
  let after = null;
  for (;;) {
    const response = await load(query, { ...variables, after });
    const repository = response?.data?.repository;
    if (repository?.nameWithOwner !== variables.repository)
      providerFailure("migration-provider-repository-mismatch");
    const page = connectionPage(select(repository), after, map);
    pages.push(page);
    if (!page.hasNextPage) return { pages };
    after = page.endCursor;
  }
}

async function exactHeadStatuses(
  json,
  repository,
  pullRequest,
  prTrackedIssues,
) {
  const issueNumber = pullRequestIssueNumber(pullRequest.body);
  if (issueNumber === undefined || !prTrackedIssues.has(issueNumber))
    return pullRequest;
  const statuses = [];
  let totalCount;
  for (let page = 1; ; page += 1) {
    const response = await json(
      `/repos/${repository}/commits/${pullRequest.head.sha}/status?per_page=100&page=${page}`,
    );
    if (
      response?.sha !== pullRequest.head.sha ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response.statuses) ||
      response.statuses.length > 100 ||
      response.total_count !== (totalCount ?? response.total_count)
    ) {
      providerFailure("migration-provider-status-page-invalid");
    }
    totalCount = response.total_count;
    statuses.push(...response.statuses);
    if (statuses.length >= totalCount || response.statuses.length < 100) break;
  }
  if (statuses.length !== totalCount)
    providerFailure("migration-provider-status-pagination-incomplete");
  const latest = new Map();
  for (const status of statuses) {
    if (
      typeof status?.context !== "string" ||
      !["error", "failure", "pending", "success"].includes(status.state)
    ) {
      providerFailure("migration-provider-status-invalid");
    }
    if (!latest.has(status.context)) latest.set(status.context, status.state);
  }
  const required = exactStatusContexts
    .filter((name) => latest.has(name))
    .map((name) => ({
      conclusion: latest.get(name).toUpperCase(),
      name,
    }));
  return {
    ...pullRequest,
    checks: {
      allPassing:
        required.length === exactStatusContexts.length &&
        required.every((status) => status.conclusion === "SUCCESS"),
      complete: true,
      head: pullRequest.head.sha,
      required,
    },
  };
}

async function issueComments(load, variables, issue, initial) {
  const pages = [connectionPage(initial, null, author)];
  let after = pages[0].endCursor;
  while (pages.at(-1).hasNextPage) {
    const response = await load(COMMENTS_QUERY, {
      after,
      name: variables.name,
      number: issue.number,
      owner: variables.owner,
      repository: variables.repository,
    });
    if (response?.data?.repository?.nameWithOwner !== variables.repository)
      providerFailure("migration-provider-repository-mismatch");
    const page = connectionPage(
      response?.data?.repository?.issue?.comments,
      after,
      author,
    );
    pages.push(page);
    after = page.endCursor;
  }
  return { pages };
}

export async function loadRepositoryContractBindings(root) {
  const directory = join(root, "docs", "contracts");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT")
      return {
        pages: [
          {
            cursor: null,
            endCursor: null,
            hasNextPage: false,
            nodes: [],
            totalCount: 0,
          },
        ],
      };
    throw error;
  }
  const nodes = [];
  for (const entry of entries) {
    if (!entry.isFile()) providerFailure("migration-contract-tree-invalid");
    const path = `docs/contracts/${entry.name}`;
    if (parseContractPath(path).ok !== true)
      providerFailure("migration-contract-path-invalid");
    const bytes = await readFile(join(directory, entry.name));
    nodes.push({ digest: contractSha256(bytes).digest, mode: "100644", path });
  }
  nodes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    pages: [
      {
        cursor: null,
        endCursor: nodes.length === 0 ? null : "repository-contracts",
        hasNextPage: false,
        nodes,
        totalCount: nodes.length,
      },
    ],
  };
}

async function scan({ contracts, graphql, json, now, repository }) {
  const match = repositoryPattern.exec(repository);
  if (match === null) providerFailure("migration-provider-repository-invalid");
  const variables = { name: match[2], owner: match[1], repository };
  const labels = await allPages(
    graphql,
    LABELS_QUERY,
    variables,
    (value) => value.labels,
    (value) => value?.name,
  );
  const comments = new Map();
  let protectedDev;
  const issues = await allPages(
    graphql,
    ISSUES_QUERY,
    variables,
    (value) => {
      const branch = value.defaultBranchRef;
      if (
        branch?.name !== "dev" ||
        !/^[0-9a-f]{40}$/u.test(branch?.target?.oid ?? "")
      )
        providerFailure("migration-provider-protected-dev-invalid");
      if (protectedDev !== undefined && protectedDev !== branch.target.oid)
        providerFailure("migration-provider-protected-dev-drift");
      protectedDev = branch.target.oid;
      return value.issues;
    },
    (value) => {
      const item = issueNode(value);
      comments.set(item.number, value.comments);
      return item;
    },
  );
  const issueNodes = issues.pages.flatMap((page) => page.nodes);
  const prTrackedIssues = new Set(
    issueNodes
      .filter(
        (issue) =>
          issue.state === "open" &&
          issue.labels.some((label) =>
            ["status: pr open", "status: ready for human review"].includes(
              label,
            ),
          ),
      )
      .map((issue) => issue.number),
  );
  for (const issue of issueNodes) {
    comments.set(
      issue.number,
      await issueComments(
        graphql,
        variables,
        issue,
        comments.get(issue.number),
      ),
    );
  }
  const pullRequests = await allPages(
    graphql,
    PULL_REQUESTS_QUERY,
    variables,
    (value) => value.pullRequests,
    pullRequestNode,
  );
  for (const page of pullRequests.pages) {
    page.nodes = await Promise.all(
      page.nodes.map((pullRequest) =>
        exactHeadStatuses(json, repository, pullRequest, prTrackedIssues),
      ),
    );
  }
  return {
    allowlistedMergers: ["Niko4417", "oscharko"],
    comments,
    contracts: await contracts(),
    issues,
    labels,
    observedAt: now(),
    protectedDev,
    pullRequests,
    repository,
  };
}

function comparable(snapshot) {
  return {
    ...snapshot,
    comments: [...snapshot.comments.entries()].sort(
      (left, right) => left[0] - right[0],
    ),
    observedAt: null,
  };
}

export function createMigrationGithubProvider({
  contracts,
  graphql = graphqlRequest,
  json = jsonRequest,
  maximumRequests = 200,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof contracts !== "function")
    throw new TypeError("migration contract reader is required");
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests <= 0)
    throw new TypeError("migration provider request ceiling is invalid");
  let requests = 0;
  const countedGraphql = async (...arguments_) => {
    requests += 1;
    if (requests > maximumRequests)
      providerFailure("migration-provider-request-ceiling");
    return graphql(...arguments_);
  };
  const countedJson = async (...arguments_) => {
    requests += 1;
    if (requests > maximumRequests)
      providerFailure("migration-provider-request-ceiling");
    return json(...arguments_);
  };
  return {
    async snapshot(repository) {
      const first = await scan({
        contracts,
        graphql: countedGraphql,
        json: countedJson,
        now,
        repository,
      });
      const second = await scan({
        contracts,
        graphql: countedGraphql,
        json: countedJson,
        now,
        repository,
      });
      if (!isDeepStrictEqual(comparable(first), comparable(second)))
        providerFailure("migration-provider-drift");
      return second;
    },
  };
}
