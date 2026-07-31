use std::{
    env,
    fmt::{Display, Formatter},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
    thread,
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

const DESKTOP_SIDECAR_PROTOCOL_VERSION: u8 = 3;
const DEVELOPMENT_SIDECAR_ENTRY: &str = "apps/desktop-sidecar/dist/main.js";
const BUNDLED_SIDECAR_NAME: &str = "silksong-git-desktop-sidecar";

/// The only long-lived repository connection owned by this Desktop process.
#[derive(Default)]
pub struct DesktopRuntime {
    state: Mutex<DesktopRuntimeState>,
}

#[derive(Default)]
struct DesktopRuntimeState {
    current_session: Option<ManagedSession>,
}

struct ManagedSession {
    connection: RepoSessionConnection,
    sidecar: SidecarProcess,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSessionConnection {
    pub endpoint: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenExternalRepositoryResult {
    Cancelled,
    Opened,
    RequiresAction {
        action: RepositoryRequiredAction,
        status: RepositoryStatus,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryStatus {
    Invalid,
    LegacyConfig,
    MigrationRequired,
    NewerIncompatible,
    RebuildRequired,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryRequiredAction {
    ChooseAnotherDirectory,
    ConfirmMigration,
    RebuildReadModel,
    UseNewerApp,
}

impl DesktopRuntime {
    fn open_repository_path<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        selected_path: PathBuf,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        self.open_repository_path_with_launch(selected_path, SidecarLaunch::for_app(app)?)
    }

    fn open_repository_path_with_launch(
        &self,
        selected_path: PathBuf,
        launch: SidecarLaunch,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        let repo_path = canonicalize_repository_path(&selected_path)?;
        let repo_path = repository_path_for_protocol(&repo_path)?;
        let mut candidate = SidecarProcess::spawn(launch)?;

        let inspection = match candidate.command(json!({
            "type": "repository.inspect",
            "repoPath": repo_path,
        })) {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                return Err(error.into());
            }
        };

        let (status, required_action) = match parse_repository_inspection(&inspection) {
            Ok(inspection) => inspection,
            Err(error) => {
                candidate.shutdown_without_session();
                return Err(error);
            }
        };

        if status != "ready" || required_action != "open" {
            candidate.shutdown_without_session();
            return Ok(OpenExternalRepositoryResult::RequiresAction {
                action: parse_required_action(&required_action)?,
                status: parse_repository_status(&status)?,
            });
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if let Err(error) = state.shutdown_current_session() {
            candidate.shutdown_without_session();
            return Err(error);
        }

        // Repo Session repeats History's inspection. The preflight above only decides whether
        // Desktop may replace its current session with this external repository.
        let opened = match candidate.command(json!({
            "type": "session.open",
            "repoPath": repo_path,
        })) {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                return Err(error.into());
            }
        };
        let connection = parse_connection(&opened)?;
        state.current_session = Some(ManagedSession {
            connection,
            sidecar: candidate,
        });

        Ok(OpenExternalRepositoryResult::Opened)
    }

    fn connection(&self) -> Result<RepoSessionConnection, DesktopRuntimeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        state
            .current_session
            .as_ref()
            .map(|session| session.connection.clone())
            .ok_or(DesktopRuntimeError::NoOpenSession)
    }

    fn control_watcher(&self, command_type: &str) -> Result<(), DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        let session = state
            .current_session
            .as_mut()
            .ok_or(DesktopRuntimeError::NoOpenSession)?;
        let response = session.sidecar.command(json!({ "type": command_type }))?;
        let expected_result = match command_type {
            "watcher.start" => "watcher.started",
            "watcher.stop" => "watcher.stopped",
            _ => return Err(DesktopRuntimeError::Unavailable),
        };
        if response.pointer("/result/type").and_then(Value::as_str) != Some(expected_result) {
            return Err(DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid watcher response.".into(),
            ));
        }

        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        state.shutdown_current_session()
    }
}

impl DesktopRuntimeState {
    fn shutdown_current_session(&mut self) -> Result<(), DesktopRuntimeError> {
        let Some(session) = self.current_session.as_mut() else {
            return Ok(());
        };

        session.sidecar.shutdown()?;
        self.current_session = None;
        Ok(())
    }
}

#[tauri::command]
pub async fn desktop_open_external_repository(
    app: AppHandle,
    runtime: State<'_, DesktopRuntime>,
) -> Result<OpenExternalRepositoryResult, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Open Save History Repository")
        .blocking_pick_folder()
    else {
        return Ok(OpenExternalRepositoryResult::Cancelled);
    };
    let selected_path = selected
        .into_path()
        .map_err(|_| "The selected directory could not be opened.".to_string())?;

    runtime
        .open_repository_path(&app, selected_path)
        .map_err(|error| error.user_message())
}

/// Returns only the current in-memory Local HTTP connection for the shared Web client closure.
#[tauri::command]
pub fn desktop_get_repo_session_connection(
    runtime: State<'_, DesktopRuntime>,
) -> Result<RepoSessionConnection, String> {
    runtime.connection().map_err(|error| error.user_message())
}

#[tauri::command]
pub fn desktop_start_watching(runtime: State<'_, DesktopRuntime>) -> Result<(), String> {
    runtime
        .control_watcher("watcher.start")
        .map_err(|error| error.user_message())
}

#[tauri::command]
pub fn desktop_stop_watching(runtime: State<'_, DesktopRuntime>) -> Result<(), String> {
    runtime
        .control_watcher("watcher.stop")
        .map_err(|error| error.user_message())
}

fn canonicalize_repository_path(path: &Path) -> Result<PathBuf, DesktopRuntimeError> {
    let canonical = fs::canonicalize(path).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
    if !canonical.is_dir() {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }

    Ok(canonical)
}

fn repository_path_for_protocol(path: &Path) -> Result<String, DesktopRuntimeError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(DesktopRuntimeError::UnsupportedDirectoryName)
}

fn parse_connection(response: &Value) -> Result<RepoSessionConnection, DesktopRuntimeError> {
    let Some(connection) = response.pointer("/result/connection") else {
        return Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid session response.".into(),
        ));
    };
    let endpoint = connection
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|endpoint| endpoint.starts_with("http://127.0.0.1:"))
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid session endpoint.".into(),
            )
        })?;
    let token = connection
        .get("bearerToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned invalid session credentials.".into(),
            )
        })?;

    Ok(RepoSessionConnection {
        endpoint: endpoint.into(),
        token: token.into(),
    })
}

fn parse_repository_inspection(response: &Value) -> Result<(String, String), DesktopRuntimeError> {
    let Some(repository) = response
        .pointer("/result/inspection")
        .filter(|value| value.is_object())
    else {
        return Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid repository inspection.".into(),
        ));
    };
    let status = repository
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid repository status.".into(),
            )
        })?;
    let action = repository
        .get("requiredAction")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid repository action.".into(),
            )
        })?;

    Ok((status.into(), action.into()))
}

fn parse_repository_status(value: &str) -> Result<RepositoryStatus, DesktopRuntimeError> {
    match value {
        "invalid" => Ok(RepositoryStatus::Invalid),
        "legacyConfig" => Ok(RepositoryStatus::LegacyConfig),
        "migrationRequired" => Ok(RepositoryStatus::MigrationRequired),
        "newerIncompatible" => Ok(RepositoryStatus::NewerIncompatible),
        "rebuildRequired" => Ok(RepositoryStatus::RebuildRequired),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown repository status.".into(),
        )),
    }
}

fn parse_required_action(value: &str) -> Result<RepositoryRequiredAction, DesktopRuntimeError> {
    match value {
        "chooseAnotherDirectory" => Ok(RepositoryRequiredAction::ChooseAnotherDirectory),
        "confirmMigration" => Ok(RepositoryRequiredAction::ConfirmMigration),
        "rebuildReadModel" => Ok(RepositoryRequiredAction::RebuildReadModel),
        "useNewerApp" => Ok(RepositoryRequiredAction::UseNewerApp),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown repository action.".into(),
        )),
    }
}

#[derive(Clone)]
enum SidecarLaunch {
    Development { entry: PathBuf, node: PathBuf },
    Bundled { executable: PathBuf },
}

impl SidecarLaunch {
    fn for_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self, DesktopRuntimeError> {
        if cfg!(debug_assertions) {
            let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .ok_or(DesktopRuntimeError::Unavailable)?;
            let entry = workspace_root.join(DEVELOPMENT_SIDECAR_ENTRY);
            if !entry.is_file() {
                return Err(DesktopRuntimeError::DevelopmentSidecarUnavailable);
            }

            return Ok(Self::Development {
                entry,
                node: PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }),
            });
        }

        let executable = app
            .path()
            .resource_dir()
            .map_err(|_| DesktopRuntimeError::Unavailable)?
            .join(BUNDLED_SIDECAR_NAME);
        if !executable.is_file() {
            return Err(DesktopRuntimeError::BundledSidecarUnavailable);
        }

        Ok(Self::Bundled { executable })
    }

    fn command(&self) -> Command {
        match self {
            Self::Development { entry, node } => {
                let mut command = Command::new(node);
                command.arg(entry);
                command
            }
            Self::Bundled { executable } => Command::new(executable),
        }
    }
}

struct SidecarProcess {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    request_sequence: u64,
}

impl SidecarProcess {
    fn spawn(launch: SidecarLaunch) -> Result<Self, DesktopRuntimeError> {
        let mut child = launch
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| DesktopRuntimeError::SidecarUnavailable)?;
        drain_sidecar_diagnostics(
            child
                .stderr
                .take()
                .ok_or(DesktopRuntimeError::SidecarUnavailable)?,
        );
        let input = child
            .stdin
            .take()
            .ok_or(DesktopRuntimeError::SidecarUnavailable)?;
        let output = child
            .stdout
            .take()
            .ok_or(DesktopRuntimeError::SidecarUnavailable)?;
        let mut process = Self {
            child,
            input,
            output: BufReader::new(output),
            request_sequence: 0,
        };

        let ready = process.read_message()?;
        if ready.get("protocolVersion").and_then(Value::as_u64)
            != Some(u64::from(DESKTOP_SIDECAR_PROTOCOL_VERSION))
            || ready.get("kind").and_then(Value::as_str) != Some("event")
            || ready.pointer("/event/type").and_then(Value::as_str) != Some("process.ready")
        {
            return Err(DesktopRuntimeError::Protocol(
                "The Desktop sidecar did not start with a compatible protocol.".into(),
            ));
        }

        Ok(process)
    }

    fn command(&mut self, command: Value) -> Result<Value, SidecarError> {
        self.request_sequence += 1;
        let request_id = format!("desktop-{}", self.request_sequence);
        let request = json!({
            "protocolVersion": DESKTOP_SIDECAR_PROTOCOL_VERSION,
            "kind": "command",
            "requestId": request_id,
            "command": command,
        });
        serde_json::to_writer(&mut self.input, &request).map_err(|_| SidecarError::Protocol)?;
        self.input.write_all(b"\n").map_err(|_| SidecarError::Io)?;
        self.input.flush().map_err(|_| SidecarError::Io)?;

        loop {
            let message = self.read_message().map_err(|error| match error {
                DesktopRuntimeError::Protocol(_) => SidecarError::Protocol,
                _ => SidecarError::Io,
            })?;
            if message.get("protocolVersion").and_then(Value::as_u64)
                != Some(u64::from(DESKTOP_SIDECAR_PROTOCOL_VERSION))
            {
                return Err(SidecarError::Protocol);
            }
            match message.get("kind").and_then(Value::as_str) {
                Some("event") => continue,
                Some("response") => {
                    if message.get("requestId").and_then(Value::as_str) != Some(request_id.as_str())
                    {
                        return Err(SidecarError::Protocol);
                    }
                    if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(message);
                    }

                    return Err(SidecarError::Rejected {
                        code: message
                            .pointer("/error/code")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_owned(),
                        message: message
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("The Desktop sidecar could not complete the request.")
                            .to_owned(),
                    });
                }
                _ => return Err(SidecarError::Protocol),
            }
        }
    }

    fn read_message(&mut self) -> Result<Value, DesktopRuntimeError> {
        let mut line = String::new();
        let bytes = self
            .output
            .read_line(&mut line)
            .map_err(|_| DesktopRuntimeError::SidecarUnavailable)?;
        if bytes == 0 {
            return Err(DesktopRuntimeError::SidecarUnavailable);
        }

        serde_json::from_str(&line).map_err(|_| {
            DesktopRuntimeError::Protocol("The Desktop sidecar sent an invalid message.".into())
        })
    }

    fn shutdown(&mut self) -> Result<(), DesktopRuntimeError> {
        let response = self.command(json!({ "type": "process.shutdown" }))?;
        if response.pointer("/result/type").and_then(Value::as_str)
            != Some("process.shutdownComplete")
        {
            return Err(DesktopRuntimeError::Protocol(
                "The Desktop sidecar did not acknowledge shutdown.".into(),
            ));
        }

        let status = self
            .child
            .wait()
            .map_err(|_| DesktopRuntimeError::SidecarUnavailable)?;
        if !status.success() {
            return Err(DesktopRuntimeError::SidecarUnavailable);
        }

        Ok(())
    }

    fn shutdown_without_session(&mut self) {
        let _ = self.shutdown();
    }
}

fn drain_sidecar_diagnostics(stderr: ChildStderr) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|bytes| bytes > 0) {
            // Sidecar diagnostics are deliberately credential-free. Do not mirror them into the
            // Desktop log, which could otherwise become an accidental path disclosure channel.
            line.clear();
        }
    });
}

#[derive(Debug)]
enum SidecarError {
    Io,
    Protocol,
    Rejected { code: String, message: String },
}

impl From<SidecarError> for DesktopRuntimeError {
    fn from(error: SidecarError) -> Self {
        match error {
            SidecarError::Io => Self::SidecarUnavailable,
            SidecarError::Protocol => {
                Self::Protocol("The Desktop sidecar returned an incompatible response.".into())
            }
            SidecarError::Rejected { code, message } => Self::SidecarRejected { code, message },
        }
    }
}

#[derive(Debug)]
pub(crate) enum DesktopRuntimeError {
    BundledSidecarUnavailable,
    DevelopmentSidecarUnavailable,
    InvalidDirectory,
    NoOpenSession,
    Protocol(String),
    SidecarRejected { code: String, message: String },
    SidecarUnavailable,
    UnsupportedDirectoryName,
    Unavailable,
}

impl DesktopRuntimeError {
    fn user_message(&self) -> String {
        match self {
            Self::BundledSidecarUnavailable | Self::SidecarUnavailable => {
                "The Desktop Local History service is unavailable. Close and reopen the app, then try again."
                    .into()
            }
            Self::DevelopmentSidecarUnavailable => {
                "The Desktop development sidecar is not built. Run pnpm build-desktop-sidecar, then restart Desktop."
                    .into()
            }
            Self::InvalidDirectory => "Choose an existing repository directory.".into(),
            Self::NoOpenSession => "Open a repository before using Local History controls.".into(),
            Self::Protocol(reason) => {
                let _ = reason;
                "The Desktop Local History service is incompatible. Update Desktop and try again."
                    .into()
            }
            Self::SidecarRejected { code, message } => match code.as_str() {
                "watcher_start_failed" => "Watching could not start. Another process may already be watching this repository; history browsing is still available.".into(),
                "watcher_stop_failed" => "Watching could not stop safely. Keep this app open and try again.".into(),
                _ => message.clone(),
            },
            Self::UnsupportedDirectoryName => {
                "This repository folder name is not supported. Choose another directory.".into()
            }
            Self::Unavailable => "Desktop Local History is temporarily unavailable.".into(),
        }
    }
}

impl Display for DesktopRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.user_message())
    }
}

impl std::error::Error for DesktopRuntimeError {}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::{
        DesktopRuntime, DesktopRuntimeError, OpenExternalRepositoryResult, SidecarLaunch,
        canonicalize_repository_path,
    };

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn canonicalizes_only_existing_directories() {
        let temp = TestDirectory::new();
        let nested = temp.path().join("repository");
        fs::create_dir(&nested).expect("create repository directory");
        let link = temp.path().join("repository-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&nested, &link).expect("create directory symlink");

        #[cfg(unix)]
        assert_eq!(
            canonicalize_repository_path(&link).expect("canonical directory"),
            nested.canonicalize().expect("canonical nested directory"),
        );
        assert!(canonicalize_repository_path(&temp.path().join("missing")).is_err());
    }

    #[test]
    fn only_opens_a_ready_inspection_after_sending_the_path_over_stdin() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("external-repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write sidecar fixture");

        let runtime = DesktopRuntime::default();
        let result = runtime.open_repository_path_with_launch(
            repository.clone(),
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
        );

        assert!(matches!(result, Ok(OpenExternalRepositoryResult::Opened)));
        assert_eq!(
            runtime.connection().expect("opened connection").endpoint,
            "http://127.0.0.1:4312"
        );
        runtime.shutdown().expect("graceful session shutdown");
    }

    #[test]
    fn invalid_inspection_never_starts_a_repo_session() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("invalid-repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "invalid"),
        )
        .expect("write sidecar fixture");

        let runtime = DesktopRuntime::default();
        let result = runtime.open_repository_path_with_launch(
            repository,
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
        );

        assert!(matches!(
            result,
            Ok(OpenExternalRepositoryResult::RequiresAction { .. })
        ));
        assert!(runtime.connection().is_err());
    }

    #[test]
    fn replacing_a_repository_waits_for_the_previous_sidecar_shutdown() {
        let temp = TestDirectory::new();
        let first_repository = temp.path().join("first-repository");
        let second_repository = temp.path().join("second-repository");
        fs::create_dir(&first_repository).expect("create first repository");
        fs::create_dir(&second_repository).expect("create second repository");
        let first_script = temp.path().join("first-sidecar.mjs");
        let second_script = temp.path().join("second-sidecar.mjs");
        fs::write(
            &first_script,
            fixture_sidecar_source(
                first_repository.to_str().expect("UTF-8 first repository"),
                "ready",
            ),
        )
        .expect("write first sidecar fixture");
        fs::write(
            &second_script,
            fixture_sidecar_source(
                second_repository.to_str().expect("UTF-8 second repository"),
                "ready",
            ),
        )
        .expect("write second sidecar fixture");

        let runtime = DesktopRuntime::default();
        runtime
            .open_repository_path_with_launch(
                first_repository,
                SidecarLaunch::Development {
                    entry: first_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open first repository");
        runtime
            .open_repository_path_with_launch(
                second_repository,
                SidecarLaunch::Development {
                    entry: second_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open replacement repository");

        assert_eq!(
            runtime
                .connection()
                .expect("replacement connection")
                .endpoint,
            "http://127.0.0.1:4312"
        );
        runtime.shutdown().expect("shutdown replacement sidecar");
    }

    #[test]
    fn failed_previous_shutdown_closes_the_inspected_candidate() {
        let temp = TestDirectory::new();
        let first_repository = temp.path().join("first-repository");
        let candidate_repository = temp.path().join("candidate-repository");
        fs::create_dir(&first_repository).expect("create first repository");
        fs::create_dir(&candidate_repository).expect("create candidate repository");
        let first_script = temp.path().join("first-sidecar.mjs");
        let candidate_script = temp.path().join("candidate-sidecar.mjs");
        let candidate_shutdown = temp.path().join("candidate-shutdown");
        fs::write(
            &first_script,
            shutdown_failure_fixture_sidecar_source(
                first_repository.to_str().expect("UTF-8 first repository"),
            ),
        )
        .expect("write first sidecar fixture");
        fs::write(
            &candidate_script,
            shutdown_recording_fixture_sidecar_source(
                candidate_repository
                    .to_str()
                    .expect("UTF-8 candidate repository"),
                candidate_shutdown
                    .to_str()
                    .expect("UTF-8 candidate shutdown marker"),
            ),
        )
        .expect("write candidate sidecar fixture");

        let runtime = DesktopRuntime::default();
        runtime
            .open_repository_path_with_launch(
                first_repository,
                SidecarLaunch::Development {
                    entry: first_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open first repository");

        let result = runtime.open_repository_path_with_launch(
            candidate_repository,
            SidecarLaunch::Development {
                entry: candidate_script,
                node: PathBuf::from("node"),
            },
        );

        assert!(matches!(
            result,
            Err(DesktopRuntimeError::SidecarUnavailable)
        ));
        assert_eq!(
            fs::read_to_string(candidate_shutdown).expect("candidate shutdown marker"),
            "shutdown"
        );
        assert_eq!(
            runtime
                .connection()
                .expect("original session stays managed")
                .endpoint,
            "http://127.0.0.1:4312"
        );
    }

    fn fixture_sidecar_source(repository: &str, status: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        let inspection = if status == "ready" {
            r#"{ status: "ready", requiredAction: "open", capabilities: ["read"] }"#
        } else {
            r#"{ status: "invalid", requiredAction: "chooseAnotherDirectory", capabilities: [] }"#
        };
        format!(
            r#"
const repository = {repository};
if (process.argv.includes(repository)) {{
  process.exitCode = 91;
  process.exit();
}}
process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = JSON.parse(line);
    let result;
    if (request.command.type === "repository.inspect") {{
      if (request.command.repoPath !== repository) throw new Error("repository path was not sent over stdin");
      result = {{ type: "repository.inspected", inspection: {inspection} }};
    }} else if (request.command.type === "session.open") {{
      if ({status:?} !== "ready") throw new Error("invalid repositories must not open sessions");
      result = {{ type: "session.opened", connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }};
    }} else if (request.command.type === "process.shutdown") {{
      result = {{ type: "process.shutdownComplete" }};
      process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }} else {{
      result = {{ type: request.command.type === "watcher.start" ? "watcher.started" : "watcher.stopped" }};
    }}
    process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
  }}
}});
"#
        )
    }

    fn shutdown_failure_fixture_sidecar_source(repository: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        format!(
            r#"
const repository = {repository};
process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.command.type === "process.shutdown") {{
      process.exit(1);
    }}
    const result = request.command.type === "repository.inspect"
      ? {{ type: "repository.inspected", inspection: {{ status: "ready", requiredAction: "open", capabilities: ["read"] }} }}
      : {{ type: "session.opened", connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }};
    if (request.command.type === "repository.inspect" && request.command.repoPath !== repository) {{
      throw new Error("repository path was not sent over stdin");
    }}
    process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
  }}
}});
"#
        )
    }

    fn shutdown_recording_fixture_sidecar_source(repository: &str, marker: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        let marker = serde_json::to_string(marker).expect("serialize marker path");
        format!(
            r#"
import fs from "node:fs";
const repository = {repository};
const marker = {marker};
process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.command.type === "repository.inspect") {{
      if (request.command.repoPath !== repository) throw new Error("repository path was not sent over stdin");
      const result = {{ type: "repository.inspected", inspection: {{ status: "ready", requiredAction: "open", capabilities: ["read"] }} }};
      process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      continue;
    }}
    if (request.command.type === "session.open") {{
      throw new Error("candidate session must not open after previous shutdown fails");
    }}
    if (request.command.type === "process.shutdown") {{
      fs.writeFileSync(marker, "shutdown");
      const result = {{ type: "process.shutdownComplete" }};
      process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }}
    throw new Error("unexpected candidate command");
  }}
}});
"#
        )
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "silksong-git-desktop-runtime-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
