#import <AppKit/AppKit.h>

int keiko_evaluation_activate(void) {
  @autoreleasepool {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    if ([NSApp respondsToSelector:@selector(activate)]) {
      [NSApp activate];
    } else {
      [NSApp activateIgnoringOtherApps:YES];
    }
    BOOL visibleWindow = NO;
    for (NSWindow *window in NSApp.windows) {
      [window makeKeyAndOrderFront:nil];
      [window orderFrontRegardless];
      visibleWindow = visibleWindow || window.visible;
    }
    return visibleWindow;
  }
}

int keiko_evaluation_native_dialog_cancel(void) {
  @autoreleasepool {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Foundation evaluation";
    alert.informativeText = @"Synthetic data only";
    [alert addButtonWithTitle:@"Cancel"];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
                     [NSApp abortModal];
                   });
    NSModalResponse response = [alert runModal];
    return response == NSModalResponseAbort || response == NSAlertFirstButtonReturn;
  }
}
