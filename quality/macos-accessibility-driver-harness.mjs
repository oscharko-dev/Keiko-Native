import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { compareCodeUnits } from "./deterministic-order.mjs";

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
  "candidate-process-failed",
]);
const CHECKPOINT_TIMEOUT_MS = 2_000;
const SURFACE_STARTUP_TIMEOUT_MS = 5_000;
const NATURAL_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;
const authenticatedProcessGroups = new WeakSet();

export const evaluationArtifactRoot = join(
  tmpdir(),
  "keiko-native-macos-accessibility-driver/issue-111-v3",
);
const operatorPhases = new Set(["allowed", "denied", "revoked", "recovered"]);
const capturePredecessorPhases = Object.freeze({
  allowed: null,
  denied: "allowed",
  revoked: "allowed",
  recovered: "revoked",
});
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

const axuielementSource = String.raw`#import <ApplicationServices/ApplicationServices.h>
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
      puts("{\"status\":\"permission-denied\",\"reasonCode\":\"accessibility-permission-denied\",\"prompted\":false,\"checkpointPasses\":0}");
      return 0;
    }
    if (argc == 1) {
      puts("{\"status\":\"ready\",\"reasonCode\":null,\"prompted\":false,\"checkpointPasses\":0}");
      return 0;
    }
    if (argc != 3) {
      puts("{\"status\":\"invalid-invocation\"}");
      return 2;
    }
    pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
    NSString *identifier = [NSString stringWithUTF8String:argv[2]];
    NSSet<NSString *> *allowedIdentifiers = [NSSet setWithArray:@[
${checkpointIds.map((id) => `      @${sourceLiteral(id)},`).join("\n")}
    ]];
    if (pid < 1 || identifier == nil ||
        ![allowedIdentifiers containsObject:identifier]) {
      puts("{\"status\":\"failed\",\"reasonCode\":\"checkpoint-action-failed\",\"prompted\":false,\"checkpointPasses\":0}");
      return 2;
    }
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    AXUIElementRef element = FindUniqueElement(
        application, (__bridge CFStringRef)identifier);
    if (element == NULL) {
      CFRelease(application);
      puts("{\"status\":\"failed\",\"reasonCode\":\"missing-or-ambiguous-checkpoint\",\"prompted\":false,\"checkpointPasses\":0}");
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
      puts("{\"status\":\"failed\",\"reasonCode\":\"checkpoint-action-failed\",\"prompted\":false,\"checkpointPasses\":0}");
      return 0;
    }
    if (!observed) {
      puts("{\"status\":\"failed\",\"reasonCode\":\"checkpoint-observation-failed\",\"prompted\":false,\"checkpointPasses\":0}");
      return 0;
    }
    puts("{\"status\":\"passed\",\"reasonCode\":null,\"prompted\":false,\"checkpointPasses\":1}");
    return 0;
  }
}
`;

const systemEventsSource = String.raw`-- Rejected without Apple Events execution.
-- A separate Automation-consent boundary prevents authoritative non-prompting evidence.
on run argv
  return "{\"status\":\"rejected\",\"reasonCode\":\"authoritative-evidence-unavailable\",\"prompted\":null,\"checkpointPasses\":0}"
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

const processGroupLauncherSource = String.raw`#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static int Inspect(void) {
  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0 || capacity > 131072) return 70;
  int *pids = calloc((size_t)capacity, sizeof(int));
  if (pids == NULL) return 71;
  int count = proc_listallpids(pids, capacity * (int)sizeof(int));
  if (count < 0 || count > capacity) {
    free(pids);
    return 72;
  }
  for (int index = 0; index < count; index += 1) {
    struct proc_bsdinfo info;
    int bytes = proc_pidinfo(
        pids[index],
        PROC_PIDTBSDINFO,
        0,
        &info,
        (int)sizeof(info));
    if (bytes != (int)sizeof(info)) continue;
    printf(
        "%d %u %llu %llu\n",
        info.pbi_pid,
        info.pbi_pgid,
        (unsigned long long)info.pbi_start_tvsec,
        (unsigned long long)info.pbi_start_tvusec);
  }
  free(pids);
  return ferror(stdout) == 0 ? 0 : 73;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--inspect") == 0) return Inspect();
  if (argc < 2) return 64;
  if (setpgid(0, 0) != 0) return 65;
  struct proc_bsdinfo info;
  int bytes = proc_pidinfo(
      getpid(),
      PROC_PIDTBSDINFO,
      0,
      &info,
      (int)sizeof(info));
  if (bytes != (int)sizeof(info)) return 66;
  printf(
      "%d %u %llu %llu\n",
      info.pbi_pid,
      info.pbi_pgid,
      (unsigned long long)info.pbi_start_tvsec,
      (unsigned long long)info.pbi_start_tvusec);
  if (fflush(stdout) != 0 || close(STDOUT_FILENO) != 0) return 67;
  char acknowledgement = 0;
  if (read(STDIN_FILENO, &acknowledgement, 1) != 1 ||
      acknowledgement != '1') return 68;
  if (close(STDIN_FILENO) != 0) return 69;
  execv(argv[1], &argv[1]);
  return 74;
}
`;

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error("evaluation-artifact-special-entry");
  }
  return files.toSorted(compareCodeUnits);
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
  const launcherSource = join(sourceRoot, "ProcessGroupLauncher.c");
  await Promise.all([
    writeFile(join(packageRoot, "Info.plist"), informationPropertyList, "utf8"),
    writeFile(surfaceSource, representativeSurfaceSource(), "utf8"),
    writeFile(axSource, axuielementSource, "utf8"),
    writeFile(eventsSource, systemEventsSource, "utf8"),
    writeFile(launcherSource, processGroupLauncherSource, "utf8"),
  ]);

  return {
    axuielementSource: axSource,
    candidates: ["axuielement", "systemEvents"],
    packageRoot: join(root, "KeikoAccessibilityEvaluation.app"),
    processGroupLauncherSource: launcherSource,
    surfaceSource,
    systemEventsSource: eventsSource,
  };
}

export async function compileProcessGroupInspector(root, compile = runClosed) {
  await mkdir(root, { recursive: true });
  const source = join(root, "ProcessGroupLauncher.c");
  const binary = join(root, "ProcessGroupLauncher");
  await writeFile(source, processGroupLauncherSource, "utf8");
  const result = compile("/usr/bin/xcrun", ["clang", source, "-o", binary]);
  if (
    result?.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut === true
  ) {
    throw new Error("process-inspector-compile-failed");
  }
  return binary;
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
  if (candidate === "systemEvents")
    return {
      candidate,
      prompted: null,
      reasonCode: "authoritative-evidence-unavailable",
      status: "rejected",
    };
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

export function executeCandidateCheckpoint({
  candidate,
  checkpoint,
  runCandidate,
  surfacePid,
}) {
  if (!new Set(["axuielement", "systemEvents"]).has(candidate))
    throw new TypeError("unknown-candidate");
  if (candidate === "systemEvents")
    return {
      checkpointPasses: 0,
      prompted: null,
      reasonCode: "authoritative-evidence-unavailable",
      status: "rejected",
    };
  if (!Object.hasOwn(checkpointBehaviorContract, checkpoint))
    throw new TypeError("unknown-checkpoint");
  if (!Number.isSafeInteger(surfacePid) || surfacePid < 1)
    throw new TypeError("surface-identity-invalid");
  if (typeof runCandidate !== "function")
    throw new TypeError("candidate-runner-invalid");
  return classifyCandidateSubprocessOutcome(
    runCandidate({
      candidate,
      checkpoint,
      expectedBehavior: checkpointBehaviorContract[checkpoint],
      surfacePid,
    }),
  );
}

function waitForEventLoopTurn(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

function processTable(processInspector) {
  const result = spawnSync(processInspector, ["--inspect"], {
    encoding: "utf8",
    shell: false,
    timeout: 1_000,
  });
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.error !== undefined
  )
    throw new Error("process-cleanup-inspection-failed");
  return result.stdout
    .split("\n")
    .map((line) => /^(\d+) (\d+) (\d+) (\d+)$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) =>
      Object.freeze({
        pid: Number.parseInt(match[1], 10),
        processGroupId: Number.parseInt(match[2], 10),
        startIdentity: `${match[3]}:${match[4]}`,
      }),
    );
}

function defaultCleanupDependencies(root = evaluationArtifactRoot) {
  const processInspector = join(root, "ProcessGroupLauncher");
  return {
    listProcessGroup: (processGroupId) =>
      processTable(processInspector).filter(
        (identity) => identity.processGroupId === processGroupId,
      ),
    monotonicNow: () => performance.now(),
    readProcessIdentity: (pid) =>
      processTable(processInspector).find((identity) => identity.pid === pid) ??
      null,
    signalProcess: (identity, signal) => {
      try {
        process.kill(identity.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    },
    waitForTurn: waitForEventLoopTurn,
  };
}

export function processCleanupDependencies(root) {
  return defaultCleanupDependencies(root);
}

function validProcessIdentity(identity, processGroupId) {
  return (
    identity !== null &&
    typeof identity === "object" &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.processGroupId === processGroupId &&
    typeof identity.startIdentity === "string" &&
    identity.startIdentity.length > 0
  );
}

function sameProcessIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.startIdentity === right.startIdentity
  );
}

export async function terminateOwnedProcess(
  child,
  dependencies = defaultCleanupDependencies(),
) {
  if (
    child === null ||
    typeof child !== "object" ||
    !authenticatedProcessGroups.has(child) ||
    typeof dependencies?.listProcessGroup !== "function" ||
    typeof dependencies.monotonicNow !== "function" ||
    typeof dependencies.readProcessIdentity !== "function" ||
    typeof dependencies.signalProcess !== "function" ||
    typeof dependencies.waitForTurn !== "function"
  )
    throw new Error("process-cleanup-identity-invalid");
  const processGroupId = child.processGroupId;
  const ownedIdentities = new Map([[child.pid, child]]);
  const deliveredSignals = new Set();
  const refresh = () => {
    const current = dependencies.listProcessGroup(processGroupId);
    if (
      !Array.isArray(current) ||
      current.some(
        (identity) => !validProcessIdentity(identity, processGroupId),
      )
    )
      throw new Error("process-cleanup-inspection-failed");
    for (const identity of current) {
      const prior = ownedIdentities.get(identity.pid);
      if (prior !== undefined && !sameProcessIdentity(prior, identity))
        throw new Error("process-cleanup-identity-conflict");
      ownedIdentities.set(identity.pid, Object.freeze({ ...identity }));
    }
    return current;
  };
  const signalCurrent = (identities, signal) => {
    for (const identity of identities.toReversed()) {
      const signalIdentity = `${signal}:${identity.pid}:${identity.startIdentity}`;
      if (deliveredSignals.has(signalIdentity)) continue;
      const current = dependencies.readProcessIdentity(identity.pid);
      if (!sameProcessIdentity(identity, current)) continue;
      dependencies.signalProcess(identity, signal);
      deliveredSignals.add(signalIdentity);
    }
  };
  const converge = async (signal) => {
    const deadline = dependencies.monotonicNow() + PROCESS_CLEANUP_TIMEOUT_MS;
    let consecutiveEmptyScans = 0;
    while (dependencies.monotonicNow() < deadline) {
      const current = refresh();
      if (current.length === 0) {
        consecutiveEmptyScans += 1;
        if (consecutiveEmptyScans === 2) return true;
      } else {
        consecutiveEmptyScans = 0;
        signalCurrent(current, signal);
      }
      await dependencies.waitForTurn(20);
    }
    return false;
  };

  if (await converge("SIGTERM")) return 0;
  if (await converge("SIGKILL")) return 0;
  throw new Error("process-cleanup-non-convergent");
}

export async function authenticateOwnedProcessGroup(
  child,
  dependencies = defaultCleanupDependencies(),
) {
  if (
    !Number.isSafeInteger(child?.pid) ||
    child.pid < 1 ||
    typeof dependencies?.monotonicNow !== "function" ||
    typeof dependencies.readProcessIdentity !== "function" ||
    typeof dependencies.waitForTurn !== "function"
  )
    throw new Error("process-cleanup-identity-invalid");
  const deadline = dependencies.monotonicNow() + PROCESS_CLEANUP_TIMEOUT_MS;
  while (dependencies.monotonicNow() < deadline) {
    const identity = dependencies.readProcessIdentity(child.pid);
    if (
      validProcessIdentity(identity, child.pid) &&
      identity.pid === child.pid
    ) {
      const authenticated = Object.freeze({ ...identity });
      authenticatedProcessGroups.add(authenticated);
      return authenticated;
    }
    await dependencies.waitForTurn(20);
  }
  throw new Error("process-group-establishment-failed");
}

function authenticateLauncherHandshake(child) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stdout.off("end", onEnd);
      child.stdout.off("error", onError);
      child.off("error", onError);
      if (error !== null) {
        reject(error);
        return;
      }
      const match = /^(\d+) (\d+) (\d+) (\d+)\n$/u.exec(raw);
      if (
        match === null ||
        Number.parseInt(match[1], 10) !== child.pid ||
        Number.parseInt(match[2], 10) !== child.pid
      ) {
        reject(new Error("process-group-handshake-invalid"));
        return;
      }
      const identity = Object.freeze({
        pid: child.pid,
        processGroupId: child.pid,
        startIdentity: `${match[3]}:${match[4]}`,
      });
      authenticatedProcessGroups.add(identity);
      child.stdin.end("1");
      resolve(identity);
    };
    const onData = (chunk) => {
      raw += chunk.toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > 128)
        finish(new Error("process-group-handshake-invalid"));
    };
    const onEnd = () => finish(null);
    const onError = () =>
      finish(new Error("process-group-handshake-unavailable"));
    const timeout = setTimeout(
      () => finish(new Error("process-group-handshake-expired")),
      PROCESS_CLEANUP_TIMEOUT_MS,
    );
    child.stdout.on("data", onData);
    child.stdout.once("end", onEnd);
    child.stdout.once("error", onError);
    child.once("error", onError);
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timeout);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

export async function rejectUnauthenticatedLauncher(
  child,
  { waitForClose = waitForChildClose } = {},
) {
  if (typeof waitForClose !== "function")
    throw new TypeError("launcher-rejection-boundary-invalid");
  child.stdin?.end();
  child.stdout?.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForClose(child, PROCESS_CLEANUP_TIMEOUT_MS)) return;
  if (!child.kill("SIGKILL"))
    throw new Error("launcher-rejection-signal-failed");
  if (await waitForClose(child, PROCESS_CLEANUP_TIMEOUT_MS)) return;
  throw new Error("launcher-rejection-non-convergent");
}

export async function establishOwnedProcess({ authenticate, launch, reject }) {
  if (
    typeof authenticate !== "function" ||
    typeof launch !== "function" ||
    typeof reject !== "function"
  )
    throw new TypeError("owned-process-boundary-invalid");
  const child = launch();
  try {
    return Object.freeze({
      child,
      ownership: await authenticate(child),
    });
  } catch (error) {
    await reject(child);
    throw error;
  }
}

function candidateOutput({
  candidate,
  checkpointPasses,
  cleanupOwnedDescendants,
  elapsedMs,
  includeTimings,
  reasonCode,
  repetition,
  status,
  timings = [],
}) {
  const output = {
    candidate,
    repetition,
    status,
    checkpointPasses,
    boundedWait: true,
    cleanupOwnedDescendants,
    reasonCode,
  };
  if (includeTimings) output.timings = { checkpoints: timings, elapsedMs };
  return output;
}

function runPermissionProbe({
  candidate,
  command,
  includeTimings,
  repetition,
}) {
  const probe = runClosed(command, [], CHECKPOINT_TIMEOUT_MS);
  const result = classifyCandidateSubprocessOutcome(probe);
  return candidateOutput({
    candidate,
    checkpointPasses: 0,
    cleanupOwnedDescendants: 0,
    elapsedMs: probe.durationMs,
    includeTimings,
    reasonCode: result.reasonCode,
    repetition,
    status: result.status,
  });
}

async function executePhysicalCheckpoint({
  candidate,
  checkpoint,
  command,
  index,
  startupDeadline,
  surfacePid,
}) {
  let attemptDurationMs = 0;
  let parsed;
  do {
    let durationMs = 0;
    parsed = executeCandidateCheckpoint({
      candidate,
      checkpoint,
      runCandidate: () => {
        const result = runClosed(
          command,
          [String(surfacePid), checkpoint],
          CHECKPOINT_TIMEOUT_MS,
        );
        durationMs = result.durationMs;
        return result;
      },
      surfacePid,
    });
    attemptDurationMs += durationMs;
    const retryableReason = [
      "missing-or-ambiguous-checkpoint",
      "surface-unavailable",
    ].includes(parsed.reasonCode);
    if (
      parsed.status === "passed" ||
      parsed.status === "permission-denied" ||
      index !== 0 ||
      !retryableReason ||
      performance.now() >= startupDeadline
    )
      break;
    await waitForEventLoopTurn(25);
  } while (performance.now() < startupDeadline);
  return { attemptDurationMs, parsed };
}

async function observeNaturalExit(surfacePid) {
  const startedAt = performance.now();
  const deadline = startedAt + NATURAL_EXIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!processExists(surfacePid))
      return {
        elapsedMs: Math.round(performance.now() - startedAt),
        passed: true,
      };
    await waitForEventLoopTurn(20);
  }
  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    passed: false,
  };
}

async function executePhysicalCheckpoints({
  candidate,
  command,
  startupDeadline,
  surfacePid,
}) {
  const checkpointTimings = [];
  let checkpointPasses = 0;
  let parsed;
  for (const [index, checkpoint] of checkpointIds.entries()) {
    const result = await executePhysicalCheckpoint({
      candidate,
      checkpoint,
      command,
      index,
      startupDeadline,
      surfacePid,
    });
    parsed = result.parsed;
    if (checkpoint === "quit-zero-descendants" && parsed.status === "passed") {
      const naturalExit = await observeNaturalExit(surfacePid);
      result.attemptDurationMs += naturalExit.elapsedMs;
      if (!naturalExit.passed)
        parsed = {
          checkpointPasses: 0,
          prompted: false,
          reasonCode: "checkpoint-observation-failed",
          status: "failed",
        };
    }
    checkpointTimings.push({
      checkpoint,
      elapsedMs: result.attemptDurationMs,
      status: parsed.status,
    });
    checkpointPasses += parsed.checkpointPasses;
    if (parsed.status !== "passed") break;
  }
  return { checkpointPasses, checkpointTimings, parsed };
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
  if (candidate === "systemEvents")
    return candidateOutput({
      candidate,
      checkpointPasses: 0,
      cleanupOwnedDescendants: 0,
      elapsedMs: 0,
      includeTimings,
      reasonCode: "authoritative-evidence-unavailable",
      repetition,
      status: "rejected",
    });
  const expectsPermission = phase === "allowed" || phase === "recovered";
  const command = join(root, "AXUIElementCandidate");
  if (!expectsPermission)
    return runPermissionProbe({
      candidate,
      command,
      includeTimings,
      repetition,
    });

  const startedAt = performance.now();
  const surfaceExecutable = join(
    root,
    "KeikoAccessibilityEvaluation.app",
    "Contents",
    "MacOS",
    "KeikoAccessibilityEvaluation",
  );
  const cleanupDependencies = defaultCleanupDependencies(root);
  const { child: surface, ownership: surfaceOwnership } =
    await establishOwnedProcess({
      authenticate: authenticateLauncherHandshake,
      launch: () =>
        spawn(join(root, "ProcessGroupLauncher"), [surfaceExecutable], {
          stdio: ["pipe", "pipe", "ignore"],
        }),
      reject: rejectUnauthenticatedLauncher,
    });
  const startupDeadline = performance.now() + SURFACE_STARTUP_TIMEOUT_MS;
  let execution;
  let cleanupOwnedDescendants;
  try {
    execution = await executePhysicalCheckpoints({
      candidate,
      command,
      startupDeadline,
      surfacePid: surface.pid,
    });
  } finally {
    try {
      cleanupOwnedDescendants = await terminateOwnedProcess(
        surfaceOwnership,
        cleanupDependencies,
      );
    } catch {
      execution = {
        checkpointPasses: 0,
        checkpointTimings: execution?.checkpointTimings ?? [],
        parsed: {
          checkpointPasses: 0,
          prompted: false,
          reasonCode: "process-cleanup-failed",
          status: "failed",
        },
      };
      cleanupOwnedDescendants = 1;
    }
  }
  const complete =
    execution.parsed.status === "passed" &&
    execution.checkpointPasses === checkpointIds.length;
  return candidateOutput({
    candidate,
    checkpointPasses: execution.checkpointPasses,
    cleanupOwnedDescendants,
    elapsedMs: Math.round(performance.now() - startedAt),
    includeTimings,
    reasonCode: complete ? null : execution.parsed.reasonCode,
    repetition,
    status: complete ? "passed" : execution.parsed.status,
    timings: execution.checkpointTimings,
  });
}

function closedAxuielementProbe(probe) {
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
      candidate: "axuielement",
      prompted: false,
      reasonCode: parsed.reasonCode,
      status: parsed.status,
    };
  } catch {
    return {
      candidate: "axuielement",
      prompted: false,
      reasonCode: "closed-probe-invalid",
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
  const launcherBinary = join(root, "ProcessGroupLauncher");
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
  const launcherCompile = runClosed("/usr/bin/xcrun", [
    "clang",
    artifacts.processGroupLauncherSource,
    "-o",
    launcherBinary,
  ]);
  if (
    surfaceCompile.exitCode !== 0 ||
    axCompile.exitCode !== 0 ||
    launcherCompile.exitCode !== 0
  ) {
    return {
      compileStatus: "failed",
      reasonCode: "apple-clang-compile-failed",
      surfaceExitCode: surfaceCompile.exitCode,
      axuielementExitCode: axCompile.exitCode,
      launcherExitCode: launcherCompile.exitCode,
    };
  }

  const axProbe = closedAxuielementProbe(runClosed(axBinary, []));
  const eventsProbe = {
    candidate: "systemEvents",
    prompted: null,
    reasonCode: "authoritative-evidence-unavailable",
    status: "rejected",
  };
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
      .toSorted(compareCodeUnits)
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
    Object.keys(inspection).toSorted(compareCodeUnits).join("\0") ===
      [
        "candidateFilesInsidePackage",
        "missingCheckpoints",
        "packageFiles",
        "privateApis",
        "productHooks",
        "status",
      ]
        .toSorted(compareCodeUnits)
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
  let reasonCode = "permission-state-mismatch";
  if (unexplainedFailures === 0)
    reasonCode = expectsSuccess ? null : "accessibility-permission-denied";
  else if (expectsSuccess) reasonCode = "unexplained-failed-repetition";
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
    reasonCode,
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

function rejectedSystemEventsState(phase) {
  return {
    status: phase === "recovered" ? "allowed" : phase,
    repetitions: 0,
    successfulRepetitions: 0,
    checkpointPasses: 0,
    boundedWaits: true,
    unexplainedFailures: 0,
    reasonCode: "authoritative-evidence-unavailable",
    cleanupOwnedDescendants: 0,
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

function validateCapturePredecessor(phase, prepared, priorCapture) {
  const predecessorPhase = capturePredecessorPhases[phase];
  if (predecessorPhase === null) {
    if (priorCapture !== null)
      throw new Error("capture-predecessor-unexpected");
    return;
  }
  if (
    priorCapture?.schemaVersion !==
      "keiko-native-macos-accessibility-driver-capture/v2" ||
    priorCapture.phase !== predecessorPhase ||
    !samePreparedIdentity(prepared, priorCapture.prepared) ||
    priorCapture.options?.axuielement?.unexplainedFailures !== 0 ||
    priorCapture.options?.axuielement?.status !== predecessorPhase
  ) {
    throw new Error("capture-predecessor-invalid");
  }
}

export async function capturePhysicalMatrixPhase(
  root,
  { phase, prepared, priorCapture = null, runCandidate },
) {
  if (!operatorPhases.has(phase)) throw new TypeError("unknown-capture-phase");
  if (typeof runCandidate !== "function")
    throw new TypeError("physical-candidate-runner-required");
  if (!validPreparedIdentity(prepared))
    throw new Error("capture-identity-invalid");
  validateCapturePredecessor(phase, prepared, priorCapture);

  const repetitions = phase === "allowed" ? 20 : 1;
  const options = {};
  const timings = {};
  for (const candidate of ["axuielement"]) {
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
  options.systemEvents = rejectedSystemEventsState(phase);
  timings.systemEvents = [];
  const capture = {
    schemaVersion: "keiko-native-macos-accessibility-driver-capture/v2",
    phase,
    predecessor:
      priorCapture === null
        ? null
        : {
            phase: priorCapture.phase,
            sha256: createHash("sha256")
              .update(`${JSON.stringify(priorCapture, null, 2)}\n`, "utf8")
              .digest("hex"),
          },
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
