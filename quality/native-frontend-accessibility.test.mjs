import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheet = await readFile(
  new URL("../native/frontend/src/foundation.css", import.meta.url),
  "utf8",
);

function token(block, name) {
  const value = block.match(
    new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "iu"),
  )?.[1];
  assert.ok(value, `${name} must remain an explicit hexadecimal color token`);
  return value;
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color
      .slice(1)
      .match(/.{2}/gu)
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function assertMinimumContrast(foreground, background, minimum, label) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label} contrast ${ratio.toFixed(3)} must be at least ${minimum}:1`,
  );
}

test("foundation interaction tokens retain WCAG 2.2 AA contrast", () => {
  const defaultTokens = stylesheet.match(/^:root\s*\{(?<body>[\s\S]*?)\n\}/u)
    ?.groups?.body;
  const lightTokens = stylesheet.match(
    /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{(?<body>[\s\S]*?)\n\s*\}/u,
  )?.groups?.body;
  assert.ok(defaultTokens, "default foundation tokens must exist");
  assert.ok(lightTokens, "Light foundation tokens must exist");

  assertMinimumContrast(
    "#ffffff",
    token(defaultTokens, "--control-primary-background"),
    4.5,
    "primary button text",
  );
  assertMinimumContrast(
    "#ffffff",
    token(defaultTokens, "--control-primary-hover-background"),
    4.5,
    "primary button hover text",
  );

  const darkTextareaBorder = token(defaultTokens, "--textarea-border");
  assertMinimumContrast(
    darkTextareaBorder,
    "#12182d",
    3,
    "Dark textarea outer boundary",
  );
  assertMinimumContrast(
    darkTextareaBorder,
    "#0b1020",
    3,
    "Dark textarea inner boundary",
  );

  const lightFocus = token(lightTokens, "--focus-outline");
  assertMinimumContrast(lightFocus, "#ffffff", 3, "Light focus on cards");
  assertMinimumContrast(lightFocus, "#eef0f8", 3, "Light focus on shell");

  const lightTextareaBorder = token(lightTokens, "--textarea-border");
  assertMinimumContrast(
    lightTextareaBorder,
    "#ffffff",
    3,
    "Light textarea inner boundary",
  );
  assertMinimumContrast(
    lightTextareaBorder,
    "#eef0f8",
    3,
    "Light textarea outer boundary",
  );

  assert.match(
    stylesheet,
    /button\s*\{[^}]*background:\s*var\(--control-primary-background\)/u,
  );
  assert.match(
    stylesheet,
    /button:hover\s*\{[^}]*background:\s*var\(--control-primary-hover-background\)/u,
  );
  assert.match(
    stylesheet,
    /button:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus-outline\)/u,
  );
  assert.match(
    stylesheet,
    /textarea\s*\{[^}]*border:\s*1px solid var\(--textarea-border\)/u,
  );
});
