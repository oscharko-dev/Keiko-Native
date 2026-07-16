const githubApiUrl = "https://api.github.com";
const maximumAttempts = 3;
const maximumDelayMilliseconds = 1_000;
const retryableStatuses = new Set([429, 502, 503, 504]);

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(value) {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return maximumDelayMilliseconds;
  return Math.min(seconds * 1_000, maximumDelayMilliseconds);
}

function retryDelay(response, attempt) {
  const retryAfter = retryAfterMilliseconds(
    response?.headers.get("Retry-After") ?? null,
  );
  return (
    retryAfter ?? Math.min(100 * 2 ** (attempt - 1), maximumDelayMilliseconds)
  );
}

async function cancelResponseBody(response) {
  await response.body?.cancel().catch(() => undefined);
}

function statusFailure(method, path, status, attempt) {
  const attemptLabel = attempt === 1 ? "attempt" : "attempts";
  return new Error(
    `GitHub API ${method} ${path} failed with ${status} after ${attempt} ${attemptLabel}.`,
  );
}

function transportFailure(method, path, attempt) {
  const attemptLabel = attempt === 1 ? "attempt" : "attempts";
  return new Error(
    `GitHub API ${method} ${path} failed after ${attempt} ${attemptLabel}: transport error.`,
  );
}

export function githubRequestFor(
  userAgent,
  { fetch: fetchImplementation, sleep = defaultSleep } = {},
) {
  return async function githubRequest(path, { method = "GET", payload } = {}) {
    const normalizedMethod = method.toUpperCase();
    const request = {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: normalizedMethod,
    };
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let response;
      try {
        response = await (fetchImplementation ?? globalThis.fetch)(
          `${githubApiUrl}${path}`,
          request,
        );
      } catch {
        if (normalizedMethod !== "GET" || attempt === maximumAttempts)
          throw transportFailure(normalizedMethod, path, attempt);
        await sleep(retryDelay(undefined, attempt));
        continue;
      }
      if (response.ok)
        return response.status === 204 ? undefined : response.json();

      const canRetry =
        normalizedMethod === "GET" &&
        retryableStatuses.has(response.status) &&
        attempt < maximumAttempts;
      const delay = canRetry ? retryDelay(response, attempt) : undefined;
      await cancelResponseBody(response);
      if (!canRetry)
        throw statusFailure(normalizedMethod, path, response.status, attempt);
      await sleep(delay);
    }
  };
}
