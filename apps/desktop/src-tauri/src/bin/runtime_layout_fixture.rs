//! Controlled executable used only by runtime-layout tests.
//!
//! It deliberately has no Node, shell, or system Git dependency. The copied
//! test installation chooses behavior by executable/entry file name.

use std::{
    env,
    io::{self, BufRead, Write},
    process::Command,
    thread,
    time::Duration,
};

use silksong_git_desktop_lib::desktop_sidecar_protocol::VERSION;

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--version")
    {
        println!("runtime-layout-fixture 1");
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "descendant")
    {
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    let behavior = arguments
        .first()
        .map(String::as_str)
        .and_then(|entry| entry.rsplit('/').next().or(Some(entry)))
        .map(str::to_owned)
        .or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| path.file_name().map(ToOwned::to_owned))
                .and_then(|name| name.to_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "ready".to_owned());
    match behavior {
        value if value.contains("malformed") => println!("not json"),
        value if value.contains("timeout") => thread::sleep(Duration::from_secs(60)),
        value if value.contains("output") => println!("{}", "x".repeat(70 * 1024)),
        value if value.contains("no-shutdown") => ready_without_shutdown_complete(),
        value if value.contains("no-exit") => ready_then_shutdown_without_exit(),
        value if value.contains("descendant") => {
            let descendant_pid = spawn_descendant();
            if let Some(marker) = env::var_os("RUNTIME_LAYOUT_DESCENDANT_PID") {
                std::fs::write(marker, descendant_pid.to_string()).expect("write descendant pid");
            }
            thread::sleep(Duration::from_secs(60));
        }
        _ => ready_then_shutdown(),
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_descendant() -> u32 {
    // The runtime-layout adapter, not this fixture, owns this child tree.
    Command::new(env::current_exe().expect("fixture executable"))
        .arg("descendant")
        .spawn()
        .expect("spawn fixture descendant")
        .id()
}

fn ready_then_shutdown() {
    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"event\",\"event\":{{\"type\":\"process.ready\"}}}}"
    );
    io::stdout().flush().expect("flush ready");
    let mut line = String::new();
    let _ = io::stdin().lock().read_line(&mut line);
    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"response\",\"requestId\":\"runtime-layout-probe\",\"ok\":true,\"result\":{{\"type\":\"process.shutdownComplete\"}}}}"
    );
}

fn ready_without_shutdown_complete() {
    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"event\",\"event\":{{\"type\":\"process.ready\"}}}}"
    );
    io::stdout().flush().expect("flush ready");
    let mut line = String::new();
    let _ = io::stdin().lock().read_line(&mut line);
    thread::sleep(Duration::from_secs(60));
}

fn ready_then_shutdown_without_exit() {
    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"event\",\"event\":{{\"type\":\"process.ready\"}}}}"
    );
    io::stdout().flush().expect("flush ready");
    let mut line = String::new();
    let _ = io::stdin().lock().read_line(&mut line);
    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"response\",\"requestId\":\"runtime-layout-probe\",\"ok\":true,\"result\":{{\"type\":\"process.shutdownComplete\"}}}}"
    );
    io::stdout().flush().expect("flush shutdown response");
    thread::sleep(Duration::from_secs(60));
}
