import { homedir } from "node:os";
import { join } from "node:path";

export function sanitizeOutput(value) {
  return value
    .replaceAll(/\/Users\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/\/home\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/[A-Z]:\\Users\\[^\\\s]+/gu, "<redacted-path>")
    .replaceAll(
      /(["']?(?:token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      "$1<redacted>",
    );
}

export function commandFailure(command, args, result) {
  const cause = result.error?.code
    ? `spawn:${result.error.code}`
    : `status:${result.status ?? "unknown"}`;
  const tail = sanitizeOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
    .split("\n")
    .slice(-8)
    .map((line) =>
      /^\s*[\[{]/u.test(line) ? "<redacted-structured-output>" : line,
    )
    .join("\n")
    .slice(-1024)
    .trim();
  const output = tail.length > 0 ? `; output-tail=${tail}` : "";
  return new Error(`${command} ${args[0] ?? ""} failed (${cause}${output})`);
}

export function productiveRustEnv(repositoryRoot, revision) {
  const home = homedir();
  const mappings = [
    [repositoryRoot, "/workspace"],
    [process.env.CARGO_HOME ?? join(home, ".cargo"), "/toolchain/cargo"],
    [process.env.RUSTUP_HOME ?? join(home, ".rustup"), "/toolchain/rustup"],
    [home, "/operator"],
  ];
  return {
    CARGO_ENCODED_RUSTFLAGS: mappings
      .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
      .join("\x1f"),
    KEIKO_NATIVE_SOURCE_REVISION: revision,
    RUSTFLAGS: "",
  };
}
