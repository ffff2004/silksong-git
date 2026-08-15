//! Controlled executable used only by runtime-layout tests.
//!
//! It deliberately has no Node, shell, or system Git dependency. The copied
//! test installation chooses behavior by executable/entry file name.

use std::{
    env,
    fs::OpenOptions,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use silksong_git_desktop_lib::desktop_sidecar_protocol::VERSION;

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--version")
    {
        if env::var_os("GIT_TEST_SENTINEL").is_some() {
            assert_restricted_environment(
                env::var_os("RUNTIME_LAYOUT_EXPECTED_GIT_EXECUTABLE").map(PathBuf::from),
            );
        }
        let executable_name = env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
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
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        if executable_name.contains("node-env-check") {
            assert_restricted_environment(None);
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
    if env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .is_some_and(|name| name.contains("desktop-business-sidecar"))
    {
        desktop_business_sidecar(&arguments);
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument.contains("sidecar-env-check"))
    {
        assert_restricted_environment(None);
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

fn desktop_business_sidecar(arguments: &[String]) {
    assert!(
        arguments.is_empty(),
        "bundled business sidecars must launch without a system-runtime command"
    );
    assert_restricted_environment(
        env::var_os("RUNTIME_LAYOUT_EXPECTED_SIDECAR_EXECUTABLE").map(PathBuf::from),
    );

    if let Some(marker) = env::var_os("RUNTIME_LAYOUT_BUSINESS_MARKER") {
        let executable = env::current_exe().expect("business sidecar executable path");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(marker)
            .expect("open business sidecar marker");
        writeln!(file, "{}", executable.to_string_lossy()).expect("record business sidecar path");
    }

    println!(
        "{{\"protocolVersion\":{VERSION},\"kind\":\"event\",\"event\":{{\"type\":\"process.ready\"}}}}"
    );
    io::stdout().flush().expect("flush business sidecar ready");

    for line in io::stdin().lock().lines() {
        let line = line.expect("read business sidecar command");
        let request: Value = serde_json::from_str(&line).expect("parse business sidecar command");
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .expect("business sidecar request ID");
        let command_type = request
            .pointer("/command/type")
            .and_then(Value::as_str)
            .expect("business sidecar command type");
        let result = match command_type {
            "repository.inspect" => json!({
                "type": "repository.inspected",
                "inspection": {
                    "status": "ready",
                    "requiredAction": "open",
                    "capabilities": ["read"],
                },
            }),
            "session.open" => json!({
                "type": "session.opened",
                "connection": {
                    "endpoint": "http://127.0.0.1:4312",
                    "bearerToken": "test-token",
                },
                "access": "readWrite",
            }),
            "process.shutdown" => json!({ "type": "process.shutdownComplete" }),
            _ => panic!("unexpected business sidecar command: {command_type}"),
        };
        let response = json!({
            "protocolVersion": VERSION,
            "kind": "response",
            "requestId": request_id,
            "ok": true,
            "result": result,
        });
        println!(
            "{}",
            serde_json::to_string(&response).expect("serialize business response")
        );
        io::stdout()
            .flush()
            .expect("flush business sidecar response");
        if command_type == "process.shutdown" {
            return;
        }
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

fn assert_restricted_environment(expected_executable: Option<PathBuf>) {
    let path_entries = env::vars_os()
        .filter(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .collect::<Vec<_>>();
    let executable = env::current_exe().expect("fixture executable path");
    let expected_path = env::var_os("RUNTIME_LAYOUT_EXPECTED_PATH")
        .map(PathBuf::from)
        .or_else(|| executable.parent().map(Path::to_path_buf))
        .expect("fixture executable parent");
    assert_eq!(path_entries.len(), 1, "runtime must install one PATH entry");
    assert_eq!(path_entries[0].0, "PATH");
    assert_eq!(PathBuf::from(&path_entries[0].1), expected_path);
    if let Some(expected_executable) = expected_executable {
        assert_eq!(executable, expected_executable);
    }
    assert!(env::vars_os().all(|(key, _)| {
        !key.to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("NODE_")
    }));
    if env::var_os("GIT_TEST_SENTINEL").is_some() {
        assert_eq!(
            env::var_os("GIT_TEST_SENTINEL"),
            Some("retained-for-history".into()),
            "Runtime Layout must leave History-owned GIT_* isolation intact"
        );
    }
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
