use clap::Parser;
use keiko_eval::cli::{Cli, Command, Platform};

#[test]
fn canonical_verify_and_benchmark_commands_parse() {
    let verify = Cli::try_parse_from(["keiko-eval", "verify", "--platform", "current"]).unwrap();
    assert_eq!(
        verify.command,
        Command::Verify {
            platform: Platform::Current
        }
    );

    let benchmark = Cli::try_parse_from([
        "keiko-eval",
        "benchmark",
        "--platform",
        "current",
        "--output",
        "artifacts/current-platform.json",
    ])
    .unwrap();
    assert!(matches!(benchmark.command, Command::Benchmark { .. }));

    assert!(
        Cli::try_parse_from([
            "keiko-eval",
            "benchmark",
            "--platform",
            "current",
            "--output",
            "/Users/alice/evidence.json",
        ])
        .is_err()
    );
}
