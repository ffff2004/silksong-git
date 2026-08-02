use std::{
    env,
    fmt::{Display, Formatter},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, Command, Stdio},
    sync::{
        Mutex,
        mpsc::{self, Receiver, TryRecvError},
    },
    thread,
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

const DESKTOP_SIDECAR_PROTOCOL_VERSION: u8 = 3;
const DEVELOPMENT_SIDECAR_ENTRY: &str = "apps/desktop-sidecar/dist/main.js";
const BUNDLED_SIDECAR_NAME: &str = "silksong-git-desktop-sidecar";

/// The high-level Desktop session and lifecycle owner.
#[derive(Default)]
pub struct DesktopWorkflow {
    state: Mutex<DesktopWorkflowState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RepositoryMenuState {
    pub close_enabled: bool,
    pub open_external_enabled: bool,
    pub start_watching_enabled: bool,
    pub stop_watching_enabled: bool,
}

#[derive(Default)]
struct DesktopWorkflowState {
    current_session: Option<ManagedSession>,
    transitioning: bool,
    invalidated: Option<InvalidatedSession>,
    last_library: Option<RepositoryLibrary>,
}

struct InvalidatedSession {
    _diagnostic: SafeDiagnostic,
    repo_path: String,
    lifecycle: RepositoryLifecycle,
}

#[derive(Clone, Copy)]
enum SafeDiagnostic {
    SidecarUnavailable,
    SidecarProtocol,
}

struct ManagedSession {
    connection: RepoSessionConnection,
    repo_path: String,
    sidecar: SidecarSupervisor,
    watching: bool,
    lifecycle: RepositoryLifecycle,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryLifecycle {
    Managed,
    Archived,
    External,
}

impl RepositoryLifecycle {
    fn sidecar_access(self) -> &'static str {
        match self {
            Self::Archived => "readOnly",
            Self::Managed | Self::External => "readWrite",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryLibrary {
    pub managed: Vec<RepositoryLibraryEntry>,
    pub archived: Vec<RepositoryLibraryEntry>,
    pub attention: Vec<RepositoryLibraryEntry>,
    pub external: Option<RepositoryLibraryEntry>,
    pub stale: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryLibraryEntry {
    pub name: String,
    pub lifecycle: RepositoryLifecycle,
    pub status: String,
    pub required_action: String,
    pub current: bool,
    pub watching: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLibraryEntryInput {
    pub lifecycle: RepositoryLifecycle,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSessionConnection {
    pub endpoint: String,
    pub token: String,
    pub access: String,
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
    BlockedByMutation,
    Busy,
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

impl DesktopWorkflow {
    pub(crate) fn repository_menu_state(&self) -> RepositoryMenuState {
        let Ok(state) = self.state.lock() else {
            return RepositoryMenuState {
                close_enabled: false,
                open_external_enabled: false,
                start_watching_enabled: false,
                stop_watching_enabled: false,
            };
        };
        let mutation_active = state
            .current_session
            .as_ref()
            .is_some_and(|session| session.sidecar.mutation_active());
        let can_change_session = !state.transitioning && !mutation_active;
        let can_control_watcher = state.current_session.as_ref().is_some_and(|session| {
            session.lifecycle != RepositoryLifecycle::Archived && !mutation_active
        });

        RepositoryMenuState {
            close_enabled: can_change_session && state.current_session.is_some(),
            open_external_enabled: can_change_session,
            start_watching_enabled: can_control_watcher
                && state
                    .current_session
                    .as_ref()
                    .is_some_and(|session| !session.watching),
            stop_watching_enabled: can_control_watcher
                && state
                    .current_session
                    .as_ref()
                    .is_some_and(|session| session.watching),
        }
    }
    pub(crate) fn open_repository_path<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        selected_path: PathBuf,
        lifecycle: RepositoryLifecycle,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        self.open_repository_path_with_lifecycle(
            selected_path,
            SidecarLaunch::for_app(app)?,
            lifecycle,
        )
    }

    #[cfg(test)]
    fn open_repository_path_with_launch(
        &self,
        selected_path: PathBuf,
        launch: SidecarLaunch,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        self.open_repository_path_with_lifecycle(
            selected_path,
            launch,
            RepositoryLifecycle::External,
        )
    }

    fn open_repository_path_with_lifecycle(
        &self,
        selected_path: PathBuf,
        launch: SidecarLaunch,
        lifecycle: RepositoryLifecycle,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        let repo_path = canonicalize_repository_path(&selected_path)?;
        let repo_path = repository_path_for_protocol(&repo_path)?;
        let mut candidate = SidecarSupervisor::spawn(launch)?;

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

        let prior_session = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning {
                Err(OpenExternalRepositoryResult::Busy)
            } else if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
            }) {
                Err(OpenExternalRepositoryResult::BlockedByMutation)
            } else {
                state.transitioning = true;
                Ok(state.current_session.take())
            }
        };
        let prior_session = match prior_session {
            Ok(session) => session,
            Err(result) => {
                candidate.shutdown_without_session();
                return Ok(result);
            }
        };
        if let Some(mut prior_session) = prior_session
            && let Err(error) = prior_session.sidecar.shutdown()
        {
            self.finish_transition(Some(prior_session));
            candidate.shutdown_without_session();
            return Err(error);
        }

        // Repo Session repeats History's inspection. The preflight above only decides whether
        // Desktop may replace its current session with this external repository.
        let opened = match candidate.command(json!({
            "type": "session.open",
            "repoPath": repo_path,
            "access": lifecycle.sidecar_access(),
        })) {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                self.finish_transition(None);
                return Err(error.into());
            }
        };
        let connection = parse_connection(&opened)?;
        self.finish_transition(Some(ManagedSession {
            connection,
            repo_path,
            sidecar: candidate,
            watching: false,
            lifecycle,
        }));

        Ok(OpenExternalRepositoryResult::Opened)
    }

    fn connection(&self) -> Result<RepoSessionConnection, DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if state.transitioning {
            return Err(DesktopRuntimeError::Busy);
        }
        if state.invalidated.is_some() {
            return Err(DesktopRuntimeError::Invalidated);
        }
        let session = state
            .current_session
            .as_mut()
            .ok_or(DesktopRuntimeError::NoOpenSession)?;
        if let Err(error) = session.sidecar.poll() {
            let repo_path = session.repo_path.clone();
            let lifecycle = session.lifecycle;
            state.current_session = None;
            state.invalidated = Some(InvalidatedSession {
                _diagnostic: diagnostic_for(&error),
                repo_path,
                lifecycle,
            });
            return Err(error);
        }
        Ok(session.connection.clone())
    }

    pub(crate) fn control_watcher(&self, command_type: &str) -> Result<(), DesktopRuntimeError> {
        let Some(mut session) = self.take_session_for_operation()? else {
            return Err(DesktopRuntimeError::NoOpenSession);
        };
        if session.lifecycle == RepositoryLifecycle::Archived {
            self.finish_transition(Some(session));
            return Err(DesktopRuntimeError::ReadOnly);
        }
        let response = match session.sidecar.command(json!({ "type": command_type })) {
            Ok(response) => response,
            Err(error) => {
                self.finish_transition(Some(session));
                return Err(error.into());
            }
        };
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

        session.watching = command_type == "watcher.start";
        self.finish_transition(Some(session));
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), DesktopRuntimeError> {
        let session = self.take_session_for_operation()?;
        let result = match session {
            Some(mut session) => session.sidecar.shutdown(),
            None => Ok(()),
        };
        self.finish_transition(None);
        result
    }

    pub(crate) fn close(&self) -> Result<(), DesktopRuntimeError> {
        self.shutdown()
    }

    fn library<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<RepositoryLibrary, DesktopRuntimeError> {
        let launch = SidecarLaunch::for_app(app)?;
        match scan_repository_library(app, launch, self.current_session_details()?) {
            Ok(library) => {
                if let Ok(mut state) = self.state.lock() {
                    state.last_library = Some(library.clone());
                }
                Ok(library)
            }
            Err(error) => {
                let previous = self
                    .state
                    .lock()
                    .map_err(|_| DesktopRuntimeError::Unavailable)?
                    .last_library
                    .clone();
                if let Some(mut library) = previous {
                    library.stale = true;
                    library.error = Some(error.user_message());
                    Ok(library)
                } else {
                    Err(error)
                }
            }
        }
    }

    fn current_session_details(
        &self,
    ) -> Result<Option<(String, RepositoryLifecycle, bool)>, DesktopRuntimeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        Ok(state.current_session.as_ref().map(|session| {
            (
                session.repo_path.clone(),
                session.lifecycle,
                session.watching,
            )
        }))
    }

    fn open_library_entry<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        input: OpenLibraryEntryInput,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        if input.lifecycle == RepositoryLifecycle::External {
            return Err(DesktopRuntimeError::InvalidDirectory);
        }
        let path = resolve_library_child(app, input.lifecycle, &input.name)?;
        self.open_repository_path_with_lifecycle(
            path,
            SidecarLaunch::for_app(app)?,
            input.lifecycle,
        )
    }

    pub(crate) fn close_requires_confirmation(&self) -> Result<bool, DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if state.transitioning {
            return Err(DesktopRuntimeError::Busy);
        }
        let Some(session) = state.current_session.as_mut() else {
            return Ok(false);
        };
        session.sidecar.poll()?;
        if session.sidecar.mutation_active() {
            return Err(DesktopRuntimeError::BlockedByMutation);
        }
        Ok(session.watching)
    }

    fn reopen<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        let (path, lifecycle) = {
            let state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            state
                .invalidated
                .as_ref()
                .map(|invalidated| (invalidated.repo_path.clone(), invalidated.lifecycle))
        }
        .ok_or(DesktopRuntimeError::NoOpenSession)?;
        self.open_repository_path_with_lifecycle(
            PathBuf::from(path),
            SidecarLaunch::for_app(app)?,
            lifecycle,
        )
    }

    #[cfg(test)]
    fn reopen_with_launch(
        &self,
        launch: SidecarLaunch,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        let (path, lifecycle) = {
            let state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            state
                .invalidated
                .as_ref()
                .map(|invalidated| (invalidated.repo_path.clone(), invalidated.lifecycle))
        }
        .ok_or(DesktopRuntimeError::NoOpenSession)?;
        self.open_repository_path_with_lifecycle(PathBuf::from(path), launch, lifecycle)
    }

    fn take_session_for_operation(&self) -> Result<Option<ManagedSession>, DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if state.transitioning {
            return Err(DesktopRuntimeError::Busy);
        }
        if state.invalidated.is_some() {
            return Err(DesktopRuntimeError::Invalidated);
        }
        if state.current_session.as_mut().is_some_and(|session| {
            session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
        }) {
            return Err(DesktopRuntimeError::BlockedByMutation);
        }
        state.transitioning = true;
        Ok(state.current_session.take())
    }

    fn finish_transition(&self, session: Option<ManagedSession>) {
        if let Ok(mut state) = self.state.lock() {
            state.current_session = session;
            state.transitioning = false;
            if state.current_session.is_some() {
                state.invalidated = None;
            }
        }
    }
}

#[tauri::command]
pub async fn desktop_open_external_repository(
    app: AppHandle,
    runtime: State<'_, DesktopWorkflow>,
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

    let result = runtime
        .open_repository_path(&app, selected_path, RepositoryLifecycle::External)
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub fn desktop_get_repository_library(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<RepositoryLibrary, String> {
    workflow.library(&app).map_err(|error| error.user_message())
}

#[tauri::command]
pub fn desktop_open_library_entry(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
    input: OpenLibraryEntryInput,
) -> Result<OpenExternalRepositoryResult, String> {
    let result = workflow
        .open_library_entry(&app, input)
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub fn desktop_close_repository(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<(), String> {
    let result = workflow.close().map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

/// Reopens only the in-memory repository selection after a sidecar failure.
/// It never restarts watching and never retries a mutation.
#[tauri::command]
pub fn desktop_reopen_repository(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<OpenExternalRepositoryResult, String> {
    let result = workflow.reopen(&app).map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

/// Returns only the current in-memory Local HTTP connection for the shared Web client closure.
#[tauri::command]
pub fn desktop_get_repo_session_connection(
    runtime: State<'_, DesktopWorkflow>,
) -> Result<RepoSessionConnection, String> {
    runtime.connection().map_err(|error| error.user_message())
}

#[tauri::command]
pub fn desktop_start_watching(
    app: AppHandle,
    runtime: State<'_, DesktopWorkflow>,
) -> Result<(), String> {
    let result = runtime
        .control_watcher("watcher.start")
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub fn desktop_stop_watching(
    app: AppHandle,
    runtime: State<'_, DesktopWorkflow>,
) -> Result<(), String> {
    let result = runtime
        .control_watcher("watcher.stop")
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

fn canonicalize_repository_path(path: &Path) -> Result<PathBuf, DesktopRuntimeError> {
    let canonical = fs::canonicalize(path).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
    if !canonical.is_dir() {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }

    Ok(canonical)
}

fn managed_root<R: Runtime>(
    app: &AppHandle<R>,
    lifecycle: RepositoryLifecycle,
) -> Result<PathBuf, DesktopRuntimeError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| DesktopRuntimeError::Unavailable)?
        .join(match lifecycle {
            RepositoryLifecycle::Managed => "repositories",
            RepositoryLifecycle::Archived => "archives",
            RepositoryLifecycle::External => return Err(DesktopRuntimeError::InvalidDirectory),
        });
    fs::create_dir_all(&root).map_err(|_| DesktopRuntimeError::Unavailable)?;
    canonicalize_repository_path(&root)
}

fn resolve_library_child<R: Runtime>(
    app: &AppHandle<R>,
    lifecycle: RepositoryLifecycle,
    name: &str,
) -> Result<PathBuf, DesktopRuntimeError> {
    if name.is_empty() || name == "." || name == ".." || Path::new(name).components().count() != 1 {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    let root = managed_root(app, lifecycle)?;
    let child = root.join(name);
    let metadata =
        fs::symlink_metadata(&child).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    let canonical = canonicalize_repository_path(&child)?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    Ok(canonical)
}

fn scan_repository_library<R: Runtime>(
    app: &AppHandle<R>,
    launch: SidecarLaunch,
    current: Option<(String, RepositoryLifecycle, bool)>,
) -> Result<RepositoryLibrary, DesktopRuntimeError> {
    let mut library = RepositoryLibrary {
        managed: Vec::new(),
        archived: Vec::new(),
        attention: Vec::new(),
        external: None,
        stale: false,
        error: None,
    };
    for lifecycle in [RepositoryLifecycle::Managed, RepositoryLifecycle::Archived] {
        let root = managed_root(app, lifecycle)?;
        for entry in fs::read_dir(&root).map_err(|_| DesktopRuntimeError::Unavailable)? {
            let entry = entry.map_err(|_| DesktopRuntimeError::Unavailable)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let candidate = match entry.file_type() {
                Ok(file_type) if file_type.is_dir() && !file_type.is_symlink() => {
                    resolve_library_child(app, lifecycle, &name).ok()
                }
                _ => None,
            };
            let (status, required_action) = if let Some(candidate) = candidate.as_ref() {
                let repo_path = repository_path_for_protocol(candidate)?;
                let mut inspector = SidecarSupervisor::spawn(launch.clone())?;
                let result = inspector
                    .command(json!({ "type": "repository.inspect", "repoPath": repo_path }));
                inspector.shutdown_without_session();
                match result {
                    Ok(response) => parse_repository_inspection(&response)?,
                    Err(_) => ("invalid".into(), "chooseAnotherDirectory".into()),
                }
            } else {
                ("invalid".into(), "chooseAnotherDirectory".into())
            };
            let is_current = current
                .as_ref()
                .is_some_and(|(path, current_lifecycle, _)| {
                    *current_lifecycle == lifecycle
                        && candidate
                            .as_ref()
                            .is_some_and(|candidate| path == &candidate.to_string_lossy())
                });
            let record = RepositoryLibraryEntry {
                name,
                lifecycle,
                status: status.clone(),
                required_action,
                current: is_current,
                watching: is_current && current.as_ref().is_some_and(|(_, _, watching)| *watching),
            };
            if status == "ready" {
                match lifecycle {
                    RepositoryLifecycle::Managed => library.managed.push(record),
                    RepositoryLifecycle::Archived => library.archived.push(record),
                    RepositoryLifecycle::External => unreachable!(),
                }
            } else {
                library.attention.push(record);
            }
        }
    }
    for entries in [
        &mut library.managed,
        &mut library.archived,
        &mut library.attention,
    ] {
        entries.sort_by(|left, right| natural_name_cmp(&left.name, &right.name));
    }
    if let Some((path, RepositoryLifecycle::External, watching)) = current {
        library.external = Some(RepositoryLibraryEntry {
            name: Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            lifecycle: RepositoryLifecycle::External,
            status: "ready".into(),
            required_action: "open".into(),
            current: true,
            watching,
        });
    }
    Ok(library)
}

fn natural_name_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left = left.chars().peekable();
    let mut right = right.chars().peekable();
    loop {
        match (left.peek(), right.peek()) {
            (Some(left_character), Some(right_character))
                if left_character.is_ascii_digit() && right_character.is_ascii_digit() =>
            {
                let left_digits: String = left
                    .by_ref()
                    .take_while(|character| character.is_ascii_digit())
                    .collect();
                let right_digits: String = right
                    .by_ref()
                    .take_while(|character| character.is_ascii_digit())
                    .collect();
                let ordering = left_digits
                    .trim_start_matches('0')
                    .len()
                    .cmp(&right_digits.trim_start_matches('0').len())
                    .then_with(|| {
                        left_digits
                            .trim_start_matches('0')
                            .cmp(right_digits.trim_start_matches('0'))
                    });
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
            (Some(_), Some(_)) => {
                let ordering = left
                    .next()
                    .map(|character| character.to_ascii_lowercase())
                    .cmp(&right.next().map(|character| character.to_ascii_lowercase()));
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
        }
    }
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
        access: response
            .pointer("/result/access")
            .and_then(Value::as_str)
            .unwrap_or("readWrite")
            .into(),
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

/// The only stdout reader for a sidecar. It demultiplexes JSONL by request ID,
/// records safe lifecycle events, drains stderr, and owns child exit checking.
struct SidecarSupervisor {
    child: Child,
    input: ChildStdin,
    output: Receiver<SidecarOutput>,
    request_sequence: u64,
    mutation_active: bool,
}

enum SidecarOutput {
    Message(Value),
    Eof,
    Protocol,
}

impl SidecarSupervisor {
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
        let (output_sender, output_receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = output_sender.send(SidecarOutput::Eof);
                        return;
                    }
                    Ok(_) => match serde_json::from_str(&line) {
                        Ok(message) => {
                            if output_sender.send(SidecarOutput::Message(message)).is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = output_sender.send(SidecarOutput::Protocol);
                            return;
                        }
                    },
                    Err(_) => {
                        let _ = output_sender.send(SidecarOutput::Eof);
                        return;
                    }
                }
            }
        });
        let mut process = Self {
            child,
            input,
            output: output_receiver,
            request_sequence: 0,
            mutation_active: false,
        };

        let ready = process.next_message()?;
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
            let message = self.next_message().map_err(|error| match error {
                DesktopRuntimeError::Protocol(_) => SidecarError::Protocol,
                _ => SidecarError::Io,
            })?;
            if message.get("protocolVersion").and_then(Value::as_u64)
                != Some(u64::from(DESKTOP_SIDECAR_PROTOCOL_VERSION))
            {
                return Err(SidecarError::Protocol);
            }
            match message.get("kind").and_then(Value::as_str) {
                Some("event") => {
                    self.handle_event(&message).map_err(|error| match error {
                        DesktopRuntimeError::Protocol(_) => SidecarError::Protocol,
                        _ => SidecarError::Io,
                    })?;
                    continue;
                }
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

    fn next_message(&mut self) -> Result<Value, DesktopRuntimeError> {
        match self
            .output
            .recv()
            .map_err(|_| DesktopRuntimeError::SidecarUnavailable)?
        {
            SidecarOutput::Message(message) => Ok(message),
            SidecarOutput::Eof => Err(DesktopRuntimeError::SidecarUnavailable),
            SidecarOutput::Protocol => Err(DesktopRuntimeError::Protocol(
                "The Desktop sidecar sent an invalid message.".into(),
            )),
        }
    }

    fn poll(&mut self) -> Result<(), DesktopRuntimeError> {
        loop {
            match self.output.try_recv() {
                Ok(SidecarOutput::Message(message)) => {
                    if message.get("protocolVersion").and_then(Value::as_u64)
                        != Some(u64::from(DESKTOP_SIDECAR_PROTOCOL_VERSION))
                    {
                        return Err(DesktopRuntimeError::Protocol(
                            "The Desktop sidecar returned an incompatible response.".into(),
                        ));
                    }
                    if message.get("kind").and_then(Value::as_str) != Some("event") {
                        return Err(DesktopRuntimeError::Protocol(
                            "The Desktop sidecar sent an unexpected response.".into(),
                        ));
                    }
                    self.handle_event(&message)?;
                }
                Ok(SidecarOutput::Eof) | Err(TryRecvError::Disconnected) => {
                    return Err(DesktopRuntimeError::SidecarUnavailable);
                }
                Ok(SidecarOutput::Protocol) => {
                    return Err(DesktopRuntimeError::Protocol(
                        "The Desktop sidecar sent an invalid message.".into(),
                    ));
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        if self
            .child
            .try_wait()
            .map_err(|_| DesktopRuntimeError::SidecarUnavailable)?
            .is_some()
        {
            return Err(DesktopRuntimeError::SidecarUnavailable);
        }
        Ok(())
    }

    fn mutation_active(&self) -> bool {
        self.mutation_active
    }

    fn handle_event(&mut self, message: &Value) -> Result<(), DesktopRuntimeError> {
        match message.pointer("/event/type").and_then(Value::as_str) {
            Some("mutation.activity") => {
                match message.pointer("/event/status").and_then(Value::as_str) {
                    Some("started") => self.mutation_active = true,
                    Some("finished") => self.mutation_active = false,
                    _ => {
                        return Err(DesktopRuntimeError::Protocol(
                            "The Desktop sidecar sent an invalid mutation event.".into(),
                        ));
                    }
                }
            }
            Some("session.failed") => return Err(DesktopRuntimeError::SidecarUnavailable),
            Some("process.ready") | Some("watcher.observation") | Some("watcher.failed") => {}
            Some(_) => {} // Forward-compatible events are safe to ignore.
            None => {
                return Err(DesktopRuntimeError::Protocol(
                    "The Desktop sidecar sent an invalid event.".into(),
                ));
            }
        }
        Ok(())
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

fn diagnostic_for(error: &DesktopRuntimeError) -> SafeDiagnostic {
    match error {
        DesktopRuntimeError::Protocol(_) => SafeDiagnostic::SidecarProtocol,
        _ => SafeDiagnostic::SidecarUnavailable,
    }
}

#[derive(Debug)]
pub(crate) enum DesktopRuntimeError {
    BlockedByMutation,
    Busy,
    BundledSidecarUnavailable,
    DevelopmentSidecarUnavailable,
    InvalidDirectory,
    Invalidated,
    NoOpenSession,
    Protocol(String),
    ReadOnly,
    SidecarRejected { code: String, message: String },
    SidecarUnavailable,
    UnsupportedDirectoryName,
    Unavailable,
}

impl DesktopRuntimeError {
    fn user_message(&self) -> String {
        match self {
            Self::BlockedByMutation => "Wait for the active Manual Checkpoint or restore to finish before changing the Desktop session.".into(),
            Self::Busy => "Desktop Local History is changing sessions. Try again when the current operation finishes.".into(),
            Self::BundledSidecarUnavailable | Self::SidecarUnavailable => {
                "The Desktop Local History service is unavailable. Close and reopen the app, then try again."
                    .into()
            }
            Self::DevelopmentSidecarUnavailable => {
                "The Desktop development sidecar is not built. Run pnpm build-desktop-sidecar, then restart Desktop."
                    .into()
            }
            Self::InvalidDirectory => "Choose an existing repository directory.".into(),
            Self::Invalidated => "The Desktop Local History connection stopped unexpectedly. Reopen the selected repository to continue browsing.".into(),
            Self::NoOpenSession => "Open a repository before using Local History controls.".into(),
            Self::Protocol(reason) => {
                let _ = reason;
                "The Desktop Local History service is incompatible. Update Desktop and try again."
                    .into()
            }
            Self::ReadOnly => "Archived repositories are read-only and cannot watch or change saves.".into(),
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
type DesktopRuntime = DesktopWorkflow;

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
        thread,
        time::Duration,
    };

    use super::{
        DesktopRuntime, DesktopRuntimeError, OpenExternalRepositoryResult, RepositoryLifecycle,
        SidecarLaunch, canonicalize_repository_path, natural_name_cmp,
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
    fn naturally_sorts_repository_names_without_using_them_as_identity() {
        assert_eq!(
            natural_name_cmp("slot2", "slot10"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            natural_name_cmp("Archive 9", "archive 10"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn repository_menu_tracks_reader_and_watcher_state() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write sidecar fixture");

        let runtime = DesktopRuntime::default();
        assert_eq!(
            runtime.repository_menu_state(),
            super::RepositoryMenuState {
                close_enabled: false,
                open_external_enabled: true,
                start_watching_enabled: false,
                stop_watching_enabled: false,
            }
        );
        runtime
            .open_repository_path_with_launch(
                repository,
                SidecarLaunch::Development {
                    entry: script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open reader session");
        assert!(runtime.repository_menu_state().close_enabled);
        assert!(runtime.repository_menu_state().start_watching_enabled);
        assert!(!runtime.repository_menu_state().stop_watching_enabled);
        runtime
            .control_watcher("watcher.start")
            .expect("start watcher");
        assert!(!runtime.repository_menu_state().start_watching_enabled);
        assert!(runtime.repository_menu_state().stop_watching_enabled);
        runtime.shutdown().expect("shutdown session");
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
    fn active_mutation_blocks_a_normal_repository_switch_before_shutdown() {
        let temp = TestDirectory::new();
        let first_repository = temp.path().join("first-repository");
        let candidate_repository = temp.path().join("candidate-repository");
        fs::create_dir(&first_repository).expect("create first repository");
        fs::create_dir(&candidate_repository).expect("create candidate repository");
        let first_script = temp.path().join("first-sidecar.mjs");
        let candidate_script = temp.path().join("candidate-sidecar.mjs");
        fs::write(
            &first_script,
            fixture_sidecar_source(first_repository.to_str().expect("UTF-8 path"), "mutation"),
        )
        .expect("write first fixture");
        fs::write(
            &candidate_script,
            fixture_sidecar_source(candidate_repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write candidate fixture");

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
            Ok(OpenExternalRepositoryResult::BlockedByMutation)
        ));
        assert_eq!(
            runtime
                .connection()
                .expect("existing session remains active")
                .endpoint,
            "http://127.0.0.1:4312"
        );
    }

    #[test]
    fn close_confirms_only_when_this_workflow_owns_an_active_watcher() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write fixture");

        let workflow = DesktopRuntime::default();
        workflow
            .open_repository_path_with_launch(
                repository,
                SidecarLaunch::Development {
                    entry: script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open reader session");
        assert!(
            !workflow
                .close_requires_confirmation()
                .expect("reader close state")
        );
        workflow
            .control_watcher("watcher.start")
            .expect("start watcher");
        assert!(
            workflow
                .close_requires_confirmation()
                .expect("watcher close state")
        );
        workflow.shutdown().expect("graceful watcher shutdown");
        assert!(matches!(
            workflow.connection(),
            Err(DesktopRuntimeError::NoOpenSession)
        ));
    }

    #[test]
    fn unexpected_sidecar_exit_invalidates_then_requires_explicit_reopen() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).expect("create repository");
        let failing_script = temp.path().join("failing-sidecar.mjs");
        let replacement_script = temp.path().join("replacement-sidecar.mjs");
        fs::write(
            &failing_script,
            unexpected_exit_fixture_sidecar_source(repository.to_str().expect("UTF-8 path")),
        )
        .expect("write failing fixture");
        fs::write(
            &replacement_script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write replacement fixture");

        let workflow = DesktopRuntime::default();
        workflow
            .open_repository_path_with_launch(
                repository,
                SidecarLaunch::Development {
                    entry: failing_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open failing reader session");
        let mut observed_unexpected_exit = false;
        for _ in 0..50 {
            if matches!(
                workflow.connection(),
                Err(DesktopRuntimeError::SidecarUnavailable)
            ) {
                observed_unexpected_exit = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(observed_unexpected_exit, "sidecar should exit unexpectedly");
        assert!(matches!(
            workflow.connection(),
            Err(DesktopRuntimeError::Invalidated)
        ));
        assert!(matches!(
            workflow.reopen_with_launch(SidecarLaunch::Development {
                entry: replacement_script,
                node: PathBuf::from("node"),
            }),
            Ok(OpenExternalRepositoryResult::Opened)
        ));
        assert!(
            !workflow
                .close_requires_confirmation()
                .expect("reopened reader is not watching")
        );
        workflow.shutdown().expect("shutdown reopened reader");
    }

    #[test]
    fn invalidated_archived_reader_reopens_with_read_only_access() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("archive");
        fs::create_dir(&repository).expect("create archive");
        let failing_script = temp.path().join("failing-sidecar.mjs");
        let replacement_script = temp.path().join("replacement-sidecar.mjs");
        fs::write(
            &failing_script,
            unexpected_exit_fixture_sidecar_source(repository.to_str().expect("UTF-8 path")),
        )
        .expect("write failing fixture");
        fs::write(
            &replacement_script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write replacement fixture");

        let workflow = DesktopRuntime::default();
        workflow
            .open_repository_path_with_lifecycle(
                repository,
                SidecarLaunch::Development {
                    entry: failing_script,
                    node: PathBuf::from("node"),
                },
                RepositoryLifecycle::Archived,
            )
            .expect("open archived reader session");
        let mut observed_unexpected_exit = false;
        for _ in 0..50 {
            if matches!(
                workflow.connection(),
                Err(DesktopRuntimeError::SidecarUnavailable)
            ) {
                observed_unexpected_exit = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(observed_unexpected_exit, "sidecar should exit unexpectedly");

        assert!(matches!(
            workflow.reopen_with_launch(SidecarLaunch::Development {
                entry: replacement_script,
                node: PathBuf::from("node"),
            }),
            Ok(OpenExternalRepositoryResult::Opened)
        ));
        assert_eq!(
            workflow
                .connection()
                .expect("reopened archive connection")
                .access,
            "readOnly"
        );
        assert!(matches!(
            workflow.control_watcher("watcher.start"),
            Err(DesktopRuntimeError::ReadOnly)
        ));
        workflow
            .shutdown()
            .expect("shutdown reopened archive reader");
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
    fn failed_previous_shutdown_closes_the_inspected_candidate_and_drops_the_stale_connection() {
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
        assert!(matches!(
            runtime.connection(),
            Err(DesktopRuntimeError::SidecarUnavailable)
        ));
    }

    fn fixture_sidecar_source(repository: &str, status: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        let inspection = if status == "ready" || status == "mutation" {
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
      if (!({status:?} === "ready" || {status:?} === "mutation")) throw new Error("invalid repositories must not open sessions");
      result = {{ type: "session.opened", access: request.command.access, connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }};
    }} else if (request.command.type === "process.shutdown") {{
      result = {{ type: "process.shutdownComplete" }};
      process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }} else {{
      result = {{ type: request.command.type === "watcher.start" ? "watcher.started" : "watcher.stopped" }};
    }}
    process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
    if (request.command.type === "session.open" && {status:?} === "mutation") {{
      process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "event", event: {{ type: "mutation.activity", mutation: "manualCheckpoint", status: "started" }} }}) + "\n");
    }}
  }}
}});
"#
        )
    }

    fn unexpected_exit_fixture_sidecar_source(repository: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        format!(
            r#"
const repository = {repository};
process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  buffer = buffer.slice(newline + 1);
  const result = request.command.type === "repository.inspect"
    ? {{ type: "repository.inspected", inspection: {{ status: "ready", requiredAction: "open", capabilities: ["read"] }} }}
    : {{ type: "session.opened", connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }};
  if (request.command.type === "repository.inspect" && request.command.repoPath !== repository) throw new Error("wrong repository");
  process.stdout.write(JSON.stringify({{ protocolVersion: 3, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
  if (request.command.type === "session.open") process.exit(1);
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
