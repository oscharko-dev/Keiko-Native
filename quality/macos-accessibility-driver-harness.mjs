import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { mkdir } from "node:fs/promises";

const checkpointIds = Object.freeze([
  "workspace-select",
  "workspace-cancel",
  "workspace-permission-deny",
  "task-submit",
  "streaming",
  "normal-completion",
  "run-cancellation",
  "crash-recovery",
  "terminal-summary",
  "keyboard-focus",
  "voiceover-semantics",
  "appearance-contrast",
  "reduce-motion-applicability",
  "scaling",
  "unicode-ime",
  "quit-zero-descendants",
]);
export const checkpointBehaviorContract = Object.freeze({
  "workspace-select": Object.freeze({
    kind: "action",
    observations: Object.freeze(["workspace:selected"]),
  }),
  "workspace-cancel": Object.freeze({
    kind: "action",
    observations: Object.freeze(["workspace:cancelled"]),
  }),
  "workspace-permission-deny": Object.freeze({
    kind: "action",
    observations: Object.freeze(["workspace:permission-denied"]),
  }),
  "task-submit": Object.freeze({
    kind: "action",
    observations: Object.freeze(["task:submitted-after-late-state"]),
  }),
  streaming: Object.freeze({
    kind: "static",
    observations: Object.freeze(["streaming:active"]),
  }),
  "normal-completion": Object.freeze({
    kind: "action",
    observations: Object.freeze(["run:completed"]),
  }),
  "run-cancellation": Object.freeze({
    kind: "action",
    observations: Object.freeze(["run:cancelled-late-result-discarded"]),
  }),
  "crash-recovery": Object.freeze({
    kind: "action",
    observations: Object.freeze(["runtime:crashed", "runtime:recovered"]),
  }),
  "terminal-summary": Object.freeze({
    kind: "static",
    observations: Object.freeze(["terminal:summary-ready"]),
  }),
  "keyboard-focus": Object.freeze({
    kind: "focus",
    observations: Object.freeze(["focused"]),
  }),
  "voiceover-semantics": Object.freeze({
    kind: "static",
    observations: Object.freeze(["VoiceOver checkpoint ready"]),
  }),
  "appearance-contrast": Object.freeze({
    kind: "action",
    observations: Object.freeze([
      "appearance:light",
      "appearance:dark",
      "appearance:increase-contrast",
    ]),
  }),
  "reduce-motion-applicability": Object.freeze({
    kind: "action",
    observations: Object.freeze(["motion:reduced", "motion:full"]),
  }),
  scaling: Object.freeze({
    kind: "scale",
    observations: Object.freeze(["2"]),
  }),
  "unicode-ime": Object.freeze({
    kind: "input",
    observations: Object.freeze(["Καλημέρα 世界"]),
  }),
  "quit-zero-descendants": Object.freeze({
    kind: "action",
    observations: Object.freeze(["application:quit"]),
  }),
});
const actionCheckpointIds = Object.freeze([
  "workspace-select",
  "workspace-cancel",
  "workspace-permission-deny",
  "task-submit",
  "normal-completion",
  "run-cancellation",
  "crash-recovery",
  "appearance-contrast",
  "reduce-motion-applicability",
  "quit-zero-descendants",
]);
const staticCheckpointIds = Object.freeze([
  "streaming",
  "terminal-summary",
  "voiceover-semantics",
]);
const singlePressTransitionIds = Object.freeze(["crash-recovery"]);
const candidateReasonCodes = Object.freeze([
  "accessibility-permission-denied",
  "bounded-wait-expired",
  "checkpoint-action-failed",
  "checkpoint-observation-failed",
  "missing-checkpoint",
  "missing-or-ambiguous-checkpoint",
  "process-cleanup-failed",
  "surface-unavailable",
  "system-events-operation-failed",
  "candidate-process-failed",
]);
const CHECKPOINT_TIMEOUT_MS = 2_000;
const SURFACE_STARTUP_TIMEOUT_MS = 5_000;
const NATURAL_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;

export const evaluationArtifactRoot =
  "/private/tmp/keiko-native-macos-accessibility-driver/issue-111-v3";
const operatorPhases = new Set(["allowed", "denied", "revoked", "recovered"]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const headPattern = /^[0-9a-f]{40}$/u;

const productHookMarkers = Object.freeze([
  "application_request",
  "application_cancel",
  "remote-debugging",
  "evaluate:macos-accessibility-driver",
]);

const privateApiMarkers = Object.freeze(["AXUIElementCreateSystemWidePrivate"]);

function sourceLiteral(value) {
  return JSON.stringify(value);
}

function objectiveCBehaviorEntries() {
  return Object.entries(checkpointBehaviorContract)
    .map(
      ([checkpoint, behavior]) =>
        `      @${sourceLiteral(checkpoint)}: @[${behavior.observations
          .map((observation) => `@${sourceLiteral(observation)}`)
          .join(", ")}],`,
    )
    .join("\n");
}

function appleScriptBehaviorClauses() {
  return Object.entries(checkpointBehaviorContract)
    .map(
      ([checkpoint, behavior], index) =>
        `      ${index === 0 ? "if" : "else if"} identifierValue is ${sourceLiteral(
          checkpoint,
        )} then\n        set expectedStates to {${behavior.observations
          .map(sourceLiteral)
          .join(", ")}}`,
    )
    .join("\n");
}

function representativeSurfaceSource() {
  const controls = checkpointIds
    .map((id) => {
      const label = id.replaceAll("-", " ");
      if (actionCheckpointIds.includes(id))
        return `  AddAction(stack, @${sourceLiteral(id)}, @${sourceLiteral(label)}, self);`;
      if (staticCheckpointIds.includes(id))
        return `  AddStatus(stack, @${sourceLiteral(id)}, @${sourceLiteral(
          label,
        )}, @${sourceLiteral(checkpointBehaviorContract[id].observations[0])});`;
      if (id === "scaling")
        return `  AddScale(stack, @${sourceLiteral(id)}, @${sourceLiteral(label)});`;
      return `  AddInput(stack, @${sourceLiteral(id)}, @${sourceLiteral(label)});`;
    })
    .join("\n");
  return `#import <AppKit/AppKit.h>

static void Configure(NSView *control, NSString *identifier, NSString *label) {
  control.accessibilityIdentifier = identifier;
  control.accessibilityLabel = label;
}

static void AddAction(
    NSStackView *stack,
    NSString *identifier,
    NSString *label,
    id target) {
  NSButton *control =
      [NSButton buttonWithTitle:label target:target action:@selector(performCheckpoint:)];
  Configure(control, identifier, label);
  [stack addArrangedSubview:control];
}

static void AddStatus(
    NSStackView *stack,
    NSString *identifier,
    NSString *label,
    NSString *value) {
  NSTextField *control = [NSTextField labelWithString:value];
  Configure(control, identifier, label);
  [stack addArrangedSubview:control];
}

static void AddInput(NSStackView *stack, NSString *identifier, NSString *label) {
  NSTextField *control = [NSTextField textFieldWithString:@""];
  Configure(control, identifier, label);
  [stack addArrangedSubview:control];
}

static void AddScale(NSStackView *stack, NSString *identifier, NSString *label) {
  NSSlider *control =
      [NSSlider sliderWithValue:1.0 minValue:1.0 maxValue:3.0 target:nil action:nil];
  Configure(control, identifier, label);
  [stack addArrangedSubview:control];
}

@interface EvaluationDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *journeyState;
@property(nonatomic) NSUInteger appearanceStep;
@property(nonatomic) BOOL reducedMotion;
@property(nonatomic) BOOL runCancelled;
@end

@implementation EvaluationDelegate
- (void)setSemanticState:(NSString *)state {
  self.journeyState.stringValue = state;
  self.window.accessibilityHelp =
      [@"Keiko Accessibility Evaluation state:" stringByAppendingString:state];
}

- (void)completeLateTaskState {
  [self setSemanticState:@"task:submitted-after-late-state"];
}

- (void)completeCancellationRace {
  [self setSemanticState:
      self.runCancelled
          ? @"run:cancelled-late-result-discarded"
          : @"run:late-result-applied"];
}

- (void)completeRuntimeRecovery {
  [self setSemanticState:@"runtime:recovered"];
}

- (void)performCheckpoint:(NSButton *)sender {
  NSString *identifier = sender.accessibilityIdentifier;
  if ([identifier isEqualToString:@"workspace-select"]) {
    [self setSemanticState:@"workspace:selected"];
  } else if ([identifier isEqualToString:@"workspace-cancel"]) {
    [self setSemanticState:@"workspace:cancelled"];
  } else if ([identifier isEqualToString:@"workspace-permission-deny"]) {
    [self setSemanticState:@"workspace:permission-denied"];
  } else if ([identifier isEqualToString:@"task-submit"]) {
    [self setSemanticState:@"task:waiting-for-late-state"];
    [self performSelector:@selector(completeLateTaskState)
               withObject:nil
               afterDelay:0.12];
  } else if ([identifier isEqualToString:@"normal-completion"]) {
    [self setSemanticState:@"run:completed"];
  } else if ([identifier isEqualToString:@"run-cancellation"]) {
    self.runCancelled = YES;
    [self setSemanticState:@"run:cancelling"];
    [self performSelector:@selector(completeCancellationRace)
               withObject:nil
               afterDelay:0.12];
  } else if ([identifier isEqualToString:@"crash-recovery"]) {
    [self setSemanticState:@"runtime:crashed"];
    [self performSelector:@selector(completeRuntimeRecovery)
               withObject:nil
               afterDelay:0.75];
  } else if ([identifier isEqualToString:@"appearance-contrast"]) {
    NSArray<NSString *> *variants = @[
      @"appearance:light",
      @"appearance:dark",
      @"appearance:increase-contrast"
    ];
    [self setSemanticState:variants[self.appearanceStep % variants.count]];
    self.appearanceStep += 1;
  } else if ([identifier isEqualToString:@"reduce-motion-applicability"]) {
    self.reducedMotion = !self.reducedMotion;
    [self setSemanticState:
        self.reducedMotion ? @"motion:reduced" : @"motion:full"];
  } else if ([identifier isEqualToString:@"quit-zero-descendants"]) {
    [self setSemanticState:@"application:quit"];
    [NSApp performSelector:@selector(terminate:) withObject:nil afterDelay:0.25];
  }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(0, 0, 720, 640)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"Keiko Accessibility Evaluation";
  NSStackView *stack = [[NSStackView alloc] init];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = NSLayoutAttributeLeading;
  stack.spacing = 8;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.window.contentView addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:self.window.contentView.leadingAnchor constant:20],
    [stack.trailingAnchor constraintEqualToAnchor:self.window.contentView.trailingAnchor constant:-20],
    [stack.topAnchor constraintEqualToAnchor:self.window.contentView.topAnchor constant:20]
  ]];
  self.journeyState = [NSTextField labelWithString:@"ready"];
  Configure(self.journeyState, @"journey-state", @"journey state");
  [stack addArrangedSubview:self.journeyState];
${controls}
  [self.window makeKeyAndOrderFront:nil];
}
@end

static EvaluationDelegate *evaluationDelegate;

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *application = NSApplication.sharedApplication;
    evaluationDelegate = [[EvaluationDelegate alloc] init];
    application.delegate = evaluationDelegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    return NSApplicationMain(argc, argv);
  }
}
`;
}

const axuielementSource = `#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <unistd.h>

static void AppendUnique(CFMutableArrayRef matches, AXUIElementRef element) {
  for (CFIndex index = 0; index < CFArrayGetCount(matches); index++) {
    if (CFEqual(CFArrayGetValueAtIndex(matches, index), element)) return;
  }
  CFArrayAppendValue(matches, element);
}

static void CollectElements(
    AXUIElementRef root,
    CFStringRef target,
    NSUInteger depth,
    CFMutableArrayRef matches) {
  if (depth > 8 || CFArrayGetCount(matches) > 1) return;
  CFTypeRef identifier = NULL;
  if (AXUIElementCopyAttributeValue(
          root, kAXIdentifierAttribute, &identifier) == kAXErrorSuccess &&
      identifier != NULL) {
    BOOL identifierMatches =
        CFGetTypeID(identifier) == CFStringGetTypeID() &&
        CFStringCompare((CFStringRef)identifier, target, 0) ==
            kCFCompareEqualTo;
    CFRelease(identifier);
    if (identifierMatches) AppendUnique(matches, root);
  }
  const CFStringRef container =
      depth == 0 ? kAXWindowsAttribute : kAXChildrenAttribute;
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(
            root, container, &value) != kAXErrorSuccess ||
        value == NULL)
      return;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)value;
      CFIndex count = MIN(CFArrayGetCount(children), 256);
      for (CFIndex index = 0; index < count; index++) {
        CollectElements(
            (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
            target,
            depth + 1,
            matches);
        if (CFArrayGetCount(matches) > 1) break;
      }
    }
    CFRelease(value);
}

static AXUIElementRef FindUniqueElement(
    AXUIElementRef root, CFStringRef target) {
  CFMutableArrayRef matches =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  CollectElements(root, target, 0, matches);
  AXUIElementRef result = NULL;
  if (CFArrayGetCount(matches) == 1) {
    result = (AXUIElementRef)CFRetain(CFArrayGetValueAtIndex(matches, 0));
  }
  CFRelease(matches);
  return result;
}

static BOOL AttributeEquals(
    AXUIElementRef element, CFStringRef attribute, CFTypeRef expected) {
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
  BOOL matches =
      error == kAXErrorSuccess && value != NULL && CFEqual(value, expected);
  if (value != NULL) CFRelease(value);
  return matches;
}

static BOOL IsActionCheckpoint(NSString *identifier) {
  static NSSet<NSString *> *identifiers;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    identifiers = [NSSet setWithArray:@[
${actionCheckpointIds.map((id) => `      @${sourceLiteral(id)},`).join("\n")}
    ]];
  });
  return [identifiers containsObject:identifier];
}

static BOOL IsStaticCheckpoint(NSString *identifier) {
  static NSSet<NSString *> *identifiers;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    identifiers = [NSSet setWithArray:@[
${staticCheckpointIds.map((id) => `      @${sourceLiteral(id)},`).join("\n")}
    ]];
  });
  return [identifiers containsObject:identifier];
}

static BOOL IsSinglePressTransition(NSString *identifier) {
  static NSSet<NSString *> *identifiers;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    identifiers = [NSSet setWithArray:@[
${singlePressTransitionIds.map((id) => `      @${sourceLiteral(id)},`).join("\n")}
    ]];
  });
  return [identifiers containsObject:identifier];
}

static NSArray<NSString *> *ExpectedObservations(NSString *identifier) {
  static NSDictionary<NSString *, NSArray<NSString *> *> *observations;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    observations = @{
${objectiveCBehaviorEntries()}
    };
  });
  return observations[identifier];
}

static BOOL WaitForJourneyState(
    AXUIElementRef application, CFStringRef expected) {
  CFAbsoluteTime deadline =
      CFAbsoluteTimeGetCurrent() + ${CHECKPOINT_TIMEOUT_MS / 1_000};
  do {
    AXUIElementRef state =
        FindUniqueElement(application, CFSTR("journey-state"));
    BOOL observed =
        state != NULL &&
        AttributeEquals(state, kAXValueAttribute, expected);
    if (state != NULL) CFRelease(state);
    if (observed) return YES;
    usleep(10 * 1000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return NO;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @NO};
    if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) {
      puts("{\\"status\\":\\"permission-denied\\",\\"reasonCode\\":\\"accessibility-permission-denied\\",\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 0;
    }
    if (argc == 1) {
      puts("{\\"status\\":\\"ready\\",\\"reasonCode\\":null,\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 0;
    }
    if (argc != 3) {
      puts("{\\"status\\":\\"invalid-invocation\\"}");
      return 2;
    }
    pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
    NSString *identifier = [NSString stringWithUTF8String:argv[2]];
    NSSet<NSString *> *allowedIdentifiers = [NSSet setWithArray:@[
${checkpointIds.map((id) => `      @${sourceLiteral(id)},`).join("\n")}
    ]];
    if (pid < 1 || identifier == nil ||
        ![allowedIdentifiers containsObject:identifier]) {
      puts("{\\"status\\":\\"failed\\",\\"reasonCode\\":\\"checkpoint-action-failed\\",\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 2;
    }
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    AXUIElementRef element = FindUniqueElement(
        application, (__bridge CFStringRef)identifier);
    if (element == NULL) {
      CFRelease(application);
      puts("{\\"status\\":\\"failed\\",\\"reasonCode\\":\\"missing-or-ambiguous-checkpoint\\",\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 0;
    }

    AXError action = kAXErrorSuccess;
    BOOL observed = YES;
    NSArray<NSString *> *expectedObservations =
        ExpectedObservations(identifier);
    if ([identifier isEqualToString:@"unicode-ime"]) {
      action = AXUIElementSetAttributeValue(
          element, kAXValueAttribute, CFSTR("Καλημέρα 世界"));
      observed = AttributeEquals(
          element, kAXValueAttribute, CFSTR("Καλημέρα 世界"));
    } else if ([identifier isEqualToString:@"keyboard-focus"]) {
      action = AXUIElementSetAttributeValue(
          element, kAXFocusedAttribute, kCFBooleanTrue);
      observed = AttributeEquals(
          element, kAXFocusedAttribute, kCFBooleanTrue);
    } else if ([identifier isEqualToString:@"scaling"]) {
      CFNumberRef scale = (__bridge CFNumberRef)@2;
      action =
          AXUIElementSetAttributeValue(element, kAXValueAttribute, scale);
      observed = AttributeEquals(element, kAXValueAttribute, scale);
    } else if (IsStaticCheckpoint(identifier)) {
      observed =
          AttributeEquals(element, kAXRoleAttribute, kAXStaticTextRole) &&
          AttributeEquals(
              element,
              kAXValueAttribute,
              (__bridge CFStringRef)expectedObservations[0]);
    } else if (IsActionCheckpoint(identifier)) {
      if (IsSinglePressTransition(identifier)) {
        action = AXUIElementPerformAction(element, kAXPressAction);
      }
      for (NSString *expectedState in expectedObservations) {
        if (!IsSinglePressTransition(identifier)) {
          action = AXUIElementPerformAction(element, kAXPressAction);
        }
        if (action != kAXErrorSuccess ||
            !WaitForJourneyState(
                application, (__bridge CFStringRef)expectedState)) {
          observed = NO;
          break;
        }
      }
    } else {
      observed = NO;
    }
    CFRelease(element);
    CFRelease(application);
    if (action != kAXErrorSuccess) {
      puts("{\\"status\\":\\"failed\\",\\"reasonCode\\":\\"checkpoint-action-failed\\",\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 0;
    }
    if (!observed) {
      puts("{\\"status\\":\\"failed\\",\\"reasonCode\\":\\"checkpoint-observation-failed\\",\\"prompted\\":false,\\"checkpointPasses\\":0}");
      return 0;
    }
    puts("{\\"status\\":\\"passed\\",\\"reasonCode\\":null,\\"prompted\\":false,\\"checkpointPasses\\":1}");
    return 0;
  }
}
`;

const systemEventsSource = `-- SystemEvents evaluation through AppleScript.
on closed(statusValue, reasonValue, checkpointPasses)
  if reasonValue is missing value then
    set reasonJson to "null"
  else
    set reasonJson to "\\"" & reasonValue & "\\""
  end if
  return "{\\"status\\":\\"" & statusValue & "\\",\\"reasonCode\\":" & reasonJson & ",\\"prompted\\":false,\\"checkpointPasses\\":" & checkpointPasses & "}"
end closed

on run argv
  try
    if (count of argv) is 1 and item 1 of argv is "--probe" then
      tell application "System Events"
        if UI elements enabled is false then
          return my closed("permission-denied", "accessibility-permission-denied", 0)
        end if
        count processes
      end tell
      return closed("ready", missing value, 0)
    end if
    if (count of argv) is not 2 then
      return closed("invalid-invocation", "invalid-invocation", 0)
    end if
    set targetPid to item 1 of argv as integer
    if targetPid is less than 1 then
      return closed("invalid-invocation", "invalid-invocation", 0)
    end if
    set identifierValue to item 2 of argv
    set expectedIdentifiers to {${checkpointIds
      .map((id) => sourceLiteral(id))
      .join(", ")}}
    if expectedIdentifiers does not contain identifierValue then
      return closed("invalid-invocation", "invalid-invocation", 0)
    end if
    set actionIdentifiers to {${actionCheckpointIds
      .map((id) => sourceLiteral(id))
      .join(", ")}}
    set staticIdentifiers to {${staticCheckpointIds
      .map((id) => sourceLiteral(id))
      .join(", ")}}
    set singlePressIdentifiers to {${singlePressTransitionIds
      .map((id) => sourceLiteral(id))
      .join(", ")}}
${appleScriptBehaviorClauses()}
      else
        return closed("failed", "missing-checkpoint", 0)
      end if
    tell application "System Events"
      set processMatches to every process whose unix id is targetPid
      if (count of processMatches) is not 1 then
        return my closed("failed", "surface-unavailable", 0)
      end if
      set targetProcess to item 1 of processMatches
      set axWindows to value of attribute "AXWindows" of targetProcess
      if (count of axWindows) is not 1 then
        return my closed("failed", "surface-unavailable", 0)
      end if
      set allElements to entire contents of item 1 of axWindows
      set matchingElements to {}
      repeat with elementItem in allElements
        try
          set elementIdentifier to value of attribute "AXIdentifier" of elementItem
          if elementIdentifier is identifierValue then
            set end of matchingElements to contents of elementItem
          end if
        end try
      end repeat
      if (count of matchingElements) is not 1 then
        return my closed("failed", "missing-or-ambiguous-checkpoint", 0)
      end if
      set targetElement to item 1 of matchingElements
      if identifierValue is "unicode-ime" then
        set value of attribute "AXValue" of targetElement to "Καλημέρα 世界"
        if (value of attribute "AXValue" of targetElement) is not "Καλημέρα 世界" then
          return my closed("failed", "checkpoint-observation-failed", 0)
        end if
      else if identifierValue is "keyboard-focus" then
        set value of attribute "AXFocused" of targetElement to true
        if (value of attribute "AXFocused" of targetElement) is not true then
          return my closed("failed", "checkpoint-observation-failed", 0)
        end if
      else if identifierValue is "scaling" then
        set value of attribute "AXValue" of targetElement to 2
        if (value of attribute "AXValue" of targetElement) is not 2 then
          return my closed("failed", "checkpoint-observation-failed", 0)
        end if
      else if staticIdentifiers contains identifierValue then
        if (value of attribute "AXRole" of targetElement) is not "AXStaticText" or (value of attribute "AXValue" of targetElement) is not (item 1 of expectedStates) then
          return my closed("failed", "checkpoint-observation-failed", 0)
        end if
      else if actionIdentifiers contains identifierValue then
        if singlePressIdentifiers contains identifierValue then
          perform action "AXPress" of targetElement
        end if
        repeat with expectedState in expectedStates
          if singlePressIdentifiers does not contain identifierValue then
            perform action "AXPress" of targetElement
          end if
          set stateObserved to false
          set expectedWindowHelp to "Keiko Accessibility Evaluation state:" & (contents of expectedState)
          set deadlineDate to (current date) + ${CHECKPOINT_TIMEOUT_MS / 1_000}
          repeat
            try
              set refreshedWindows to value of attribute "AXWindows" of targetProcess
              if (count of refreshedWindows) is 1 and (value of attribute "AXHelp" of item 1 of refreshedWindows) is expectedWindowHelp then
                set stateObserved to true
                exit repeat
              end if
            end try
            if (current date) is greater than or equal to deadlineDate then exit repeat
            delay 0.02
          end repeat
          if stateObserved is false then
            return my closed("failed", "checkpoint-observation-failed", 0)
          end if
        end repeat
      else
        return my closed("failed", "checkpoint-action-failed", 0)
      end if
      return my closed("passed", missing value, 1)
    end tell
  on error errorMessage number errorNumber
    if errorNumber is -1743 or errorNumber is -25211 or errorMessage contains "assistive" or errorMessage contains "not authorized" or errorMessage contains "not permitted" then
      return closed("permission-denied", "accessibility-permission-denied", 0)
    end if
    return closed("failed", "system-events-operation-failed", 0)
  end try
end run
`;

const informationPropertyList = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>KeikoAccessibilityEvaluation</string>
  <key>CFBundleIdentifier</key>
  <string>dev.oscharko.keiko-native.evaluation.accessibility</string>
  <key>CFBundleName</key>
  <string>Keiko Accessibility Evaluation</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`;

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error("evaluation-artifact-special-entry");
  }
  return files.toSorted();
}

export async function createEvaluationArtifacts(root) {
  const packageRoot = join(
    root,
    "KeikoAccessibilityEvaluation.app",
    "Contents",
  );
  const sourceRoot = join(root, "sources");
  await mkdir(join(packageRoot, "MacOS"), { recursive: true });
  await mkdir(join(packageRoot, "Resources"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  const surfaceSource = join(sourceRoot, "RepresentativeSurface.m");
  const axSource = join(sourceRoot, "AXUIElementCandidate.m");
  const eventsSource = join(sourceRoot, "SystemEventsCandidate.applescript");
  await Promise.all([
    writeFile(join(packageRoot, "Info.plist"), informationPropertyList, "utf8"),
    writeFile(surfaceSource, representativeSurfaceSource(), "utf8"),
    writeFile(axSource, axuielementSource, "utf8"),
    writeFile(eventsSource, systemEventsSource, "utf8"),
  ]);

  return {
    axuielementSource: axSource,
    candidates: ["axuielement", "systemEvents"],
    packageRoot: join(root, "KeikoAccessibilityEvaluation.app"),
    surfaceSource,
    systemEventsSource: eventsSource,
  };
}

export async function inspectEvaluationArtifacts(root) {
  const packageRoot = join(root, "KeikoAccessibilityEvaluation.app");
  const packageFiles = await filesBelow(packageRoot);
  const packageBodies = await Promise.all(
    packageFiles.map((file) => readFile(file, "utf8")),
  );
  const surface = await readFile(
    join(root, "sources", "RepresentativeSurface.m"),
    "utf8",
  );
  const missingCheckpoints = checkpointIds.filter(
    (checkpoint) => !surface.includes(sourceLiteral(checkpoint)),
  );
  const candidateFilesInsidePackage = packageFiles.filter((file) =>
    /Candidate\.(?:m|applescript)$/u.test(relative(packageRoot, file)),
  ).length;

  return {
    candidateFilesInsidePackage,
    missingCheckpoints,
    packageFiles: packageFiles.map((file) => relative(packageRoot, file)),
    privateApis: privateApiMarkers.filter((marker) =>
      packageBodies.some((body) => body.includes(marker)),
    ).length,
    productHooks: productHookMarkers.filter((marker) =>
      packageBodies.some((body) => body.includes(marker)),
    ).length,
    status:
      missingCheckpoints.length === 0 &&
      candidateFilesInsidePackage === 0 &&
      privateApiMarkers.every((marker) =>
        packageBodies.every((body) => !body.includes(marker)),
      ) &&
      productHookMarkers.every((marker) =>
        packageBodies.every((body) => !body.includes(marker)),
      )
        ? "prepared"
        : "invalid",
  };
}

export function permissionProbeResult(candidate, allowed) {
  if (!new Set(["axuielement", "systemEvents"]).has(candidate))
    throw new TypeError("unknown-candidate");
  return allowed
    ? {
        candidate,
        prompted: false,
        reasonCode: null,
        status: "ready",
      }
    : {
        candidate,
        prompted: false,
        reasonCode: "accessibility-permission-denied",
        status: "permission-denied",
      };
}

function runClosed(command, args, timeoutMs = 30_000) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
  });
  return {
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: result.status,
    signal: result.signal,
    stderrEmpty: result.stderr === "",
    stdout: (result.stdout ?? "").trim(),
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function parseClosedCandidateOutput(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    const commonInvalid =
      typeof parsed !== "object" ||
      parsed === null ||
      !["passed", "permission-denied", "failed"].includes(parsed.status) ||
      !Number.isInteger(parsed?.checkpointPasses) ||
      parsed.checkpointPasses < 0 ||
      parsed.checkpointPasses > 1 ||
      parsed.prompted !== false ||
      !(
        parsed.reasonCode === null ||
        candidateReasonCodes.includes(parsed.reasonCode)
      );
    const stateValid =
      (parsed?.status === "passed" &&
        parsed.checkpointPasses === 1 &&
        parsed.reasonCode === null) ||
      (parsed?.status === "permission-denied" &&
        parsed.checkpointPasses === 0 &&
        parsed.reasonCode === "accessibility-permission-denied") ||
      (parsed?.status === "failed" &&
        parsed.checkpointPasses === 0 &&
        parsed.reasonCode !== null);
    if (commonInvalid || !stateValid)
      throw new Error("candidate-output-invalid");
    return {
      checkpointPasses: parsed.checkpointPasses,
      prompted: false,
      reasonCode: parsed.reasonCode,
      status: parsed.status,
    };
  } catch {
    return {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "candidate-output-invalid",
      status: "failed",
    };
  }
}

export function classifyCandidateSubprocessOutcome(result) {
  if (result?.timedOut === true) {
    return {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "bounded-wait-expired",
      status: "failed",
    };
  }
  if (
    result?.exitCode !== 0 ||
    result?.signal !== null ||
    result?.stderrEmpty !== true
  ) {
    return {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "candidate-process-failed",
      status: "failed",
    };
  }
  return parseClosedCandidateOutput(result);
}

function waitForEventLoopTurn(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function directChildPids(parentPid) {
  const result = runClosed("/usr/bin/pgrep", ["-P", String(parentPid)], 1_000);
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error("process-cleanup-inspection-failed");
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function discoverOwnedProcessTree(rootPid) {
  if (!processExists(rootPid)) return [];
  const discovered = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    for (const childPid of directChildPids(parentPid)) {
      if (!discovered.includes(childPid)) {
        discovered.push(childPid);
        pending.push(childPid);
      }
    }
  }
  return discovered;
}

function signalOwnedProcesses(pids, signal) {
  for (const pid of pids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

export async function terminateOwnedProcess(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error("process-cleanup-identity-invalid");
  const ownedPids = new Set([
    child.pid,
    ...discoverOwnedProcessTree(child.pid),
  ]);
  if (![...ownedPids].some(processExists)) return 0;
  signalOwnedProcesses([...ownedPids], "SIGTERM");
  let deadline = performance.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    for (const pid of discoverOwnedProcessTree(child.pid)) ownedPids.add(pid);
    if (![...ownedPids].some(processExists)) return 0;
    await waitForEventLoopTurn(20);
  }
  signalOwnedProcesses([...ownedPids], "SIGKILL");
  deadline = performance.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (![...ownedPids].some(processExists)) return 0;
    await waitForEventLoopTurn(20);
  }
  const remaining = [...ownedPids].filter(processExists).length;
  if (remaining !== 0) throw new Error("process-cleanup-non-convergent");
  return 0;
}

export async function runPhysicalCandidate({
  candidate,
  includeTimings = false,
  phase,
  repetition,
  root = evaluationArtifactRoot,
}) {
  if (!new Set(["axuielement", "systemEvents"]).has(candidate))
    throw new TypeError("unknown-candidate");
  if (!operatorPhases.has(phase)) throw new TypeError("unknown-capture-phase");
  const expectsPermission = phase === "allowed" || phase === "recovered";
  const command =
    candidate === "axuielement"
      ? join(root, "AXUIElementCandidate")
      : "/usr/bin/osascript";
  const probeArgs =
    candidate === "axuielement"
      ? []
      : [join(root, "sources", "SystemEventsCandidate.applescript"), "--probe"];
  if (!expectsPermission) {
    const probe = runClosed(command, probeArgs, CHECKPOINT_TIMEOUT_MS);
    const result = classifyCandidateSubprocessOutcome(probe);
    const output = {
      candidate,
      repetition,
      status: result.status,
      checkpointPasses: 0,
      boundedWait: true,
      cleanupOwnedDescendants: 0,
      reasonCode: result.reasonCode,
    };
    if (includeTimings)
      output.timings = {
        checkpoints: [],
        elapsedMs: probe.durationMs,
      };
    return output;
  }

  const startedAt = performance.now();
  const surface = spawn(
    join(
      root,
      "KeikoAccessibilityEvaluation.app",
      "Contents",
      "MacOS",
      "KeikoAccessibilityEvaluation",
    ),
    [],
    { stdio: "ignore" },
  );
  const startupDeadline = performance.now() + SURFACE_STARTUP_TIMEOUT_MS;
  const checkpointTimings = [];
  let parsed = {
    checkpointPasses: 0,
    prompted: false,
    reasonCode: "surface-unavailable",
    status: "failed",
  };
  let checkpointPasses = 0;
  let cleanupOwnedDescendants = 1;
  try {
    for (const [index, checkpoint] of checkpointIds.entries()) {
      let attemptDurationMs = 0;
      do {
        const args =
          candidate === "axuielement"
            ? [String(surface.pid), checkpoint]
            : [
                join(root, "sources", "SystemEventsCandidate.applescript"),
                String(surface.pid),
                checkpoint,
              ];
        const result = runClosed(command, args, CHECKPOINT_TIMEOUT_MS);
        attemptDurationMs += result.durationMs;
        parsed = classifyCandidateSubprocessOutcome(result);
        if (
          parsed.status === "passed" ||
          parsed.status === "permission-denied" ||
          index !== 0 ||
          !["missing-or-ambiguous-checkpoint", "surface-unavailable"].includes(
            parsed.reasonCode,
          ) ||
          performance.now() >= startupDeadline
        )
          break;
        await waitForEventLoopTurn(25);
      } while (performance.now() < startupDeadline);
      if (
        checkpoint === "quit-zero-descendants" &&
        parsed.status === "passed"
      ) {
        const naturalExitStartedAt = performance.now();
        const naturalExitDeadline =
          naturalExitStartedAt + NATURAL_EXIT_TIMEOUT_MS;
        let naturalExitObserved = false;
        while (performance.now() < naturalExitDeadline) {
          if (!processExists(surface.pid)) {
            naturalExitObserved = true;
            break;
          }
          await waitForEventLoopTurn(20);
        }
        attemptDurationMs += Math.round(
          performance.now() - naturalExitStartedAt,
        );
        if (!naturalExitObserved)
          parsed = {
            checkpointPasses: 0,
            prompted: false,
            reasonCode: "checkpoint-observation-failed",
            status: "failed",
          };
      }
      checkpointTimings.push({
        checkpoint,
        elapsedMs: attemptDurationMs,
        status: parsed.status,
      });
      checkpointPasses += parsed.checkpointPasses;
      if (parsed.status !== "passed") break;
    }
  } finally {
    try {
      cleanupOwnedDescendants = await terminateOwnedProcess(surface);
    } catch {
      parsed = {
        checkpointPasses: 0,
        prompted: false,
        reasonCode: "process-cleanup-failed",
        status: "failed",
      };
      checkpointPasses = 0;
      cleanupOwnedDescendants = 1;
    }
  }
  const output = {
    candidate,
    repetition,
    status:
      parsed.status === "passed" && checkpointPasses === checkpointIds.length
        ? "passed"
        : parsed.status,
    checkpointPasses,
    boundedWait: true,
    cleanupOwnedDescendants,
    reasonCode:
      parsed.status === "passed" && checkpointPasses === checkpointIds.length
        ? null
        : parsed.reasonCode,
  };
  if (includeTimings)
    output.timings = {
      checkpoints: checkpointTimings,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  return output;
}

function closedProbe(probe, candidate) {
  try {
    if (
      probe.timedOut ||
      probe.exitCode !== 0 ||
      probe.signal !== null ||
      probe.stderrEmpty !== true
    )
      throw new Error("invalid-probe-process-outcome");
    const parsed = JSON.parse(probe.stdout);
    if (
      !["ready", "permission-denied"].includes(parsed.status) ||
      parsed.prompted !== false
    )
      throw new Error("invalid-probe");
    return {
      candidate,
      prompted: false,
      reasonCode: parsed.reasonCode,
      status: parsed.status,
    };
  } catch {
    return {
      candidate,
      prompted: false,
      reasonCode:
        candidate === "systemEvents"
          ? "system-events-probe-unavailable"
          : "closed-probe-invalid",
      status: "unavailable",
    };
  }
}

export async function compileAndProbeEvaluation(root) {
  const artifacts = await createEvaluationArtifacts(root);
  const surfaceBinary = join(
    artifacts.packageRoot,
    "Contents",
    "MacOS",
    "KeikoAccessibilityEvaluation",
  );
  const axBinary = join(root, "AXUIElementCandidate");
  const surfaceCompile = runClosed("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-framework",
    "AppKit",
    artifacts.surfaceSource,
    "-o",
    surfaceBinary,
  ]);
  const axCompile = runClosed("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-framework",
    "ApplicationServices",
    "-framework",
    "Foundation",
    artifacts.axuielementSource,
    "-o",
    axBinary,
  ]);
  if (surfaceCompile.exitCode !== 0 || axCompile.exitCode !== 0) {
    return {
      compileStatus: "failed",
      reasonCode: "apple-clang-compile-failed",
      surfaceExitCode: surfaceCompile.exitCode,
      axuielementExitCode: axCompile.exitCode,
    };
  }

  const axProbe = closedProbe(runClosed(axBinary, []), "axuielement");
  const eventsProbe = closedProbe(
    runClosed("/usr/bin/osascript", [artifacts.systemEventsSource, "--probe"]),
    "systemEvents",
  );
  const inspection = await inspectEvaluationArtifacts(root);
  const packageFiles = await filesBelow(artifacts.packageRoot);
  const digest = createHash("sha256");
  for (const file of packageFiles) {
    digest.update(relative(artifacts.packageRoot, file));
    digest.update(await readFile(file));
  }

  return {
    candidateDigests: {
      axuielement: await digestFile(axBinary),
      systemEvents: await digestFile(artifacts.systemEventsSource),
    },
    candidateProbes: { axuielement: axProbe, systemEvents: eventsProbe },
    compileStatus: "passed",
    foundationPackageExclusion: "pending-acceptance-macos",
    inspection,
    representativePackageSha256: digest.digest("hex"),
  };
}

async function digestFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function validPreparedIdentity(prepared) {
  return (
    prepared?.schemaVersion ===
      "keiko-native-macos-accessibility-driver-prepared/v1" &&
    headPattern.test(prepared.sourceHead) &&
    sha256Pattern.test(prepared.sourceDigest) &&
    sha256Pattern.test(prepared.representativePackageSha256) &&
    representativeInspectionValid(prepared.representativeInspection) &&
    prepared.bundleIdentifier ===
      "dev.oscharko.keiko-native.evaluation.accessibility" &&
    Object.keys(prepared.candidateDigests ?? {})
      .toSorted()
      .join(",") === "axuielement,systemEvents" &&
    Object.values(prepared.candidateDigests).every((value) =>
      sha256Pattern.test(value),
    )
  );
}

export function representativeInspectionValid(inspection) {
  return (
    inspection !== null &&
    typeof inspection === "object" &&
    !Array.isArray(inspection) &&
    Object.keys(inspection).toSorted().join("\0") ===
      [
        "candidateFilesInsidePackage",
        "missingCheckpoints",
        "packageFiles",
        "privateApis",
        "productHooks",
        "status",
      ]
        .toSorted()
        .join("\0") &&
    inspection.status === "prepared" &&
    inspection.candidateFilesInsidePackage === 0 &&
    inspection.privateApis === 0 &&
    inspection.productHooks === 0 &&
    Array.isArray(inspection.missingCheckpoints) &&
    inspection.missingCheckpoints.length === 0 &&
    Array.isArray(inspection.packageFiles) &&
    inspection.packageFiles.length === 2 &&
    inspection.packageFiles[0] === "Contents/Info.plist" &&
    inspection.packageFiles[1] === "Contents/MacOS/KeikoAccessibilityEvaluation"
  );
}

function samePreparedIdentity(left, right) {
  return (
    validPreparedIdentity(left) &&
    validPreparedIdentity(right) &&
    left.sourceHead === right.sourceHead &&
    left.sourceDigest === right.sourceDigest &&
    left.representativePackageSha256 === right.representativePackageSha256 &&
    JSON.stringify(left.representativeInspection) ===
      JSON.stringify(right.representativeInspection) &&
    left.candidateDigests.axuielement === right.candidateDigests.axuielement &&
    left.candidateDigests.systemEvents === right.candidateDigests.systemEvents
  );
}

export function summarizePhysicalRuns(state, runs) {
  if (!new Set(["allowed", "denied", "revoked", "recovered"]).has(state))
    throw new TypeError("unknown-permission-state");
  if (!Array.isArray(runs) || runs.length === 0)
    throw new TypeError("physical-runs-empty");
  const expectsSuccess = state === "allowed" || state === "recovered";
  const unexplainedFailures = runs.filter((run) =>
    expectsSuccess
      ? run.status !== "passed" ||
        run.checkpointPasses !== checkpointIds.length ||
        run.cleanupOwnedDescendants !== 0 ||
        run.boundedWait !== true
      : run.status !== "permission-denied" ||
        run.reasonCode !== "accessibility-permission-denied" ||
        run.cleanupOwnedDescendants !== 0 ||
        run.boundedWait !== true,
  ).length;
  return {
    status: state === "recovered" ? "allowed" : state,
    repetitions: runs.length,
    successfulRepetitions: runs.filter((run) => run.status === "passed").length,
    checkpointPasses: runs.reduce(
      (total, run) => total + run.checkpointPasses,
      0,
    ),
    boundedWaits: runs.every((run) => run.boundedWait === true),
    unexplainedFailures,
    reasonCode: expectsSuccess
      ? unexplainedFailures === 0
        ? null
        : "unexplained-failed-repetition"
      : unexplainedFailures === 0
        ? "accessibility-permission-denied"
        : "permission-state-mismatch",
    cleanupOwnedDescendants: runs.reduce(
      (maximum, run) =>
        Math.max(
          maximum,
          run.cleanupOwnedDescendants ?? Number.MAX_SAFE_INTEGER,
        ),
      0,
    ),
  };
}

export async function preparePhysicalMatrix(
  root = evaluationArtifactRoot,
  { compile = compileAndProbeEvaluation, sourceDigest, sourceHead } = {},
) {
  const compiled = await compile(root);
  if (
    compiled.compileStatus !== "passed" ||
    compiled.inspection?.status !== "prepared"
  )
    throw new Error("evaluation-prepare-failed");
  const prepared = {
    schemaVersion: "keiko-native-macos-accessibility-driver-prepared/v1",
    sourceHead,
    sourceDigest,
    bundleIdentifier: "dev.oscharko.keiko-native.evaluation.accessibility",
    representativePackageSha256: compiled.representativePackageSha256,
    representativeInspection: compiled.inspection,
    candidateDigests: compiled.candidateDigests,
  };
  if (!validPreparedIdentity(prepared))
    throw new Error("evaluation-prepare-identity-invalid");
  await writeFile(
    join(root, "prepared-evidence.json"),
    `${JSON.stringify(prepared, null, 2)}\n`,
    "utf8",
  );
  return prepared;
}

export async function capturePhysicalMatrixPhase(
  root = evaluationArtifactRoot,
  { phase, prepared, priorCapture = null, runCandidate },
) {
  if (!operatorPhases.has(phase)) throw new TypeError("unknown-capture-phase");
  if (typeof runCandidate !== "function")
    throw new TypeError("physical-candidate-runner-required");
  if (!validPreparedIdentity(prepared))
    throw new Error("capture-identity-invalid");
  if (
    priorCapture !== null &&
    !samePreparedIdentity(prepared, priorCapture.prepared)
  )
    throw new Error("capture-identity-mismatch");

  const repetitions = phase === "allowed" ? 20 : 1;
  const options = {};
  const timings = {};
  for (const candidate of ["axuielement", "systemEvents"]) {
    const runs = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const run = await runCandidate({
        candidate,
        includeTimings: true,
        phase,
        repetition,
        root,
      });
      runs.push(run);
      const expectedStatus =
        phase === "allowed" || phase === "recovered"
          ? "passed"
          : "permission-denied";
      if (run.status !== expectedStatus) break;
    }
    options[candidate] = summarizePhysicalRuns(phase, runs);
    timings[candidate] = runs.map((run) => ({
      checkpoints: run.timings?.checkpoints ?? [],
      elapsedMs: run.timings?.elapsedMs ?? null,
      repetition: run.repetition,
    }));
  }
  const capture = {
    schemaVersion: "keiko-native-macos-accessibility-driver-capture/v1",
    phase,
    prepared,
    options,
    timings,
  };
  await writeFile(
    join(root, `capture-${phase}.json`),
    `${JSON.stringify(capture, null, 2)}\n`,
    "utf8",
  );
  return capture;
}
