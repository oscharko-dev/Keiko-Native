import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { githubGraphqlRequestFor, githubRequestFor } from "./github-api.mjs";
import { contractSha256, parseContractPath } from "./repository-contract.mjs";

const graphqlRequest = githubGraphqlRequestFor(
  "keiko-native-migration-dry-run",
);
const jsonRequest = githubRequestFor("keiko-native-migration-dry-run");
const exactStatusContexts = [
  "Issue contract current",
  "PR contract",
  "Lifecycle handoff",
];
const claimPermissions = new Set(["admin", "maintain", "write"]);
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
    defaultBranchRef { name target { ... on Commit { oid tree { oid } } } }
    issues(first: 50, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        number title body state stateReason updatedAt lastEditedAt
        labels(first: 100) { totalCount nodes { name } }
        assignees(first: 100) { totalCount nodes { login } }
        comments(first: 100) {
          totalCount
          pageInfo { endCursor hasNextPage }
          nodes {
            databaseId body createdAt
            author {
              __typename login
              ... on User { databaseId }
              ... on Bot { databaseId }
            }
          }
        }
        timelineItems(first: 100, itemTypes: [REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT]) {
          totalCount
          pageInfo { endCursor hasNextPage }
          nodes {
            __typename
            ... on ReopenedEvent { createdAt actor { login } }
            ... on AssignedEvent {
              createdAt actor { login }
              assignee { ... on User { login } }
            }
            ... on UnassignedEvent {
              createdAt actor { login }
              assignee { ... on User { login } }
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
          databaseId body createdAt
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

const EVENTS_QUERY = `query MigrationIssueEvents($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT]) {
        totalCount
        pageInfo { endCursor hasNextPage }
        nodes {
          __typename
          ... on ReopenedEvent { createdAt actor { login } }
          ... on AssignedEvent {
            createdAt actor { login }
            assignee { ... on User { login } }
          }
          ... on UnassignedEvent {
            createdAt actor { login }
            assignee { ... on User { login } }
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
        number title state merged body baseRefName baseRefOid headRefName headRefOid
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
              status {
                contexts {
                  context state
                  creator {
                    __typename login
                    ... on User { databaseId }
                    ... on Bot { databaseId }
                  }
                }
              }
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
    typeof comment.body !== "string" ||
    typeof comment.createdAt !== "string" ||
    !Number.isFinite(Date.parse(comment.createdAt))
  ) {
    providerFailure("migration-provider-comment-invalid");
  }
  return {
    body: comment.body,
    createdAt: comment.createdAt,
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

function issueEvent(event) {
  if (
    !["ReopenedEvent", "AssignedEvent", "UnassignedEvent"].includes(
      event?.__typename,
    ) ||
    typeof event.createdAt !== "string" ||
    !Number.isFinite(Date.parse(event.createdAt))
  )
    providerFailure("migration-provider-issue-event-invalid");
  const actor = event.actor?.login;
  const assignee = event.assignee?.login;
  if (
    (actor !== null && actor !== undefined && typeof actor !== "string") ||
    (event.__typename !== "ReopenedEvent" && typeof assignee !== "string")
  )
    providerFailure("migration-provider-issue-event-invalid");
  return {
    action:
      event.__typename === "ReopenedEvent"
        ? "reopened"
        : event.__typename === "AssignedEvent"
          ? "assigned"
          : "unassigned",
    actor: actor ?? null,
    assignee: assignee ?? null,
    createdAt: event.createdAt,
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
    typeof issue.updatedAt !== "string" ||
    !(issue.lastEditedAt === null || typeof issue.lastEditedAt === "string")
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
    claim: null,
    labels,
    lastEditedAt: issue.lastEditedAt,
    number: issue.number,
    reopenedAt: null,
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

function statusContext(status) {
  const actor = status?.creator;
  if (
    typeof status?.context !== "string" ||
    !["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"].includes(
      status.state,
    ) ||
    !record(actor) ||
    !Number.isSafeInteger(actor.databaseId) ||
    !["Bot", "User"].includes(actor.__typename) ||
    typeof actor.login !== "string"
  )
    providerFailure("migration-provider-status-invalid");
  return {
    conclusion: status.state === "EXPECTED" ? "PENDING" : status.state,
    name: status.context,
    producer: {
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

function pullRequestNode(pullRequest) {
  const commit = pullRequest?.commits?.nodes?.[0]?.commit;
  const rollupState = commit?.statusCheckRollup?.state;
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    !["OPEN", "CLOSED", "MERGED"].includes(pullRequest.state) ||
    typeof pullRequest.merged !== "boolean" ||
    typeof pullRequest.title !== "string" ||
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
  const statusContexts = Array.isArray(commit?.status?.contexts)
    ? commit.status.contexts.map(statusContext)
    : [];
  const duplicateStatusContext =
    new Set(statusContexts.map(({ name }) => name)).size !==
    statusContexts.length;
  if (duplicateStatusContext)
    providerFailure("migration-provider-status-context-conflict");
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
      required: exactStatusContexts
        .map((name) => statusContexts.find((status) => status.name === name))
        .filter((status) => status !== undefined),
    },
    head: { ref: pullRequest.headRefName ?? null, sha: headOid },
    headCommit: commitVerification(commit?.signature),
    labels,
    mergeCommit,
    merged: pullRequest.merged,
    mergedBy: pullRequest.mergedBy?.login ?? null,
    number: pullRequest.number,
    state: pullRequest.state === "OPEN" ? "open" : "closed",
    title: pullRequest.title,
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

async function issueEvents(load, variables, issue, initial) {
  const pages = [connectionPage(initial, null, issueEvent)];
  let after = pages[0].endCursor;
  while (pages.at(-1).hasNextPage) {
    const response = await load(EVENTS_QUERY, {
      after,
      name: variables.name,
      number: issue.number,
      owner: variables.owner,
      repository: variables.repository,
    });
    if (response?.data?.repository?.nameWithOwner !== variables.repository)
      providerFailure("migration-provider-repository-mismatch");
    const page = connectionPage(
      response?.data?.repository?.issue?.timelineItems,
      after,
      issueEvent,
    );
    pages.push(page);
    after = page.endCursor;
  }
  return { pages };
}

async function collaboratorCanClaim(json, repository, login) {
  if (typeof login !== "string" || login === "") return false;
  try {
    const result = await json(
      `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return claimPermissions.has(result?.permission);
  } catch {
    return false;
  }
}

async function addIssueHistoryEvidence(json, repository, issue, events) {
  const ordered = events.pages
    .flatMap((page) => page.nodes)
    .toSorted((left, right) =>
      left.createdAt === right.createdAt
        ? left.action.localeCompare(right.action)
        : left.createdAt.localeCompare(right.createdAt),
    );
  const reopened = ordered.filter(({ action }) => action === "reopened").at(-1);
  issue.reopenedAt = reopened?.createdAt ?? null;
  if (
    issue.labels.includes("status: in progress") &&
    issue.assignees.length === 1
  ) {
    const assignee = issue.assignees[0];
    const latestAssignment = ordered
      .filter((event) => event.assignee === assignee)
      .at(-1);
    if (
      latestAssignment?.action === "assigned" &&
      (await collaboratorCanClaim(json, repository, latestAssignment.actor)) &&
      (await collaboratorCanClaim(json, repository, assignee))
    )
      issue.claim = {
        id: `${issue.number}:assignment:${assignee}:${latestAssignment.createdAt}`,
        validated: true,
      };
  }
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

async function loadProtectedRepositoryContractBindings({
  json,
  protectedDev,
  protectedTree,
  repository,
}) {
  const tree = await json(
    `/repos/${repository}/git/trees/${protectedTree}?recursive=1`,
  );
  if (
    tree?.sha !== protectedTree ||
    tree.truncated === true ||
    !Array.isArray(tree.tree)
  )
    providerFailure("migration-contract-tree-invalid");
  const contractEntries = tree.tree
    .filter(
      (entry) =>
        typeof entry?.path === "string" &&
        entry.path.startsWith("docs/contracts/"),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const nodes = [];
  for (const entry of contractEntries) {
    if (
      entry.type !== "blob" ||
      entry.mode !== "100644" ||
      !/^[0-9a-f]{40}$/u.test(entry.sha ?? "") ||
      parseContractPath(entry.path).ok !== true
    )
      providerFailure("migration-contract-tree-invalid");
    const blob = await json(`/repos/${repository}/git/blobs/${entry.sha}`);
    if (
      blob?.sha !== entry.sha ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string"
    )
      providerFailure("migration-contract-blob-invalid");
    const bytes = Buffer.from(blob.content.replaceAll("\n", ""), "base64");
    if (bytes.toString("base64") !== blob.content.replaceAll("\n", ""))
      providerFailure("migration-contract-blob-invalid");
    nodes.push({
      digest: contractSha256(bytes).digest,
      mode: entry.mode,
      path: entry.path,
    });
  }
  return {
    pages: [
      {
        cursor: null,
        endCursor: nodes.length === 0 ? null : "protected-contracts",
        hasNextPage: false,
        nodes,
        totalCount: nodes.length,
      },
    ],
    protectedDev,
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
  const initialEvents = new Map();
  let protectedDev;
  let protectedTree;
  const issues = await allPages(
    graphql,
    ISSUES_QUERY,
    variables,
    (value) => {
      const branch = value.defaultBranchRef;
      if (
        branch?.name !== "dev" ||
        !/^[0-9a-f]{40}$/u.test(branch?.target?.oid ?? "") ||
        !/^[0-9a-f]{40}$/u.test(branch?.target?.tree?.oid ?? "")
      )
        providerFailure("migration-provider-protected-dev-invalid");
      if (protectedDev !== undefined && protectedDev !== branch.target.oid)
        providerFailure("migration-provider-protected-dev-drift");
      if (
        protectedTree !== undefined &&
        protectedTree !== branch.target.tree.oid
      )
        providerFailure("migration-provider-protected-tree-drift");
      protectedDev = branch.target.oid;
      protectedTree = branch.target.tree.oid;
      return value.issues;
    },
    (value) => {
      const item = issueNode(value);
      comments.set(item.number, value.comments);
      initialEvents.set(item.number, value.timelineItems);
      return item;
    },
  );
  const issueNodes = issues.pages.flatMap((page) => page.nodes);
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
    const events = await issueEvents(
      graphql,
      variables,
      issue,
      initialEvents.get(issue.number),
    );
    await addIssueHistoryEvidence(json, repository, issue, events);
  }
  const pullRequests = await allPages(
    graphql,
    PULL_REQUESTS_QUERY,
    variables,
    (value) => value.pullRequests,
    pullRequestNode,
  );
  const contractSnapshot = await contracts({
    json,
    protectedDev,
    protectedTree,
    repository,
  });
  if (contractSnapshot?.protectedDev !== protectedDev)
    providerFailure("migration-contract-protected-dev-mismatch");
  return {
    allowlistedMergers: ["Niko4417", "oscharko"],
    comments,
    contracts: { pages: contractSnapshot.pages },
    contractsProtectedDev: contractSnapshot.protectedDev,
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
  contracts = loadProtectedRepositoryContractBindings,
  graphql = graphqlRequest,
  json = jsonRequest,
  maximumRequests = 200,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof contracts !== "function")
    throw new TypeError("migration contract reader is invalid");
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
