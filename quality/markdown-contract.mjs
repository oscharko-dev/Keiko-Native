export function markdownLines(value) {
  return typeof value === "string"
    ? value.replaceAll("\r\n", "\n").split("\n")
    : [];
}

export function markdownHeading(line) {
  if (!line.startsWith("##") || !/\s/u.test(line[2] ?? "")) return undefined;
  const heading = line.slice(3).trim();
  return heading === "" ? undefined : heading;
}

export function fieldValue(section, field) {
  const prefix = `- ${field}:`;
  for (const line of markdownLines(section)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (value !== "") return value;
  }
  return undefined;
}

export function logicalListItems(body) {
  const items = [];
  let current;
  for (const line of markdownLines(body)) {
    const isCheckbox =
      line.startsWith("- [") &&
      [" ", "x", "X"].includes(line[3]) &&
      line[4] === "]" &&
      /\s/u.test(line[5] ?? "");
    if (line.startsWith("- ") && !isCheckbox) {
      if (current !== undefined) items.push(current);
      current = line.slice(2).trim();
      continue;
    }
    if (
      current !== undefined &&
      line.length - line.trimStart().length >= 2 &&
      line.trim() !== ""
    ) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    if (current !== undefined) {
      items.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) items.push(current);
  return items;
}

export function splitFencedMarkdown(body) {
  const blocks = [];
  const prose = [];
  let activeBlock;
  let activeFence;
  let commandFence = false;
  for (const line of markdownLines(body)) {
    if (line.trimStart().startsWith("```")) {
      if (activeBlock === undefined) {
        activeBlock = [];
        activeFence = line;
        commandFence = ["", "text", "bash", "sh"].includes(
          line.trim().slice(3).trim(),
        );
      } else {
        if (commandFence) blocks.push(activeBlock.join("\n"));
        activeBlock = undefined;
        activeFence = undefined;
        commandFence = false;
      }
      continue;
    }
    if (activeBlock === undefined) prose.push(line);
    else activeBlock.push(line);
  }
  if (activeBlock !== undefined) prose.push(activeFence, ...activeBlock);
  return { blocks, prose: prose.join("\n") };
}

export function hasAnglePlaceholder(body) {
  return markdownLines(body).some((line) => {
    const opening = line.indexOf("<");
    return opening >= 0 && line.includes(">", opening + 2);
  });
}

export function hasInlineOptionList(body) {
  let opening = body.indexOf("`");
  while (opening >= 0) {
    const closing = body.indexOf("`", opening + 1);
    if (closing < 0) return false;
    if (body.slice(opening + 1, closing).includes("|")) return true;
    opening = body.indexOf("`", closing + 1);
  }
  return false;
}
