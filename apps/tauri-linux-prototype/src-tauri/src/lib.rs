use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WindowEvent};

const PROTOCOL_VERSION: u64 = 1;
const EVENT_TIMEOUT: Duration = Duration::from_secs(30);

struct PrototypeState {
    active_close_probe: Mutex<Option<Sidecar>>,
    closing: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TracerResult {
    visible_steps: Vec<&'static str>,
    resource_dir: String,
    sidecar_path: String,
    private_git_bin_dir: String,
    workspace_path: String,
    encoded_sha256: String,
    restored_sha256: String,
    byte_exact_restore: bool,
    raw_observation_count: u64,
    graceful_first_exit: ExitEvidence,
    graceful_reopen_exit: ExitEvidence,
    unexpected_exit: UnexpectedExitEvidence,
    forced_cleanup: ForcedCleanupEvidence,
    duration_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvidence {
    exit_code: Option<i32>,
    operation_completed_before_stopped: bool,
    stopped_event_seen: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnexpectedExitEvidence {
    exit_code: Option<i32>,
    reported_as: &'static str,
    stopped_event_seen: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForcedCleanupEvidence {
    process_group: i32,
    members_before: Vec<i32>,
    members_after: Vec<i32>,
    bundled_git_pid: i32,
    bundled_git_executable: String,
    bundled_git_executable_matched: bool,
    bundled_git_running_before: bool,
    sidecar_running_after: bool,
    bundled_git_running_after: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWorkResult {
    sidecar_pid: u32,
    protocol_phase: &'static str,
    instruction: &'static str,
}

#[tauri::command]
async fn run_tracer(app: tauri::AppHandle) -> Result<TracerResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_tracer_blocking(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_active_work(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrototypeState>,
) -> Result<ActiveWorkResult, String> {
    let paths = InstalledPaths::resolve(&app)?;
    let workspace = workspace_root("close-drain");
    reset_directory(&workspace)?;
    let mut sidecar = Sidecar::spawn(&paths)?;
    let sidecar_pid = sidecar.pid();
    sidecar.send(json!({
        "version": PROTOCOL_VERSION,
        "id": "close-active",
        "command": "exercise",
        "workspacePath": workspace,
        "fixturePath": paths.fixture_path,
        "activeDelayMs": 2500
    }))?;
    sidecar.wait_for(|message| {
        message["type"] == "prototypePhase"
            && message["replyTo"] == "close-active"
    })?;

    let mut active = state
        .active_close_probe
        .lock()
        .map_err(|_| "active close-probe state is poisoned".to_string())?;
    if active.is_some() {
        return Err("an active close probe already exists".to_string());
    }
    *active = Some(sidecar);

    Ok(ActiveWorkResult {
        sidecar_pid,
        protocol_phase: "beforeObservation",
        instruction: "close the window; Rust will request shutdown and wait for the operation",
    })
}

#[tauri::command]
fn prototype_autorun() -> Option<String> {
    std::env::var("SILKSONG_GIT_PROTOTYPE_AUTORUN").ok()
}

pub fn run() {
    tauri::Builder::default()
        .manage(PrototypeState {
            active_close_probe: Mutex::new(None),
            closing: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            run_tracer,
            start_active_work,
            prototype_autorun
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<PrototypeState>();
                let active = state
                    .active_close_probe
                    .lock()
                    .ok()
                    .and_then(|mut value| value.take());
                if let Some(mut sidecar) = active {
                    api.prevent_close();
                    if state.closing.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let app = window.app_handle().clone();
                    thread::spawn(move || {
                        let started = Instant::now();
                        let result = sidecar.graceful_shutdown("close-shutdown");
                        let evidence = json!({
                            "kind": "closeDrain",
                            "requestedWhileActive": true,
                            "operationCompletedBeforeStopped": result
                                .as_ref()
                                .map(|value| value.operation_completed_before_stopped)
                                .unwrap_or(false),
                            "stoppedEventSeen": result
                                .as_ref()
                                .map(|value| value.stopped_event_seen)
                                .unwrap_or(false),
                            "exitCode": result.as_ref().ok().and_then(|value| value.exit_code),
                            "durationMs": started.elapsed().as_millis(),
                            "error": result.err()
                        });
                        let _ = write_env_evidence(
                            "SILKSONG_GIT_PROTOTYPE_CLOSE_EVIDENCE",
                            &evidence,
                        );
                        app.exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run disposable Tauri prototype");
}

fn run_tracer_blocking(app: &tauri::AppHandle) -> Result<TracerResult, String> {
    let started = Instant::now();
    let paths = InstalledPaths::resolve(app)?;
    let workspace = workspace_root("完整 tracer");
    reset_directory(&workspace)?;
    let history_repo = workspace.join("history-repo");
    let restore_path = workspace.join("恢复 exact.dat");

    let mut first = Sidecar::spawn(&paths)?;
    first.send(json!({
        "version": PROTOCOL_VERSION,
        "id": "exercise",
        "command": "exercise",
        "workspacePath": workspace,
        "fixturePath": paths.fixture_path
    }))?;
    let exercise = first.wait_for(|message| {
        message["type"] == "operationCompleted" && message["replyTo"] == "exercise"
    })?;
    let encoded_sha256 = string_field(&exercise, "/result/encodedSha256")?;
    let raw_observation_count = exercise
        .pointer("/result/rawObservationCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "exercise omitted rawObservationCount".to_string())?;
    let first_exit = first.graceful_shutdown("exercise-shutdown")?;

    let mut reopen = Sidecar::spawn(&paths)?;
    reopen.send(json!({
        "version": PROTOCOL_VERSION,
        "id": "reopen",
        "command": "reopen",
        "repoPath": history_repo,
        "restorePath": restore_path
    }))?;
    let reopened = reopen.wait_for(|message| {
        message["type"] == "operationCompleted" && message["replyTo"] == "reopen"
    })?;
    let restored_sha256 = string_field(&reopened, "/result/restoredSha256")?;
    let reopen_exit = reopen.graceful_shutdown("reopen-shutdown")?;

    let unexpected_exit = probe_unexpected_exit(&paths)?;
    let forced_cleanup = probe_forced_cleanup(&paths)?;
    let byte_exact_restore = encoded_sha256 == restored_sha256;
    if !byte_exact_restore {
        return Err("fresh-process restore was not byte exact".to_string());
    }

    let result = TracerResult {
        visible_steps: vec![
            "resolved installed bundle resources",
            "initialized Save History Repository",
            "observed Encoded Save",
            "queried one Raw Save Observation",
            "gracefully stopped the first sidecar",
            "reopened through a fresh sidecar process",
            "restored Encoded Save byte-for-byte",
            "reported unexpected termination distinctly",
            "force-cleaned a live sidecar and bundled Git process group",
        ],
        resource_dir: paths.resource_dir.display().to_string(),
        sidecar_path: paths.sidecar_path.display().to_string(),
        private_git_bin_dir: paths.private_git_bin_dir.display().to_string(),
        workspace_path: workspace.display().to_string(),
        encoded_sha256,
        restored_sha256,
        byte_exact_restore,
        raw_observation_count,
        graceful_first_exit: first_exit,
        graceful_reopen_exit: reopen_exit,
        unexpected_exit,
        forced_cleanup,
        duration_ms: started.elapsed().as_millis(),
    };
    write_env_evidence(
        "SILKSONG_GIT_PROTOTYPE_TRACER_EVIDENCE",
        &serde_json::to_value(&result).map_err(|error| error.to_string())?,
    )?;
    Ok(result)
}

struct InstalledPaths {
    resource_dir: PathBuf,
    sidecar_path: PathBuf,
    private_git_bin_dir: PathBuf,
    fixture_path: PathBuf,
}

impl InstalledPaths {
    fn resolve(app: &tauri::AppHandle) -> Result<Self, String> {
        let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
        let executable_dir = std::env::current_exe()
            .map_err(|error| error.to_string())?
            .parent()
            .ok_or("installed executable has no parent directory")?
            .to_path_buf();
        let sidecar_path = first_existing(&[
            resource_dir.join("silksong-git-sidecar"),
            resource_dir.join("binaries/silksong-git-sidecar"),
            executable_dir.join("silksong-git-sidecar"),
        ], "fixed bundled sidecar")?;
        let private_git_bin_dir = first_existing(&[
            resource_dir.join("resources/private-git/bin"),
            resource_dir.join("private-git/bin"),
        ], "private Git bin directory")?;
        let fixture_path = first_existing(&[
            resource_dir.join("resources/fixtures/minimal-valid-save.dat"),
            resource_dir.join("fixtures/minimal-valid-save.dat"),
        ], "bundled save fixture")?;
        Ok(Self {
            resource_dir,
            sidecar_path,
            private_git_bin_dir,
            fixture_path,
        })
    }
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    process_group: i32,
    observed: Vec<Value>,
}

impl Sidecar {
    fn spawn(paths: &InstalledPaths) -> Result<Self, String> {
        let mut command = Command::new(&paths.sidecar_path);
        command
            .env(
                "SILKSONG_GIT_BUNDLED_BIN_DIR",
                &paths.private_git_bin_dir,
            )
            .current_dir(&paths.resource_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    libc::raise(libc::SIGKILL);
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to spawn installed sidecar {}: {error}",
                paths.sidecar_path.display()
            )
        })?;
        let process_group = child.id() as i32;
        let stdout = child.stdout.take().ok_or("sidecar stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr was not piped")?;
        let stdin = child.stdin.take().ok_or("sidecar stdin was not piped")?;
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        let parsed = serde_json::from_str::<Value>(&line)
                            .unwrap_or_else(|error| json!({
                                "version": PROTOCOL_VERSION,
                                "type": "invalidJsonl",
                                "error": error.to_string(),
                                "line": line
                            }));
                        let _ = sender.send(parsed);
                    }
                    Err(_) => break,
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[bundled-sidecar stderr] {line}");
            }
        });
        let mut sidecar = Self {
            child,
            stdin,
            messages,
            process_group,
            observed: Vec::new(),
        };
        sidecar.wait_for(|message| message["type"] == "ready")?;
        Ok(sidecar)
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn send(&mut self, value: Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, &value).map_err(|error| error.to_string())?;
        self.stdin.write_all(b"\n").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }

    fn wait_for(&mut self, predicate: impl Fn(&Value) -> bool) -> Result<Value, String> {
        let deadline = Instant::now() + EVENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = self.messages.recv_timeout(remaining).map_err(|error| {
                format!(
                    "timed out waiting for sidecar event ({error}); observed={}",
                    Value::Array(self.observed.clone())
                )
            })?;
            if message["version"].as_u64() != Some(PROTOCOL_VERSION) {
                return Err(format!("invalid sidecar protocol message: {message}"));
            }
            if message["type"] == "invalidJsonl" {
                return Err(format!("sidecar stdout was not valid JSONL: {message}"));
            }
            let matched = predicate(&message);
            self.observed.push(message.clone());
            if matched {
                return Ok(message);
            }
        }
    }

    fn graceful_shutdown(&mut self, id: &str) -> Result<ExitEvidence, String> {
        self.send(json!({
            "version": PROTOCOL_VERSION,
            "id": id,
            "command": "shutdown"
        }))?;
        self.wait_for(|message| message["type"] == "stopped")?;
        let status = self.child.wait().map_err(|error| error.to_string())?;
        let completed_index = self
            .observed
            .iter()
            .rposition(|message| message["type"] == "operationCompleted");
        let stopped_index = self
            .observed
            .iter()
            .rposition(|message| message["type"] == "stopped");
        Ok(ExitEvidence {
            exit_code: status.code(),
            operation_completed_before_stopped: match (completed_index, stopped_index) {
                (Some(completed), Some(stopped)) => completed < stopped,
                (None, Some(_)) => true,
                _ => false,
            },
            stopped_event_seen: stopped_index.is_some(),
        })
    }

    fn force_process_group(&mut self) -> Result<(), String> {
        let result = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let _ = self.child.wait().map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            unsafe {
                libc::kill(-self.process_group, libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }
}

fn probe_unexpected_exit(paths: &InstalledPaths) -> Result<UnexpectedExitEvidence, String> {
    let mut sidecar = Sidecar::spawn(paths)?;
    unsafe {
        libc::kill(sidecar.pid() as i32, libc::SIGKILL);
    }
    let status = sidecar.child.wait().map_err(|error| error.to_string())?;
    thread::sleep(Duration::from_millis(100));
    while let Ok(message) = sidecar.messages.try_recv() {
        sidecar.observed.push(message);
    }
    Ok(UnexpectedExitEvidence {
        exit_code: status.code().or(Some(128 + libc::SIGKILL)),
        reported_as: "unexpectedExit",
        stopped_event_seen: sidecar
            .observed
            .iter()
            .any(|message| message["type"] == "stopped"),
    })
}

fn probe_forced_cleanup(paths: &InstalledPaths) -> Result<ForcedCleanupEvidence, String> {
    let mut sidecar = Sidecar::spawn(paths)?;
    sidecar.send(json!({
        "version": PROTOCOL_VERSION,
        "id": "forced",
        "command": "holdGit"
    }))?;
    let descendant = sidecar.wait_for(|message| {
        message["type"] == "prototypeGitDescendant" && message["replyTo"] == "forced"
    })?;
    let bundled_git_pid = descendant["pid"]
        .as_i64()
        .and_then(|pid| i32::try_from(pid).ok())
        .ok_or_else(|| format!("Git descendant event omitted a valid pid: {descendant}"))?;
    let bundled_git_executable = string_field(&descendant, "/executablePath")?;
    let expected_git_executable = paths.private_git_bin_dir.join("git");
    let observed_git_executable = fs::read_link(format!("/proc/{bundled_git_pid}/exe"))
        .map_err(|error| format!("could not inspect live bundled Git descendant: {error}"))?;
    let bundled_git_executable_matched =
        observed_git_executable == expected_git_executable
            && Path::new(&bundled_git_executable) == expected_git_executable;
    let process_group = sidecar.process_group;
    let members_before = process_group_members(process_group);
    let bundled_git_running_before = members_before.contains(&bundled_git_pid);
    if !bundled_git_running_before || !bundled_git_executable_matched {
        return Err(format!(
            "forced-cleanup probe did not observe the bundled private Git as a live sidecar descendant: \
             pid={bundled_git_pid}, expected={}, observed={}, members={members_before:?}",
            expected_git_executable.display(),
            observed_git_executable.display()
        ));
    }
    sidecar.force_process_group()?;
    thread::sleep(Duration::from_millis(150));
    let members_after = process_group_members(process_group);
    let bundled_git_running_after = process_cmdlines().iter().any(|cmdline| {
        cmdline.contains(&paths.private_git_bin_dir.join("git").display().to_string())
    });
    Ok(ForcedCleanupEvidence {
        process_group,
        members_before,
        members_after: members_after.clone(),
        bundled_git_pid,
        bundled_git_executable,
        bundled_git_executable_matched,
        bundled_git_running_before,
        sidecar_running_after: !members_after.is_empty(),
        bundled_git_running_after,
    })
}

fn process_group_members(process_group: i32) -> Vec<i32> {
    let mut result = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(after_name) = stat.rsplit_once(") ").map(|(_, value)| value) else {
            continue;
        };
        let fields = after_name.split_whitespace().collect::<Vec<_>>();
        if fields.get(2).and_then(|value| value.parse::<i32>().ok()) == Some(process_group) {
            result.push(pid);
        }
    }
    result.sort_unstable();
    result
}

fn process_cmdlines() -> Vec<String> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| fs::read(entry.path().join("cmdline")).ok())
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .replace('\0', " ")
                .trim()
                .to_string()
        })
        .collect()
}

fn first_existing(candidates: &[PathBuf], label: &str) -> Result<PathBuf, String> {
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "could not resolve {label} from installed resources; checked {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn workspace_root(label: &str) -> PathBuf {
    std::env::var_os("SILKSONG_GIT_PROTOTYPE_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("Silksong Git 空格路径/{label}"))
}

fn reset_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

fn string_field(value: &Value, pointer: &str) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("protocol response omitted {pointer}: {value}"))
}

fn write_env_evidence(variable: &str, value: &Value) -> Result<(), String> {
    let Some(path) = std::env::var_os(variable).map(PathBuf::from) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())
}
