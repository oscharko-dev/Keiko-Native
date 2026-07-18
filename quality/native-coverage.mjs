export function createNativeCoverageGate({
  coverageFailures,
  ensureFrontendDependencies,
  onMacOs,
  projectContract,
  run,
  sourceRevision,
}) {
  return async function coverageNative() {
    await ensureFrontendDependencies();
    run("npm", ["--prefix", "native/frontend", "run", "coverage"], {
      env: { KEIKO_NATIVE_SOURCE_REVISION: sourceRevision() },
    });
    if (!onMacOs()) return;
    const exclusion = (await projectContract()).coverageExclusions?.[0];
    if (
      exclusion?.path !== "native/apps/keiko-desktop/src/main.rs" ||
      exclusion.evidence !== "acceptance:macos"
    ) {
      throw new Error("Rust coverage exclusion contract rejected");
    }
    const version = run("cargo-llvm-cov", ["llvm-cov", "--version"], {
      capture: true,
    });
    if (version !== "cargo-llvm-cov 0.8.7")
      throw new Error("cargo-llvm-cov version rejected");
    const report = JSON.parse(
      run(
        "cargo",
        [
          "+nightly-2026-07-17",
          "llvm-cov",
          "--locked",
          "--workspace",
          "--all-features",
          "--branch",
          "--json",
          "--summary-only",
          "--ignore-filename-regex",
          exclusion.path,
          "--manifest-path",
          "native/Cargo.toml",
        ],
        { capture: true },
      ),
    );
    const failures = coverageFailures(report);
    if (failures.length > 0) throw new Error(failures.join(","));
  };
}
