import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  tracerAccessibilityActions,
  tracerAccessibilitySource,
} from "./codex-tracer-accessibility-source.mjs";

test("the packaged tracer adapter is a closed AXUIElement-only action surface", () => {
  assert.deepEqual(tracerAccessibilityActions, [
    "probe-start",
    "open-canvas",
    "probe-canvas",
    "open-workspace-picker",
    "select-workspace",
    "cancel-workspace-picker",
    "observe-workspace-selected",
    "observe-workspace-cancelled",
    "observe-workspace-permission-denied",
    "check-runtime",
    "focus-task",
    "set-task",
    "submit-task",
    "cancel-turn",
    "set-unicode",
    "observe-runtime-ready",
    "observe-streaming",
    "observe-completed",
    "observe-stopping",
    "observe-cancelled",
    "observe-failed",
    "observe-response-semantics",
    "quit",
  ]);
  for (const action of tracerAccessibilityActions)
    assert.ok(tracerAccessibilitySource.includes(`@\"${action}\"`));
  assert.match(tracerAccessibilitySource, /AXUIElementCreateApplication/u);
  assert.match(tracerAccessibilitySource, /AXIsProcessTrustedWithOptions/u);
  for (const attribute of [
    "kAXChildrenAttribute",
    "kAXRowsAttribute",
    "kAXColumnsAttribute",
    "kAXVisibleChildrenAttribute",
    "kAXContentsAttribute",
  ]) {
    assert.match(tracerAccessibilitySource, new RegExp(attribute, "u"));
  }
  assert.match(tracerAccessibilitySource, /CFArrayContainsValue/u);
  assert.match(tracerAccessibilitySource, /kAXTextFieldRole/u);
  assert.match(tracerAccessibilitySource, /kAXMenuItemRole/u);
  assert.match(tracerAccessibilitySource, /CFSTR\("ListView"\)/u);
  assert.match(tracerAccessibilitySource, /CFSTR\("AXOpen"\)/u);
  assert.match(
    tracerAccessibilitySource,
    /OpenPickerItem\(\s*application,\s*\(__bridge CFStringRef\)label\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /PressPickerControl\(application, CFSTR\("OKButton"\)\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /NavigatePickerToDocuments\(application\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /OpenPickerItem\(application, CFSTR\("Documents"\)\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /EnsurePickerListView\(application\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /PressPickerControl\(application, CFSTR\("CancelButton"\)\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /HasCancellationProjection\(application\)/u,
  );
  const setValue = tracerAccessibilitySource.match(
    /static BOOL SetValue\([\s\S]*?\n\}\n\nstatic BOOL Focus/u,
  )?.[0];
  assert.match(setValue ?? "", /kAXFocusedAttribute/u);
  assert.match(
    tracerAccessibilitySource,
    /accessibility-permission-denied"\);\s+return 1;/u,
  );
  assert.doesNotMatch(
    tracerAccessibilitySource,
    /AppleScript|System Events|CGEvent|AXUIElementCreateSystemWidePrivate|application_request|application_cancel|remote-debugging/iu,
  );
  assert.doesNotMatch(
    tracerAccessibilitySource,
    /no-effect prompt|Users\/|repository content|credential|authorization/iu,
  );
});

const macArm64Test =
  process.platform === "darwin" && process.arch === "arm64"
    ? test
    : (name, callback) =>
        test(name, { skip: "requires authoritative macOS arm64" }, callback);

macArm64Test(
  "the bounded adapter compiles with public macOS frameworks",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-tracer-ax-source-"));
    const source = join(root, "KeikoTracerAX.m");
    const binary = join(root, "KeikoTracerAX");
    try {
      await writeFile(source, tracerAccessibilitySource, "utf8");
      const result = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang",
          "-fobjc-arc",
          "-framework",
          "ApplicationServices",
          "-framework",
          "AppKit",
          "-framework",
          "Foundation",
          source,
          "-o",
          binary,
        ],
        { encoding: "utf8", shell: false },
      );
      assert.equal(result.status, 0, "adapter must compile");
      assert.ok((await readFile(binary)).byteLength > 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
