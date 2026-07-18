import { homedir } from "node:os";
import { join } from "node:path";

export function sanitizeOutput(value) {
  return value
    .replaceAll(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
      "<redacted-private-key>",
    )
    .replaceAll(/\/Users\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/\/home\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/[A-Z]:\\Users\\[^\\\s]+/gu, "<redacted-path>")
    .replaceAll(
      /(["']?(?:token|password|secret|credential|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)/giu,
      "$1<redacted>",
    )
    .replaceAll(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "<redacted-email>",
    )
    .replaceAll(/\b(?:https?|wss?):\/\/[^\s,)}\]]+/giu, "<redacted-endpoint>");
}

export function sanitizeDiagnostic(value) {
  const tail = sanitizeOutput(String(value))
    .split("\n")
    .slice(-8)
    .map((line) =>
      /^\s*[\[{]/u.test(line) ? "<redacted-structured-output>" : line,
    )
    .join("\n")
    .slice(-1024)
    .trim();
  return tail.length > 0 ? tail : "native-gate-failure";
}

export async function runNativeGateCli(
  execute,
  mode,
  writeError = console.error,
) {
  try {
    await execute(mode);
    return 0;
  } catch (error) {
    writeError(sanitizeDiagnostic(error?.message ?? String(error)));
    return 1;
  }
}

export function commandFailure(command, args, result) {
  const cause = result.error?.code
    ? `spawn:${result.error.code}`
    : `status:${result.status ?? "unknown"}`;
  const rawOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const tail = rawOutput.trim().length > 0 ? sanitizeDiagnostic(rawOutput) : "";
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
