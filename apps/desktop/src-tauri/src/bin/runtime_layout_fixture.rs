//! Controlled executable used only by runtime-layout tests.
//!
//! It deliberately has no Node, shell, or system Git dependency. The copied
//! test installation chooses behavior by executable/entry file name.

use std::{
    env,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
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
        let executable_name = env::current_exe()
            .ok()
            .and_then(|path| path.file_name().map(ToOwned::to_owned))
            .and_then(|name| name.to_str().map(str::to_owned))
            .unwrap_or_default();
        if executable_name.contains("git-malformed") {
            println!("git version 2.34");
        } else if executable_name.contains("git-floor") {
            println!("git version 2.34.0");
        } else if executable_name.contains("git-ceiling") {
            println!("git version 2.99.999");
        } else if executable_name.contains("git-extra-line") {
            println!("git version 2.34.0");
            println!("extra");
        } else if executable_name.contains("git-crlf") {
            print!("git version 2.34.0\r\n");
        } else if executable_name.contains("git-control") {
            println!("git version 2.34.0\x01vendor");
        } else if executable_name.contains("git-four-part") {
            println!("git version 2.34.0.1");
        } else if executable_name.contains("git-multiline") {
            println!("git version 2.34.0\nsecond");
        } else if executable_name.contains("git-unsafe-suffix") {
            println!("git version 2.34.0vendor");
        } else if executable_name.contains("git-incompatible") {
            println!("git version 2.33.9");
        } else if executable_name.contains("git-upper-bound") {
            println!("git version 3.0.0");
        } else if executable_name.contains("git-apple") {
            println!("git version 2.39.5 (Apple Git-154)");
        } else if executable_name.contains("git-windows") {
            println!("git version 2.45.2.windows.1");
        } else if executable_name.contains("git-vendor") {
            println!("git version 2.39.5 (Apple Git-154)");
        } else {
            println!("git version 2.43.0");
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "--eval")
    {
        let executable_name = env::current_exe()
            .ok()
            .and_then(|path| path.file_name().map(ToOwned::to_owned))
            .and_then(|name| name.to_str().map(str::to_owned))
            .unwrap_or_default();
        if executable_name.contains("node-env-check") {
            assert_restricted_environment();
        }
        let major = if executable_name.contains("node-incompatible") {
            23
        } else {
            24
        };
        let sqlite = if executable_name.contains("node-sqlite-missing") {
            "unavailable"
        } else {
            "prepared-write-read-close"
        };
        println!(r#"{{"nodeMajor":{major},"sqlite":"{sqlite}"}}"#);
        if sqlite == "unavailable" {
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument.contains("sidecar-env-check"))
    {
        assert_restricted_environment();
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
            let marker = env::var_os("RUNTIME_LAYOUT_DESCENDANT_PID")
                .map(PathBuf::from)
                .or_else(|| {
                    env::current_exe()
                        .ok()
                        .and_then(|path| path.parent().map(Path::to_path_buf))
                        .and_then(|path| path.parent().map(Path::to_path_buf))
                        .map(|path| path.join("descendant-pid"))
                })
                .expect("descendant marker path");
            std::fs::write(marker, descendant_pid.to_string()).expect("write descendant pid");
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

fn assert_restricted_environment() {
    let path_entries = env::vars_os()
        .filter(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .collect::<Vec<_>>();
    let expected_path = env::current_exe()
        .expect("fixture executable path")
        .parent()
        .expect("fixture executable parent")
        .to_path_buf();
    assert_eq!(path_entries.len(), 1, "runtime must install one PATH entry");
    assert_eq!(path_entries[0].0, "PATH");
    assert_eq!(PathBuf::from(&path_entries[0].1), expected_path);
    assert!(env::vars_os().all(|(key, _)| {
        !key.to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("NODE_")
    }));
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
