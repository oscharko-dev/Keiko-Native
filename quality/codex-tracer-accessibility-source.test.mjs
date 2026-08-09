import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  tracerAccessibilityActivatingActions,
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
  assert.deepEqual(tracerAccessibilityActivatingActions, [
    "open-canvas",
    "open-workspace-picker",
    "select-workspace",
    "cancel-workspace-picker",
    "check-runtime",
    "focus-task",
    "set-task",
    "submit-task",
    "cancel-turn",
    "set-unicode",
    "quit",
  ]);
  assert.deepEqual(
    tracerAccessibilityActions.filter(
      (action) => !tracerAccessibilityActivatingActions.includes(action),
    ),
    [
      "probe-start",
      "probe-canvas",
      "observe-workspace-selected",
      "observe-workspace-cancelled",
      "observe-workspace-permission-denied",
      "observe-runtime-ready",
      "observe-streaming",
      "observe-completed",
      "observe-stopping",
      "observe-cancelled",
      "observe-failed",
      "observe-response-semantics",
    ],
  );
  for (const action of tracerAccessibilityActions)
    assert.ok(tracerAccessibilitySource.includes(`@\"${action}\"`));
  assert.match(tracerAccessibilitySource, /AXUIElementCreateApplication/u);
  assert.match(tracerAccessibilitySource, /AXIsProcessTrustedWithOptions/u);
  assert.match(
    tracerAccessibilitySource,
    /isFinishedLaunching[\s\S]*?missing-or-ambiguous-semantic-target[\s\S]*?AXUIElementCreateApplication/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /\[activatingActions containsObject:action\]/u,
  );
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
    /SelectPickerItem\(\s*application,\s*\(__bridge CFStringRef\)label\)/u,
  );
  const selectPickerItem = tracerAccessibilitySource.match(
    /static BOOL SelectPickerItem\([\s\S]*?\n\}\n\nstatic BOOL PickerIsAt/u,
  )?.[0];
  assert.match(
    selectPickerItem ?? "",
    /AXUIElementSetAttributeValue\([\s\S]*?kAXSelectedRowsAttribute/u,
  );
  assert.match(
    selectPickerItem ?? "",
    /AXUIElementCopyAttributeValue\([\s\S]*?kAXSelectedRowsAttribute/u,
  );
  assert.match(selectPickerItem ?? "", /CFArrayContainsValue/u);
  const selectWorkspace = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"select-workspace"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  assert.doesNotMatch(
    selectWorkspace ?? "",
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
    /SelectPickerSidebarItem\(application, CFSTR\("Documents"\)\)/u,
  );
  const selectPickerSidebarItem = tracerAccessibilitySource.match(
    /static BOOL SelectPickerSidebarItem\([\s\S]*?\n\}\n\nstatic BOOL PressPickerControl/u,
  )?.[0];
  assert.match(selectPickerSidebarItem ?? "", /kAXOutlineRole/u);
  assert.match(selectPickerSidebarItem ?? "", /kAXRowsAttribute/u);
  assert.match(selectPickerSidebarItem ?? "", /RowContainsExpected/u);
  assert.match(
    selectPickerSidebarItem ?? "",
    /AXUIElementSetAttributeValue\([\s\S]*?kAXSelectedRowsAttribute/u,
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
    /no-effect prompt|Users\/|repository content|credential|authorization|picker-stage/iu,
  );
});

test("the canvas probe verifies its semantic set in one bounded tree traversal", () => {
  const probeCanvas = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"probe-canvas"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];

  assert.match(tracerAccessibilitySource, /static BOOL HasUniqueSet\(/u);
  assert.match(probeCanvas ?? "", /HasUniqueSet\(/u);
  assert.doesNotMatch(probeCanvas ?? "", /HasUnique\(/u);
});

test("the cancellation probe checks alternative terminal states in one traversal", () => {
  const cancellationProbe = tracerAccessibilitySource.match(
    /static BOOL HasCancellationProjection\([\s\S]*?\n\}/u,
  )?.[0];

  assert.match(cancellationProbe ?? "", /HasAnyUniqueValue\(/u);
  assert.doesNotMatch(cancellationProbe ?? "", /HasUnique\(/u);
});

test("the cancellation terminal probe distinguishes incomplete cleanup", () => {
  const terminalProbe = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"observe-cancelled"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];

  assert.match(terminalProbe ?? "", /Emit\(NO, "cleanup-failed"\)/u);
  assert.match(terminalProbe ?? "", /Emit\(NO, "containment-failed"\)/u);
  assert.match(terminalProbe ?? "", /return 1;/u);
  assert.match(terminalProbe ?? "", /CancellationTerminal\(application\)/u);
  assert.doesNotMatch(terminalProbe ?? "", /HasUnique\(/u);
  const cancellationTerminal = tracerAccessibilitySource.match(
    /static NSInteger CancellationTerminal\([\s\S]*?\n\}/u,
  )?.[0];
  assert.match(
    cancellationTerminal ?? "",
    /Der Codex-Lauf wurde abgebrochen und vollständig beendet\./u,
  );
  assert.match(
    cancellationTerminal ?? "",
    /Die Laufzeit konnte nicht vollständig bereinigt werden\./u,
  );
  assert.match(
    cancellationTerminal ?? "",
    /Eine nicht erlaubte Anbieteraktivität wurde abgefangen/u,
  );
  assert.match(cancellationTerminal ?? "", /UniqueValueIndex\(/u);
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
