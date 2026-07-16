function codePointLength(value) {
  return [...value].length;
}

function fenceMarker(line) {
  const value = line.trimStart();
  const marker = value[0];
  if (marker !== "`" && marker !== "~") return undefined;
  let length = 0;
  while (value[length] === marker) length += 1;
  return length >= 3 ? { length, marker } : undefined;
}

function htmlElements(line) {
  return [...line.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)\b/gu)].map((match) =>
    match[1]?.toLowerCase(),
  );
}

function headingLevel(line) {
  const value = line.trimStart();
  let level = 0;
  while (value[level] === "#") level += 1;
  return level > 0 && level <= 6 && value[level] === " " ? level : undefined;
}

export function markdownFailures(content, config) {
  const failures = [];
  let fence;
  let previousHeading;
  for (const [index, line] of content.split("\n").entries()) {
    const lineNumber = index + 1;
    const marker = fenceMarker(line);
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker.marker === fence.marker && marker.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (line.includes("\t"))
      failures.push(`${String(lineNumber)}: tab character`);
    if (line.endsWith(" "))
      failures.push(`${String(lineNumber)}: trailing whitespace`);
    if (!line.includes("|") && codePointLength(line) > config.lineLength)
      failures.push(
        `${String(lineNumber)}: line exceeds ${String(config.lineLength)} characters`,
      );
    const disallowed = htmlElements(line).filter(
      (element) =>
        element !== undefined && !config.allowedHtmlElements.includes(element),
    );
    if (disallowed.length > 0)
      failures.push(
        `${String(lineNumber)}: disallowed HTML element ${disallowed[0]}`,
      );
    const level = headingLevel(line);
    if (level !== undefined) {
      if (previousHeading !== undefined && level > previousHeading + 1)
        failures.push(`${String(lineNumber)}: heading level skipped`);
      previousHeading = level;
    }
  }
  if (fence !== undefined) failures.push("unclosed fenced code block");
  return failures;
}
