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

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::managed_initialization::{
    ClaimedDirectoryCleanupError, ManagedDirectoryClaim, claim_managed_repository_directory,
    managed_repository_name, remove_claimed_directory,
};
use crate::save_location::{SaveLocationPlatform, SaveLocationSystem, initial_directory};

const DESKTOP_SIDECAR_PROTOCOL_VERSION: u8 = 6;
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
    pending_migration: Option<PendingRepositoryMigration>,
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

struct PendingRepositoryMigration {
    sidecar: SidecarSupervisor,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryLifecycle {
    Managed,
    Archived,
    External,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryOpenIntent {
    Open,
    Rebuild,
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
    pub intent: RepositoryOpenIntent,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMigrationInput {
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

#[derive(Clone, Serialize)]
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

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepositoryMigrationPreparationResult {
    Prepared {
        snapshot: RepositoryArchiveSnapshot,
    },
    RequiresAction {
        action: RepositoryRequiredAction,
        status: RepositoryStatus,
    },
    Failed {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    BlockedByMutation,
    Busy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryArchiveSnapshot {
    pub repo_path: String,
    pub directory_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_integrity_warning: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryMigrationSourceState {
    Unchanged,
    Migrated,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RepositoryMigrationSnapshotState {
    NotCreated,
    Retained { repo_path: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMigrationInspection {
    inspection_id: String,
    status: String,
    required_action: String,
    capabilities: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RepositoryMigrationCommitResult {
    Migrated {
        inspection: RepositoryMigrationInspection,
        backup_created: bool,
        source_state: RepositoryMigrationSourceState,
        snapshot_state: RepositoryMigrationSnapshotState,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
    },
    Rejected {
        reason: String,
        source_state: RepositoryMigrationSourceState,
        snapshot_state: RepositoryMigrationSnapshotState,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
    },
    Failed {
        reason: String,
        source_state: RepositoryMigrationSourceState,
        snapshot_state: RepositoryMigrationSnapshotState,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
    },
}

/// A path-free result for Desktop Static Save inspection.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PickStaticEncodedSaveResult {
    Cancelled,
    DecodeFailed,
    Failed {
        message: String,
    },
    InvalidFile,
    Loaded {
        #[serde(rename = "decodedSave")]
        decoded_save: Value,
    },
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManagedInitializationResult {
    Cancelled,
    Initialized,
    ExistingRepository {
        name: String,
    },
    Failed {
        phase: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        residual_path: Option<String>,
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
            .is_some_and(|session| session.sidecar.mutation_active())
            || state.pending_migration.is_some();
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
            RepositoryOpenIntent::Open,
        )
    }

    pub(crate) fn initialize_managed_repository<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        selected_path: PathBuf,
    ) -> Result<ManagedInitializationResult, DesktopRuntimeError> {
        self.initialize_managed_repository_at(
            selected_path,
            managed_root(app, RepositoryLifecycle::Managed)?,
            SidecarLaunch::for_app(app)?,
            Local::now().fixed_offset(),
        )
    }

    #[cfg(test)]
    fn initialize_managed_repository_with_launch(
        &self,
        selected_path: PathBuf,
        managed_root: PathBuf,
        launch: SidecarLaunch,
        initialized_at: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<ManagedInitializationResult, DesktopRuntimeError> {
        self.initialize_managed_repository_at(selected_path, managed_root, launch, initialized_at)
    }

    fn initialize_managed_repository_at(
        &self,
        selected_path: PathBuf,
        managed_root: PathBuf,
        launch: SidecarLaunch,
        initialized_at: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<ManagedInitializationResult, DesktopRuntimeError> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                return Ok(ManagedInitializationResult::Busy);
            }
            if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
            }) {
                return Ok(ManagedInitializationResult::BlockedByMutation);
            }
            state.transitioning = true;
        }

        let selected_path = match canonicalize_readable_regular_file(&selected_path) {
            Ok(path) => path,
            Err(DesktopRuntimeError::InvalidSaveFile) => {
                self.finish_transition_preserving_session();
                return Ok(initialization_failure(
                    "preflight",
                    "Select an existing readable regular Encoded Save file.",
                    None,
                ));
            }
            Err(error) => {
                self.finish_transition_preserving_session();
                return Err(error);
            }
        };

        let mut candidate = match SidecarSupervisor::spawn(launch) {
            Ok(candidate) => candidate,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Err(error);
            }
        };

        let save_path = match repository_path_for_protocol(&selected_path) {
            Ok(path) => path,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let preflight = candidate.command(json!({
            "type": "save.inspect",
            "savePath": save_path,
        }));
        let preflight = match preflight {
            Ok(response) => match parse_save_inspection(&response) {
                Ok(inspection) => inspection,
                Err(error) => {
                    self.finish_failed_candidate(candidate);
                    return Err(error);
                }
            },
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error.into());
            }
        };
        if !matches!(preflight, StaticSaveInspection::Loaded(_)) {
            self.finish_failed_candidate(candidate);
            return Ok(initialization_failure(
                "preflight",
                "The selected file could not be decoded as an Encoded Save.",
                None,
            ));
        }

        let existing_root = match existing_managed_root(&managed_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        if let Some(root) = existing_root.as_ref() {
            let duplicate =
                match find_duplicate_managed_repository(root, &selected_path, &mut candidate) {
                    Ok(duplicate) => duplicate,
                    Err(error) => {
                        self.finish_failed_candidate(candidate);
                        return Err(error);
                    }
                };
            if let Some(name) = duplicate {
                self.finish_failed_candidate(candidate);
                return Ok(ManagedInitializationResult::ExistingRepository { name });
            }
        }

        let root = match ensure_managed_root(&managed_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let base_name = managed_repository_name(&selected_path, initialized_at);
        let claimed = match claim_managed_repository_directory(&root, &base_name) {
            Ok(claimed) => claimed,
            Err(_error) => {
                self.finish_failed_candidate(candidate);
                return Err(DesktopRuntimeError::Unavailable);
            }
        };
        let repo_path = match repository_path_for_protocol(&claimed.path) {
            Ok(path) => path,
            Err(error) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate,
                    &root,
                    &claimed,
                    "directoryClaim",
                    &error.user_message(),
                );
                return Ok(result);
            }
        };
        let watched_save_path = match repository_path_for_protocol(&selected_path) {
            Ok(path) => path,
            Err(error) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate,
                    &root,
                    &claimed,
                    "preflight",
                    &error.user_message(),
                );
                return Ok(result);
            }
        };

        let initialized = candidate.command(json!({
            "type": "repository.initialize",
            "repoPath": repo_path,
            "watchedSavePath": watched_save_path,
        }));
        let initialization = match initialized {
            Ok(response) => parse_managed_initialization_result(&response),
            Err(_) => Err(DesktopRuntimeError::Unavailable),
        };
        match initialization {
            Ok(ManagedInitializationOutcome::Initialized) => {}
            Ok(ManagedInitializationOutcome::Failed { phase, reason }) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate, &root, &claimed, &phase, &reason,
                );
                return Ok(result);
            }
            Err(error) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate,
                    &root,
                    &claimed,
                    "repository",
                    &error.user_message(),
                );
                return Ok(result);
            }
        }

        let opened = match candidate.command(json!({
            "type": "session.open",
            "repoPath": repo_path,
            "access": "readWrite",
        })) {
            Ok(response) => response,
            Err(_error) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate,
                    &root,
                    &claimed,
                    "session",
                    "The new Repo Session could not be opened.",
                );
                return Ok(result);
            }
        };
        let connection = match parse_connection(&opened) {
            Ok(connection) => connection,
            Err(error) => {
                let result = self.finish_claimed_initialization_failure(
                    candidate,
                    &root,
                    &claimed,
                    "session",
                    &error.user_message(),
                );
                return Ok(result);
            }
        };
        let mut new_session = ManagedSession {
            connection,
            repo_path: repo_path.clone(),
            sidecar: candidate,
            watching: false,
            lifecycle: RepositoryLifecycle::Managed,
        };

        let mut previous = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
            }) {
                let result = initialization_failure_with_candidate(
                    new_session.sidecar,
                    &root,
                    &claimed,
                    "session",
                    "The current Desktop session started a mutation during initialization.",
                );
                state.transitioning = false;
                return Ok(result);
            }
            state.current_session.take()
        };
        let previous_was_watching = previous.as_ref().is_some_and(|session| session.watching);

        if let Some(previous_session) = previous.as_mut()
            && previous_was_watching
        {
            if let Err(_error) = send_watcher_command(previous_session, "watcher.stop") {
                return Ok(self.finish_claimed_initialization_failure_with_session(
                    new_session.sidecar,
                    &root,
                    &claimed,
                    "watching",
                    "The previous watcher could not be stopped safely.",
                    previous,
                ));
            }
            previous_session.watching = false;
        }

        if let Err(_error) = send_watcher_command(&mut new_session, "watcher.start") {
            if let Some(previous_session) = previous.as_mut()
                && previous_was_watching
                && send_watcher_command(previous_session, "watcher.start").is_ok()
            {
                previous_session.watching = true;
            }
            return Ok(self.finish_claimed_initialization_failure_with_session(
                new_session.sidecar,
                &root,
                &claimed,
                "watching",
                "The new watcher could not be started.",
                previous,
            ));
        }
        new_session.watching = true;

        if let Some(mut previous_session) = previous
            && let Err(_error) = previous_session.sidecar.shutdown()
        {
            return Ok(self.finish_claimed_initialization_failure_with_session(
                new_session.sidecar,
                &root,
                &claimed,
                "session",
                "The previous Repo Session could not be closed safely.",
                Some(previous_session),
            ));
        }

        self.finish_transition(Some(new_session));
        Ok(ManagedInitializationResult::Initialized)
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
            RepositoryOpenIntent::Open,
        )
    }

    fn open_repository_path_with_lifecycle(
        &self,
        selected_path: PathBuf,
        launch: SidecarLaunch,
        lifecycle: RepositoryLifecycle,
        intent: RepositoryOpenIntent,
    ) -> Result<OpenExternalRepositoryResult, DesktopRuntimeError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                return Ok(OpenExternalRepositoryResult::Busy);
            }
        }
        let repo_path = canonicalize_repository_path(&selected_path)?;
        let repo_path = repository_path_for_protocol(&repo_path)?;
        let mut candidate = SidecarSupervisor::spawn(launch)?;

        let inspection =
            match candidate.command(repository_open_inspection_command(&repo_path, lifecycle)) {
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

        let can_open = (status == "ready" && required_action == "open")
            || (lifecycle == RepositoryLifecycle::Archived
                && is_read_only_archive_status(&status, &required_action));
        let can_rebuild = intent == RepositoryOpenIntent::Rebuild
            && is_managed_rebuild_candidate(lifecycle, &status, &required_action);
        if !can_open && !can_rebuild {
            candidate.shutdown_without_session();
            return Ok(OpenExternalRepositoryResult::RequiresAction {
                action: parse_required_action(&required_action)?,
                status: parse_repository_status(&status)?,
            });
        }

        let admission = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                Err(OpenExternalRepositoryResult::Busy)
            } else if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
            }) {
                Err(OpenExternalRepositoryResult::BlockedByMutation)
            } else {
                state.transitioning = true;
                Ok(())
            }
        };
        if let Err(result) = admission {
            candidate.shutdown_without_session();
            return Ok(result);
        }

        if can_rebuild {
            let rebuilt = candidate.command(json!({
                "type": "repository.rebuild",
                "repoPath": repo_path,
            }));
            let rebuilt = match rebuilt {
                Ok(response) => response,
                Err(error) => {
                    candidate.shutdown_without_session();
                    self.finish_transition_preserving_session();
                    return Err(error.into());
                }
            };
            if let Err(error) = parse_repository_rebuild(&rebuilt) {
                candidate.shutdown_without_session();
                self.finish_transition_preserving_session();
                return Err(error);
            }

            let reinspection =
                match candidate.command(strict_repository_inspection_command(&repo_path)) {
                    Ok(response) => response,
                    Err(error) => {
                        candidate.shutdown_without_session();
                        self.finish_transition_preserving_session();
                        return Err(error.into());
                    }
                };
            let (status, required_action) = match parse_repository_inspection(&reinspection) {
                Ok(inspection) => inspection,
                Err(error) => {
                    candidate.shutdown_without_session();
                    self.finish_transition_preserving_session();
                    return Err(error);
                }
            };
            if status != "ready" || required_action != "open" {
                candidate.shutdown_without_session();
                self.finish_transition_preserving_session();
                return Ok(OpenExternalRepositoryResult::RequiresAction {
                    action: parse_required_action(&required_action)?,
                    status: parse_repository_status(&status)?,
                });
            }
        }

        // Open the candidate session while the current session remains owned by Desktop. This
        // keeps a failed candidate open from destroying the only usable connection.
        let opened = match candidate.command(json!({
            "type": "session.open",
            "repoPath": repo_path,
            "access": lifecycle.sidecar_access(),
        })) {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                self.finish_transition_preserving_session();
                return Err(error.into());
            }
        };
        let connection = match parse_connection(&opened) {
            Ok(connection) => connection,
            Err(error) => {
                candidate.shutdown_without_session();
                self.finish_transition_preserving_session();
                return Err(error);
            }
        };

        let prior_session = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?
            .current_session
            .take();
        if let Some(mut prior_session) = prior_session
            && let Err(error) = prior_session.sidecar.shutdown()
        {
            candidate.shutdown_without_session();
            self.finish_transition(Some(prior_session));
            return Err(error);
        }

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
        if state.pending_migration.is_some() {
            return Err(DesktopRuntimeError::BlockedByMutation);
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
            input.intent,
        )
    }

    fn prepare_repository_migration<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        input: RepositoryMigrationInput,
    ) -> Result<RepositoryMigrationPreparationResult, DesktopRuntimeError> {
        if input.lifecycle != RepositoryLifecycle::Managed {
            return Err(DesktopRuntimeError::InvalidDirectory);
        }
        let path = resolve_library_child(app, RepositoryLifecycle::Managed, &input.name)?;
        let repo_path = repository_path_for_protocol(&path)?;
        let snapshot_root = managed_root(app, RepositoryLifecycle::Archived)?;
        let snapshot_name = format!(
            "{}--pre-migration-{}",
            input.name,
            Local::now().format("%Y-%m-%dT%H-%M-%S%.3f%z"),
        );
        let snapshot_path = snapshot_root.join(snapshot_name);
        let snapshot_path = repository_path_for_protocol(&snapshot_path)?;

        let mut candidate = SidecarSupervisor::spawn(SidecarLaunch::for_app(app)?)?;
        let inspection = match candidate.command(advisory_repository_inspection_command(&repo_path))
        {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                return Err(error.into());
            }
        };
        let details = match parse_repository_inspection_details(&inspection) {
            Ok(details) => details,
            Err(error) => {
                candidate.shutdown_without_session();
                return Err(error);
            }
        };
        if details.status != "legacyConfig" && details.status != "migrationRequired" {
            candidate.shutdown_without_session();
            return Ok(RepositoryMigrationPreparationResult::RequiresAction {
                action: parse_required_action(&details.required_action)?,
                status: parse_repository_status(&details.status)?,
            });
        }
        let inspection_id = details.inspection_id.ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid repository inspection ID.".into(),
            )
        })?;

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                candidate.shutdown_without_session();
                return Ok(RepositoryMigrationPreparationResult::Busy);
            }
            if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok()
                    && (session.sidecar.mutation_active() || session.watching)
            }) {
                candidate.shutdown_without_session();
                return Ok(RepositoryMigrationPreparationResult::BlockedByMutation);
            }
            state.transitioning = true;
        }

        let response = candidate.command(json!({
            "type": "repository.migration.prepare",
            "repoPath": repo_path,
            "inspectionId": inspection_id,
            "confirmation": "migrate-save-history-repository",
            "snapshotPath": snapshot_path,
        }));
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                candidate.shutdown_without_session();
                self.finish_mutation();
                return Err(error.into());
            }
        };
        let preparation = match parse_repository_migration_preparation(&response) {
            Ok(preparation) => preparation,
            Err(error) => {
                candidate.shutdown_without_session();
                self.finish_mutation();
                return Err(error);
            }
        };
        match preparation {
            RepositoryMigrationPreparationResult::Prepared { snapshot } => {
                if snapshot.repo_path.is_empty() || snapshot.directory_digest.len() != 64 {
                    candidate.shutdown_without_session();
                    self.finish_mutation();
                    return Err(DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid archive snapshot.".into(),
                    ));
                }
                if let Ok(mut state) = self.state.lock() {
                    state.pending_migration =
                        Some(PendingRepositoryMigration { sidecar: candidate });
                    state.transitioning = false;
                }
                Ok(RepositoryMigrationPreparationResult::Prepared { snapshot })
            }
            other => {
                candidate.shutdown_without_session();
                self.finish_mutation();
                Ok(other)
            }
        }
    }

    fn commit_repository_migration(
        &self,
    ) -> Result<RepositoryMigrationCommitResult, DesktopRuntimeError> {
        let mut pending = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning {
                return Err(DesktopRuntimeError::Busy);
            }
            let pending = state
                .pending_migration
                .take()
                .ok_or(DesktopRuntimeError::NoPreparedMigration)?;
            state.transitioning = true;
            pending
        };

        let response = pending.sidecar.command(json!({
            "type": "repository.migration.commit",
        }));
        let migration = response
            .map_err(DesktopRuntimeError::from)
            .and_then(|response| parse_repository_migration_result(&response));
        let shutdown = pending.sidecar.shutdown();
        let result = match (migration, shutdown) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(result), Ok(())) => Ok(result),
        };
        self.finish_mutation();
        result
    }

    pub(crate) fn close_requires_confirmation(&self) -> Result<bool, DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if state.transitioning {
            return Err(DesktopRuntimeError::Busy);
        }
        if state.pending_migration.is_some() {
            return Err(DesktopRuntimeError::BlockedByMutation);
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
            RepositoryOpenIntent::Open,
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
        self.open_repository_path_with_lifecycle(
            PathBuf::from(path),
            launch,
            lifecycle,
            RepositoryOpenIntent::Open,
        )
    }

    fn take_session_for_operation(&self) -> Result<Option<ManagedSession>, DesktopRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if state.transitioning {
            return Err(DesktopRuntimeError::Busy);
        }
        if state.pending_migration.is_some() {
            return Err(DesktopRuntimeError::BlockedByMutation);
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

    fn finish_transition_preserving_session(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.transitioning = false;
        }
    }

    fn finish_failed_candidate(&self, mut candidate: SidecarSupervisor) {
        let _ = candidate.shutdown();
        self.finish_transition_preserving_session();
    }

    fn finish_claimed_initialization_failure(
        &self,
        candidate: SidecarSupervisor,
        root: &Path,
        claimed: &ManagedDirectoryClaim,
        phase: &str,
        message: &str,
    ) -> ManagedInitializationResult {
        let result =
            initialization_failure_with_candidate(candidate, root, claimed, phase, message);
        self.finish_transition_preserving_session();
        result
    }

    fn finish_claimed_initialization_failure_with_session(
        &self,
        candidate: SidecarSupervisor,
        root: &Path,
        claimed: &ManagedDirectoryClaim,
        phase: &str,
        message: &str,
        session: Option<ManagedSession>,
    ) -> ManagedInitializationResult {
        let result =
            initialization_failure_with_candidate(candidate, root, claimed, phase, message);
        self.finish_transition(session);
        result
    }

    fn finish_mutation(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.transitioning = false;
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
pub async fn desktop_initialize_managed_repository(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<ManagedInitializationResult, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Initialize managed Silksong save history")
        .add_filter("Silksong save", &["dat"])
        .set_directory(initial_directory(
            current_save_location_platform(),
            &EnvironmentSaveLocationSystem,
        ))
        .blocking_pick_file()
    else {
        return Ok(ManagedInitializationResult::Cancelled);
    };
    let selected_path = selected
        .into_path()
        .map_err(|_| "The selected save file could not be opened.".to_string())?;

    let result = workflow
        .initialize_managed_repository(&app, selected_path)
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

/// Opens one native file picker for an Encoded Save. The WebView receives only
/// a decoded JSON value after both Rust and the Core-owning sidecar validate it.
#[tauri::command]
pub async fn desktop_pick_static_encoded_save(
    app: AppHandle,
) -> Result<PickStaticEncodedSaveResult, String> {
    inspect_static_encoded_save(&app).map_err(|error| error.user_message())
}

pub(crate) fn inspect_static_encoded_save<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<PickStaticEncodedSaveResult, DesktopRuntimeError> {
    inspect_static_encoded_save_with_adapters(
        current_save_location_platform(),
        &EnvironmentSaveLocationSystem,
        &TauriStaticSavePicker { app },
        &NativeStaticSaveFileSystem,
        &SidecarStaticSaveInspector { app },
    )
}

/// Returns the native picker hint without attempting to discover a save slot.
pub(crate) fn static_save_picker_initial_directory() -> PathBuf {
    initial_directory(
        current_save_location_platform(),
        &EnvironmentSaveLocationSystem,
    )
}

/// Inspects an already-selected native path. This deliberately performs no UI
/// work so callers can keep sidecar launch and decoding off the UI thread.
pub(crate) fn inspect_selected_static_encoded_save<R: Runtime>(
    app: &AppHandle<R>,
    selected_path: &Path,
) -> Result<PickStaticEncodedSaveResult, DesktopRuntimeError> {
    inspect_selected_static_encoded_save_with_adapters(
        selected_path,
        &NativeStaticSaveFileSystem,
        &SidecarStaticSaveInspector { app },
    )
}

/// Menu events cannot return an IPC rejection, so convert every native failure
/// into the same path-free, user-visible outcome the command would expose.
pub(crate) fn menu_static_save_result(
    result: Result<PickStaticEncodedSaveResult, DesktopRuntimeError>,
) -> PickStaticEncodedSaveResult {
    match result {
        Ok(result) => result,
        Err(error) => PickStaticEncodedSaveResult::Failed {
            message: error.user_message(),
        },
    }
}

trait StaticSavePicker {
    /// The `.dat` filter is presentation-only: this picker intentionally lets
    /// the user navigate anywhere and choose a file with any suffix.
    fn pick_file(&self, initial_directory: &Path) -> Result<Option<PathBuf>, DesktopRuntimeError>;
}

trait StaticSaveFileSystem {
    /// Returns a canonical, readable regular file, never a directory or other
    /// filesystem object.
    fn readable_regular_file(&self, selected_path: &Path) -> Result<PathBuf, DesktopRuntimeError>;
}

trait StaticSaveInspector {
    fn inspect(&self, selected_path: &Path) -> Result<StaticSaveInspection, DesktopRuntimeError>;
}

enum StaticSaveInspection {
    DecodeFailed,
    InvalidFile,
    Loaded(Value),
}

fn inspect_static_encoded_save_with_adapters(
    platform: SaveLocationPlatform,
    location_system: &impl SaveLocationSystem,
    picker: &impl StaticSavePicker,
    file_system: &impl StaticSaveFileSystem,
    inspector: &impl StaticSaveInspector,
) -> Result<PickStaticEncodedSaveResult, DesktopRuntimeError> {
    let initial_directory = initial_directory(platform, location_system);
    let Some(selected_path) = picker.pick_file(&initial_directory)? else {
        return Ok(PickStaticEncodedSaveResult::Cancelled);
    };

    inspect_selected_static_encoded_save_with_adapters(
        selected_path.as_path(),
        file_system,
        inspector,
    )
}

fn inspect_selected_static_encoded_save_with_adapters(
    selected_path: &Path,
    file_system: &impl StaticSaveFileSystem,
    inspector: &impl StaticSaveInspector,
) -> Result<PickStaticEncodedSaveResult, DesktopRuntimeError> {
    let selected_path = match file_system.readable_regular_file(selected_path) {
        Ok(path) => path,
        Err(DesktopRuntimeError::InvalidSaveFile) => {
            return Ok(PickStaticEncodedSaveResult::InvalidFile);
        }
        Err(error) => return Err(error),
    };

    match inspector.inspect(&selected_path)? {
        StaticSaveInspection::Loaded(decoded_save) => {
            Ok(PickStaticEncodedSaveResult::Loaded { decoded_save })
        }
        StaticSaveInspection::InvalidFile => Ok(PickStaticEncodedSaveResult::InvalidFile),
        StaticSaveInspection::DecodeFailed => Ok(PickStaticEncodedSaveResult::DecodeFailed),
    }
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
pub fn desktop_prepare_repository_migration(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
    input: RepositoryMigrationInput,
) -> Result<RepositoryMigrationPreparationResult, String> {
    let result = workflow
        .prepare_repository_migration(&app, input)
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub fn desktop_commit_repository_migration(
    app: AppHandle,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<RepositoryMigrationCommitResult, String> {
    let result = workflow
        .commit_repository_migration()
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

fn canonicalize_readable_regular_file(path: &Path) -> Result<PathBuf, DesktopRuntimeError> {
    let canonical = fs::canonicalize(path).map_err(|_| DesktopRuntimeError::InvalidSaveFile)?;
    let metadata = fs::metadata(&canonical).map_err(|_| DesktopRuntimeError::InvalidSaveFile)?;
    if !metadata.is_file() || fs::File::open(&canonical).is_err() {
        return Err(DesktopRuntimeError::InvalidSaveFile);
    }

    Ok(canonical)
}

struct TauriStaticSavePicker<'app, R: Runtime> {
    app: &'app AppHandle<R>,
}

impl<R: Runtime> StaticSavePicker for TauriStaticSavePicker<'_, R> {
    fn pick_file(&self, initial_directory: &Path) -> Result<Option<PathBuf>, DesktopRuntimeError> {
        let selected = self
            .app
            .dialog()
            .file()
            .set_title("Inspect local Silksong save")
            .add_filter("Silksong save", &["dat"])
            .set_directory(initial_directory)
            .blocking_pick_file();
        selected
            .map(|file| {
                file.into_path()
                    .map_err(|_| DesktopRuntimeError::InvalidSaveFile)
            })
            .transpose()
    }
}

struct NativeStaticSaveFileSystem;

impl StaticSaveFileSystem for NativeStaticSaveFileSystem {
    fn readable_regular_file(&self, selected_path: &Path) -> Result<PathBuf, DesktopRuntimeError> {
        canonicalize_readable_regular_file(selected_path)
    }
}

struct SidecarStaticSaveInspector<'app, R: Runtime> {
    app: &'app AppHandle<R>,
}

impl<R: Runtime> StaticSaveInspector for SidecarStaticSaveInspector<'_, R> {
    fn inspect(&self, selected_path: &Path) -> Result<StaticSaveInspection, DesktopRuntimeError> {
        let save_path = repository_path_for_protocol(selected_path)?;
        let mut inspector = SidecarSupervisor::spawn(SidecarLaunch::for_app(self.app)?)?;
        let response = inspector.command(json!({
            "type": "save.inspect",
            "savePath": save_path,
        }));
        let shutdown = inspector.shutdown();
        let response = response.map_err(DesktopRuntimeError::from)?;
        shutdown?;

        parse_save_inspection(&response)
    }
}

fn parse_save_inspection(response: &Value) -> Result<StaticSaveInspection, DesktopRuntimeError> {
    match response.pointer("/result/type").and_then(Value::as_str) {
        Some("save.inspected") => response
            .pointer("/result/decodedSave")
            .cloned()
            .map(StaticSaveInspection::Loaded)
            .ok_or_else(|| {
                DesktopRuntimeError::Protocol(
                    "The Desktop sidecar returned an invalid save inspection.".into(),
                )
            }),
        Some("save.invalidFile") => Ok(StaticSaveInspection::InvalidFile),
        Some("save.decodeFailed") => Ok(StaticSaveInspection::DecodeFailed),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid save inspection.".into(),
        )),
    }
}

struct EnvironmentSaveLocationSystem;

impl SaveLocationSystem for EnvironmentSaveLocationSystem {
    fn environment(&self, variable: &str) -> Option<PathBuf> {
        env::var_os(variable).map(PathBuf::from)
    }

    fn home_directory(&self) -> PathBuf {
        self.environment("HOME")
            .or_else(|| self.environment("USERPROFILE"))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn is_existing_directory(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

fn current_save_location_platform() -> SaveLocationPlatform {
    if cfg!(target_os = "windows") {
        SaveLocationPlatform::Windows
    } else if cfg!(target_os = "macos") {
        SaveLocationPlatform::Macos
    } else if cfg!(target_os = "linux") {
        SaveLocationPlatform::Linux
    } else {
        SaveLocationPlatform::Other
    }
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
    Ok(root)
}

fn existing_managed_root(root: &Path) -> Result<Option<PathBuf>, DesktopRuntimeError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(DesktopRuntimeError::InvalidDirectory)
        }
        Ok(_) => fs::canonicalize(root)
            .map(Some)
            .map_err(|_| DesktopRuntimeError::InvalidDirectory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(DesktopRuntimeError::Unavailable),
    }
}

fn ensure_managed_root(root: &Path) -> Result<PathBuf, DesktopRuntimeError> {
    if let Some(existing) = existing_managed_root(root)? {
        return Ok(existing);
    }

    fs::create_dir_all(root).map_err(|_| DesktopRuntimeError::Unavailable)?;
    existing_managed_root(root)?.ok_or(DesktopRuntimeError::Unavailable)
}

fn resolve_library_child<R: Runtime>(
    app: &AppHandle<R>,
    lifecycle: RepositoryLifecycle,
    name: &str,
) -> Result<PathBuf, DesktopRuntimeError> {
    if name.is_empty() || name == "." || name == ".." || Path::new(name).components().count() != 1 {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    let root = existing_managed_root(&managed_root(app, lifecycle)?)?
        .ok_or(DesktopRuntimeError::InvalidDirectory)?;
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
        let Some(root) = existing_managed_root(&managed_root(app, lifecycle)?)? else {
            continue;
        };
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
                let result = inspector.command(advisory_repository_inspection_command(&repo_path));
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
            let can_migrate_managed = lifecycle == RepositoryLifecycle::Managed
                && (status == "legacyConfig" || status == "migrationRequired")
                && required_action == "confirmMigration";
            let can_rebuild_managed =
                is_managed_rebuild_candidate(lifecycle, &status, &required_action);
            let can_browse_archived = lifecycle == RepositoryLifecycle::Archived
                && is_read_only_archive_status(&status, &required_action);
            let record = RepositoryLibraryEntry {
                name,
                lifecycle,
                status: status.clone(),
                required_action,
                current: is_current,
                watching: is_current && current.as_ref().is_some_and(|(_, _, watching)| *watching),
            };
            if status == "ready"
                || can_migrate_managed
                || can_rebuild_managed
                || can_browse_archived
            {
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

fn advisory_repository_inspection_command(repo_path: &str) -> Value {
    repository_inspection_command(repo_path, "advisory")
}

fn strict_repository_inspection_command(repo_path: &str) -> Value {
    repository_inspection_command(repo_path, "strict")
}

fn repository_open_inspection_command(repo_path: &str, lifecycle: RepositoryLifecycle) -> Value {
    if lifecycle == RepositoryLifecycle::Archived {
        advisory_repository_inspection_command(repo_path)
    } else {
        strict_repository_inspection_command(repo_path)
    }
}

fn repository_inspection_command(repo_path: &str, git_integrity_policy: &str) -> Value {
    json!({
        "type": "repository.inspect",
        "repoPath": repo_path,
        "gitIntegrityPolicy": git_integrity_policy,
    })
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

struct RepositoryInspectionDetails {
    inspection_id: Option<String>,
    status: String,
    required_action: String,
}

fn parse_repository_inspection_details(
    response: &Value,
) -> Result<RepositoryInspectionDetails, DesktopRuntimeError> {
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
    let inspection_id = repository
        .get("inspectionId")
        .and_then(Value::as_str)
        .filter(|inspection_id| !inspection_id.is_empty());
    Ok(RepositoryInspectionDetails {
        inspection_id: inspection_id.map(str::to_owned),
        status: status.into(),
        required_action: action.into(),
    })
}

fn repository_watched_save_comparison_command(repo_path: &str, save_path: &str) -> Value {
    json!({
        "type": "repository.compareWatchedSave",
        "repoPath": repo_path,
        "savePath": save_path,
    })
}

fn parse_repository_watched_save_comparison(response: &Value) -> Result<bool, DesktopRuntimeError> {
    if response.pointer("/result/type").and_then(Value::as_str)
        != Some("repository.watchedSaveCompared")
    {
        return Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid Watched Save comparison.".into(),
        ));
    }
    response
        .pointer("/result/same")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid Watched Save comparison.".into(),
            )
        })
}

fn parse_repository_inspection(response: &Value) -> Result<(String, String), DesktopRuntimeError> {
    let details = parse_repository_inspection_details(response)?;
    Ok((details.status, details.required_action))
}

fn parse_repository_rebuild(response: &Value) -> Result<(), DesktopRuntimeError> {
    if response.pointer("/result/type").and_then(Value::as_str) != Some("repository.rebuilt") {
        return Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid repository rebuild result.".into(),
        ));
    }
    Ok(())
}

enum ManagedInitializationOutcome {
    Initialized,
    Failed { phase: String, reason: String },
}

fn parse_managed_initialization_result(
    response: &Value,
) -> Result<ManagedInitializationOutcome, DesktopRuntimeError> {
    let initialization = response.pointer("/result/initialization").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid initialization result.".into(),
        )
    })?;
    match initialization.get("status").and_then(Value::as_str) {
        Some("initialized") => Ok(ManagedInitializationOutcome::Initialized),
        Some("failed") => {
            let phase = initialization
                .get("phase")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid initialization phase.".into(),
                    )
                })?;
            let reason = initialization
                .get("reason")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid initialization reason.".into(),
                    )
                })?;
            let message = match (phase, reason) {
                ("repository", "historyFailed") => {
                    "History could not establish the Save History Repository."
                }
                ("baseline", "observationFailed") => {
                    "History could not commit the first Raw Save Observation."
                }
                _ => {
                    return Err(DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an unknown initialization failure.".into(),
                    ));
                }
            };
            Ok(ManagedInitializationOutcome::Failed {
                phase: phase.into(),
                reason: message.into(),
            })
        }
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown initialization status.".into(),
        )),
    }
}

fn initialization_failure(
    phase: &str,
    message: &str,
    residual_path: Option<String>,
) -> ManagedInitializationResult {
    ManagedInitializationResult::Failed {
        phase: phase.into(),
        message: message.into(),
        residual_path,
    }
}

fn initialization_failure_with_candidate(
    mut candidate: SidecarSupervisor,
    root: &Path,
    claimed: &ManagedDirectoryClaim,
    phase: &str,
    message: &str,
) -> ManagedInitializationResult {
    let cleanup = match candidate.shutdown() {
        Ok(()) => remove_claimed_directory(root, claimed),
        Err(_) => Err(ClaimedDirectoryCleanupError::with_residual(
            std::io::Error::other("candidate sidecar shutdown failed"),
            Some(claimed.path.clone()),
        )),
    };
    let residual_path = cleanup.err().and_then(|error| {
        error
            .residual_path
            .or_else(|| Some(claimed.path.clone()))
            .map(|path| path.to_string_lossy().into_owned())
    });
    let message = if residual_path.is_some() {
        format!("{message} Cleanup could not remove the candidate directory.")
    } else {
        message.into()
    };
    initialization_failure(phase, &message, residual_path)
}

fn send_watcher_command(
    session: &mut ManagedSession,
    command_type: &str,
) -> Result<(), SidecarError> {
    let response = session.sidecar.command(json!({ "type": command_type }))?;
    let expected = match command_type {
        "watcher.start" => "watcher.started",
        "watcher.stop" => "watcher.stopped",
        _ => return Err(SidecarError::Protocol),
    };
    if response.pointer("/result/type").and_then(Value::as_str) != Some(expected) {
        return Err(SidecarError::Protocol);
    }
    Ok(())
}

fn find_duplicate_managed_repository(
    root: &Path,
    selected_save_path: &Path,
    inspector: &mut SidecarSupervisor,
) -> Result<Option<String>, DesktopRuntimeError> {
    for entry in fs::read_dir(root).map_err(|_| DesktopRuntimeError::Unavailable)? {
        let entry = entry.map_err(|_| DesktopRuntimeError::Unavailable)?;
        let file_type = entry
            .file_type()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }

        let candidate =
            fs::canonicalize(entry.path()).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
        if candidate.parent() != Some(root) {
            continue;
        }
        let candidate_path = repository_path_for_protocol(&candidate)?;
        let selected_save_path = repository_path_for_protocol(selected_save_path)?;
        let response = inspector
            .command(repository_watched_save_comparison_command(
                &candidate_path,
                &selected_save_path,
            ))
            .map_err(DesktopRuntimeError::from)?;
        if parse_repository_watched_save_comparison(&response)? {
            return Ok(Some(entry.file_name().to_string_lossy().into_owned()));
        }
    }

    Ok(None)
}

fn is_read_only_archive_status(status: &str, required_action: &str) -> bool {
    required_action == "confirmMigration" && matches!(status, "legacyConfig" | "migrationRequired")
}

fn is_managed_rebuild_candidate(
    lifecycle: RepositoryLifecycle,
    status: &str,
    required_action: &str,
) -> bool {
    lifecycle == RepositoryLifecycle::Managed
        && status == "rebuildRequired"
        && required_action == "rebuildReadModel"
}

fn parse_repository_migration_preparation(
    response: &Value,
) -> Result<RepositoryMigrationPreparationResult, DesktopRuntimeError> {
    let preparation = response.pointer("/result/preparation").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid migration preparation.".into(),
        )
    })?;
    match preparation.get("status").and_then(Value::as_str) {
        Some("prepared") => {
            let snapshot = preparation.get("snapshot").ok_or_else(|| {
                DesktopRuntimeError::Protocol(
                    "The Desktop sidecar returned an invalid archive snapshot.".into(),
                )
            })?;
            let repo_path = snapshot
                .get("repoPath")
                .and_then(Value::as_str)
                .filter(|repo_path| !repo_path.is_empty())
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid archive path.".into(),
                    )
                })?;
            let directory_digest = snapshot
                .get("directoryDigest")
                .and_then(Value::as_str)
                .filter(|digest| {
                    digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid archive digest.".into(),
                    )
                })?;
            Ok(RepositoryMigrationPreparationResult::Prepared {
                snapshot: RepositoryArchiveSnapshot {
                    repo_path: repo_path.into(),
                    directory_digest: directory_digest.into(),
                    git_integrity_warning: snapshot
                        .get("gitIntegrityWarning")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            })
        }
        Some("rejected") => {
            let reason = preparation
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if reason == "migrationNotRequired" {
                return Err(DesktopRuntimeError::Protocol(
                    "The repository no longer requires migration.".into(),
                ));
            }
            Ok(RepositoryMigrationPreparationResult::Failed {
                reason: reason.into(),
                message: None,
            })
        }
        Some("failed") => Ok(RepositoryMigrationPreparationResult::Failed {
            reason: preparation
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("snapshotFailed")
                .into(),
            message: preparation
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown migration preparation status.".into(),
        )),
    }
}

fn parse_repository_migration_result(
    response: &Value,
) -> Result<RepositoryMigrationCommitResult, DesktopRuntimeError> {
    let migration = response
        .pointer("/result/migration")
        .cloned()
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid migration result.".into(),
            )
        })?;

    serde_json::from_value(migration).map_err(|_| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid migration result.".into(),
        )
    })
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
        let workspace_root = workspace_root()?;
        if cfg!(debug_assertions) {
            return development_sidecar_launch(workspace_root);
        }

        let resource_directory = app
            .path()
            .resource_dir()
            .map_err(|_| DesktopRuntimeError::Unavailable)?;
        sidecar_launch_for_resource_directory(false, &resource_directory, workspace_root)
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

fn workspace_root() -> Result<&'static Path, DesktopRuntimeError> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .ok_or(DesktopRuntimeError::Unavailable)
}

fn development_sidecar_launch(workspace_root: &Path) -> Result<SidecarLaunch, DesktopRuntimeError> {
    let entry = workspace_root.join(DEVELOPMENT_SIDECAR_ENTRY);
    if !entry.is_file() {
        return Err(DesktopRuntimeError::DevelopmentSidecarUnavailable);
    }

    Ok(SidecarLaunch::Development {
        entry,
        node: PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }),
    })
}

/// Selects the workspace sidecar only for the unbundled Cargo release layout.
/// Packaged applications never use this fallback: their resource directory is
/// outside the workspace target directory and must contain the bundled binary.
fn sidecar_launch_for_resource_directory(
    debug_build: bool,
    resource_directory: &Path,
    workspace_root: &Path,
) -> Result<SidecarLaunch, DesktopRuntimeError> {
    if debug_build {
        return development_sidecar_launch(workspace_root);
    }

    let executable = resource_directory.join(BUNDLED_SIDECAR_NAME);
    if executable.is_file() {
        return Ok(SidecarLaunch::Bundled { executable });
    }

    let workspace_release_resources = workspace_root.join("apps/desktop/src-tauri/target/release");
    if resource_directory == workspace_release_resources {
        return development_sidecar_launch(workspace_root);
    }

    Err(DesktopRuntimeError::BundledSidecarUnavailable)
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
    InvalidSaveFile,
    Invalidated,
    NoOpenSession,
    NoPreparedMigration,
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
            Self::InvalidSaveFile => "Choose an existing readable save file.".into(),
            Self::Invalidated => "The Desktop Local History connection stopped unexpectedly. Reopen the selected repository to continue browsing.".into(),
            Self::NoOpenSession => "Open a repository before using Local History controls.".into(),
            Self::NoPreparedMigration => "No prepared repository migration is active.".into(),
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
        cell::RefCell,
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
        thread,
        time::Duration,
    };

    use chrono::{FixedOffset, TimeZone, Timelike};

    use super::{
        DEVELOPMENT_SIDECAR_ENTRY, DesktopRuntime, DesktopRuntimeError,
        ManagedInitializationResult, OpenExternalRepositoryResult, PendingRepositoryMigration,
        PickStaticEncodedSaveResult, RepositoryLifecycle, RepositoryOpenIntent,
        SaveLocationPlatform, SaveLocationSystem, SidecarLaunch, SidecarSupervisor,
        StaticSaveFileSystem, StaticSaveInspection, StaticSaveInspector, StaticSavePicker,
        advisory_repository_inspection_command, canonicalize_repository_path,
        inspect_static_encoded_save_with_adapters, managed_repository_name,
        menu_static_save_result, natural_name_cmp, repository_open_inspection_command,
        sidecar_launch_for_resource_directory,
    };

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct FakeSaveLocationSystem;

    impl SaveLocationSystem for FakeSaveLocationSystem {
        fn environment(&self, _variable: &str) -> Option<PathBuf> {
            None
        }

        fn home_directory(&self) -> PathBuf {
            PathBuf::from("/home/player")
        }

        fn is_existing_directory(&self, _path: &Path) -> bool {
            false
        }
    }

    struct FakeStaticSavePicker {
        selected: Option<PathBuf>,
        initial_directory: RefCell<Option<PathBuf>>,
    }

    impl StaticSavePicker for FakeStaticSavePicker {
        fn pick_file(
            &self,
            initial_directory: &Path,
        ) -> Result<Option<PathBuf>, DesktopRuntimeError> {
            self.initial_directory
                .replace(Some(initial_directory.to_path_buf()));
            Ok(self.selected.clone())
        }
    }

    enum FakeFileResult {
        Invalid,
        Valid(PathBuf),
    }

    struct FakeStaticSaveFileSystem {
        result: FakeFileResult,
    }

    impl StaticSaveFileSystem for FakeStaticSaveFileSystem {
        fn readable_regular_file(
            &self,
            _selected_path: &Path,
        ) -> Result<PathBuf, DesktopRuntimeError> {
            match &self.result {
                FakeFileResult::Invalid => Err(DesktopRuntimeError::InvalidSaveFile),
                FakeFileResult::Valid(path) => Ok(path.clone()),
            }
        }
    }

    struct FakeStaticSaveInspector {
        result: StaticSaveInspection,
        inspected_paths: RefCell<Vec<PathBuf>>,
    }

    impl StaticSaveInspector for FakeStaticSaveInspector {
        fn inspect(
            &self,
            selected_path: &Path,
        ) -> Result<StaticSaveInspection, DesktopRuntimeError> {
            self.inspected_paths
                .borrow_mut()
                .push(selected_path.to_path_buf());
            match &self.result {
                StaticSaveInspection::DecodeFailed => Ok(StaticSaveInspection::DecodeFailed),
                StaticSaveInspection::InvalidFile => Ok(StaticSaveInspection::InvalidFile),
                StaticSaveInspection::Loaded(value) => {
                    Ok(StaticSaveInspection::Loaded(value.clone()))
                }
            }
        }
    }

    #[test]
    fn static_save_adapters_allow_custom_navigation_and_valid_non_dat_files() {
        let custom_path = PathBuf::from("/a/custom/location/save-without-a-dat-suffix");
        let picker = FakeStaticSavePicker {
            selected: Some(custom_path.clone()),
            initial_directory: RefCell::new(None),
        };
        let inspector = FakeStaticSaveInspector {
            result: StaticSaveInspection::Loaded(serde_json::json!({ "player": "Hornet" })),
            inspected_paths: RefCell::new(Vec::new()),
        };

        let result = inspect_static_encoded_save_with_adapters(
            SaveLocationPlatform::Other,
            &FakeSaveLocationSystem,
            &picker,
            &FakeStaticSaveFileSystem {
                result: FakeFileResult::Valid(custom_path.clone()),
            },
            &inspector,
        )
        .expect("custom selection can be inspected");

        assert_eq!(
            picker.initial_directory.into_inner(),
            Some(PathBuf::from("/home/player"))
        );
        assert!(matches!(
            result,
            PickStaticEncodedSaveResult::Loaded { decoded_save }
                if decoded_save == serde_json::json!({ "player": "Hornet" })
        ));
        assert_eq!(inspector.inspected_paths.into_inner(), vec![custom_path]);
    }

    #[test]
    fn loaded_static_save_ipc_payload_uses_the_web_contract_field_name() {
        let payload = serde_json::to_value(PickStaticEncodedSaveResult::Loaded {
            decoded_save: serde_json::json!({ "player": "Hornet" }),
        })
        .expect("static save result is serializable for Tauri IPC");

        assert_eq!(
            payload,
            serde_json::json!({
                "kind": "loaded",
                "decodedSave": { "player": "Hornet" },
            })
        );
    }

    #[test]
    fn static_save_adapters_reject_missing_non_regular_and_unreadable_files() {
        for selected_path in [
            "/custom/missing.dat",
            "/custom/directory.dat",
            "/custom/unreadable.dat",
            "/custom/socket.dat",
        ] {
            let picker = FakeStaticSavePicker {
                selected: Some(PathBuf::from(selected_path)),
                initial_directory: RefCell::new(None),
            };
            let inspector = FakeStaticSaveInspector {
                result: StaticSaveInspection::Loaded(serde_json::json!({})),
                inspected_paths: RefCell::new(Vec::new()),
            };

            let result = inspect_static_encoded_save_with_adapters(
                SaveLocationPlatform::Other,
                &FakeSaveLocationSystem,
                &picker,
                &FakeStaticSaveFileSystem {
                    result: FakeFileResult::Invalid,
                },
                &inspector,
            )
            .expect("invalid selections are safe picker outcomes");

            assert!(matches!(result, PickStaticEncodedSaveResult::InvalidFile));
            assert!(inspector.inspected_paths.into_inner().is_empty());
        }
    }

    #[test]
    fn static_save_adapters_preserve_cancellation_and_decode_failure_outcomes() {
        let cancelled_picker = FakeStaticSavePicker {
            selected: None,
            initial_directory: RefCell::new(None),
        };
        let inspector = FakeStaticSaveInspector {
            result: StaticSaveInspection::DecodeFailed,
            inspected_paths: RefCell::new(Vec::new()),
        };
        let cancelled = inspect_static_encoded_save_with_adapters(
            SaveLocationPlatform::Other,
            &FakeSaveLocationSystem,
            &cancelled_picker,
            &FakeStaticSaveFileSystem {
                result: FakeFileResult::Valid(PathBuf::from("/unused")),
            },
            &inspector,
        )
        .expect("cancellation is a safe picker outcome");
        assert!(matches!(cancelled, PickStaticEncodedSaveResult::Cancelled));
        assert!(inspector.inspected_paths.into_inner().is_empty());

        let selected_path = PathBuf::from("/custom/save.dat");
        let picker = FakeStaticSavePicker {
            selected: Some(selected_path.clone()),
            initial_directory: RefCell::new(None),
        };
        let inspector = FakeStaticSaveInspector {
            result: StaticSaveInspection::DecodeFailed,
            inspected_paths: RefCell::new(Vec::new()),
        };
        let decode_failed = inspect_static_encoded_save_with_adapters(
            SaveLocationPlatform::Other,
            &FakeSaveLocationSystem,
            &picker,
            &FakeStaticSaveFileSystem {
                result: FakeFileResult::Valid(selected_path),
            },
            &inspector,
        )
        .expect("decode errors are safe picker outcomes");
        assert!(matches!(
            decode_failed,
            PickStaticEncodedSaveResult::DecodeFailed
        ));
    }

    #[test]
    fn menu_static_save_failures_become_visible_path_free_events() {
        let result = menu_static_save_result(Err(DesktopRuntimeError::SidecarUnavailable));

        assert!(matches!(
            result,
            PickStaticEncodedSaveResult::Failed { message }
                if message == "The Desktop Local History service is unavailable. Close and reopen the app, then try again."
        ));
    }

    #[test]
    fn unbundled_workspace_release_uses_the_built_workspace_sidecar() {
        let temp = TestDirectory::new();
        let workspace_root = temp.path().join("workspace");
        let entry = workspace_root.join(DEVELOPMENT_SIDECAR_ENTRY);
        fs::create_dir_all(entry.parent().expect("sidecar parent")).expect("create sidecar parent");
        fs::write(&entry, "// sidecar").expect("write built sidecar");
        let release_resources = workspace_root.join("apps/desktop/src-tauri/target/release");
        fs::create_dir_all(&release_resources).expect("create release resources");

        assert!(matches!(
            sidecar_launch_for_resource_directory(false, &release_resources, &workspace_root),
            Ok(SidecarLaunch::Development { entry: actual, node })
                if actual == entry && node == Path::new("node")
        ));
    }

    #[test]
    fn packaged_release_never_uses_a_workspace_sidecar_fallback() {
        let temp = TestDirectory::new();
        let workspace_root = temp.path().join("workspace");
        let entry = workspace_root.join(DEVELOPMENT_SIDECAR_ENTRY);
        fs::create_dir_all(entry.parent().expect("sidecar parent")).expect("create sidecar parent");
        fs::write(entry, "// sidecar").expect("write built sidecar");
        let packaged_resources = temp.path().join("installed/resources");
        fs::create_dir_all(&packaged_resources).expect("create packaged resources");

        assert!(matches!(
            sidecar_launch_for_resource_directory(false, &packaged_resources, &workspace_root),
            Err(DesktopRuntimeError::BundledSidecarUnavailable)
        ));
    }

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
    fn desktop_repository_preflights_and_library_scans_use_advisory_git_integrity() {
        assert_eq!(
            advisory_repository_inspection_command("/tmp/repository"),
            serde_json::json!({
                "type": "repository.inspect",
                "repoPath": "/tmp/repository",
                "gitIntegrityPolicy": "advisory",
            })
        );
        assert_eq!(
            repository_open_inspection_command("/tmp/repository", RepositoryLifecycle::External),
            serde_json::json!({
                "type": "repository.inspect",
                "repoPath": "/tmp/repository",
                "gitIntegrityPolicy": "strict",
            })
        );
        assert_eq!(
            repository_open_inspection_command("/tmp/archive", RepositoryLifecycle::Archived),
            advisory_repository_inspection_command("/tmp/archive")
        );
    }

    #[test]
    fn only_managed_rebuild_required_entries_are_landing_candidates() {
        assert!(super::is_managed_rebuild_candidate(
            RepositoryLifecycle::Managed,
            "rebuildRequired",
            "rebuildReadModel",
        ));
        assert!(!super::is_managed_rebuild_candidate(
            RepositoryLifecycle::Archived,
            "rebuildRequired",
            "rebuildReadModel",
        ));
        assert!(!super::is_managed_rebuild_candidate(
            RepositoryLifecycle::External,
            "rebuildRequired",
            "rebuildReadModel",
        ));
        assert!(!super::is_managed_rebuild_candidate(
            RepositoryLifecycle::Managed,
            "ready",
            "open",
        ));
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
    fn managed_rebuild_reinspects_and_opens_without_starting_watching() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("managed-repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("rebuild-sidecar.mjs");
        fs::write(
            &script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 repository path"),
                "success",
                "success",
                None,
            ),
        )
        .expect("write rebuild fixture");

        let runtime = DesktopRuntime::default();
        let result = runtime.open_repository_path_with_lifecycle(
            repository,
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Rebuild,
        );

        assert!(matches!(result, Ok(OpenExternalRepositoryResult::Opened)));
        assert!(
            !runtime
                .close_requires_confirmation()
                .expect("rebuild leaves watching inactive")
        );
        runtime.shutdown().expect("shutdown rebuilt session");
    }

    #[test]
    fn normal_open_returns_rebuild_required_without_rebuilding() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("managed-repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("normal-open-sidecar.mjs");
        fs::write(
            &script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 repository path"),
                "unexpected",
                "success",
                None,
            ),
        )
        .expect("write normal-open fixture");

        let runtime = DesktopRuntime::default();
        let result = runtime.open_repository_path_with_lifecycle(
            repository,
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Open,
        );

        assert!(matches!(
            result,
            Ok(OpenExternalRepositoryResult::RequiresAction {
                action: super::RepositoryRequiredAction::RebuildReadModel,
                status: super::RepositoryStatus::RebuildRequired,
            })
        ));
        assert!(matches!(
            runtime.connection(),
            Err(DesktopRuntimeError::NoOpenSession)
        ));
    }

    #[test]
    fn failed_managed_rebuild_preserves_the_current_session_and_can_be_retried() {
        let temp = TestDirectory::new();
        let first_repository = temp.path().join("first-repository");
        let candidate_repository = temp.path().join("candidate-repository");
        fs::create_dir(&first_repository).expect("create first repository");
        fs::create_dir(&candidate_repository).expect("create candidate repository");
        let first_script = temp.path().join("first-sidecar.mjs");
        let failing_script = temp.path().join("failing-rebuild-sidecar.mjs");
        let retry_script = temp.path().join("retry-rebuild-sidecar.mjs");
        fs::write(
            &first_script,
            fixture_sidecar_source(first_repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write first fixture");
        fs::write(
            &failing_script,
            rebuild_fixture_sidecar_source(
                candidate_repository.to_str().expect("UTF-8 path"),
                "failed",
                "success",
                None,
            ),
        )
        .expect("write failing rebuild fixture");
        fs::write(
            &retry_script,
            rebuild_fixture_sidecar_source(
                candidate_repository.to_str().expect("UTF-8 path"),
                "success",
                "success",
                None,
            ),
        )
        .expect("write retry rebuild fixture");

        let runtime = DesktopRuntime::default();
        runtime
            .open_repository_path_with_launch(
                first_repository,
                SidecarLaunch::Development {
                    entry: first_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open current repository");

        let failed = runtime.open_repository_path_with_lifecycle(
            candidate_repository.clone(),
            SidecarLaunch::Development {
                entry: failing_script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Rebuild,
        );
        assert!(matches!(
            failed,
            Err(DesktopRuntimeError::SidecarRejected { code, .. })
                if code == "repository_rebuild_failed"
        ));
        assert_eq!(
            runtime
                .connection()
                .expect("failed rebuild preserves current session")
                .endpoint,
            "http://127.0.0.1:4312"
        );

        let retried = runtime.open_repository_path_with_lifecycle(
            candidate_repository,
            SidecarLaunch::Development {
                entry: retry_script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Rebuild,
        );
        assert!(matches!(retried, Ok(OpenExternalRepositoryResult::Opened)));
        runtime.shutdown().expect("shutdown retried session");
    }

    #[test]
    fn successful_rebuild_followed_by_session_failure_does_not_retry_rebuild() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("managed-repository");
        let rebuild_marker = temp.path().join("rebuild-marker");
        fs::create_dir(&repository).expect("create repository");
        let failing_script = temp.path().join("rebuild-session-failure.mjs");
        let retry_script = temp.path().join("rebuild-session-retry.mjs");
        fs::write(
            &failing_script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 path"),
                "success",
                "failed",
                Some(rebuild_marker.as_path()),
            ),
        )
        .expect("write session failure fixture");
        fs::write(
            &retry_script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 path"),
                "success",
                "success",
                Some(rebuild_marker.as_path()),
            ),
        )
        .expect("write retry fixture");

        let runtime = DesktopRuntime::default();
        let failed = runtime.open_repository_path_with_lifecycle(
            repository.clone(),
            SidecarLaunch::Development {
                entry: failing_script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Rebuild,
        );
        assert!(matches!(
            failed,
            Err(DesktopRuntimeError::SidecarRejected { code, .. })
                if code == "session_open_failed"
        ));
        assert_eq!(
            fs::read_to_string(&rebuild_marker).expect("rebuild marker"),
            "rebuilt\n"
        );

        let retried = runtime.open_repository_path_with_lifecycle(
            repository,
            SidecarLaunch::Development {
                entry: retry_script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Managed,
            RepositoryOpenIntent::Rebuild,
        );
        assert!(matches!(retried, Ok(OpenExternalRepositoryResult::Opened)));
        assert_eq!(
            fs::read_to_string(&rebuild_marker).expect("rebuild marker after retry"),
            "rebuilt\n"
        );
        runtime.shutdown().expect("shutdown retried session");
    }

    #[test]
    fn archived_rebuild_required_repository_is_refused_before_rebuild() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("archive");
        fs::create_dir(&repository).expect("create archive");
        let script = temp.path().join("archive-rebuild-sidecar.mjs");
        fs::write(
            &script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 repository path"),
                "unexpected",
                "success",
                None,
            ),
        )
        .expect("write archive fixture");

        let runtime = DesktopRuntime::default();
        let result = runtime.open_repository_path_with_lifecycle(
            repository,
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
            RepositoryLifecycle::Archived,
            RepositoryOpenIntent::Rebuild,
        );

        assert!(matches!(
            result,
            Ok(OpenExternalRepositoryResult::RequiresAction {
                action: super::RepositoryRequiredAction::RebuildReadModel,
                status: super::RepositoryStatus::RebuildRequired,
            })
        ));
        assert!(matches!(
            runtime.connection(),
            Err(DesktopRuntimeError::NoOpenSession)
        ));
    }

    #[test]
    fn external_rebuild_required_repository_is_refused_before_rebuild() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("external-repository");
        fs::create_dir(&repository).expect("create external repository");
        let script = temp.path().join("external-rebuild-sidecar.mjs");
        fs::write(
            &script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 repository path"),
                "unexpected",
                "success",
                None,
            ),
        )
        .expect("write external fixture");

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
            Ok(OpenExternalRepositoryResult::RequiresAction {
                action: super::RepositoryRequiredAction::RebuildReadModel,
                status: super::RepositoryStatus::RebuildRequired,
            })
        ));
        assert!(matches!(
            runtime.connection(),
            Err(DesktopRuntimeError::NoOpenSession)
        ));
    }

    #[test]
    fn newer_incompatible_repository_is_refused_without_rebuild() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("newer-repository");
        fs::create_dir(&repository).expect("create newer repository");
        let script = temp.path().join("newer-sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 repository path"), "newer"),
        )
        .expect("write newer fixture");

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
            Ok(OpenExternalRepositoryResult::RequiresAction {
                action: super::RepositoryRequiredAction::UseNewerApp,
                status: super::RepositoryStatus::NewerIncompatible,
            })
        ));
        assert!(matches!(
            runtime.connection(),
            Err(DesktopRuntimeError::NoOpenSession)
        ));
    }

    #[test]
    fn rebuild_blocks_repository_switch_and_normal_exit_until_it_finishes() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("managed-repository");
        let replacement = temp.path().join("replacement-repository");
        let marker = temp.path().join("rebuild-lifecycle-marker");
        fs::create_dir(&repository).expect("create repository");
        fs::create_dir(&replacement).expect("create replacement");
        let rebuild_script = temp.path().join("blocked-rebuild-sidecar.mjs");
        let replacement_script = temp.path().join("replacement-sidecar.mjs");
        fs::write(
            &rebuild_script,
            rebuild_fixture_sidecar_source(
                repository.to_str().expect("UTF-8 repository path"),
                "blocked",
                "success",
                Some(marker.as_path()),
            ),
        )
        .expect("write blocked rebuild fixture");
        fs::write(
            &replacement_script,
            fixture_sidecar_source(
                replacement.to_str().expect("UTF-8 replacement path"),
                "ready",
            ),
        )
        .expect("write replacement fixture");

        let workflow = DesktopRuntime::default();
        thread::scope(|scope| {
            let rebuild = scope.spawn(|| {
                workflow.open_repository_path_with_lifecycle(
                    repository,
                    SidecarLaunch::Development {
                        entry: rebuild_script,
                        node: PathBuf::from("node"),
                    },
                    RepositoryLifecycle::Managed,
                    RepositoryOpenIntent::Rebuild,
                )
            });

            for _ in 0..50 {
                if fs::read_to_string(&marker).is_ok_and(|contents| contents == "entered") {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(
                fs::read_to_string(&marker).expect("rebuild entered marker"),
                "entered"
            );

            let replacement_result = workflow.open_repository_path_with_launch(
                replacement,
                SidecarLaunch::Development {
                    entry: replacement_script,
                    node: PathBuf::from("node"),
                },
            );
            assert!(matches!(
                replacement_result,
                Ok(OpenExternalRepositoryResult::Busy)
            ));
            assert!(matches!(
                workflow.close_requires_confirmation(),
                Err(DesktopRuntimeError::Busy)
            ));
            let menu = workflow.repository_menu_state();
            assert!(!menu.close_enabled);
            assert!(!menu.open_external_enabled);

            fs::write(&marker, "release").expect("release blocked rebuild");
            assert!(matches!(
                rebuild.join().expect("join rebuild"),
                Ok(OpenExternalRepositoryResult::Opened)
            ));
        });
        workflow.shutdown().expect("shutdown rebuilt session");
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
        let menu = runtime.repository_menu_state();
        assert!(!menu.close_enabled);
        assert!(!menu.open_external_enabled);
        assert!(!menu.start_watching_enabled);
        assert!(!menu.stop_watching_enabled);
        assert!(matches!(
            runtime.close_requires_confirmation(),
            Err(DesktopRuntimeError::BlockedByMutation)
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
    fn pending_migration_blocks_repository_switch_and_normal_exit() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).expect("create repository");
        let script = temp.path().join("sidecar.mjs");
        fs::write(
            &script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 path"), "ready"),
        )
        .expect("write sidecar fixture");

        let workflow = DesktopRuntime::default();
        let pending_sidecar = SidecarSupervisor::spawn(SidecarLaunch::Development {
            entry: script,
            node: PathBuf::from("node"),
        })
        .expect("start migration sidecar");
        {
            let mut state = workflow.state.lock().expect("lock workflow state");
            state.pending_migration = Some(PendingRepositoryMigration {
                sidecar: pending_sidecar,
            });
        }

        let result = workflow.open_repository_path_with_launch(
            temp.path().join("another-repository"),
            SidecarLaunch::Development {
                entry: temp.path().join("unused-sidecar.mjs"),
                node: PathBuf::from("node"),
            },
        );
        assert!(matches!(result, Ok(OpenExternalRepositoryResult::Busy)));
        assert!(matches!(
            workflow.close_requires_confirmation(),
            Err(DesktopRuntimeError::BlockedByMutation)
        ));
        let menu = workflow.repository_menu_state();
        assert!(!menu.close_enabled);
        assert!(!menu.open_external_enabled);

        let pending = workflow
            .state
            .lock()
            .expect("lock workflow state")
            .pending_migration
            .is_some();
        assert!(pending);
        let pending = {
            let mut state = workflow.state.lock().expect("lock workflow state");
            state.pending_migration.take().expect("pending migration")
        };
        let mut sidecar = pending.sidecar;
        sidecar.shutdown_without_session();
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
                RepositoryOpenIntent::Open,
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
    fn failed_candidate_open_preserves_the_current_session() {
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
            fixture_sidecar_source(
                first_repository.to_str().expect("UTF-8 first repository"),
                "ready",
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
            Err(DesktopRuntimeError::SidecarRejected { code, .. })
                if code == "session_open_failed"
        ));
        assert_eq!(
            fs::read_to_string(candidate_shutdown).expect("candidate shutdown marker"),
            "shutdown"
        );
        assert_eq!(
            runtime
                .connection()
                .expect("current session remains active")
                .endpoint,
            "http://127.0.0.1:4312"
        );
        runtime.shutdown().expect("shutdown current session");
    }

    #[test]
    fn managed_initialization_preflight_does_not_create_a_managed_root() {
        let temp = TestDirectory::new();
        let managed_root = temp.path().join("repositories");
        let runtime = DesktopRuntime::default();
        let result = runtime.initialize_managed_repository_with_launch(
            temp.path().join("missing-save.dat"),
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            test_initialization_time(),
        );

        assert!(matches!(
            result,
            Ok(ManagedInitializationResult::Failed { phase, residual_path: None, .. })
                if phase == "preflight"
        ));
        assert!(!managed_root.exists());
    }

    #[test]
    fn managed_initialization_resets_transition_after_an_invalid_managed_root() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"encoded-save").expect("write save fixture");
        let invalid_root = temp.path().join("repositories");
        fs::write(&invalid_root, b"not a directory").expect("create invalid managed root");
        let runtime = DesktopRuntime::default();

        let result = runtime.initialize_managed_repository_with_launch(
            save_path.clone(),
            invalid_root,
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            test_initialization_time(),
        );
        assert!(matches!(result, Err(DesktopRuntimeError::InvalidDirectory)));

        let result = runtime.initialize_managed_repository_with_launch(
            save_path,
            temp.path().join("valid-repositories"),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            test_initialization_time(),
        );
        assert!(matches!(
            result,
            Ok(ManagedInitializationResult::Initialized)
        ));
        runtime.shutdown().expect("shutdown initialized workflow");
    }

    #[test]
    fn managed_initialization_reports_decode_failure_before_claiming_a_directory() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"not-a-save").expect("write save fixture");
        let managed_root = temp.path().join("repositories");
        let runtime = DesktopRuntime::default();
        let result = runtime.initialize_managed_repository_with_launch(
            save_path,
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "decode",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            test_initialization_time(),
        );

        assert!(matches!(
            result,
            Ok(ManagedInitializationResult::Failed { phase, residual_path: None, .. })
                if phase == "preflight"
        ));
        assert!(!managed_root.exists());
    }

    #[test]
    fn managed_initialization_succeeds_through_session_and_watcher_start() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"encoded-save").expect("write save fixture");
        let managed_root = temp.path().join("repositories");
        let timestamp = test_initialization_time();
        let runtime = DesktopRuntime::default();
        let result = runtime.initialize_managed_repository_with_launch(
            save_path.clone(),
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            timestamp,
        );

        assert!(matches!(
            result,
            Ok(ManagedInitializationResult::Initialized)
        ));
        let expected_name = managed_repository_name(&save_path, timestamp);
        assert!(managed_root.join(&expected_name).is_dir());
        assert!(
            runtime
                .close_requires_confirmation()
                .expect("watcher state")
        );
        runtime.shutdown().expect("shutdown initialized workflow");
    }

    #[test]
    fn managed_initialization_rolls_back_repository_and_baseline_failures() {
        for (failure, expected_phase) in [("repository", "repository"), ("baseline", "baseline")] {
            let temp = TestDirectory::new();
            let save_path = temp.path().join("slot.dat");
            fs::write(&save_path, b"encoded-save").expect("write save fixture");
            let managed_root = temp.path().join("repositories");
            let runtime = DesktopRuntime::default();
            let result = runtime.initialize_managed_repository_with_launch(
                save_path,
                managed_root.clone(),
                managed_initialization_fixture_launch(
                    temp.path(),
                    "loaded",
                    failure,
                    "success",
                    "success",
                    "success",
                    None,
                ),
                test_initialization_time(),
            );

            assert!(matches!(
                result,
                Ok(ManagedInitializationResult::Failed { phase, residual_path: None, .. })
                    if phase == expected_phase
            ));
            assert!(managed_root.is_dir());
            assert_eq!(
                fs::read_dir(&managed_root)
                    .expect("read managed root")
                    .count(),
                0
            );
        }
    }

    #[test]
    fn managed_initialization_uses_timestamped_collision_safe_names() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"encoded-save").expect("write save fixture");
        let managed_root = temp.path().join("repositories");
        fs::create_dir_all(&managed_root).expect("create managed root");
        let timestamp = test_initialization_time();
        let base_name = managed_repository_name(&save_path, timestamp);
        let base_path = managed_root.join(&base_name);
        fs::create_dir(&base_path).expect("create timestamp collision");
        fs::write(base_path.join("keep"), b"keep").expect("write collision marker");

        let first = DesktopRuntime::default();
        let first_result = first.initialize_managed_repository_with_launch(
            save_path.clone(),
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            timestamp,
        );
        assert!(matches!(
            first_result,
            Ok(ManagedInitializationResult::Initialized)
        ));
        first
            .shutdown()
            .expect("shutdown first initialized workflow");
        assert!(managed_root.join(format!("{base_name}-1")).is_dir());
        assert_eq!(
            fs::read(base_path.join("keep")).expect("collision survives"),
            b"keep"
        );

        let second = DesktopRuntime::default();
        let second_result = second.initialize_managed_repository_with_launch(
            save_path,
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                None,
            ),
            timestamp,
        );
        assert!(matches!(
            second_result,
            Ok(ManagedInitializationResult::Initialized)
        ));
        second
            .shutdown()
            .expect("shutdown second initialized workflow");
        assert!(managed_root.join(format!("{base_name}-2")).is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn managed_initialization_detects_duplicate_watched_save_through_symlink_and_respects_case() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::symlink;

        let temp = TestDirectory::new();
        let actual_save = temp.path().join("Actual-Save.dat");
        let selected_save = temp.path().join("selected-save.dat");
        fs::write(&actual_save, b"encoded-save").expect("write actual save");
        symlink(&actual_save, &selected_save).expect("create selected save symlink");
        let managed_root = temp.path().join("repositories");
        let existing = managed_root.join("existing-repository");
        fs::create_dir_all(&existing).expect("create existing repository");
        let canonical_save = fs::canonicalize(&actual_save).expect("canonical save");
        let runtime = DesktopRuntime::default();
        let duplicate = runtime.initialize_managed_repository_with_launch(
            selected_save,
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                Some(&canonical_save),
            ),
            test_initialization_time(),
        );
        assert!(matches!(
            duplicate,
            Ok(ManagedInitializationResult::ExistingRepository { name })
                if name == "existing-repository"
        ));
        assert_eq!(
            fs::read_dir(&managed_root)
                .expect("read managed root")
                .count(),
            1
        );

        let case_variant = temp.path().join("actual-save.dat");
        fs::write(&case_variant, b"encoded-save").expect("write case variant save");
        let actual_identity = fs::metadata(&actual_save).expect("stat actual save");
        let case_variant_identity = fs::metadata(&case_variant).expect("stat case variant save");
        let same_file = actual_identity.dev() == case_variant_identity.dev()
            && actual_identity.ino() == case_variant_identity.ino();
        let initialized_runtime = DesktopRuntime::default();
        let initialized = initialized_runtime.initialize_managed_repository_with_launch(
            case_variant,
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "success",
                "success",
                "success",
                "success",
                Some(&canonical_save),
            ),
            test_initialization_time(),
        );
        if same_file {
            assert!(matches!(
                initialized,
                Ok(ManagedInitializationResult::ExistingRepository { name })
                    if name == "existing-repository"
            ));
        } else {
            assert!(matches!(
                initialized,
                Ok(ManagedInitializationResult::Initialized)
            ));
            initialized_runtime
                .shutdown()
                .expect("shutdown case variant workflow");
        }
    }

    #[test]
    fn managed_initialization_reports_session_and_watcher_failures_after_bounded_rollback() {
        for (expected_phase, session, watcher) in [
            ("session", "failed", "success"),
            ("watching", "success", "failed"),
        ] {
            let temp = TestDirectory::new();
            let save_path = temp.path().join("slot.dat");
            fs::write(&save_path, b"encoded-save").expect("write save fixture");
            let managed_root = temp.path().join("repositories");
            let runtime = DesktopRuntime::default();
            let result = runtime.initialize_managed_repository_with_launch(
                save_path,
                managed_root.clone(),
                managed_initialization_fixture_launch(
                    temp.path(),
                    "loaded",
                    "success",
                    session,
                    watcher,
                    "success",
                    None,
                ),
                test_initialization_time(),
            );

            assert!(matches!(
                result,
                Ok(ManagedInitializationResult::Failed { phase, residual_path: None, .. })
                    if phase == expected_phase
            ));
            assert_eq!(
                fs::read_dir(&managed_root)
                    .expect("read managed root")
                    .count(),
                0
            );
        }
    }

    #[test]
    fn managed_initialization_rollback_never_removes_a_preexisting_collision() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"encoded-save").expect("write save fixture");
        let managed_root = temp.path().join("repositories");
        fs::create_dir_all(&managed_root).expect("create managed root");
        let base_name = managed_repository_name(&save_path, test_initialization_time());
        let existing = managed_root.join(&base_name);
        fs::create_dir(&existing).expect("create preexisting collision");
        fs::write(existing.join("keep"), b"keep").expect("write collision marker");

        let result = DesktopRuntime::default().initialize_managed_repository_with_launch(
            save_path,
            managed_root.clone(),
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "baseline",
                "success",
                "success",
                "success",
                None,
            ),
            test_initialization_time(),
        );

        assert!(
            matches!(result, Ok(ManagedInitializationResult::Failed { phase, .. }) if phase == "baseline")
        );
        assert_eq!(
            fs::read(existing.join("keep")).expect("collision survives"),
            b"keep"
        );
        assert_eq!(
            fs::read_dir(&managed_root)
                .expect("read managed root")
                .count(),
            1
        );
    }

    #[test]
    fn managed_initialization_reports_residual_path_when_cleanup_fails() {
        let temp = TestDirectory::new();
        let save_path = temp.path().join("slot.dat");
        fs::write(&save_path, b"encoded-save").expect("write save fixture");
        let managed_root = temp.path().join("repositories");
        let timestamp = test_initialization_time();
        let expected_path = managed_root.join(managed_repository_name(&save_path, timestamp));

        let result = DesktopRuntime::default().initialize_managed_repository_with_launch(
            save_path,
            managed_root,
            managed_initialization_fixture_launch(
                temp.path(),
                "loaded",
                "baseline",
                "success",
                "success",
                "failed",
                None,
            ),
            timestamp,
        );

        assert!(matches!(
            result,
            Ok(ManagedInitializationResult::Failed { phase, residual_path: Some(path), .. })
                if phase == "baseline" && path == expected_path.to_string_lossy()
        ));
        assert!(expected_path.is_dir());
    }

    fn test_initialization_time() -> chrono::DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 60 * 60)
            .expect("offset")
            .with_ymd_and_hms(2026, 8, 3, 14, 5, 6)
            .single()
            .expect("timestamp")
            .with_nanosecond(123_000_000)
            .expect("milliseconds")
    }

    fn managed_initialization_fixture_launch(
        temp: &Path,
        inspection: &str,
        initialization: &str,
        session: &str,
        watcher: &str,
        shutdown: &str,
        duplicate_save_path: Option<&Path>,
    ) -> SidecarLaunch {
        let script = temp.join(format!(
            "managed-initialization-sidecar-{}.mjs",
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let duplicate_save_path = duplicate_save_path
            .map(|path| path.to_str().expect("fixture paths are UTF-8").to_owned());
        fs::write(
            &script,
            managed_initialization_fixture_sidecar_source(
                inspection,
                initialization,
                session,
                watcher,
                shutdown,
                duplicate_save_path.as_deref(),
            ),
        )
        .expect("write managed initialization fixture");
        SidecarLaunch::Development {
            entry: script,
            node: PathBuf::from("node"),
        }
    }

    fn managed_initialization_fixture_sidecar_source(
        inspection: &str,
        initialization: &str,
        session: &str,
        watcher: &str,
        shutdown: &str,
        duplicate_save_path: Option<&str>,
    ) -> String {
        let duplicate_save_path =
            serde_json::to_string(&duplicate_save_path).expect("serialize duplicate save path");
        format!(
            r#"
const inspection = {inspection:?};
const initialization = {initialization:?};
const session = {session:?};
const watcher = {watcher:?};
const shutdown = {shutdown:?};
const duplicateSavePath = {duplicate_save_path};

function write(message) {{
  process.stdout.write(JSON.stringify(message) + "\n");
}}
function response(requestId, result) {{
  write({{ protocolVersion: 6, kind: "response", requestId, ok: true, result }});
}}
function failure(requestId, code, message) {{
  write({{ protocolVersion: 6, kind: "response", requestId, ok: false, error: {{ code, message }} }});
}}

write({{ protocolVersion: 6, kind: "event", event: {{ type: "process.ready" }} }});
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const type = request.command.type;

    if (type === "save.inspect") {{
      response(request.requestId, inspection === "loaded"
        ? {{ type: "save.inspected", decodedSave: {{ player: "Hornet" }} }}
        : {{ type: inspection === "invalid" ? "save.invalidFile" : "save.decodeFailed" }});
      continue;
    }}
    if (type === "repository.compareWatchedSave") {{
      response(request.requestId, {{
        type: "repository.watchedSaveCompared",
        same: duplicateSavePath !== null && request.command.savePath === duplicateSavePath,
      }});
      continue;
    }}
    if (type === "repository.initialize") {{
      if (initialization === "repository") {{
        response(request.requestId, {{ type: "repository.initializationResult", initialization: {{ status: "failed", phase: "repository", reason: "historyFailed" }} }});
      }} else if (initialization === "baseline") {{
        response(request.requestId, {{ type: "repository.initializationResult", initialization: {{ status: "failed", phase: "baseline", reason: "observationFailed" }} }});
      }} else {{
        response(request.requestId, {{ type: "repository.initializationResult", initialization: {{ status: "initialized" }} }});
      }}
      continue;
    }}
    if (type === "session.open") {{
      if (session === "failed") {{
        failure(request.requestId, "session_open_failed", "fixture session open failed");
      }} else {{
        response(request.requestId, {{ type: "session.opened", access: request.command.access, connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }});
      }}
      continue;
    }}
    if (type === "watcher.start") {{
      if (watcher === "failed") {{
        failure(request.requestId, "watcher_start_failed", "fixture watcher start failed");
      }} else {{
        response(request.requestId, {{ type: "watcher.started" }});
      }}
      continue;
    }}
    if (type === "watcher.stop") {{
      response(request.requestId, {{ type: "watcher.stopped" }});
      continue;
    }}
    if (type === "process.shutdown") {{
      if (shutdown === "failed") {{
        failure(request.requestId, "shutdown_failed", "fixture shutdown failed");
        process.exit(1);
      }} else {{
        response(request.requestId, {{ type: "process.shutdownComplete" }});
        process.exit(0);
      }}
    }}
    failure(request.requestId, "unknown_command", "fixture command was unexpected");
  }}
}});
"#,
            inspection = inspection,
            initialization = initialization,
            session = session,
            watcher = watcher,
            shutdown = shutdown,
            duplicate_save_path = duplicate_save_path,
        )
    }

    fn rebuild_fixture_sidecar_source(
        repository: &str,
        rebuild: &str,
        session: &str,
        marker: Option<&Path>,
    ) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        let marker = serde_json::to_string(
            &marker.map(|path| path.to_str().expect("fixture paths are UTF-8")),
        )
        .expect("serialize rebuild marker path");
        format!(
            r#"
import fs from "node:fs";
const repository = {repository};
const rebuild = {rebuild:?};
const session = {session:?};
const marker = {marker};
let repositoryStatus = marker !== null && fs.existsSync(marker) ? "ready" : "rebuildRequired";

function write(message) {{
  process.stdout.write(JSON.stringify(message) + "\n");
}}
function response(requestId, result) {{
  write({{ protocolVersion: 6, kind: "response", requestId, ok: true, result }});
}}
function failure(requestId, code, message) {{
  write({{ protocolVersion: 6, kind: "response", requestId, ok: false, error: {{ code, message }} }});
}}
function mutation(status) {{
  write({{ protocolVersion: 6, kind: "event", event: {{ type: "mutation.activity", mutation: "repositoryRebuild", status }} }});
}}
function inspection() {{
  const ready = repositoryStatus === "ready";
  return {{
    status: ready ? "ready" : "rebuildRequired",
    requiredAction: ready ? "open" : "rebuildReadModel",
    capabilities: ready ? ["read"] : ["read", "rebuildReadModel"],
  }};
}}

write({{ protocolVersion: 6, kind: "event", event: {{ type: "process.ready" }} }});
let buffer = "";
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const type = request.command.type;

    if (type === "repository.inspect") {{
      if (request.command.repoPath !== repository) throw new Error("wrong repository path");
      response(request.requestId, {{ type: "repository.inspected", inspection: inspection() }});
      continue;
    }}
    if (type === "repository.rebuild") {{
      if (rebuild === "unexpected") throw new Error("rebuild should not have been requested");
      if (rebuild === "blocked") {{
        if (marker === null) throw new Error("blocked rebuild needs a marker");
        fs.writeFileSync(marker, "entered");
        while (fs.readFileSync(marker, "utf8") !== "release") {{}}
        repositoryStatus = "ready";
        response(request.requestId, {{
          type: "repository.rebuilt",
          rebuild: {{ observationCount: 0, recognizedObservationCount: 0, unrecognizedObservationCount: 0, snapshotCount: 0, eventCount: 0 }},
          repository: {{ status: "ready", requiredAction: "open", capabilities: ["read"] }},
        }});
      }} else if (rebuild === "success") {{
        repositoryStatus = "ready";
        if (marker !== null) fs.appendFileSync(marker, "rebuilt\n");
        response(request.requestId, {{
          type: "repository.rebuilt",
          rebuild: {{ observationCount: 0, recognizedObservationCount: 0, unrecognizedObservationCount: 0, snapshotCount: 0, eventCount: 0 }},
          repository: {{ status: "ready", requiredAction: "open", capabilities: ["read"] }},
        }});
      }} else {{
        failure(request.requestId, "repository_rebuild_failed", "fixture rebuild failed");
      }}
      mutation("started");
      mutation("finished");
      continue;
    }}
    if (type === "session.open") {{
      if (session === "failed") {{
        failure(request.requestId, "session_open_failed", "fixture session open failed");
      }} else {{
        response(request.requestId, {{ type: "session.opened", access: request.command.access, connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }});
      }}
      continue;
    }}
    if (type === "watcher.start") {{
      response(request.requestId, {{ type: "watcher.started" }});
      continue;
    }}
    if (type === "watcher.stop") {{
      response(request.requestId, {{ type: "watcher.stopped" }});
      continue;
    }}
    if (type === "process.shutdown") {{
      response(request.requestId, {{ type: "process.shutdownComplete" }});
      process.exit(0);
    }}
    failure(request.requestId, "unknown_command", "fixture command was unexpected");
  }}
}});
"#,
            repository = repository,
            rebuild = rebuild,
            session = session,
            marker = marker,
        )
    }

    fn fixture_sidecar_source(repository: &str, status: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        let inspection = if status == "ready" || status == "mutation" {
            r#"{ status: "ready", requiredAction: "open", capabilities: ["read"] }"#
        } else if status == "newer" {
            r#"{ status: "newerIncompatible", requiredAction: "useNewerApp", capabilities: [] }"#
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
process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
      process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }} else {{
      result = {{ type: request.command.type === "watcher.start" ? "watcher.started" : "watcher.stopped" }};
    }}
    process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
    if (request.command.type === "session.open" && {status:?} === "mutation") {{
      process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "event", event: {{ type: "mutation.activity", mutation: "manualCheckpoint", status: "started" }} }}) + "\n");
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
process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
  process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
  if (request.command.type === "session.open") process.exit(1);
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
process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
      process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      continue;
    }}
    if (request.command.type === "session.open") {{
      const error = {{
        protocolVersion: 6,
        kind: "response",
        requestId: request.requestId,
        ok: false,
        error: {{
          code: "session_open_failed",
          message: "candidate session failed to open",
        }},
      }};
      process.stdout.write(JSON.stringify(error) + "\n");
      continue;
    }}
    if (request.command.type === "process.shutdown") {{
      fs.writeFileSync(marker, "shutdown");
      const result = {{ type: "process.shutdownComplete" }};
      process.stdout.write(JSON.stringify({{ protocolVersion: 6, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
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
