import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { githubGraphqlRequestFor, githubRequestFor } from "./github-api.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
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
const shaPattern = /^[0-9a-f]{40}$/u;
const manifestPathPattern =
  /^docs\/qa\/repository-migration-manifest-v([1-9]\d*)\.md$/u;
const issueEventActions = new Map([
  ["AssignedEvent", "assigned"],
  ["ReopenedEvent", "reopened"],
  ["UnassignedEvent", "unassigned"],
]);

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
            ... on ReopenedEvent { id createdAt actor { login } }
            ... on AssignedEvent {
              id createdAt actor { login }
              assignee { ... on User { login } }
            }
            ... on UnassignedEvent {
              id createdAt actor { login }
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
          ... on ReopenedEvent { id createdAt actor { login } }
          ... on AssignedEvent {
            id createdAt actor { login }
            assignee { ... on User { login } }
          }
          ... on UnassignedEvent {
            id createdAt actor { login }
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
        number title state merged isDraft mergeable body baseRefName baseRefOid headRefName headRefOid
        headRepository { nameWithOwner }
        mergedBy { login }
        labels(first: 100) { totalCount nodes { name } }
        mergeCommit {
          oid
          signature { isValid state }
          parents(first: 2) { totalCount nodes { oid } }
        }
        commits(first: 100) {
          totalCount
          pageInfo { endCursor hasNextPage }
          nodes {
            commit {
              oid
              signature { isValid state }
            }
          }
        }
        headCommit: commits(last: 1) {
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

const PULL_REQUEST_COMMITS_QUERY = `query MigrationPullRequestCommits($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        totalCount
        pageInfo { endCursor hasNextPage }
        nodes {
          commit {
            oid
            signature { isValid state }
          }
        }
      }
    }
  }
}`;

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sanitizedProviderFailureCodes = new Set([
  "migration-contract-blob-invalid",
  "migration-contract-path-invalid",
  "migration-contract-protected-dev-mismatch",
  "migration-contract-tree-invalid",
  "migration-manifest-blob-invalid",
  "migration-manifest-bytes-invalid",
  "migration-manifest-bytes-noncanonical",
  "migration-manifest-schema-invalid",
  "migration-manifest-tree-invalid",
  "migration-provider-assignees-incomplete",
  "migration-provider-checked-out-dev-mismatch",
  "migration-provider-collaborator-unavailable",
  "migration-provider-comment-invalid",
  "migration-provider-comments-incomplete",
  "migration-provider-connection-invalid",
  "migration-provider-drift",
  "migration-provider-issue-event-invalid",
  "migration-provider-issue-events-incomplete",
  "migration-provider-issue-invalid",
  "migration-provider-issue-labels-incomplete",
  "migration-provider-pr-labels-incomplete",
  "migration-provider-pr-commits-incomplete",
  "migration-provider-protected-dev-drift",
  "migration-provider-protected-dev-invalid",
  "migration-provider-protected-tree-drift",
  "migration-provider-pull-request-invalid",
  "migration-provider-repository-invalid",
  "migration-provider-repository-mismatch",
  "migration-provider-request-ceiling",
  "migration-provider-status-context-conflict",
  "migration-provider-status-invalid",
]);

export function sanitizedMigrationProviderFailure(error) {
  return sanitizedProviderFailureCodes.has(error?.message)
    ? error.message
    : "provider-unavailable";
}

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
    typeof comment.body !== "string" ||
    typeof comment.createdAt !== "string" ||
    !Number.isFinite(Date.parse(comment.createdAt))
  ) {
    providerFailure("migration-provider-comment-invalid");
  }
  if (actor === null)
    return {
      body: comment.body,
      createdAt: comment.createdAt,
      id: comment.databaseId,
      user: { id: null, login: null, type: "Deleted" },
    };
  if (
    !record(actor) ||
    !Number.isSafeInteger(actor.databaseId) ||
    !["Bot", "User"].includes(actor.__typename) ||
    typeof actor.login !== "string"
  )
    providerFailure("migration-provider-comment-invalid");
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
    typeof event.id !== "string" ||
    event.id === "" ||
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
    action: issueEventActions.get(event.__typename),
    actor: actor ?? null,
    assignee: assignee ?? null,
    createdAt: event.createdAt,
    id: event.id,
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

function pullRequestCommitNode(node) {
  if (!shaPattern.test(node?.commit?.oid ?? ""))
    providerFailure("migration-provider-pull-request-invalid");
  return {
    ...commitVerification(node.commit.signature),
    sha: node.commit.oid,
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

function pullRequestNode(pullRequest, commits) {
  const commit = pullRequest?.headCommit?.nodes?.[0]?.commit;
  const rollupState = commit?.statusCheckRollup?.state;
  const headRepository = pullRequest?.headRepository?.nameWithOwner ?? null;
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    !["OPEN", "CLOSED", "MERGED"].includes(pullRequest.state) ||
    typeof pullRequest.merged !== "boolean" ||
    typeof pullRequest.isDraft !== "boolean" ||
    !["CONFLICTING", "MERGEABLE", "UNKNOWN"].includes(pullRequest.mergeable) ||
    typeof pullRequest.title !== "string" ||
    typeof pullRequest.body !== "string" ||
    !(headRepository === null || repositoryPattern.test(headRepository)) ||
    !record(pullRequest.headCommit) ||
    !Number.isSafeInteger(pullRequest.headCommit.totalCount) ||
    pullRequest.headCommit.totalCount < 1 ||
    !Array.isArray(pullRequest.headCommit.nodes) ||
    pullRequest.headCommit.nodes.length !== 1
  ) {
    providerFailure("migration-provider-pull-request-invalid");
  }
  const commitObservations = completePagedNodes(
    commits,
    (item) => item.sha,
    "migration-provider-pr-commits-incomplete",
  );
  if (
    pullRequest.headCommit.totalCount !== commitObservations.length ||
    commitObservations.at(-1)?.sha !== commit?.oid
  )
    providerFailure("migration-provider-pr-commits-incomplete");
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
    head: {
      ref: pullRequest.headRefName ?? null,
      repository: headRepository,
      sha: headOid,
    },
    headCommit: commitVerification(commit?.signature),
    commitsVerified:
      commitObservations.length > 0 &&
      commitObservations.every(
        ({ reason, verified }) => reason === "valid" && verified === true,
      ),
    labels,
    isDraft: pullRequest.isDraft,
    mergeCommit,
    mergeable: pullRequest.mergeable,
    merged: pullRequest.merged,
    mergedBy: pullRequest.mergedBy?.login ?? null,
    number: pullRequest.number,
    state: pullRequest.state === "OPEN" ? "open" : "closed",
    title: pullRequest.title,
  };
}

function completePagedNodes(value, identity, code) {
  if (!record(value) || !Array.isArray(value.pages) || value.pages.length === 0)
    providerFailure(code);
  let priorEnd = null;
  let total;
  const nodes = [];
  const identities = new Set();
  for (let index = 0; index < value.pages.length; index += 1) {
    const page = value.pages[index];
    if (
      !record(page) ||
      page.cursor !== priorEnd ||
      page.totalCount !== (total ?? page.totalCount) ||
      page.hasNextPage !== index < value.pages.length - 1 ||
      (page.hasNextPage && page.endCursor === null)
    )
      providerFailure(code);
    total = page.totalCount;
    priorEnd = page.endCursor;
    for (const node of page.nodes) {
      const id = identity(node);
      if (id === undefined || id === null || identities.has(id))
        providerFailure(code);
      identities.add(id);
      nodes.push(node);
    }
  }
  if (nodes.length !== total) providerFailure(code);
  return nodes;
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

async function pullRequestCommits(load, variables, pullRequest, initial) {
  const pages = [connectionPage(initial, null, pullRequestCommitNode)];
  let after = pages[0].endCursor;
  while (pages.at(-1).hasNextPage) {
    const response = await load(PULL_REQUEST_COMMITS_QUERY, {
      after,
      name: variables.name,
      number: pullRequest.number,
      owner: variables.owner,
      repository: variables.repository,
    });
    if (response?.data?.repository?.nameWithOwner !== variables.repository)
      providerFailure("migration-provider-repository-mismatch");
    const page = connectionPage(
      response?.data?.repository?.pullRequest?.commits,
      after,
      pullRequestCommitNode,
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
  } catch (error) {
    if (sanitizedProviderFailureCodes.has(error?.message)) throw error;
    providerFailure("migration-provider-collaborator-unavailable");
  }
}

async function addIssueHistoryEvidence(
  json,
  repository,
  issue,
  events,
  comments,
) {
  const ordered = completePagedNodes(
    events,
    (event) => event.id,
    "migration-provider-issue-events-incomplete",
  ).toSorted((left, right) =>
    left.createdAt === right.createdAt
      ? left.action.localeCompare(right.action) ||
        left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
  const reopened = ordered.findLast(({ action }) => action === "reopened");
  issue.reopenedAt = reopened?.createdAt ?? null;
  if (
    issue.labels.includes("status: in progress") &&
    issue.assignees.length === 1
  ) {
    const assignee = issue.assignees[0];
    const latestAssignment = ordered.findLast(
      (event) => event.assignee === assignee,
    );
    const completeComments = completePagedNodes(
      comments,
      (comment) => comment.id,
      "migration-provider-comments-incomplete",
    );
    const readiness = readinessRecordFromComments(completeComments);
    const acceptedComment = completeComments.find(
      (comment) => comment.id === readiness?.commentId,
    );
    const claimMustFollow = [
      issue.lastEditedAt,
      issue.reopenedAt,
      readiness?.status === "accepted" ? acceptedComment?.createdAt : null,
    ].filter((value) => value !== null && value !== undefined);
    if (
      latestAssignment?.action === "assigned" &&
      claimMustFollow.every(
        (value) => Date.parse(latestAssignment.createdAt) > Date.parse(value),
      ) &&
      readiness?.status === "accepted" &&
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

async function readProtectedBlob({
  blobFailure,
  entry,
  json,
  repository,
  treeFailure,
  validPath,
}) {
  if (
    entry.type !== "blob" ||
    entry.mode !== "100644" ||
    !shaPattern.test(entry.sha ?? "") ||
    !validPath(entry.path)
  )
    providerFailure(treeFailure);
  const blob = await json(`/repos/${repository}/git/blobs/${entry.sha}`);
  if (
    blob?.sha !== entry.sha ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  )
    providerFailure(blobFailure);
  const encoded = blob.content.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) providerFailure(blobFailure);
  return bytes;
}

async function protectedContractNodes(json, repository, entries) {
  const nodes = [];
  for (const entry of entries) {
    const bytes = await readProtectedBlob({
      blobFailure: "migration-contract-blob-invalid",
      entry,
      json,
      repository,
      treeFailure: "migration-contract-tree-invalid",
      validPath: (path) => parseContractPath(path).ok === true,
    });
    nodes.push({
      digest: contractSha256(bytes).digest,
      mode: entry.mode,
      path: entry.path,
    });
  }
  return nodes;
}

function manifestPredecessor(bytes) {
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (text !== `${JSON.stringify(value)}\n`)
      providerFailure("migration-manifest-bytes-noncanonical");
  } catch (error) {
    if (error?.message?.startsWith("migration-manifest-")) throw error;
    providerFailure("migration-manifest-bytes-invalid");
  }
  if (
    !record(value) ||
    !Array.isArray(value.entries) ||
    !(value.predecessor === null || record(value.predecessor))
  )
    providerFailure("migration-manifest-schema-invalid");
  return value.predecessor;
}

async function protectedManifestNodes(json, repository, entries) {
  const nodes = [];
  for (const entry of entries) {
    const bytes = await readProtectedBlob({
      blobFailure: "migration-manifest-blob-invalid",
      entry,
      json,
      repository,
      treeFailure: "migration-manifest-tree-invalid",
      validPath: (path) => manifestPathPattern.test(path),
    });
    nodes.push({
      digest: contractSha256(bytes).digest,
      mode: entry.mode,
      path: entry.path,
      predecessor: manifestPredecessor(bytes),
    });
  }
  return nodes;
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
  const nodes = await protectedContractNodes(json, repository, contractEntries);
  const manifestEntries = tree.tree
    .filter(
      (entry) =>
        typeof entry?.path === "string" && manifestPathPattern.test(entry.path),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const manifests = await protectedManifestNodes(
    json,
    repository,
    manifestEntries,
  );
  return {
    contracts: {
      pages: [
        {
          cursor: null,
          endCursor: nodes.length === 0 ? null : "protected-contracts",
          hasNextPage: false,
          nodes,
          totalCount: nodes.length,
        },
      ],
    },
    manifests: {
      pages: [
        {
          cursor: null,
          endCursor: manifests.length === 0 ? null : "protected-manifests",
          hasNextPage: false,
          nodes: manifests,
          totalCount: manifests.length,
        },
      ],
    },
    protectedDev,
  };
}

async function scan({
  contracts,
  expectedProtectedDev,
  graphql,
  json,
  now,
  repository,
}) {
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
      if (
        expectedProtectedDev !== null &&
        protectedDev !== expectedProtectedDev
      )
        providerFailure("migration-provider-checked-out-dev-mismatch");
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
    await addIssueHistoryEvidence(
      json,
      repository,
      issue,
      events,
      comments.get(issue.number),
    );
  }
  const pullRequests = await allPages(
    graphql,
    PULL_REQUESTS_QUERY,
    variables,
    (value) => value.pullRequests,
    (value) => value,
  );
  for (const page of pullRequests.pages) {
    const mapped = [];
    for (const pullRequest of page.nodes) {
      const commits = await pullRequestCommits(
        graphql,
        variables,
        pullRequest,
        pullRequest.commits,
      );
      mapped.push(pullRequestNode(pullRequest, commits));
    }
    page.nodes = mapped;
  }
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
    contracts: contractSnapshot.contracts,
    contractsProtectedDev: contractSnapshot.protectedDev,
    issues,
    labels,
    manifests: contractSnapshot.manifests,
    manifestsProtectedDev: contractSnapshot.protectedDev,
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
  expectedProtectedDev = null,
  graphql = graphqlRequest,
  json = jsonRequest,
  maximumRequests = 200,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof contracts !== "function")
    throw new TypeError("migration contract reader is invalid");
  if (expectedProtectedDev !== null && !shaPattern.test(expectedProtectedDev))
    throw new TypeError("expected protected dev is invalid");
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
        expectedProtectedDev,
        graphql: countedGraphql,
        json: countedJson,
        now,
        repository,
      });
      const second = await scan({
        contracts,
        expectedProtectedDev,
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
