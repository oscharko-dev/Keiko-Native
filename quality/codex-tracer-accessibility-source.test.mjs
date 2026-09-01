import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { waitForTracerAccessibilityAction } from "./codex-tracer-accessibility.mjs";
import {
  tracerAccessibilityActivatingActions,
  tracerAccessibilityActions,
  tracerAccessibilitySource,
} from "./codex-tracer-accessibility-source.mjs";

const macArm64Test =
  process.platform === "darwin" && process.arch === "arm64"
    ? test
    : (name, callback) =>
        test(name, { skip: "requires authoritative macOS arm64" }, callback);

test("the packaged tracer adapter is a closed nonactivating AX and AppKit surface", () => {
  assert.ok(
    tracerAccessibilityActions.includes("inspect-window-display-binding"),
    "the adapter must expose one nonactivating semantic Keiko window/display binding",
  );
  assert.ok(
    !tracerAccessibilityActivatingActions.includes(
      "inspect-window-display-binding",
    ),
  );
  assert.deepEqual(tracerAccessibilityActions, [
    "inspect-display-topology",
    "inspect-window-display-binding",
    "probe-start",
    "open-canvas",
    "probe-canvas",
    "open-workspace-picker",
    "select-workspace",
    "cancel-workspace-picker",
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
    "probe-start",
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
      "inspect-display-topology",
      "inspect-window-display-binding",
      "probe-canvas",
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
  assert.match(tracerAccessibilitySource, /CGWindowListCopyWindowInfo/u);
  assert.match(tracerAccessibilitySource, /kCGWindowNumber/u);
  assert.match(tracerAccessibilitySource, /windowPosition/u);
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
  assert.match(tracerAccessibilitySource, /ProjectionPairIsAllowed/u);
  assert.match(tracerAccessibilitySource, /WaitForProjection/u);
  assert.match(tracerAccessibilitySource, /clock_gettime\(CLOCK_MONOTONIC/u);
  assert.doesNotMatch(tracerAccessibilitySource, /CFAbsoluteTimeGetCurrent/u);
  const timedPickerAction = tracerAccessibilitySource.match(
    /static BOOL PressPickerControlWithProjectionTiming\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  assert.match(
    timedPickerAction ?? "",
    /actionStartedAt = MonotonicSeconds\(\);[\s\S]*?AXUIElementPerformAction\(control, kAXPressAction\);[\s\S]*?actionReturnedAt = MonotonicSeconds\(\);[\s\S]*?\*projectionStartedAt = actionReturnedAt/u,
  );
  assert.match(
    timedPickerAction ?? "",
    /\*nativeActionMs = \(NSUInteger\)\([\s\S]*?MAX\(0\.0, actionReturnedAt - actionStartedAt\) \* 1000\.0 \+ 0\.5\)/u,
  );
  assert.match(tracerAccessibilitySource, /\\"projectedMs\\":%lu/u);
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
    selectWorkspace ?? "",
    /\[observation isEqualToString:@"observe-workspace-selected"\][\s\S]*?PressPickerControlWithProjectionTiming\([\s\S]*?&nativeActionMs,[\s\S]*?&projectionStartedAt\)[\s\S]*?else[\s\S]*?PressPickerControlWithProjectionTiming\([\s\S]*?&nativeActionMs,[\s\S]*?&projectionStartedAt\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /PressPickerControlWithProjectionTiming\(/u,
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
    /PressReadyPickerCancellation\(\s*application, &projectionStartedAt, &failureReasonCode\)/u,
  );
  assert.match(
    tracerAccessibilitySource,
    /CancellationProjection\(application\)/u,
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

test("picker cancellation waits for one actionable semantic control before timing", () => {
  const actionableControl = tracerAccessibilitySource.match(
    /static AXUIElementRef FindUniqueActionablePickerControl\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  const uniqueIdentifier = tracerAccessibilitySource.match(
    /static AXUIElementRef FindDescendantByIdentifier\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  const uniquePanel = tracerAccessibilitySource.match(
    /static AXUIElementRef FindPickerPanel\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  const readinessWait = tracerAccessibilitySource.match(
    /static AXUIElementRef WaitForUniqueActionablePickerControl\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  const timedCancellation = tracerAccessibilitySource.match(
    /static BOOL PressReadyPickerCancellation\([\s\S]*?\n\}\n\nstatic/u,
  )?.[0];
  const cancellationAction = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"cancel-workspace-picker"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];

  assert.match(actionableControl ?? "", /kAXEnabledAttribute/u);
  assert.match(actionableControl ?? "", /AXUIElementCopyActionNames/u);
  assert.match(actionableControl ?? "", /kAXPressAction/u);
  assert.match(
    actionableControl ?? "",
    /if \(isEnabled && exposesPress\) return control;/u,
  );
  assert.match(uniqueIdentifier ?? "", /ambiguous/u);
  assert.match(uniqueIdentifier ?? "", /CFArrayContainsValue/u);
  assert.match(uniqueIdentifier ?? "", /BOOL complete = YES;/u);
  assert.match(
    tracerAccessibilitySource,
    /kMaximumPickerTraversalElements = 512/u,
  );
  assert.match(tracerAccessibilitySource, /kMaximumPickerChildren = 256/u);
  assert.match(
    uniqueIdentifier ?? "",
    /childCount > kMaximumPickerChildren[\s\S]*?complete = NO/u,
  );
  assert.match(
    uniqueIdentifier ?? "",
    /CFArrayGetCount\(queue\) >= kMaximumPickerTraversalElements[\s\S]*?complete = NO/u,
  );
  assert.match(
    uniqueIdentifier ?? "",
    /if \(\(!complete \|\| ambiguous\) && result != NULL\)/u,
  );
  assert.match(
    uniquePanel ?? "",
    /if \(result != NULL\) \{[\s\S]*?CFRelease\(result\);[\s\S]*?result = NULL;[\s\S]*?break;/u,
  );
  assert.match(
    readinessWait ?? "",
    /startedAt = MonotonicSeconds\(\);[\s\S]*?deadline = startedAt \+ 5\.0;[\s\S]*?FindUniqueActionablePickerControl\([\s\S]*?usleep\(5 \* 1000\)/u,
  );
  assert.match(
    timedCancellation ?? "",
    /WaitForUniqueActionablePickerControl\([\s\S]*?\*failureReasonCode = "bounded-wait-expired";[\s\S]*?actionStartedAt = MonotonicSeconds\(\);[\s\S]*?AXUIElementPerformAction\(control, kAXPressAction\);[\s\S]*?\*projectionStartedAt = actionStartedAt/u,
  );
  assert.equal(
    timedCancellation?.match(/AXUIElementPerformAction/gu)?.length,
    1,
  );
  assert.doesNotMatch(timedCancellation ?? "", /usleep|actionReturnedAt/u);
  assert.match(
    cancellationAction ?? "",
    /PressReadyPickerCancellation\([\s\S]*?&projectionStartedAt,[\s\S]*?&failureReasonCode\)/u,
  );
  assert.doesNotMatch(
    cancellationAction ?? "",
    /PressEither|CFSTR\("Cancel"\)|CFSTR\("Abbrechen"\)|projectionStartedAt = MonotonicSeconds/u,
  );
  assert.doesNotMatch(tracerAccessibilitySource, /static BOOL PressEither\(/u);
});

test("a cancellation press failure is terminal across adapter processes", async () => {
  let attempts = 0;
  const result = await waitForTracerAccessibilityAction({
    action: "cancel-workspace-picker",
    binary: "/bounded/adapter",
    execute: () => {
      attempts += 1;
      return {
        prompted: false,
        reasonCode: "bounded-wait-expired",
        status: "failed",
      };
    },
    monotonicNow: () => 0,
    observation: "observe-workspace-cancelled",
    pid: 42,
    timeoutMs: 5_000,
    wait: async () => assert.fail("a failed press must not be retried"),
  });

  assert.equal(attempts, 1);
  assert.equal(result.reasonCode, "bounded-wait-expired");
});

macArm64Test(
  "picker readiness behavior rejects incomplete traversal and predicate inversion",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-tracer-ax-behavior-"));
    const source = join(root, "picker-readiness.c");
    const binary = join(root, "picker-readiness");
    const descendant = tracerAccessibilitySource
      .match(
        /static AXUIElementRef FindDescendantByIdentifier\([\s\S]*?\n\}\n\nstatic/u,
      )?.[0]
      .replace(/\n\nstatic$/u, "");
    const actionable = tracerAccessibilitySource
      .match(
        /static AXUIElementRef FindUniqueActionablePickerControl\([\s\S]*?\n\}\n\nstatic/u,
      )?.[0]
      .replace(/\n\nstatic$/u, "");
    assert.ok(descendant);
    assert.ok(actionable);
    const harness = `
#include <stdlib.h>
#include <string.h>

typedef int BOOL;
typedef int AXError;
typedef long CFIndex;
typedef unsigned long NSUInteger;
typedef const char *CFStringRef;
typedef void *CFTypeRef;
typedef struct FakeNode *AXUIElementRef;
typedef struct FakeArray *CFArrayRef;
typedef struct FakeArray *CFMutableArrayRef;
typedef struct FakeBoolean *CFBooleanRef;
typedef struct { CFIndex location; CFIndex length; } CFRange;

#define YES 1
#define NO 0
#define kAXErrorSuccess 0
#define kAXErrorCannotComplete -25204
#define kAXErrorAttributeUnsupported -25205
#define kAXErrorNoValue -25212

static const char childrenAttribute[] = "children";
static const char identifierAttribute[] = "identifier";
static const char enabledAttribute[] = "enabled";
static const char pressAction[] = "press";
#define kAXChildrenAttribute childrenAttribute
#define kAXIdentifierAttribute identifierAttribute
#define kAXEnabledAttribute enabledAttribute
#define kAXPressAction pressAction

struct FakeArray {
  int type;
  CFIndex count;
  const void **values;
};
struct FakeBoolean { int type; BOOL value; };
struct FakeNode {
  const char *identifier;
  AXError childrenError;
  AXError enabledError;
  AXError actionsError;
  struct FakeArray children;
  struct FakeArray actions;
  struct FakeBoolean enabled;
};

static const int kCFTypeArrayCallBacks = 0;
static const CFIndex kMaximumPickerTraversalElements = 512;
static const CFIndex kMaximumPickerChildren = 256;
static CFRange CFRangeMake(CFIndex location, CFIndex length) {
  return (CFRange){location, length};
}
static unsigned long CFArrayGetTypeID(void) { return 1; }
static unsigned long CFBooleanGetTypeID(void) { return 2; }
static unsigned long CFGetTypeID(CFTypeRef value) {
  return (unsigned long)*(int *)value;
}
static BOOL CFBooleanGetValue(CFBooleanRef value) { return value->value; }
static CFMutableArrayRef CFArrayCreateMutable(
    void *allocator, CFIndex capacity, const void *callbacks) {
  (void)allocator;
  (void)capacity;
  (void)callbacks;
  CFMutableArrayRef value = calloc(1, sizeof(*value));
  if (value != NULL) {
    value->type = 1;
    value->values = calloc(1024, sizeof(*value->values));
  }
  return value;
}
static CFIndex CFArrayGetCount(CFArrayRef value) { return value->count; }
static const void *CFArrayGetValueAtIndex(CFArrayRef value, CFIndex index) {
  return value->values[index];
}
static void CFArrayAppendValue(CFMutableArrayRef value, const void *entry) {
  value->values[value->count++] = entry;
}
static BOOL CFArrayContainsValue(
    CFArrayRef value, CFRange range, const void *entry) {
  for (CFIndex index = range.location;
       index < range.location + range.length;
       index += 1) {
    if (value->values[index] == entry) return YES;
  }
  return NO;
}
static void *CFRetain(const void *value) { return (void *)value; }
static void CFRelease(const void *value) { (void)value; }
static BOOL StringAttributeEquals(
    AXUIElementRef element, CFStringRef attribute, CFStringRef expected) {
  (void)attribute;
  return strcmp(element->identifier, expected) == 0;
}
static AXError AXUIElementCopyAttributeValue(
    AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
  if (attribute == kAXChildrenAttribute) {
    if (element->childrenError != kAXErrorSuccess)
      return element->childrenError;
    *value = &element->children;
    return kAXErrorSuccess;
  }
  if (element->enabledError != kAXErrorSuccess) return element->enabledError;
  *value = &element->enabled;
  return kAXErrorSuccess;
}
static AXError AXUIElementCopyActionNames(
    AXUIElementRef element, CFArrayRef *actions) {
  if (element->actionsError != kAXErrorSuccess) return element->actionsError;
  *actions = &element->actions;
  return kAXErrorSuccess;
}
static AXUIElementRef FindPickerPanel(AXUIElementRef application) {
  return application;
}
static void InitializeNode(struct FakeNode *node, const char *identifier) {
  memset(node, 0, sizeof(*node));
  node->identifier = identifier;
  node->children.type = 1;
  node->children.values = calloc(300, sizeof(*node->children.values));
  node->actions.type = 1;
  node->actions.values = calloc(4, sizeof(*node->actions.values));
  node->enabled.type = 2;
  node->enabled.value = YES;
}
static void AddChild(struct FakeNode *parent, struct FakeNode *child) {
  parent->children.values[parent->children.count++] = child;
}

${descendant}

${actionable}

int main(void) {
  struct FakeNode root;
  struct FakeNode control;
  InitializeNode(&root, "panel");
  InitializeNode(&control, "CancelButton");
  AddChild(&root, &control);
  control.actions.values[control.actions.count++] = kAXPressAction;
  if (FindUniqueActionablePickerControl(&root, "CancelButton") != &control)
    return 1;

  control.enabled.value = NO;
  if (FindUniqueActionablePickerControl(&root, "CancelButton") != NULL)
    return 2;
  control.enabled.value = YES;
  control.actions.count = 0;
  if (FindUniqueActionablePickerControl(&root, "CancelButton") != NULL)
    return 3;
  control.actions.values[control.actions.count++] = kAXPressAction;

  struct FakeNode duplicate;
  InitializeNode(&duplicate, "CancelButton");
  AddChild(&root, &duplicate);
  if (FindUniqueActionablePickerControl(&root, "CancelButton") != NULL)
    return 4;

  struct FakeNode wideRoot;
  struct FakeNode wide[241];
  InitializeNode(&wideRoot, "panel");
  for (int index = 0; index < 241; index += 1) {
    InitializeNode(&wide[index], index == 240 ? "CancelButton" : "other");
    AddChild(&wideRoot, &wide[index]);
  }
  wide[240].actions.values[wide[240].actions.count++] = kAXPressAction;
  if (FindUniqueActionablePickerControl(&wideRoot, "CancelButton") !=
      &wide[240])
    return 5;

  struct FakeNode tooWideRoot;
  struct FakeNode tooWide[257];
  InitializeNode(&tooWideRoot, "panel");
  for (int index = 0; index < 257; index += 1) {
    InitializeNode(
        &tooWide[index], index == 0 ? "CancelButton" : "other");
    AddChild(&tooWideRoot, &tooWide[index]);
  }
  tooWide[0].actions.values[tooWide[0].actions.count++] = kAXPressAction;
  if (FindUniqueActionablePickerControl(&tooWideRoot, "CancelButton") != NULL)
    return 6;

  struct FakeNode deepRoot;
  struct FakeNode first[256];
  struct FakeNode grandchildren[256];
  InitializeNode(&deepRoot, "panel");
  for (int index = 0; index < 256; index += 1) {
    InitializeNode(&first[index], index == 1 ? "CancelButton" : "other");
    InitializeNode(&grandchildren[index], "grandchild");
    AddChild(&deepRoot, &first[index]);
    AddChild(&first[0], &grandchildren[index]);
  }
  first[1].actions.values[first[1].actions.count++] = kAXPressAction;
  if (FindUniqueActionablePickerControl(&deepRoot, "CancelButton") != NULL)
    return 7;

  struct FakeNode partialRoot;
  struct FakeNode partialControl;
  struct FakeNode unavailable;
  InitializeNode(&partialRoot, "panel");
  InitializeNode(&partialControl, "CancelButton");
  InitializeNode(&unavailable, "other");
  unavailable.childrenError = kAXErrorCannotComplete;
  AddChild(&partialRoot, &partialControl);
  AddChild(&partialRoot, &unavailable);
  partialControl.actions.values[partialControl.actions.count++] =
      kAXPressAction;
  if (FindUniqueActionablePickerControl(
          &partialRoot, "CancelButton") != NULL)
    return 8;
  return 0;
}
`;
    try {
      await writeFile(source, harness, "utf8");
      const compile = spawnSync(
        "/usr/bin/xcrun",
        ["clang", "-std=c11", "-Wall", "-Werror", source, "-o", binary],
        { encoding: "utf8", shell: false },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", shell: false });
      assert.equal(run.status, 0, run.stderr);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

test("permission denial starts local projection timing after the native action returns", () => {
  const selectWorkspace = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"select-workspace"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  const permissionDenialAction = selectWorkspace?.match(
    /\} else \{([\s\S]*?)\n          \}/u,
  )?.[1];
  const startsAtActionReturn =
    /PressPickerControlWithProjectionTiming\([\s\S]*?&nativeActionMs,[\s\S]*?&projectionStartedAt\)/u.test(
      permissionDenialAction ?? "",
    );
  const startsBeforeAction =
    /projectionStartedAt = MonotonicSeconds\(\);[\s\S]*?PressPickerControl\(/u.test(
      permissionDenialAction ?? "",
    );
  const nativeActionStartedAtMs = 1_000;
  const nativeActionReturnedAtMs = 1_140;
  const projectionObservedAtMs = 1_140;
  const projectionStartedAtMs = startsAtActionReturn
    ? nativeActionReturnedAtMs
    : startsBeforeAction
      ? nativeActionStartedAtMs
      : Number.NaN;
  const overallActionMs = projectionObservedAtMs - nativeActionStartedAtMs;
  const projectedMs = projectionObservedAtMs - projectionStartedAtMs;

  assert.deepEqual(
    {
      overallActionMs,
      overallActionWithinBound: overallActionMs <= 5_000,
      projectedMs,
      projectionWithinBound: projectedMs <= 100,
    },
    {
      overallActionMs: 140,
      overallActionWithinBound: true,
      projectedMs: 0,
      projectionWithinBound: true,
    },
  );
});

test("cancellation starts local stopping timing after the native action returns", () => {
  const cancelTurn = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"cancel-turn"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  const startsAfterAction =
    /passed = Press\([\s\S]*?CFSTR\("Codex-Lauf abbrechen"\)\);[\s\S]*?projectionStartedAt = MonotonicSeconds\(\);/u.test(
      cancelTurn ?? "",
    );
  const startsBeforeAction =
    /projectionStartedAt = MonotonicSeconds\(\);[\s\S]*?passed = Press\([\s\S]*?CFSTR\("Codex-Lauf abbrechen"\)\);/u.test(
      cancelTurn ?? "",
    );
  const nativeActionStartedAtMs = 1_000;
  const nativeActionReturnedAtMs = 1_140;
  const stoppingObservedAtMs = 1_140;
  const projectionStartedAtMs = startsAfterAction
    ? nativeActionReturnedAtMs
    : startsBeforeAction
      ? nativeActionStartedAtMs
      : Number.NaN;
  const overallActionMs = stoppingObservedAtMs - nativeActionStartedAtMs;
  const projectedMs = stoppingObservedAtMs - projectionStartedAtMs;

  assert.deepEqual(
    {
      overallActionMs,
      overallActionWithinBound: overallActionMs <= 5_000,
      projectedMs,
      projectionWithinBound: projectedMs <= 100,
    },
    {
      overallActionMs: 140,
      overallActionWithinBound: true,
      projectedMs: 0,
      projectionWithinBound: true,
    },
  );
});

test("canvas projection starts with a real timed welcome action", () => {
  assert.match(
    tracerAccessibilitySource,
    /BOOL welcome = HasUnique\(application, CFSTR\("Foundation öffnen"\)\)[\s\S]{0,1000}projectionStartedAt = MonotonicSeconds\(\);[\s\S]{0,300}welcome[\s\S]{0,120}Press\(application, CFSTR\("Foundation öffnen"\)\)/u,
  );
});

test("persisted canvas is preconditioned through About before a timed canvas action", () => {
  assert.match(
    tracerAccessibilitySource,
    /HasUnique\(application, CFSTR\("codex-task"\)\)[\s\S]{0,250}Press\(application, CFSTR\("Über Keiko Native"\)\)[\s\S]{0,250}WaitForUnique\(application, CFSTR\("ÜBER DIESE VERSION"\)\)[\s\S]{0,500}projectionStartedAt = MonotonicSeconds\(\);[\s\S]{0,300}Press\(application, CFSTR\("Leere Fläche"\)\)/u,
  );
  assert.doesNotMatch(
    tracerAccessibilitySource,
    /passed = HasUnique\(application, CFSTR\("codex-task"\)\);[\s\S]{0,120}EmitProjection/u,
  );
});

test("persisted About and Update starts remain driveable through a timed canvas action", () => {
  const probeStart = tracerAccessibilitySource.match(
    /if \(\[action isEqualToString:@"probe-start"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  const openCanvas = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"open-canvas"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];

  for (const checkpoint of ["ÜBER DIESE VERSION", "UPDATE-STATUS"]) {
    assert.match(probeStart ?? "", new RegExp(checkpoint, "u"));
    assert.match(openCanvas ?? "", new RegExp(checkpoint, "u"));
  }
  assert.match(
    openCanvas ?? "",
    /Press\(application, CFSTR\("Leere Fläche"\)\)/u,
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
    /static NSInteger CancellationProjection\([\s\S]*?\n\}/u,
  )?.[0];

  assert.match(cancellationProbe ?? "", /UniqueValueIndex\(/u);
  assert.doesNotMatch(cancellationProbe ?? "", /HasUnique\(/u);
});

test("successful workspace projection rejects a stale accepted-prefix sibling", () => {
  const selectedProjection = tracerAccessibilitySource.match(
    /if \(\[observation isEqualToString:@"observe-workspace-selected"\]\) \{[\s\S]*?\n  \}/u,
  )?.[0];
  assert.match(
    tracerAccessibilitySource,
    /selectedWorkspaceProjection =\s*\[NSString stringWithFormat:@"Ausgewählt: %@", label\]/u,
  );
  assert.match(
    selectedProjection ?? "",
    /exactWorkspaceProjection != nil[\s\S]*?HasUnique\([\s\S]*?exactWorkspaceProjection/u,
  );
  assert.doesNotMatch(selectedProjection ?? "", /HasUniquePrefix/u);
});

test("the obsolete standalone selected-workspace probe is closed", () => {
  assert.equal(
    tracerAccessibilityActions.includes("observe-workspace-selected"),
    false,
  );
  assert.doesNotMatch(
    tracerAccessibilitySource,
    /else if \(\[action isEqualToString:@"observe-workspace-selected"\]\)/u,
  );
  assert.doesNotMatch(tracerAccessibilitySource, /HasUniquePrefix/u);
});

test("a supplied invalid UTF-8 observation fails closed", () => {
  assert.match(
    tracerAccessibilitySource,
    /NSString \*observation =[\s\S]*?argc == 4 && observation == nil/u,
  );
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
  assert.match(
    cancellationTerminal ?? "",
    /Keiko hat einen internen Laufzeitfehler erkannt/u,
  );
  assert.match(
    cancellationTerminal ?? "",
    /Keiko konnte die Beendigung des Codex-Laufs nicht bestätigen/u,
  );
  assert.match(cancellationTerminal ?? "", /UniqueValueIndex\(/u);
});

test("fast cancellation failures are classified before the first stopping sample", () => {
  const projectionProbe = tracerAccessibilitySource.match(
    /static NSInteger CancellationProjection\([\s\S]*?\n\}/u,
  )?.[0];
  assert.match(projectionProbe ?? "", /Keiko beendet den Codex-Lauf sicher\./u);
  assert.match(
    projectionProbe ?? "",
    /Der Codex-Lauf wurde abgebrochen und vollständig beendet\./u,
  );
  assert.match(
    projectionProbe ?? "",
    /Die Laufzeit konnte nicht vollständig bereinigt werden\./u,
  );
  assert.match(
    projectionProbe ?? "",
    /Keiko hat einen internen Laufzeitfehler erkannt/u,
  );
  assert.match(
    projectionProbe ?? "",
    /Keiko konnte die Beendigung des Codex-Laufs nicht bestätigen/u,
  );
  assert.match(
    projectionProbe ?? "",
    /Eine nicht erlaubte Anbieteraktivität wurde abgefangen/u,
  );

  const stoppingProbe = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"observe-stopping"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  assert.match(stoppingProbe ?? "", /Emit\(NO, "cleanup-failed"\)/u);
  assert.match(stoppingProbe ?? "", /Emit\(NO, "containment-failed"\)/u);
  const pairedProjection = tracerAccessibilitySource.match(
    /if \(passed && observation != nil\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.match(pairedProjection ?? "", /cancellationProjection == 2/u);
  assert.match(pairedProjection ?? "", /Emit\(NO, "cleanup-failed"\)/u);
  assert.match(pairedProjection ?? "", /cancellationProjection == 3/u);
  assert.match(pairedProjection ?? "", /cancellationProjection == 4/u);
  assert.match(pairedProjection ?? "", /cancellationProjection == 5/u);
  assert.match(pairedProjection ?? "", /Emit\(NO, "containment-failed"\)/u);
  assert.doesNotMatch(
    pairedProjection ?? "",
    /cancellationProjection == [345][\s\S]{0,200}EmitProjection/u,
  );
});

test("the packaged stopping checkpoint accepts only the stopping projection", () => {
  const stoppingProbe = tracerAccessibilitySource.match(
    /else if \(\[action isEqualToString:@"observe-stopping"\]\) \{[\s\S]*?\n    \} else if/u,
  )?.[0];
  assert.match(stoppingProbe ?? "", /passed = projection == 0;/u);
  assert.doesNotMatch(
    stoppingProbe ?? "",
    /projection == 0 \|\| projection == 1/u,
  );

  const pairedProjection = tracerAccessibilitySource.match(
    /if \(passed && observation != nil\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.match(pairedProjection ?? "", /cancellationProjection == 1/u);
  assert.match(
    pairedProjection ?? "",
    /Emit\(NO, "missing-or-ambiguous-semantic-target"\)/u,
  );
});

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
