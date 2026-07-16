function positiveInteger(value) {
  return /^[1-9]\d*$/u.test(value) ? Number(value) : undefined;
}

function githubUrl(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== ""
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function issuePath(parsed) {
  const segments = parsed.pathname.split("/");
  if (segments.length === 6 && segments.at(-1) === "") segments.pop();
  if (
    segments.length !== 5 ||
    segments[0] !== "" ||
    segments[1] === "" ||
    segments[2] === "" ||
    segments[3] !== "issues"
  )
    return undefined;
  const issueNumber = positiveInteger(segments[4]);
  return issueNumber === undefined
    ? undefined
    : { issueNumber, repository: `${segments[1]}/${segments[2]}` };
}

export function issueNumberFromReference(value) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("#")) return positiveInteger(value.slice(1));
  const parsed = githubUrl(value);
  if (parsed?.hash !== "") return undefined;
  return issuePath(parsed)?.issueNumber;
}

export function readinessCommentReference(value) {
  if (typeof value !== "string") return undefined;
  const parsed = githubUrl(value);
  const path = parsed === undefined ? undefined : issuePath(parsed);
  const hashPrefix = "#issuecomment-";
  if (path === undefined || !parsed.hash.startsWith(hashPrefix))
    return undefined;
  const commentId = positiveInteger(parsed.hash.slice(hashPrefix.length));
  return commentId === undefined ? undefined : { commentId, ...path };
}
