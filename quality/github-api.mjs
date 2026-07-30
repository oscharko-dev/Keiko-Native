const githubApiUrl = "https://api.github.com";

const OWNER = "([A-Za-z0-9-]+)";
const REPOSITORY = "([A-Za-z0-9_.-]+)";
const INTEGER = "([1-9][0-9]*)";
const SHA = "([0-9a-f]{40})";
const SHA256 = "([0-9a-f]{64})";
const ENCODED_SEGMENT = "((?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+)";
const repositoryPrefix = `/repos/${OWNER}/${REPOSITORY}`;
const completeTagEmoji = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const completeZwjEmoji =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)+/gu;

function route(method, suffix, types, build) {
  return {
    build,
    method,
    pattern: new RegExp(`^${repositoryPrefix}${suffix}$`, "u"),
    types: ["owner", "repository", ...types],
  };
}

const routes = [
  route(
    "GET",
    String.raw`/issues\?state=open&per_page=100&page=${INTEGER}`,
    ["integer"],
    ([owner, repository, page]) =>
      `/repos/${owner}/${repository}/issues?state=open&per_page=100&page=${page}`,
  ),
  route(
    "GET",
    String.raw`/issues/${INTEGER}/comments\?per_page=100&page=${INTEGER}`,
    ["integer", "integer"],
    ([owner, repository, issue, page]) =>
      `/repos/${owner}/${repository}/issues/${issue}/comments?per_page=100&page=${page}`,
  ),
  route(
    "GET",
    String.raw`/issues/${INTEGER}/comments\?sort=created&direction=desc&per_page=100&page=${INTEGER}`,
    ["integer", "integer"],
    ([owner, repository, issue, page]) =>
      `/repos/${owner}/${repository}/issues/${issue}/comments?sort=created&direction=desc&per_page=100&page=${page}`,
  ),
  route(
    "GET",
    String.raw`/pulls\?state=(open|closed)&per_page=100&page=${INTEGER}`,
    ["pullState", "integer"],
    ([owner, repository, state, page]) =>
      `/repos/${owner}/${repository}/pulls?state=${state}&per_page=100&page=${page}`,
  ),
  route(
    "POST",
    `/statuses/${SHA}`,
    ["sha"],
    ([owner, repository, sha]) =>
      `/repos/${owner}/${repository}/statuses/${sha}`,
  ),
  route(
    "GET",
    `/commits/${SHA}/status`,
    ["sha"],
    ([owner, repository, sha]) =>
      `/repos/${owner}/${repository}/commits/${sha}/status`,
  ),
  route(
    "GET",
    `/collaborators/${ENCODED_SEGMENT}/permission`,
    ["actor"],
    ([owner, repository, actor]) =>
      `/repos/${owner}/${repository}/collaborators/${actor}/permission`,
  ),
  route(
    "GET",
    `/issues/${INTEGER}`,
    ["integer"],
    ([owner, repository, issue]) =>
      `/repos/${owner}/${repository}/issues/${issue}`,
  ),
  route(
    "GET",
    `/issues/comments/${INTEGER}`,
    ["integer"],
    ([owner, repository, comment]) =>
      `/repos/${owner}/${repository}/issues/comments/${comment}`,
  ),
  route(
    "PATCH",
    `/issues/${INTEGER}`,
    ["integer"],
    ([owner, repository, issue]) =>
      `/repos/${owner}/${repository}/issues/${issue}`,
  ),
  route(
    "POST",
    `/issues/${INTEGER}/labels`,
    ["integer"],
    ([owner, repository, issue]) =>
      `/repos/${owner}/${repository}/issues/${issue}/labels`,
  ),
  route(
    "DELETE",
    `/issues/${INTEGER}/labels/${ENCODED_SEGMENT}`,
    ["integer", "label"],
    ([owner, repository, issue, label]) =>
      `/repos/${owner}/${repository}/issues/${issue}/labels/${label}`,
  ),
  route(
    "POST",
    `/issues/${INTEGER}/comments`,
    ["integer"],
    ([owner, repository, issue]) =>
      `/repos/${owner}/${repository}/issues/${issue}/comments`,
  ),
  route(
    "GET",
    String.raw`/labels\?per_page=100&page=${INTEGER}`,
    ["integer"],
    ([owner, repository, page]) =>
      `/repos/${owner}/${repository}/labels?per_page=100&page=${page}`,
  ),
  route(
    "GET",
    `/pulls/${INTEGER}`,
    ["integer"],
    ([owner, repository, pull]) =>
      `/repos/${owner}/${repository}/pulls/${pull}`,
  ),
  route(
    "GET",
    `/actions/runs/${INTEGER}`,
    ["integer"],
    ([owner, repository, run]) =>
      `/repos/${owner}/${repository}/actions/runs/${run}`,
  ),
  route(
    "GET",
    String.raw`/actions/runs/${INTEGER}/artifacts\?per_page=100`,
    ["integer"],
    ([owner, repository, run]) =>
      `/repos/${owner}/${repository}/actions/runs/${run}/artifacts?per_page=100`,
  ),
  route(
    "GET",
    String.raw`/actions/artifacts\?name=${ENCODED_SEGMENT}&per_page=100&page=${INTEGER}`,
    ["label", "integer"],
    ([owner, repository, name, page]) =>
      `/repos/${owner}/${repository}/actions/artifacts?name=${name}&per_page=100&page=${page}`,
  ),
  route(
    "GET",
    String.raw`/actions/runs/${INTEGER}/jobs\?filter=all&per_page=100`,
    ["integer"],
    ([owner, repository, run]) =>
      `/repos/${owner}/${repository}/actions/runs/${run}/jobs?filter=all&per_page=100`,
  ),
  route(
    "GET",
    `/actions/jobs/${INTEGER}`,
    ["integer"],
    ([owner, repository, job]) =>
      `/repos/${owner}/${repository}/actions/jobs/${job}`,
  ),
  route(
    "GET",
    `/actions/artifacts/${INTEGER}/zip`,
    ["integer"],
    ([owner, repository, artifact]) =>
      `/repos/${owner}/${repository}/actions/artifacts/${artifact}/zip`,
  ),
  route(
    "GET",
    `/attestations/sha256:${SHA256}`,
    ["sha256"],
    ([owner, repository, digest]) =>
      `/repos/${owner}/${repository}/attestations/sha256:${digest}`,
  ),
  route(
    "GET",
    String.raw`/compare/${SHA}\.\.\.dev`,
    ["sha"],
    ([owner, repository, commit]) =>
      `/repos/${owner}/${repository}/compare/${commit}...dev`,
  ),
];

function isLogin(value, maximumLength) {
  return (
    value.length <= maximumLength &&
    !value.includes("--") &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value)
  );
}

function isOwner(value) {
  return isLogin(value, 39);
}

function isRepository(value) {
  return (
    value.length <= 100 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}

function isInteger(value) {
  return Number.isSafeInteger(Number(value));
}

function hasHostileFormat(value) {
  const withoutTagEmoji = value.replace(completeTagEmoji, "");
  const withoutValidEmoji = withoutTagEmoji.replace(completeZwjEmoji, "");
  return /\p{Cf}/u.test(withoutValidEmoji);
}

function decodedCanonicalSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      /[\p{Cc}/\\?#]/u.test(decoded) ||
      hasHostileFormat(decoded) ||
      /%(?:00|23|2e|2f|3f|5c)/iu.test(decoded)
    )
      return undefined;
    return encodeURIComponent(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function normalizedActor(value) {
  const decoded = decodedCanonicalSegment(value);
  if (decoded === undefined || decoded.length > 39) return undefined;
  const login = decoded.endsWith("[bot]") ? decoded.slice(0, -5) : decoded;
  return isLogin(login, 39) ? decoded : undefined;
}

function normalizedLabel(value) {
  const decoded = decodedCanonicalSegment(value);
  return decoded !== undefined && Array.from(decoded).length <= 100
    ? decoded
    : undefined;
}

const plainValueValidators = {
  integer: isInteger,
  owner: isOwner,
  pullState: (value) => ["open", "closed"].includes(value),
  repository: isRepository,
  sha: (value) => /^[0-9a-f]{40}$/u.test(value),
  sha256: (value) => /^[0-9a-f]{64}$/u.test(value),
};

export function githubSha256Subject(identity) {
  if (typeof identity !== "string" || !/^[0-9a-f]{64}$/u.test(identity))
    throw new TypeError("GitHub SHA-256 identity is invalid.");
  return `sha256:${identity}`;
}

function hasValidSyntax(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    return false;
  if (/[\p{Cc}\p{Cf}\p{Z}\\#@]/u.test(path)) return false;
  if (/%(?![0-9A-F]{2})/u.test(path)) return false;
  if (/%(?:00|23|2E|2F|3F|5C)/u.test(path)) return false;
  const pathname = path.split("?", 1)[0];
  return !pathname
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function normalizedValue(type, value) {
  if (type === "actor") return normalizedActor(value);
  if (type === "label") return normalizedLabel(value);
  return plainValueValidators[type]?.(value) ? value : undefined;
}

function canonicalValue(type, value) {
  const normalized = normalizedValue(type, value);
  return normalized === undefined ? undefined : encodeURIComponent(normalized);
}

function reconstructedTarget(path, method) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(path);
    if (match === null) continue;
    const values = candidate.types.map((type, index) =>
      canonicalValue(type, match[index + 1]),
    );
    if (!values.includes(undefined)) return candidate.build(values);
  }
  return undefined;
}

function validateRequestTarget(path, method) {
  const target = reconstructedTarget(path, method);
  if (target === undefined || target !== path)
    throw new Error("GitHub API request target is invalid.");
  return target;
}

function requestUrl(canonicalTarget) {
  const query = canonicalTarget.indexOf("?");
  const pathname =
    query === -1 ? canonicalTarget : canonicalTarget.slice(0, query);
  const search = query === -1 ? "" : canonicalTarget.slice(query);
  const url = new URL(githubApiUrl);
  url.pathname = pathname;
  url.search = search;
  if (
    url.protocol !== "https:" ||
    url.origin !== githubApiUrl ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    `${url.pathname}${url.search}` !== canonicalTarget
  )
    throw new Error("GitHub API request target is invalid.");
  return url.href;
}

async function fetchResponse(url, options, method) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(
      `GitHub API ${method} request failed: provider timeout or unavailable.`,
    );
  }
}

async function discardResponseBody(response) {
  try {
    if (!response.bodyUsed) await response.body?.cancel();
    return "";
  } catch {
    return " Response cleanup failed.";
  }
}

async function parseResponseJson(response, method) {
  try {
    return await response.json();
  } catch {
    const cleanupNote = await discardResponseBody(response);
    throw new Error(
      `GitHub API ${method} response failed: invalid JSON.${cleanupNote}`,
    );
  }
}

export function githubRequestFor(userAgent) {
  return async function githubRequest(path, options = {}) {
    if (!hasValidSyntax(path))
      throw new Error("GitHub API request target is invalid.");
    const method = options.method ?? "GET";
    const canonicalTarget = validateRequestTarget(path, method);
    const url = requestUrl(canonicalTarget);
    const payload = options.payload;
    const response = await fetchResponse(
      url,
      {
        body: payload === undefined ? undefined : JSON.stringify(payload),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        method,
      },
      method,
    );
    if (!response.ok) {
      const cleanupNote = await discardResponseBody(response);
      throw new Error(
        `GitHub API ${method} failed with ${response.status}.${cleanupNote}`,
      );
    }
    return response.status === 204
      ? undefined
      : parseResponseJson(response, method);
  };
}

export function githubBinaryRequestFor(userAgent) {
  return async function githubBinaryRequest(path) {
    if (!hasValidSyntax(path))
      throw new Error("GitHub API request target is invalid.");
    const method = "GET";
    const canonicalTarget = validateRequestTarget(path, method);
    const response = await fetchResponse(
      requestUrl(canonicalTarget),
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "User-Agent": userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        method,
        redirect: "follow",
      },
      method,
    );
    if (!response.ok) {
      const cleanupNote = await discardResponseBody(response);
      throw new Error(
        `GitHub API ${method} failed with ${response.status}.${cleanupNote}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 65_536)
      throw new Error("GitHub API artifact exceeds 65,536 bytes.");
    return bytes;
  };
}

export function githubGraphqlRequestFor(userAgent) {
  return async function githubGraphqlRequest(query, variables) {
    if (
      typeof query !== "string" ||
      query.length === 0 ||
      query.length > 16_384 ||
      variables === null ||
      typeof variables !== "object" ||
      Array.isArray(variables)
    )
      throw new Error("GitHub GraphQL request is invalid.");
    const method = "POST";
    const response = await fetchResponse(
      `${githubApiUrl}/graphql`,
      {
        body: JSON.stringify({ query, variables }),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        method,
      },
      method,
    );
    if (!response.ok) {
      const cleanupNote = await discardResponseBody(response);
      throw new Error(
        `GitHub GraphQL request failed with ${response.status}.${cleanupNote}`,
      );
    }
    const body = await parseResponseJson(response, method);
    if (body?.errors !== undefined)
      throw new Error("GitHub GraphQL response contains errors.");
    return body;
  };
}
