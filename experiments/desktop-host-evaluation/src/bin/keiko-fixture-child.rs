use std::process::Command;

fn main() -> std::io::Result<()> {
    let arguments: Vec<_> = std::env::args().collect();
    if arguments.iter().any(|argument| argument == "--leaf") {
        std::thread::park();
        return Ok(());
    }
    let executable = std::env::current_exe()?;
    let _grandchild = Command::new(executable).arg("--leaf").spawn()?;
    if arguments.iter().any(|argument| argument == "--exit-root") {
        return Ok(());
    }
    std::thread::park();
    Ok(())
}
