const githubApiUrl = "https://api.github.com";

const OWNER = "([A-Za-z0-9-]+)";
const REPOSITORY = "([A-Za-z0-9_.-]+)";
const INTEGER = "([1-9][0-9]*)";
const SHA = "([0-9a-f]{40})";
const ENCODED_SEGMENT = "((?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+)";
const repositoryPrefix = `/repos/${OWNER}/${REPOSITORY}`;

function route(method, suffix, types) {
  return {
    method,
    pattern: new RegExp(`^${repositoryPrefix}${suffix}$`, "u"),
    types: ["owner", "repository", ...types],
  };
}

const routes = [
  route("GET", `/issues/${INTEGER}/comments\\?per_page=100&page=${INTEGER}`, [
    "integer",
    "integer",
  ]),
  route("GET", `/pulls\\?state=(open|closed)&per_page=100&page=${INTEGER}`, [
    "pullState",
    "integer",
  ]),
  route("POST", `/statuses/${SHA}`, ["sha"]),
  route("GET", `/commits/${SHA}/status`, ["sha"]),
  route("GET", `/collaborators/${ENCODED_SEGMENT}/permission`, ["actor"]),
  route("GET", `/issues/${INTEGER}`, ["integer"]),
  route("PATCH", `/issues/${INTEGER}`, ["integer"]),
  route("POST", `/issues/${INTEGER}/labels`, ["integer"]),
  route("DELETE", `/issues/${INTEGER}/labels/${ENCODED_SEGMENT}`, [
    "integer",
    "label",
  ]),
  route("POST", `/issues/${INTEGER}/comments`, ["integer"]),
  route("GET", `/labels\\?per_page=100&page=${INTEGER}`, ["integer"]),
  route("GET", `/pulls/${INTEGER}`, ["integer"]),
];

function isOwner(value) {
  return (
    value.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value)
  );
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

function decodedCanonicalSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      /[\u0000-\u001f\u007f/\\?#]/u.test(decoded) ||
      /%(?:00|23|2e|2f|3f|5c)/iu.test(decoded)
    )
      return undefined;
    return encodeURIComponent(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isActor(value) {
  const decoded = decodedCanonicalSegment(value);
  return (
    decoded !== undefined &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/u.test(decoded)
  );
}

function isLabel(value) {
  return decodedCanonicalSegment(value) !== undefined;
}

const validators = {
  actor: isActor,
  integer: isInteger,
  label: isLabel,
  owner: isOwner,
  pullState: (value) => value === "open" || value === "closed",
  repository: isRepository,
  sha: (value) => /^[0-9a-f]{40}$/u.test(value),
};

function hasValidSyntax(path) {
  if (typeof path !== "string" || path[0] !== "/" || path[1] === "/")
    return false;
  if (/[\p{Cc}\p{Cf}\p{Z}\\#@]/u.test(path)) return false;
  if (/%(?![0-9A-F]{2})/u.test(path)) return false;
  if (/%(?:00|23|2E|2F|3F|5C)/u.test(path)) return false;
  const pathname = path.split("?", 1)[0];
  return !pathname
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function matchesRoute(path, method) {
  return routes.some((candidate) => {
    if (candidate.method !== method) return false;
    const match = candidate.pattern.exec(path);
    return (
      match !== null &&
      candidate.types.every((type, index) => validators[type](match[index + 1]))
    );
  });
}

function validateRequestTarget(path, method) {
  if (!matchesRoute(path, method))
    throw new Error("GitHub API request target is invalid.");
}

function requestUrl(path) {
  const url = new URL(path, githubApiUrl);
  if (
    url.protocol !== "https:" ||
    url.origin !== githubApiUrl ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    `${url.pathname}${url.search}` !== path
  )
    throw new Error("GitHub API request target is invalid.");
  return url.href;
}

export function githubRequestFor(userAgent) {
  return async function githubRequest(path, options = {}) {
    if (!hasValidSyntax(path))
      throw new Error("GitHub API request target is invalid.");
    const method = options.method ?? "GET";
    validateRequestTarget(path, method);
    const url = requestUrl(path);
    const payload = options.payload;
    const response = await fetch(url, {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method,
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} failed with ${response.status}.`);
    }
    return response.status === 204 ? undefined : response.json();
  };
}
