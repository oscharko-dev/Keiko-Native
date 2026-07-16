use clap::Parser;
use keiko_eval::cli::{Cli, Command};
use keiko_eval::runner::{benchmark_current, verify_current};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Verify { platform: _ } => {
            let evidence = verify_current()?;
            println!(
                "verified {} packages for {} at {}",
                evidence.packages.len(),
                evidence.platform,
                evidence.source_commit
            );
        }
        Command::Benchmark {
            platform: _,
            output: _,
        } => {
            let evidence = benchmark_current()?;
            println!(
                "recorded {} sanitized launch samples at {}",
                evidence.samples.len(),
                evidence.source_commit
            );
        }
    }
    Ok(())
}
