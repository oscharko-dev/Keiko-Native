import {
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
} from "./epic-merge-policy.mjs";
import {
  epicMergeFindingCurrent as validFinding,
  epicMergePullResponseCurrent as validPull,
} from "./epic-merge-authorization.mjs";
import { listEpicMergeReviewThreads } from "./epic-merge-graphql.mjs";

const prefix = `/repos/${EPIC_MERGE_REPOSITORY}`;
const PAGE_LIMIT = 100;
const closingIssue =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)/iu;
const ok = (response) =>
  response?.status === 200 &&
  response.body !== null &&
  typeof response.body === "object";
const pageNumber = (response, current) => {
  const link = response?.headers?.link;
  if (typeof link !== "string") return null;
  const nextLink = link
    .split(",")
    .find((value) =>
      value.split(";").some((attribute) => attribute.trim() === 'rel="next"'),
    );
  if (nextLink === undefined) return null;
  const start = nextLink.indexOf("<");
  const end = nextLink.indexOf(">");
  if (start < 0 || end <= start + 1) return undefined;
  let pageValue;
  try {
    pageValue = new URL(nextLink.slice(start + 1, end)).searchParams.get(
      "page",
    );
  } catch {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(pageValue ?? "")) return undefined;
  const next = Number(pageValue);
  return Number.isSafeInteger(next) && next > current ? next : undefined;
};
const page = (response, current, select = (body) => body) => {
  const items = select(response?.body);
  const nextPage = pageNumber(response, current);
  return response?.status === 200 &&
    Array.isArray(items) &&
    nextPage !== undefined
    ? { items, nextPage }
    : { items: [], nextPage: undefined };
};
const requestPath = (path, query = {}) => {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  return search.size > 0 ? `${path}?${search}` : path;
};
const encoded = (value) => encodeURIComponent(value);
const commitSha = (value) => isEpicMergeCommit(value);
const policyDocument = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalidPolicySource = (revision) => ({
  document: null,
  protected: false,
  ref: "refs/heads/dev",
  revision,
});

function authenticatedUser(response) {
  const user = response?.body;
  return ok(response) &&
    Number.isSafeInteger(user?.id) &&
    user.id > 0 &&
    typeof user.login === "string" &&
    user.type === "User"
    ? { id: user.id, login: user.login }
    : null;
}

function classicBypass(protection, user) {
  const allowances =
    protection?.required_pull_request_reviews?.bypass_pull_request_allowances;
  if (allowances === undefined || allowances === null) return false;
  const users = allowances.users;
  const teams = allowances.teams;
  const apps = allowances.apps;
  if (
    !Array.isArray(users) ||
    !Array.isArray(teams) ||
    !Array.isArray(apps) ||
    users.some(
      (candidate) =>
        !Number.isSafeInteger(candidate?.id) ||
        candidate.id <= 0 ||
        candidate.type !== "User",
    )
  )
    return null;
  if (users.some((candidate) => candidate.id === user.id)) return true;
  return teams.length === 0 && apps.length === 0 ? false : null;
}

function rulesetBypass(rulesets, user) {
  const actors = rulesets.flatMap((ruleset) => ruleset.bypass_actors);
  if (
    actors.some(
      (actor) => actor?.actor_id === user.id || actor?.actor?.id === user.id,
    )
  )
    return true;
  return actors.length === 0 ? false : null;
}

function normalizedRule(ruleset, protection, target) {
  const types = new Map(
    (Array.isArray(ruleset?.rules) ? ruleset.rules : []).map((rule) => [
      rule?.type,
      rule,
    ]),
  );
  return {
    bypassActors: ruleset.bypass_actors.map(
      (actor) => actor?.actor?.name ?? actor?.actor_id,
    ),
    controls: {
      deletionBlocked:
        types.has("deletion") && protection?.allow_deletions?.enabled === false,
      forcePushBlocked:
        types.has("non_fast_forward") &&
        protection?.allow_force_pushes?.enabled === false,
      pullRequestRequired:
        types.has("pull_request") &&
        protection?.required_pull_request_reviews !== null,
      requiredSignatures:
        types.has("required_signatures") &&
        protection?.required_signatures?.enabled === true,
      requiredStatusChecks: {
        strict:
          types.get("required_status_checks")?.parameters
            ?.strict_required_status_checks_policy === true &&
          protection?.required_status_checks?.strict === true,
      },
    },
    enforcement: ruleset?.enforcement,
    id: ruleset?.id,
    target,
  };
}

export function createEpicMergeGitHubBoundary({ request }) {
  if (typeof request !== "function")
    throw new Error("invalid_epic_merge_github_boundary");
  const get = (path) => request({ method: "GET", path });

  async function readPullRequest({ pullRequest }) {
    const response = await get(`${prefix}/pulls/${String(pullRequest)}`);
    if (!ok(response)) return null;
    const raw = response.body;
    if (!validPull(raw, pullRequest)) return null;
    const issueMatch = closingIssue.exec(raw.body);
    const commit = await get(`${prefix}/git/commits/${raw.head?.sha}`);
    if (
      !ok(commit) ||
      commit.body?.sha !== raw.head.sha ||
      !commitSha(commit.body?.tree?.sha)
    )
      return null;
    return {
      ...raw,
      head: {
        ...raw.head,
        tree: ok(commit) ? commit.body.tree?.sha : null,
      },
      issue: issueMatch === null ? null : Number(issueMatch[1]),
    };
  }

  async function protection(target) {
    return get(`${prefix}/branches/${encoded(target)}/protection`);
  }

  async function applicableRuleSetIds(target) {
    const ids = new Set();
    let number = 1;
    for (let count = 0; count < PAGE_LIMIT; count += 1) {
      const result = page(
        await get(
          requestPath(`${prefix}/rules/branches/${encoded(target)}`, {
            page: number,
            per_page: 100,
          }),
        ),
        number,
      );
      if (
        result.nextPage === undefined ||
        result.items.some(
          (rule) =>
            !Number.isSafeInteger(rule?.ruleset_id) || rule.ruleset_id <= 0,
        )
      )
        return null;
      for (const rule of result.items) ids.add(rule.ruleset_id);
      if (result.nextPage === null) return ids;
      number = result.nextPage;
    }
    return null;
  }

  async function rulesets(target, number) {
    const [response, applicableIds] = await Promise.all([
      get(
        requestPath(`${prefix}/rulesets`, {
          includes_parents: true,
          page: number,
          per_page: 100,
        }),
      ),
      applicableRuleSetIds(target),
    ]);
    const result = page(response, number);
    if (
      applicableIds === null ||
      result.nextPage === undefined ||
      result.items.some(
        (item) => !Number.isSafeInteger(item?.id) || item.id <= 0,
      )
    )
      return { items: [], nextPage: undefined, valid: false };
    const details = await Promise.all(
      result.items.map((item) => get(`${prefix}/rulesets/${String(item.id)}`)),
    );
    if (
      details.some(
        (detail, index) =>
          !ok(detail) ||
          detail.body?.id !== result.items[index].id ||
          !Array.isArray(detail.body?.bypass_actors) ||
          !Array.isArray(detail.body?.rules) ||
          !Array.isArray(detail.body?.conditions?.ref_name?.include) ||
          !Array.isArray(detail.body?.conditions?.ref_name?.exclude),
      )
    )
      return { items: [], nextPage: undefined, valid: false };
    return {
      items: details
        .map((detail) => detail.body)
        .filter(
          (item) => item.enforcement === "active" && applicableIds.has(item.id),
        ),
      nextPage: result.nextPage,
      valid: true,
    };
  }

  async function mergeObservation({ pullRequest, target }) {
    const [pull, targetRef] = await Promise.all([
      get(`${prefix}/pulls/${String(pullRequest)}`),
      get(`${prefix}/git/ref/heads/${encoded(target)}`),
    ]);
    if (
      !ok(pull) ||
      !ok(targetRef) ||
      !validPull(pull.body, pullRequest, false) ||
      typeof pull.body.merged !== "boolean" ||
      !commitSha(targetRef.body?.object?.sha)
    )
      return null;
    const sha = pull.body.merge_commit_sha;
    const mergeCommit = commitSha(sha)
      ? await get(`${prefix}/git/commits/${sha}`)
      : null;
    if (
      pull.body.merged === true &&
      (!ok(mergeCommit) ||
        mergeCommit.body?.sha !== sha ||
        !commitSha(mergeCommit.body?.tree?.sha) ||
        !Array.isArray(mergeCommit.body?.parents) ||
        !mergeCommit.body.parents.every((parent) => commitSha(parent?.sha)))
    )
      return null;
    return {
      base: pull.body.base.sha,
      commit: {
        parents: (mergeCommit?.body?.parents ?? []).map(
          (parent) => parent?.sha,
        ),
        sha,
        tree: mergeCommit?.body?.tree?.sha,
      },
      merged: pull.body.merged === true,
      pullRequest,
      source: pull.body.head.ref,
      sourceHead: pull.body.head.sha,
      target: pull.body.base.ref,
      targetTip: targetRef.body.object.sha,
    };
  }

  return Object.freeze({
    listChecks: async ({ head, page: number }) =>
      page(
        await get(
          requestPath(`${prefix}/commits/${head}/check-runs`, {
            filter: "latest",
            page: number,
            per_page: 100,
          }),
        ),
        number,
        (body) => body?.check_runs,
      ),
    listCommitStatuses: async ({ head, page: number }) =>
      page(
        await get(
          requestPath(`${prefix}/commits/${head}/statuses`, {
            page: number,
            per_page: 100,
          }),
        ),
        number,
      ),
    listConversations: (input) =>
      listEpicMergeReviewThreads({ ...input, request }),
    listFindings: async ({ pullRequest, page: number }) => {
      const result = page(
        await get(
          requestPath(`${prefix}/code-scanning/alerts`, {
            page: number,
            per_page: 100,
            pr: pullRequest,
          }),
        ),
        number,
      );
      return result.nextPage === undefined ||
        result.items.some((item) => !validFinding(item, pullRequest))
        ? { items: [], nextPage: undefined }
        : {
            items: result.items.map((item) => ({
              blocking: item.state === "open",
            })),
            nextPage: result.nextPage,
          };
    },
    listIssueComments: async ({ issue, page: number }) =>
      page(
        await get(
          requestPath(`${prefix}/issues/${String(issue)}/comments`, {
            page: number,
            per_page: 100,
          }),
        ),
        number,
      ),
    listTargetRules: async ({ page: number, target }) => {
      const [protectedBranch, applicable] = await Promise.all([
        protection(target),
        rulesets(target, number),
      ]);
      return !ok(protectedBranch)
        ? { items: [], nextPage: undefined }
        : {
            items: applicable.items.map((item) =>
              normalizedRule(item, protectedBranch.body, target),
            ),
            nextPage: applicable.nextPage,
          };
    },
    merge: async (input) =>
      request({
        body: {
          merge_method: input.merge_method,
          sha: input.sha,
        },
        method: "PUT",
        path: `${prefix}/pulls/${String(input.pullRequest)}/merge`,
        signal: input.signal,
      }),
    readIssue: async ({ issue }) => {
      const response = await get(`${prefix}/issues/${String(issue)}`);
      const body = response?.body;
      return ok(response) &&
        body?.number === issue &&
        ["closed", "open"].includes(body.state) &&
        typeof body.title === "string" &&
        typeof body.body === "string" &&
        Array.isArray(body.labels)
        ? body
        : null;
    },
    readPermission: async ({ actor, target }) => {
      const userResponse = await request({ method: "GET", path: "/user" });
      const user = authenticatedUser(userResponse);
      if (
        user === null ||
        (actor !== undefined &&
          (typeof actor !== "string" ||
            actor.toLowerCase() !== user.login.toLowerCase()))
      )
        return null;
      const login = actor ?? user.login;
      const [permission, protectedBranch, applicable] = await Promise.all([
        get(`${prefix}/collaborators/${encoded(login)}/permission`),
        protection(target),
        rulesets(target, 1),
      ]);
      if (
        !ok(permission) ||
        !["admin", "maintain", "push", "read", "triage"].includes(
          permission.body?.permission,
        ) ||
        !ok(protectedBranch) ||
        applicable.valid !== true
      )
        return null;
      const classic = classicBypass(protectedBranch.body, user);
      const ruleset = rulesetBypass(applicable.items, user);
      return {
        bypass:
          protectedBranch.body?.enforce_admins?.enabled !== true ||
          classic === null ||
          ruleset === null
            ? null
            : classic || ruleset,
        permission: permission?.body?.permission,
      };
    },
    readPolicy: async () => {
      const [ref, protectedDev] = await Promise.all([
        get(`${prefix}/git/ref/heads/dev`),
        protection("dev"),
      ]);
      const revision = ref?.body?.object?.sha;
      if (
        !ok(ref) ||
        !commitSha(revision) ||
        !ok(protectedDev) ||
        protectedDev.body?.enforce_admins?.enabled !== true
      )
        return {
          document: null,
          protected: false,
          ref: commitSha(revision) ? "refs/heads/dev" : null,
          revision: commitSha(revision) ? revision : null,
        };
      const response = await get(
        requestPath(`${prefix}/contents/quality/epic-merge-policy.json`, {
          ref: revision,
        }),
      );
      if (
        !ok(response) ||
        response.body?.encoding !== "base64" ||
        typeof response.body?.content !== "string"
      )
        return invalidPolicySource(revision);
      let document;
      try {
        document = JSON.parse(
          Buffer.from(response.body.content, "base64").toString("utf8"),
        );
      } catch {
        return invalidPolicySource(revision);
      }
      if (!policyDocument(document)) return invalidPolicySource(revision);
      return {
        document,
        protected: true,
        ref: "refs/heads/dev",
        revision,
      };
    },
    readMergeOutcome: mergeObservation,
    readPullRequest,
    readReconciliation: mergeObservation,
    readRef: async ({ ref }) => {
      const response = await get(`${prefix}/git/ref/heads/${encoded(ref)}`);
      return ok(response) && commitSha(response.body?.object?.sha)
        ? response.body.object
        : null;
    },
  });
}
