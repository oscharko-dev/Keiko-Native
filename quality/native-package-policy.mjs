export const CLOSED_PACKAGE_PATHS = [
  "Contents/Info.plist",
  "Contents/MacOS/keiko-native-desktop",
  "Contents/Resources/THIRD-PARTY-NOTICES.json",
];

export const CLOSED_FILE_CLASSES = {
  "Contents/Info.plist": "plist",
  "Contents/MacOS/keiko-native-desktop": "mach-o-executable",
  "Contents/Resources/THIRD-PARTY-NOTICES.json": "dependency-notice",
};

export const CLOSED_PROHIBITED_MARKERS = [
  "--health-json",
  "codex/9-desktop-host-evaluation",
  "example.invalid",
  "experiment-command",
  "generic-ping",
  "secret-value",
  "test-listener",
  "remote-debugging",
];

export const CLOSED_PROHIBITED_PATH_FRAGMENTS = [
  "node_modules",
  "/target/",
  "/tests/",
  "fixture",
  "experiment",
  "listener",
  "driver",
];

export const CLOSED_SPDX_EXPRESSIONS = [
  "(MIT OR Apache-2.0) AND Unicode-3.0",
  "0BSD OR MIT OR Apache-2.0",
  "Apache-2.0",
  "Apache-2.0 AND MIT",
  "Apache-2.0 OR BSL-1.0",
  "Apache-2.0 OR MIT",
  "Apache-2.0 WITH LLVM-exception",
  "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
  "BSD-3-Clause",
  "BSD-3-Clause OR MIT OR Apache-2.0",
  "CC0-1.0 OR MIT-0 OR Apache-2.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "MIT OR Apache-2.0 OR LGPL-2.1-or-later",
  "MIT OR Apache-2.0 OR Zlib",
  "MIT OR Zlib OR Apache-2.0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense OR MIT",
  "Zlib",
  "Zlib OR Apache-2.0 OR MIT",
];
