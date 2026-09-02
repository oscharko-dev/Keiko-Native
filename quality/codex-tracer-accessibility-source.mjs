export const tracerAccessibilityActions = Object.freeze([
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

export const tracerAccessibilityActivatingActions = Object.freeze([
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

export const tracerAccessibilitySource = String.raw`#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <time.h>
#import <unistd.h>

static const NSUInteger kMaximumElements = 2048;
static const NSUInteger kMaximumDepth = 12;
static const CFIndex kMaximumPickerTraversalElements = 512;
static const CFIndex kMaximumPickerChildren = 256;

static BOOL ActivateApplication(pid_t pid) {
  NSRunningApplication *application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  return application != nil &&
      [application activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

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
  if (ElementMatches(root, expected) &&
      !CFArrayContainsValue(
          matches, CFRangeMake(0, CFArrayGetCount(matches)), root))
    CFArrayAppendValue(matches, root);
  const CFStringRef rootContainers[] = {kAXWindowsAttribute};
  const CFStringRef childContainers[] = {
    kAXChildrenAttribute,
    kAXRowsAttribute,
    kAXColumnsAttribute,
    kAXVisibleChildrenAttribute,
    kAXContentsAttribute,
  };
  const CFStringRef *containers =
      depth == 0 ? rootContainers : childContainers;
  NSUInteger containerCount = depth == 0 ? 1 : 5;
  for (NSUInteger containerIndex = 0;
       containerIndex < containerCount;
       containerIndex += 1) {
    BOOL traversedChildren = NO;
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(
            root, containers[containerIndex], &value) != kAXErrorSuccess ||
        value == NULL)
      continue;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)value;
      CFIndex count = MIN(CFArrayGetCount(children), 512);
      traversedChildren = count > 0;
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
    if (traversedChildren || CFArrayGetCount(matches) > 1) break;
  }
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

static BOOL MatchCountsExceedOne(
    const NSUInteger *counts, NSUInteger expectedCount) {
  for (NSUInteger index = 0; index < expectedCount; index += 1) {
    if (counts[index] > 1) return YES;
  }
  return NO;
}

static void RecordExpectedMatches(
    AXUIElementRef element,
    const CFStringRef *expected,
    NSUInteger expectedCount,
    const CFStringRef *attributes,
    NSUInteger attributeCount,
    NSUInteger *counts) {
  BOOL matched[8] = {NO};
  for (NSUInteger attributeIndex = 0;
       attributeIndex < attributeCount;
       attributeIndex += 1) {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(
        element, attributes[attributeIndex], &value);
    if (error == kAXErrorSuccess && value != NULL &&
        CFGetTypeID(value) == CFStringGetTypeID()) {
      for (NSUInteger expectedIndex = 0;
           expectedIndex < expectedCount;
           expectedIndex += 1) {
        if (!matched[expectedIndex] &&
            CFStringCompare(
                (CFStringRef)value, expected[expectedIndex], 0) ==
                kCFCompareEqualTo)
          matched[expectedIndex] = YES;
      }
    }
    if (value != NULL) CFRelease(value);
  }
  for (NSUInteger index = 0; index < expectedCount; index += 1) {
    if (matched[index]) counts[index] += 1;
  }
}

static void CollectExpectedMatches(
    AXUIElementRef root,
    const CFStringRef *expected,
    NSUInteger expectedCount,
    const CFStringRef *attributes,
    NSUInteger attributeCount,
    BOOL childrenOnly,
    NSUInteger depth,
    NSUInteger *counts,
    NSUInteger *visited) {
  if (depth > kMaximumDepth || *visited >= kMaximumElements ||
      MatchCountsExceedOne(counts, expectedCount))
    return;
  *visited += 1;
  RecordExpectedMatches(
      root, expected, expectedCount, attributes, attributeCount, counts);
  const CFStringRef rootContainers[] = {kAXWindowsAttribute};
  const CFStringRef childContainers[] = {
    kAXChildrenAttribute,
    kAXRowsAttribute,
    kAXColumnsAttribute,
    kAXVisibleChildrenAttribute,
    kAXContentsAttribute,
  };
  const CFStringRef *containers =
      depth == 0 ? rootContainers : childContainers;
  NSUInteger containerCount = depth == 0 || childrenOnly ? 1 : 5;
  for (NSUInteger containerIndex = 0;
       containerIndex < containerCount;
       containerIndex += 1) {
    BOOL traversedChildren = NO;
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(
            root, containers[containerIndex], &value) != kAXErrorSuccess ||
        value == NULL)
      continue;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)value;
      CFIndex count = MIN(CFArrayGetCount(children), 512);
      traversedChildren = count > 0;
      for (CFIndex index = 0; index < count; index += 1) {
        CollectExpectedMatches(
            (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
            expected,
            expectedCount,
            attributes,
            attributeCount,
            childrenOnly,
            depth + 1,
            counts,
            visited);
        if (MatchCountsExceedOne(counts, expectedCount)) break;
      }
    }
    CFRelease(value);
    if (traversedChildren || MatchCountsExceedOne(counts, expectedCount))
      break;
  }
}

static BOOL HasUniqueSet(
    AXUIElementRef application,
    const CFStringRef *expected,
    NSUInteger expectedCount) {
  if (expectedCount < 1 || expectedCount > 8) return NO;
  const CFStringRef attributes[] = {
    kAXIdentifierAttribute,
    CFSTR("AXDOMIdentifier"),
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXValueAttribute,
  };
  NSUInteger counts[8] = {0};
  NSUInteger visited = 0;
  CollectExpectedMatches(
      application,
      expected,
      expectedCount,
      attributes,
      sizeof(attributes) / sizeof(attributes[0]),
      NO,
      0,
      counts,
      &visited);
  for (NSUInteger index = 0; index < expectedCount; index += 1) {
    if (counts[index] != 1) return NO;
  }
  return YES;
}

static BOOL HasAnyUniqueValue(
    AXUIElementRef application,
    const CFStringRef *expected,
    NSUInteger expectedCount) {
  if (expectedCount < 1 || expectedCount > 8) return NO;
  const CFStringRef attributes[] = {kAXValueAttribute};
  NSUInteger counts[8] = {0};
  NSUInteger visited = 0;
  CollectExpectedMatches(
      application,
      expected,
      expectedCount,
      attributes,
      sizeof(attributes) / sizeof(attributes[0]),
      YES,
      0,
      counts,
      &visited);
  BOOL found = NO;
  for (NSUInteger index = 0; index < expectedCount; index += 1) {
    if (counts[index] > 1) return NO;
    if (counts[index] == 1) found = YES;
  }
  return found;
}

static AXUIElementRef FindPickerPanel(AXUIElementRef application) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(
          application, kAXWindowsAttribute, &value) != kAXErrorSuccess ||
      value == NULL || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return NULL;
  }
  AXUIElementRef result = NULL;
  CFArrayRef windows = (CFArrayRef)value;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); index += 1) {
    AXUIElementRef window =
        (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (StringAttributeEquals(
            window, kAXIdentifierAttribute, CFSTR("open-panel"))) {
      if (result != NULL) {
        CFRelease(result);
        result = NULL;
        break;
      }
      result = (AXUIElementRef)CFRetain(window);
    }
  }
  CFRelease(value);
  return result;
}

static AXUIElementRef FindDescendantByIdentifier(
    AXUIElementRef root, CFStringRef identifier) {
  CFMutableArrayRef queue =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  if (queue == NULL) return NULL;
  CFArrayAppendValue(queue, root);
  AXUIElementRef result = NULL;
  BOOL ambiguous = NO;
  BOOL complete = YES;
  for (CFIndex cursor = 0; cursor < CFArrayGetCount(queue); cursor += 1) {
    AXUIElementRef element =
        (AXUIElementRef)CFArrayGetValueAtIndex(queue, cursor);
    if (StringAttributeEquals(element, kAXIdentifierAttribute, identifier)) {
      if (result != NULL) {
        ambiguous = YES;
        break;
      }
      result = (AXUIElementRef)CFRetain(element);
    }
    CFTypeRef value = NULL;
    AXError childrenError = AXUIElementCopyAttributeValue(
        element, kAXChildrenAttribute, &value);
    if (childrenError == kAXErrorAttributeUnsupported ||
        childrenError == kAXErrorNoValue) {
      if (value != NULL) CFRelease(value);
      continue;
    }
    if (childrenError != kAXErrorSuccess || value == NULL ||
        CFGetTypeID(value) != CFArrayGetTypeID()) {
      if (value != NULL) CFRelease(value);
      complete = NO;
      break;
    }
    CFArrayRef children = (CFArrayRef)value;
    CFIndex childCount = CFArrayGetCount(children);
    if (childCount > kMaximumPickerChildren) {
      complete = NO;
    } else {
      for (CFIndex index = 0; index < childCount; index += 1) {
        const void *child = CFArrayGetValueAtIndex(children, index);
        if (CFArrayContainsValue(
                queue, CFRangeMake(0, CFArrayGetCount(queue)), child))
          continue;
        if (CFArrayGetCount(queue) >= kMaximumPickerTraversalElements) {
          complete = NO;
          break;
        }
        CFArrayAppendValue(queue, child);
      }
    }
    CFRelease(value);
    if (!complete) break;
  }
  CFRelease(queue);
  if ((!complete || ambiguous) && result != NULL) {
    CFRelease(result);
    result = NULL;
  }
  return result;
}

static AXUIElementRef FindInRow(
    AXUIElementRef root, CFStringRef expected, NSUInteger depth) {
  if (depth > 4) return NULL;
  if (ElementMatches(root, expected) &&
      StringAttributeEquals(root, kAXRoleAttribute, kAXTextFieldRole))
    return (AXUIElementRef)CFRetain(root);
  AXUIElementRef result = NULL;
  const CFStringRef containers[] = {
    kAXChildrenAttribute,
    kAXVisibleChildrenAttribute,
    kAXContentsAttribute,
  };
  for (NSUInteger containerIndex = 0;
       containerIndex < 3 && result == NULL;
       containerIndex += 1) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(
            root, containers[containerIndex], &value) != kAXErrorSuccess ||
        value == NULL)
      continue;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)value;
      CFIndex count = MIN(CFArrayGetCount(children), 32);
      for (CFIndex index = 0; index < count; index += 1) {
        result = FindInRow(
            (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
            expected,
            depth + 1);
        if (result != NULL) break;
      }
    }
    CFRelease(value);
  }
  return result;
}

static BOOL RowContainsExpected(
    AXUIElementRef root, CFStringRef expected, NSUInteger depth) {
  if (depth > 4) return NO;
  if (ElementMatches(root, expected)) return YES;
  const CFStringRef containers[] = {
    kAXChildrenAttribute,
    kAXVisibleChildrenAttribute,
    kAXContentsAttribute,
  };
  for (NSUInteger containerIndex = 0;
       containerIndex < 3;
       containerIndex += 1) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(
            root, containers[containerIndex], &value) != kAXErrorSuccess ||
        value == NULL)
      continue;
    BOOL found = NO;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)value;
      CFIndex count = MIN(CFArrayGetCount(children), 32);
      for (CFIndex index = 0; index < count && !found; index += 1)
        found = RowContainsExpected(
            (AXUIElementRef)CFArrayGetValueAtIndex(children, index),
            expected,
            depth + 1);
    }
    CFRelease(value);
    if (found) return YES;
  }
  return NO;
}

static AXUIElementRef FindPickerRow(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NULL;
  AXUIElementRef list =
      FindDescendantByIdentifier(panel, CFSTR("ListView"));
  CFRelease(panel);
  if (list == NULL) return NULL;
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(
          list, kAXRowsAttribute, &value) != kAXErrorSuccess ||
      value == NULL || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    CFRelease(list);
    return NULL;
  }
  AXUIElementRef result = NULL;
  CFArrayRef rows = (CFArrayRef)value;
  CFIndex count = MIN(CFArrayGetCount(rows), 512);
  for (CFIndex index = 0; index < count; index += 1) {
    AXUIElementRef row =
        (AXUIElementRef)CFArrayGetValueAtIndex(rows, index);
    AXUIElementRef match = FindInRow(row, expected, 0);
    if (match != NULL) {
      CFRelease(match);
      result = (AXUIElementRef)CFRetain(row);
      break;
    }
  }
  CFRelease(value);
  CFRelease(list);
  return result;
}

static AXUIElementRef FindPickerItem(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef row = FindPickerRow(application, expected);
  if (row == NULL) return NULL;
  AXUIElementRef item = FindInRow(row, expected, 0);
  CFRelease(row);
  return item;
}

static BOOL OpenPickerItem(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef item = FindPickerItem(application, expected);
  if (item == NULL) return NO;
  AXError error = AXUIElementPerformAction(item, CFSTR("AXOpen"));
  CFRelease(item);
  return error == kAXErrorSuccess;
}

static BOOL SelectPickerItem(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef row = FindPickerRow(application, expected);
  if (row == NULL) return NO;
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) {
    CFRelease(row);
    return NO;
  }
  AXUIElementRef list =
      FindDescendantByIdentifier(panel, CFSTR("ListView"));
  CFRelease(panel);
  if (list == NULL) {
    CFRelease(row);
    return NO;
  }
  const void *rowValue = row;
  CFArrayRef requested =
      CFArrayCreate(NULL, &rowValue, 1, &kCFTypeArrayCallBacks);
  AXError error = AXUIElementSetAttributeValue(
      list, kAXSelectedRowsAttribute, requested);
  CFTypeRef selected = NULL;
  BOOL observed =
      error == kAXErrorSuccess &&
      AXUIElementCopyAttributeValue(
          list, kAXSelectedRowsAttribute, &selected) == kAXErrorSuccess &&
      selected != NULL && CFGetTypeID(selected) == CFArrayGetTypeID() &&
      CFArrayContainsValue(
          (CFArrayRef)selected,
          CFRangeMake(0, CFArrayGetCount((CFArrayRef)selected)),
          row);
  if (selected != NULL) CFRelease(selected);
  CFRelease(requested);
  CFRelease(list);
  CFRelease(row);
  return observed;
}

static BOOL PickerIsAt(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NO;
  AXUIElementRef location =
      FindDescendantByIdentifier(panel, CFSTR("where popup"));
  CFRelease(panel);
  if (location == NULL) return NO;
  BOOL matches =
      StringAttributeEquals(location, kAXValueAttribute, expected);
  CFRelease(location);
  return matches;
}

static BOOL SelectPickerSidebarItem(
    AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NO;
  CFMutableArrayRef queue =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  CFArrayAppendValue(queue, panel);
  CFRelease(panel);
  BOOL observed = NO;
  for (CFIndex cursor = 0;
       cursor < CFArrayGetCount(queue) && cursor < 128 && !observed;
       cursor += 1) {
    AXUIElementRef element =
        (AXUIElementRef)CFArrayGetValueAtIndex(queue, cursor);
    if (StringAttributeEquals(element, kAXRoleAttribute, kAXOutlineRole) &&
        !StringAttributeEquals(
            element, kAXIdentifierAttribute, CFSTR("ListView"))) {
      CFTypeRef rowsValue = NULL;
      if (AXUIElementCopyAttributeValue(
              element, kAXRowsAttribute, &rowsValue) == kAXErrorSuccess &&
          rowsValue != NULL &&
          CFGetTypeID(rowsValue) == CFArrayGetTypeID()) {
        CFArrayRef rows = (CFArrayRef)rowsValue;
        CFIndex count = MIN(CFArrayGetCount(rows), 64);
        for (CFIndex index = 0; index < count && !observed; index += 1) {
          AXUIElementRef row =
              (AXUIElementRef)CFArrayGetValueAtIndex(rows, index);
          if (!RowContainsExpected(row, expected, 0)) continue;
          const void *rowValue = row;
          CFArrayRef requested =
              CFArrayCreate(NULL, &rowValue, 1, &kCFTypeArrayCallBacks);
          AXError error = AXUIElementSetAttributeValue(
              element, kAXSelectedRowsAttribute, requested);
          CFTypeRef selected = NULL;
          observed =
              error == kAXErrorSuccess &&
              AXUIElementCopyAttributeValue(
                  element, kAXSelectedRowsAttribute, &selected) ==
                  kAXErrorSuccess &&
              selected != NULL &&
              CFGetTypeID(selected) == CFArrayGetTypeID() &&
              CFArrayContainsValue(
                  (CFArrayRef)selected,
                  CFRangeMake(
                      0, CFArrayGetCount((CFArrayRef)selected)),
                  row);
          if (selected != NULL) CFRelease(selected);
          CFRelease(requested);
        }
      }
      if (rowsValue != NULL) CFRelease(rowsValue);
    }
    CFTypeRef childrenValue = NULL;
    if (AXUIElementCopyAttributeValue(
            element, kAXChildrenAttribute, &childrenValue) !=
            kAXErrorSuccess ||
        childrenValue == NULL)
      continue;
    if (CFGetTypeID(childrenValue) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)childrenValue;
      CFIndex count = MIN(CFArrayGetCount(children), 64);
      for (CFIndex index = 0;
           index < count && CFArrayGetCount(queue) < 128;
           index += 1)
        CFArrayAppendValue(queue, CFArrayGetValueAtIndex(children, index));
    }
    CFRelease(childrenValue);
  }
  CFRelease(queue);
  return observed;
}

static BOOL PressPickerControl(
    AXUIElementRef application, CFStringRef identifier) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NO;
  AXUIElementRef control =
      FindDescendantByIdentifier(panel, identifier);
  CFRelease(panel);
  if (control == NULL) return NO;
  AXError error = AXUIElementPerformAction(control, kAXPressAction);
  CFRelease(control);
  return error == kAXErrorSuccess;
}

static AXUIElementRef FindUniqueActionablePickerControl(
    AXUIElementRef application, CFStringRef identifier) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NULL;
  AXUIElementRef control =
      FindDescendantByIdentifier(panel, identifier);
  CFRelease(panel);
  if (control == NULL) return NULL;
  CFTypeRef enabled = NULL;
  CFArrayRef actions = NULL;
  BOOL isEnabled =
      AXUIElementCopyAttributeValue(
          control, kAXEnabledAttribute, &enabled) == kAXErrorSuccess &&
      enabled != NULL && CFGetTypeID(enabled) == CFBooleanGetTypeID() &&
      CFBooleanGetValue((CFBooleanRef)enabled);
  BOOL exposesPress =
      AXUIElementCopyActionNames(control, &actions) == kAXErrorSuccess &&
      actions != NULL &&
      CFArrayContainsValue(
          actions, CFRangeMake(0, CFArrayGetCount(actions)), kAXPressAction);
  if (enabled != NULL) CFRelease(enabled);
  if (actions != NULL) CFRelease(actions);
  if (isEnabled && exposesPress) return control;
  CFRelease(control);
  return NULL;
}

static double MonotonicSeconds(void);

static BOOL PressPickerControlWithProjectionTiming(
    AXUIElementRef application,
    CFStringRef identifier,
    NSUInteger *nativeActionMs,
    double *projectionStartedAt) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NO;
  AXUIElementRef control = FindDescendantByIdentifier(panel, identifier);
  CFRelease(panel);
  if (control == NULL) return NO;
  double actionStartedAt = MonotonicSeconds();
  AXError error = AXUIElementPerformAction(control, kAXPressAction);
  double actionReturnedAt = MonotonicSeconds();
  CFRelease(control);
  if (error != kAXErrorSuccess) return NO;
  *nativeActionMs = (NSUInteger)(
      MAX(0.0, actionReturnedAt - actionStartedAt) * 1000.0 + 0.5);
  *projectionStartedAt = actionReturnedAt;
  return YES;
}

static AXUIElementRef FindMenuItem(
    AXUIElementRef application, CFStringRef expected) {
  CFMutableArrayRef queue =
      CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  CFArrayAppendValue(queue, application);
  AXUIElementRef result = NULL;
  const CFStringRef containers[] = {
    kAXWindowsAttribute,
    kAXChildrenAttribute,
    kAXVisibleChildrenAttribute,
  };
  for (CFIndex cursor = 0;
       cursor < CFArrayGetCount(queue) && cursor < 128;
       cursor += 1) {
    AXUIElementRef element =
        (AXUIElementRef)CFArrayGetValueAtIndex(queue, cursor);
    if (ElementMatches(element, expected) &&
        StringAttributeEquals(element, kAXRoleAttribute, kAXMenuItemRole)) {
      result = (AXUIElementRef)CFRetain(element);
      break;
    }
    for (NSUInteger containerIndex = 0;
         containerIndex < 3;
         containerIndex += 1) {
      CFTypeRef value = NULL;
      if (AXUIElementCopyAttributeValue(
              element, containers[containerIndex], &value) !=
              kAXErrorSuccess ||
          value == NULL)
        continue;
      BOOL appended = NO;
      if (CFGetTypeID(value) == CFArrayGetTypeID()) {
        CFArrayRef children = (CFArrayRef)value;
        CFIndex count = MIN(CFArrayGetCount(children), 64);
        for (CFIndex index = 0;
             index < count && CFArrayGetCount(queue) < 128;
             index += 1)
          CFArrayAppendValue(queue, CFArrayGetValueAtIndex(children, index));
        appended = count > 0;
      }
      CFRelease(value);
      if (appended) break;
    }
  }
  CFRelease(queue);
  return result;
}

static BOOL NavigatePickerToDocuments(AXUIElementRef application) {
  if (PickerIsAt(application, CFSTR("Documents")) ||
      PickerIsAt(application, CFSTR("Dokumente")))
    return YES;
  if (OpenPickerItem(application, CFSTR("Documents")) ||
      OpenPickerItem(application, CFSTR("Dokumente"))) {
    usleep(100 * 1000);
    if (PickerIsAt(application, CFSTR("Documents")) ||
        PickerIsAt(application, CFSTR("Dokumente")))
      return YES;
  }
  if (SelectPickerSidebarItem(application, CFSTR("Documents")) ||
      SelectPickerSidebarItem(application, CFSTR("Dokumente"))) {
    usleep(100 * 1000);
    return PickerIsAt(application, CFSTR("Documents")) ||
        PickerIsAt(application, CFSTR("Dokumente"));
  }
  if (!PressPickerControl(application, CFSTR("where popup"))) {
    return NO;
  }
  usleep(100 * 1000);
  AXUIElementRef item = FindMenuItem(application, CFSTR("Documents"));
  if (item == NULL) item = FindMenuItem(application, CFSTR("Dokumente"));
  if (item == NULL) return NO;
  AXError error = AXUIElementPerformAction(item, kAXPressAction);
  CFRelease(item);
  if (error != kAXErrorSuccess) return NO;
  usleep(100 * 1000);
  return PickerIsAt(application, CFSTR("Documents")) ||
      PickerIsAt(application, CFSTR("Dokumente"));
}

static BOOL PickerHasIdentifier(
    AXUIElementRef application, CFStringRef identifier) {
  AXUIElementRef panel = FindPickerPanel(application);
  if (panel == NULL) return NO;
  AXUIElementRef element =
      FindDescendantByIdentifier(panel, identifier);
  CFRelease(panel);
  if (element == NULL) return NO;
  CFRelease(element);
  return YES;
}

static BOOL EnsurePickerListView(AXUIElementRef application) {
  if (PickerHasIdentifier(application, CFSTR("ListView"))) return YES;
  if (!PressPickerControl(application, CFSTR("View Options"))) return NO;
  usleep(100 * 1000);
  AXUIElementRef item = FindMenuItem(application, CFSTR("List"));
  if (item == NULL) return NO;
  AXError error = AXUIElementPerformAction(item, kAXPressAction);
  CFRelease(item);
  if (error != kAXErrorSuccess) return NO;
  usleep(100 * 1000);
  return PickerHasIdentifier(application, CFSTR("ListView"));
}

static BOOL HasUnique(AXUIElementRef application, CFStringRef expected) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  CFRelease(element);
  return YES;
}

static BOOL HasCancellationProjection(AXUIElementRef application) {
  const CFStringRef expected[] = {
    CFSTR("Keiko beendet den Codex-Lauf sicher."),
    CFSTR("Der Codex-Lauf wurde abgebrochen und vollständig beendet."),
  };
  return HasAnyUniqueValue(
      application, expected, sizeof(expected) / sizeof(expected[0]));
}

static BOOL Perform(
    AXUIElementRef application,
    CFStringRef expected,
    CFStringRef action) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  AXError error = AXUIElementPerformAction(element, action);
  CFRelease(element);
  return error == kAXErrorSuccess;
}

static BOOL Press(AXUIElementRef application, CFStringRef expected) {
  return Perform(application, expected, kAXPressAction);
}

static BOOL SetValue(
    AXUIElementRef application, CFStringRef expected, CFStringRef value) {
  AXUIElementRef element = FindUnique(application, expected);
  if (element == NULL) return NO;
  AXError focusError = AXUIElementSetAttributeValue(
      element, kAXFocusedAttribute, kCFBooleanTrue);
  AXError error = AXUIElementSetAttributeValue(
      element, kAXValueAttribute, value);
  BOOL observed =
      focusError == kAXErrorSuccess && error == kAXErrorSuccess &&
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

static BOOL ProjectionPairIsAllowed(NSString *action, NSString *observation) {
  if (observation == nil) return YES;
  return
      ([action isEqualToString:@"open-canvas"] &&
       [observation isEqualToString:@"probe-canvas"]) ||
      ([action isEqualToString:@"cancel-workspace-picker"] &&
       [observation isEqualToString:@"observe-workspace-cancelled"]) ||
      ([action isEqualToString:@"select-workspace"] &&
       ([observation isEqualToString:@"observe-workspace-selected"] ||
        [observation isEqualToString:@"observe-workspace-permission-denied"])) ||
      ([action isEqualToString:@"cancel-turn"] &&
       [observation isEqualToString:@"observe-stopping"]);
}

static BOOL ProjectionIsVisible(
    AXUIElementRef application,
    NSString *observation,
    NSString *exactWorkspaceProjection) {
  if ([observation isEqualToString:@"probe-canvas"]) {
    const CFStringRef expected[] = {
      CFSTR("ime-harness"),
      CFSTR("codex-task"),
      CFSTR("Repository auswählen"),
      CFSTR("Codex-Bereitschaft prüfen"),
    };
    return HasUniqueSet(
        application, expected, sizeof(expected) / sizeof(expected[0]));
  }
  if ([observation isEqualToString:@"observe-workspace-selected"]) {
    return exactWorkspaceProjection != nil &&
        HasUnique(
            application,
            (__bridge CFStringRef)exactWorkspaceProjection);
  }
  if ([observation isEqualToString:@"observe-workspace-cancelled"]) {
    return HasUnique(
        application,
        CFSTR("Auswahl abgebrochen. Es wurde kein Repository gebunden."));
  }
  if ([observation isEqualToString:@"observe-workspace-permission-denied"]) {
    return HasUnique(
        application,
        CFSTR("Zugriff verweigert. Wählen Sie das Repository erneut und erlauben Sie den Zugriff."));
  }
  if ([observation isEqualToString:@"observe-stopping"]) {
    return HasCancellationProjection(application);
  }
  return NO;
}

static double MonotonicSeconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1.0;
  return (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}

static BOOL WaitForUnique(
    AXUIElementRef application, CFStringRef expected) {
  const double startedAt = MonotonicSeconds();
  if (startedAt < 0.0) return NO;
  const double deadline = startedAt + 5.0;
  while (YES) {
    if (HasUnique(application, expected)) return YES;
    usleep(5 * 1000);
    double now = MonotonicSeconds();
    if (now < 0.0 || now >= deadline) return NO;
  }
}

static AXUIElementRef WaitForUniqueActionablePickerControl(
    AXUIElementRef application, CFStringRef identifier) {
  const double startedAt = MonotonicSeconds();
  if (startedAt < 0.0) return NULL;
  const double deadline = startedAt + 5.0;
  while (YES) {
    AXUIElementRef control =
        FindUniqueActionablePickerControl(application, identifier);
    if (control != NULL) return control;
    usleep(5 * 1000);
    double now = MonotonicSeconds();
    if (now < 0.0 || now >= deadline) return NULL;
  }
}

static BOOL PressReadyPickerCancellation(
    AXUIElementRef application,
    double *projectionStartedAt,
    const char **failureReasonCode) {
  AXUIElementRef control = WaitForUniqueActionablePickerControl(
      application, CFSTR("CancelButton"));
  if (control == NULL) return NO;
  *failureReasonCode = "bounded-wait-expired";
  double actionStartedAt = MonotonicSeconds();
  if (actionStartedAt < 0.0) {
    CFRelease(control);
    return NO;
  }
  AXError error = AXUIElementPerformAction(control, kAXPressAction);
  CFRelease(control);
  if (error != kAXErrorSuccess) return NO;
  *projectionStartedAt = actionStartedAt;
  return YES;
}

static BOOL WaitForProjection(
    AXUIElementRef application,
    NSString *observation,
    NSString *exactWorkspaceProjection,
    double startedAt,
    NSUInteger *projectedMs) {
  const double deadline = startedAt + 5.0;
  while (YES) {
    if (ProjectionIsVisible(
            application, observation, exactWorkspaceProjection)) {
      double elapsed = MonotonicSeconds() - startedAt;
      if (elapsed < 0.0) return NO;
      *projectedMs = (NSUInteger)(MAX(0.0, elapsed) * 1000.0 + 0.5);
      return YES;
    }
    usleep(5 * 1000);
    double now = MonotonicSeconds();
    if (now < 0.0 || now >= deadline) break;
  }
  return NO;
}

static void Emit(BOOL passed, const char *reasonCode) {
  if (passed) {
    puts("{\"status\":\"passed\",\"reasonCode\":null,\"prompted\":false}");
  } else {
    printf(
        "{\"status\":\"failed\",\"reasonCode\":\"%s\",\"prompted\":false}\n",
        reasonCode);
  }
}

static void EmitProjection(
    BOOL passed, const char *reasonCode, NSUInteger projectedMs) {
  if (passed) {
    printf(
        "{\"status\":\"passed\",\"reasonCode\":null,\"prompted\":false,\"projectedMs\":%lu}\n",
        (unsigned long)projectedMs);
  } else {
    Emit(NO, reasonCode);
  }
}

static void EmitWorkspaceProjection(
    BOOL passed,
    const char *reasonCode,
    NSUInteger projectedMs,
    NSUInteger nativeActionMs) {
  if (passed) {
    printf(
        "{\"status\":\"passed\",\"reasonCode\":null,\"prompted\":false,\"projectedMs\":%lu,\"nativeActionMs\":%lu}\n",
        (unsigned long)projectedMs,
        (unsigned long)nativeActionMs);
  } else {
    Emit(NO, reasonCode);
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
    if (argc != 3 && argc != 4) {
      Emit(NO, "invalid-invocation");
      return 2;
    }
    pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
    NSString *action = [NSString stringWithUTF8String:argv[2]];
    NSString *observation =
        argc == 4 ? [NSString stringWithUTF8String:argv[3]] : nil;
    NSSet<NSString *> *allowed = [NSSet setWithArray:@[
${tracerAccessibilityActions.map((action) => `      @"${action}",`).join("\n")}
    ]];
    NSSet<NSString *> *activatingActions = [NSSet setWithArray:@[
${tracerAccessibilityActivatingActions.map((action) => `      @"${action}",`).join("\n")}
    ]];
    if (pid < 1 || action == nil || (argc == 4 && observation == nil) ||
        ![allowed containsObject:action] ||
        !ProjectionPairIsAllowed(action, observation)) {
      Emit(NO, "invalid-invocation");
      return 2;
    }
    NSRunningApplication *runningApplication =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (runningApplication == nil || ![runningApplication isFinishedLaunching]) {
      Emit(NO, "missing-or-ambiguous-semantic-target");
      return 1;
    }
    if ([activatingActions containsObject:action]) {
      if (!ActivateApplication(pid)) {
        Emit(NO, "missing-or-ambiguous-semantic-target");
        return 1;
      }
      usleep(50 * 1000);
    }
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    BOOL passed = NO;
    double projectionStartedAt = 0.0;
    NSUInteger nativeActionMs = 0;
    NSString *selectedWorkspaceProjection = nil;
    const char *failureReasonCode =
        "missing-or-ambiguous-semantic-target";
    if ([action isEqualToString:@"probe-start"]) {
      BOOL welcome = HasUnique(application, CFSTR("Foundation öffnen"));
      BOOL canvas = HasUnique(application, CFSTR("codex-task"));
      BOOL navigation =
          HasUnique(application, CFSTR("ÜBER DIESE VERSION")) ||
          HasUnique(application, CFSTR("UPDATE-STATUS"));
      passed = (welcome || canvas || navigation) &&
          HasUnique(application, CFSTR("Keiko Native beenden"));
    } else if ([action isEqualToString:@"open-canvas"]) {
      BOOL welcome = HasUnique(application, CFSTR("Foundation öffnen"));
      BOOL navigation =
          HasUnique(application, CFSTR("ÜBER DIESE VERSION")) ||
          HasUnique(application, CFSTR("UPDATE-STATUS"));
      if (!welcome && !navigation &&
          HasUnique(application, CFSTR("codex-task"))) {
        navigation =
            Press(application, CFSTR("Über Keiko Native")) &&
            WaitForUnique(application, CFSTR("ÜBER DIESE VERSION"));
      }
      if (welcome || navigation) {
        projectionStartedAt = MonotonicSeconds();
        passed = welcome
            ? Press(application, CFSTR("Foundation öffnen"))
            : Press(application, CFSTR("Leere Fläche"));
      }
    } else if ([action isEqualToString:@"probe-canvas"]) {
      const CFStringRef expected[] = {
        CFSTR("ime-harness"),
        CFSTR("codex-task"),
        CFSTR("Repository auswählen"),
        CFSTR("Codex-Bereitschaft prüfen"),
      };
      passed = HasUniqueSet(
          application, expected, sizeof(expected) / sizeof(expected[0]));
    } else if ([action isEqualToString:@"open-workspace-picker"]) {
      passed =
          Press(application, CFSTR("Repository auswählen")) ||
          Press(application, CFSTR("Anderes Repository auswählen"));
    } else if ([action isEqualToString:@"select-workspace"]) {
      NSString *label = ReadBoundedInput();
      NSCharacterSet *invalid =
          [[NSCharacterSet alphanumericCharacterSet] invertedSet];
      BOOL labelValid =
          label != nil &&
          [label hasPrefix:@"KeikoAcceptanceIdentity104"] &&
          [label rangeOfCharacterFromSet:invalid].location == NSNotFound;
      if (labelValid) {
        selectedWorkspaceProjection =
            [NSString stringWithFormat:@"Ausgewählt: %@", label];
      }
      passed = labelValid &&
          (PickerIsAt(application, (__bridge CFStringRef)label) ||
           (EnsurePickerListView(application) &&
            NavigatePickerToDocuments(application) &&
            SelectPickerItem(application, (__bridge CFStringRef)label)));
      if (passed) {
        passed = NO;
        for (NSUInteger attempt = 0; attempt < 20 && !passed; attempt += 1) {
          usleep(50 * 1000);
          if ([observation isEqualToString:@"observe-workspace-selected"]) {
            passed = PressPickerControlWithProjectionTiming(
                application,
                CFSTR("OKButton"),
                &nativeActionMs,
                &projectionStartedAt);
          } else {
            projectionStartedAt = MonotonicSeconds();
            passed = PressPickerControl(application, CFSTR("OKButton"));
          }
        }
      }
    } else if ([action isEqualToString:@"cancel-workspace-picker"]) {
      passed = PressReadyPickerCancellation(
          application, &projectionStartedAt, &failureReasonCode);
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
      projectionStartedAt = MonotonicSeconds();
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
                   CFSTR("Codex hat normal geantwortet und die Laufzeit wurde beendet.")) &&
          HasUnique(application, CFSTR("Repository-Kontext an Codex: 0 Byte."));
    } else if ([action isEqualToString:@"observe-stopping"]) {
      passed = HasCancellationProjection(application);
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
    if (passed && observation != nil) {
      NSUInteger projectedMs = 0;
      passed = projectionStartedAt > 0.0 &&
          WaitForProjection(
              application,
              observation,
              selectedWorkspaceProjection,
              projectionStartedAt,
              &projectedMs);
      CFRelease(application);
      if ([observation isEqualToString:@"observe-workspace-selected"]) {
        EmitWorkspaceProjection(
            passed,
            failureReasonCode,
            projectedMs,
            nativeActionMs);
      } else {
        EmitProjection(passed, failureReasonCode, projectedMs);
      }
      return passed ? 0 : 1;
    }
    CFRelease(application);
    Emit(passed, failureReasonCode);
    return passed ? 0 : 1;
  }
}
`;
