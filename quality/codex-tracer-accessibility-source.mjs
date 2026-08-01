export const tracerAccessibilityActions = Object.freeze([
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

export const tracerAccessibilitySource = `#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <unistd.h>

static const NSUInteger kMaximumElements = 2048;
static const NSUInteger kMaximumDepth = 12;

static BOOL StringAttributeEquals(
    AXUIElementRef element, CFStringRef attribute, CFStringRef expected) {
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
  BOOL matches =
      error == kAXErrorSuccess && value != NULL &&
      CFGetTypeID(value) == CFStringGetTypeID() &&
      CFStringCompare((CFStringRef)value, expected, 0) == kCFCompareEqualTo;
  if (value != NULL) CFRelease(value);
  return matches;
}

static BOOL ElementMatches(AXUIElementRef element, CFStringRef expected) {
  const CFStringRef attributes[] = {
    kAXIdentifierAttribute,
    CFSTR("AXDOMIdentifier"),
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXValueAttribute,
  };
  for (NSUInteger index = 0;
       index < sizeof(attributes) / sizeof(attributes[0]);
       index += 1) {
    if (StringAttributeEquals(element, attributes[index], expected)) return YES;
  }
  return NO;
}

static void CollectMatches(
    AXUIElementRef root,
    CFStringRef expected,
    NSUInteger depth,
    CFMutableArrayRef matches,
    NSUInteger *visited) {
  if (depth > kMaximumDepth || *visited >= kMaximumElements ||
      CFArrayGetCount(matches) > 1)
    return;
  *visited += 1;
  if (ElementMatches(root, expected)) CFArrayAppendValue(matches, root);
  const CFStringRef container =
      depth == 0 ? kAXWindowsAttribute : kAXChildrenAttribute;
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(root, container, &value) !=
          kAXErrorSuccess ||
      value == NULL)
    return;
  if (CFGetTypeID(value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)value;
    CFIndex count = MIN(CFArrayGetCount(children), 512);
    for (CFIndex index = 0; index < count; index += 1) {
      CollectMatches(
          (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
          expected,
          depth + 1,
          matches,
          visited);
      if (CFArrayGetCount(matches) > 1) break;
    }
  }
  CFRelease(value);
}

static AXUIElementRef FindUnique(
    AXUIElementRef application, CFStringRef expected) {
  CFMutableArrayRef matches =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  NSUInteger visited = 0;
  CollectMatches(application, expected, 0, matches, &visited);
  AXUIElementRef result = NULL;
  if (CFArrayGetCount(matches) == 1) {
    result = (AXUIElementRef)CFRetain(CFArrayGetValueAtIndex(matches, 0));
  }
  CFRelease(matches);
  return result;
}

static BOOL HasUnique(AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  CFRelease(element);
  return YES;
}

static BOOL Press(AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  AXError error = AXUIElementPerformAction(element, kAXPressAction);
  CFRelease(element);
  return error == kAXErrorSuccess;
}

static BOOL PressEither(
    AXUIElementRef application, CFStringRef first, CFStringRef second) {
  return Press(application, first) || Press(application, second);
}

static BOOL StringAttributeHasPrefix(
    AXUIElementRef element, CFStringRef attribute, CFStringRef prefix) {
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
  BOOL matches = NO;
  if (error == kAXErrorSuccess && value != NULL &&
      CFGetTypeID(value) == CFStringGetTypeID()) {
    CFStringRef string = (CFStringRef)value;
    CFRange range = CFRangeMake(0, CFStringGetLength(prefix));
    matches = CFStringGetLength(string) >= CFStringGetLength(prefix) &&
        CFStringCompareWithOptions(string, prefix, range, 0) ==
            kCFCompareEqualTo;
  }
  if (value != NULL) CFRelease(value);
  return matches;
}

static BOOL ElementHasPrefix(AXUIElementRef element, CFStringRef prefix) {
  const CFStringRef attributes[] = {
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXValueAttribute,
  };
  for (NSUInteger index = 0;
       index < sizeof(attributes) / sizeof(attributes[0]);
       index += 1) {
    if (StringAttributeHasPrefix(element, attributes[index], prefix)) return YES;
  }
  return NO;
}

static void CollectPrefixMatches(
    AXUIElementRef root,
    CFStringRef prefix,
    NSUInteger depth,
    CFMutableArrayRef matches,
    NSUInteger *visited) {
  if (depth > kMaximumDepth || *visited >= kMaximumElements ||
      CFArrayGetCount(matches) > 1)
    return;
  *visited += 1;
  if (ElementHasPrefix(root, prefix)) CFArrayAppendValue(matches, root);
  const CFStringRef container =
      depth == 0 ? kAXWindowsAttribute : kAXChildrenAttribute;
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(root, container, &value) !=
          kAXErrorSuccess ||
      value == NULL)
    return;
  if (CFGetTypeID(value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)value;
    CFIndex count = MIN(CFArrayGetCount(children), 512);
    for (CFIndex index = 0; index < count; index += 1) {
      CollectPrefixMatches(
          (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
          prefix,
          depth + 1,
          matches,
          visited);
      if (CFArrayGetCount(matches) > 1) break;
    }
  }
  CFRelease(value);
}

static BOOL HasUniquePrefix(
    AXUIElementRef application, CFStringRef prefix) {
  CFMutableArrayRef matches =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  NSUInteger visited = 0;
  CollectPrefixMatches(application, prefix, 0, matches, &visited);
  BOOL result = CFArrayGetCount(matches) == 1;
  CFRelease(matches);
  return result;
}

static BOOL SetValue(
    AXUIElementRef application, CFStringRef expected, CFStringRef value) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  AXError error = AXUIElementSetAttributeValue(
      element, kAXValueAttribute, value);
  BOOL observed =
      error == kAXErrorSuccess &&
      StringAttributeEquals(element, kAXValueAttribute, value);
  CFRelease(element);
  return observed;
}

static BOOL Focus(AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  AXError error = AXUIElementSetAttributeValue(
      element, kAXFocusedAttribute, kCFBooleanTrue);
  CFTypeRef focused = NULL;
  BOOL observed =
      error == kAXErrorSuccess &&
      AXUIElementCopyAttributeValue(element, kAXFocusedAttribute, &focused) ==
          kAXErrorSuccess &&
      focused != NULL && CFEqual(focused, kCFBooleanTrue);
  if (focused != NULL) CFRelease(focused);
  CFRelease(element);
  return observed;
}

static NSString *ReadBoundedInput(void) {
  NSData *data = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
  if (data.length < 1 || data.length > 4096) return nil;
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static void Emit(BOOL passed, const char *reasonCode) {
  if (passed) {
    puts("{\\"status\\":\\"passed\\",\\"reasonCode\\":null,\\"prompted\\":false}");
  } else {
    printf(
        "{\\"status\\":\\"failed\\",\\"reasonCode\\":\\"%s\\",\\"prompted\\":false}\\n",
        reasonCode);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSDictionary *options = @{
      (__bridge NSString *)kAXTrustedCheckOptionPrompt: @NO
    };
    if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) {
      Emit(NO, "accessibility-permission-denied");
      return 1;
    }
    if (argc != 3) {
      Emit(NO, "invalid-invocation");
      return 2;
    }
    pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
    NSString *action = [NSString stringWithUTF8String:argv[2]];
    NSSet<NSString *> *allowed = [NSSet setWithArray:@[
${tracerAccessibilityActions.map((action) => `      @"${action}",`).join("\n")}
    ]];
    if (pid < 1 || action == nil || ![allowed containsObject:action]) {
      Emit(NO, "invalid-invocation");
      return 2;
    }
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    BOOL passed = NO;
    if ([action isEqualToString:@"probe-start"]) {
      BOOL welcome = HasUnique(application, CFSTR("Foundation öffnen"));
      BOOL canvas = HasUnique(application, CFSTR("codex-task"));
      passed = (welcome || canvas) &&
          HasUnique(application, CFSTR("Keiko Native beenden"));
    } else if ([action isEqualToString:@"open-canvas"]) {
      passed = HasUnique(application, CFSTR("codex-task")) ||
          Press(application, CFSTR("Foundation öffnen"));
    } else if ([action isEqualToString:@"probe-canvas"]) {
      passed =
          HasUnique(application, CFSTR("ime-harness")) &&
          HasUnique(application, CFSTR("codex-task")) &&
          HasUnique(application, CFSTR("Repository auswählen")) &&
          HasUnique(application, CFSTR("Codex-Bereitschaft prüfen"));
    } else if ([action isEqualToString:@"open-workspace-picker"]) {
      passed = Press(application, CFSTR("Repository auswählen"));
    } else if ([action isEqualToString:@"select-workspace"]) {
      NSString *label = ReadBoundedInput();
      NSCharacterSet *invalid =
          [[NSCharacterSet alphanumericCharacterSet] invertedSet];
      BOOL labelValid =
          label != nil &&
          [label hasPrefix:@"KeikoAcceptanceIdentity104"] &&
          [label rangeOfCharacterFromSet:invalid].location == NSNotFound;
      passed = labelValid &&
          PressEither(application, CFSTR("Documents"), CFSTR("Dokumente"));
      if (passed) {
        usleep(100 * 1000);
        passed = Press(
            application, (__bridge CFStringRef)label) &&
            PressEither(application, CFSTR("Open"), CFSTR("Öffnen"));
      }
    } else if ([action isEqualToString:@"cancel-workspace-picker"]) {
      passed = PressEither(application, CFSTR("Cancel"), CFSTR("Abbrechen"));
    } else if ([action isEqualToString:@"observe-workspace-selected"]) {
      passed = HasUniquePrefix(
          application, CFSTR("Ausgewählt: KeikoAcceptanceIdentity104"));
    } else if ([action isEqualToString:@"observe-workspace-cancelled"]) {
      passed = HasUnique(
          application,
          CFSTR("Auswahl abgebrochen. Es wurde kein Repository gebunden."));
    } else if ([action isEqualToString:@"observe-workspace-permission-denied"]) {
      passed = HasUnique(
          application,
          CFSTR("Zugriff verweigert. Wählen Sie das Repository erneut und erlauben Sie den Zugriff."));
    } else if ([action isEqualToString:@"check-runtime"]) {
      passed =
          Press(application, CFSTR("Codex-Bereitschaft prüfen")) ||
          Press(application, CFSTR("Prüfung wiederholen"));
    } else if ([action isEqualToString:@"focus-task"]) {
      passed = Focus(application, CFSTR("codex-task"));
    } else if ([action isEqualToString:@"set-task"]) {
      NSString *input = ReadBoundedInput();
      passed = input != nil &&
          SetValue(
              application,
              CFSTR("codex-task"),
              (__bridge CFStringRef)input);
    } else if ([action isEqualToString:@"submit-task"]) {
      passed = Press(application, CFSTR("Begrenzten Auftrag starten"));
    } else if ([action isEqualToString:@"cancel-turn"]) {
      passed = Press(application, CFSTR("Codex-Lauf abbrechen"));
    } else if ([action isEqualToString:@"set-unicode"]) {
      passed = SetValue(
          application, CFSTR("ime-harness"), CFSTR("Καλημέρα 世界"));
    } else if ([action isEqualToString:@"observe-runtime-ready"]) {
      passed = HasUnique(
          application,
          CFSTR("Codex 0.145.0 ist protokollbereit. Für einen Auftrag wird später ein neuer Prozess gestartet."));
    } else if ([action isEqualToString:@"observe-streaming"]) {
      passed = HasUnique(
          application,
          CFSTR("Codex antwortet innerhalb der Nur-Text-Grenze."));
    } else if ([action isEqualToString:@"observe-completed"]) {
      passed = HasUnique(
          application,
          CFSTR("Codex hat normal geantwortet und die Laufzeit wurde beendet."));
    } else if ([action isEqualToString:@"observe-stopping"]) {
      passed = HasUnique(
          application,
          CFSTR("Keiko beendet den Codex-Lauf sicher."));
    } else if ([action isEqualToString:@"observe-cancelled"]) {
      passed = HasUnique(
          application,
          CFSTR("Der Codex-Lauf wurde abgebrochen und vollständig beendet."));
    } else if ([action isEqualToString:@"observe-failed"]) {
      passed = HasUnique(
          application,
          CFSTR("Der Codex-Lauf ist sicher fehlgeschlagen und wurde beendet."));
    } else if ([action isEqualToString:@"observe-response-semantics"]) {
      passed = HasUnique(application, CFSTR("Codex-Antwort"));
    } else if ([action isEqualToString:@"quit"]) {
      passed = Press(application, CFSTR("Keiko Native beenden"));
    }
    CFRelease(application);
    Emit(passed, "missing-or-ambiguous-semantic-target");
    return passed ? 0 : 1;
  }
}
`;
