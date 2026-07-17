use std::env;

unsafe extern "C" {
    fn getsid(pid: i32) -> i32;
}

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let pid = (arguments.len() == 1)
        .then(|| arguments[0].parse::<i32>().ok())
        .flatten()
        .filter(|value| *value > 0)
        .unwrap_or_else(|| std::process::exit(64));
    let session = unsafe { getsid(pid) };
    if session <= 0 {
        std::process::exit(65);
    }
    println!("{session}");
}
