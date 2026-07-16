use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Clone, Debug, Eq, PartialEq, Parser)]
#[command(name = "keiko-eval")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Clone, Debug, Eq, PartialEq, Subcommand)]
pub enum Command {
    Verify {
        #[arg(long, value_enum)]
        platform: Platform,
    },
    Benchmark {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long, value_parser = parse_output)]
        output: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Platform {
    Current,
}

fn parse_output(value: &str) -> Result<PathBuf, String> {
    if value != "artifacts/current-platform.json" {
        return Err("output must use the canonical sanitized artifact path".into());
    }
    Ok(PathBuf::from(value))
}
