const githubApiUrl = "https://api.github.com";

export function githubRequestFor(userAgent) {
  return async function githubRequest(path, { method = "GET", payload } = {}) {
    const response = await fetch(`${githubApiUrl}${path}`, {
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
      const message = await response.text();
      throw new Error(
        `GitHub API ${method} ${path} failed with ${response.status}: ${message.slice(0, 300)}`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  };
}
