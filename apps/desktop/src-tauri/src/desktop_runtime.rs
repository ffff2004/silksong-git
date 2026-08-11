use std::{
    env,
    fmt::{Display, Formatter},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
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

const DESKTOP_SIDECAR_PROTOCOL_VERSION: u8 = 11;
const DEVELOPMENT_SIDECAR_ENTRY: &str = "apps/desktop-sidecar/dist/main.js";
const BUNDLED_SIDECAR_NAME: &str = "silksong-git-desktop-sidecar";
const REPLACEMENT_CONFIRMATION: &str = "archive-and-reinitialize-managed-repository";
const REPOSITORY_WATCHED_SAVE_COMPARE_FAILED: &str = "repository_watched_save_compare_failed";
static REPLACEMENT_OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The high-level Desktop session and lifecycle owner.
pub struct DesktopWorkflow {
    state: Mutex<DesktopWorkflowState>,
    archive_clock: Box<dyn ArchiveClock>,
    #[cfg(test)]
    replacement_test_input: Mutex<Option<TestReplacementInput>>,
}

#[cfg(test)]
struct TestReplacementInput {
    selected_path: PathBuf,
    launch: SidecarLaunch,
    initialized_at: chrono::DateTime<chrono::FixedOffset>,
}

trait ArchiveClock: Send + Sync {
    fn now(&self) -> chrono::DateTime<chrono::FixedOffset>;
}

struct SystemArchiveClock;

impl ArchiveClock for SystemArchiveClock {
    fn now(&self) -> chrono::DateTime<chrono::FixedOffset> {
        Local::now().fixed_offset()
    }
}

impl Default for DesktopWorkflow {
    fn default() -> Self {
        Self {
            state: Mutex::new(DesktopWorkflowState::default()),
            archive_clock: Box::new(SystemArchiveClock),
            #[cfg(test)]
            replacement_test_input: Mutex::new(None),
        }
    }
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRepositoryInput {
    pub lifecycle: RepositoryLifecycle,
    pub name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRepositoryReplacementInput {
    pub confirmation: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArchiveRepositoryResult {
    Archived {
        name: String,
    },
    Failed {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Busy,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManagedRepositoryReplacementResult {
    Cancelled,
    Succeeded {
        #[serde(rename = "managedPath")]
        managed_path: String,
        #[serde(rename = "archivePath")]
        archive_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "cleanupWarning")]
        cleanup_warning: Option<String>,
    },
    Failed {
        phase: String,
        reason: String,
        message: String,
        rollback: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "managedPath")]
        managed_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "archivePath")]
        archive_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "replacementResidualPath")]
        replacement_residual_path: Option<String>,
    },
    BlockedByMutation,
    Busy,
}

#[derive(Clone, Deserialize, Serialize)]
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

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportRepositoryResult {
    Cancelled,
    Imported {
        name: String,
        source_status: String,
        status: String,
        required_action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
    },
    Rejected {
        reason: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
    },
    Failed {
        phase: String,
        reason: String,
        message: String,
        source_state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        residual_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_failure: Option<String>,
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

    pub(crate) fn import_repository<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<ImportRepositoryResult, DesktopRuntimeError> {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("Import external Save History Repository")
            .blocking_pick_folder()
        else {
            return Ok(ImportRepositoryResult::Cancelled);
        };
        let selected_path = selected
            .into_path()
            .map_err(|_| DesktopRuntimeError::InvalidDirectory);
        let selected_path = match selected_path {
            Ok(path) => path,
            Err(error) => {
                return Ok(import_failure(
                    "preflight",
                    "invalidPath",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let managed_root_path = match managed_root(app, RepositoryLifecycle::Managed) {
            Ok(root) => root,
            Err(error) => {
                return Ok(import_failure(
                    "placement",
                    "managedRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let archives_root = match managed_root(app, RepositoryLifecycle::Archived) {
            Ok(root) => root,
            Err(error) => {
                return Ok(import_failure(
                    "placement",
                    "archivesRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let staging_root = match staging_root(app) {
            Ok(root) => root,
            Err(error) => {
                return Ok(import_failure(
                    "placement",
                    "stagingRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let launch = match SidecarLaunch::for_app(app) {
            Ok(launch) => launch,
            Err(error) => {
                return Ok(import_failure(
                    "spawn",
                    "sidecarUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        self.import_repository_at(
            selected_path,
            managed_root_path,
            archives_root,
            staging_root,
            launch,
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

    fn import_repository_at(
        &self,
        selected_path: PathBuf,
        managed_root: PathBuf,
        archives_root: PathBuf,
        staging_root: PathBuf,
        launch: SidecarLaunch,
        imported_at: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<ImportRepositoryResult, DesktopRuntimeError> {
        {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    return Ok(import_failure(
                        "state",
                        "unavailable",
                        "Desktop Local History is temporarily unavailable.",
                        None,
                    ));
                }
            };
            if state.transitioning || state.pending_migration.is_some() {
                return Ok(import_failure(
                    "session",
                    "busy",
                    "Desktop Local History is already changing sessions.",
                    None,
                ));
            }
            if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok() && session.sidecar.mutation_active()
            }) {
                return Ok(import_failure(
                    "mutation",
                    "mutationActive",
                    "Wait for the active Desktop mutation to finish before importing a repository.",
                    None,
                ));
            }
            if state
                .current_session
                .as_ref()
                .is_some_and(|session| session.lifecycle == RepositoryLifecycle::External)
            {
                return Ok(ImportRepositoryResult::Rejected {
                    reason: "externalSession".into(),
                    message:
                        "Close the current external repository before importing another repository."
                            .into(),
                    status: None,
                    cleanup_failure: None,
                });
            }
            state.transitioning = true;
        }

        let source_path = match canonicalize_import_source(&selected_path) {
            Ok(path) => path,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Ok(import_rejected("invalidPlacement", error.user_message()));
            }
        };
        let managed_root = match ensure_managed_root(&managed_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Ok(import_failure(
                    "placement",
                    "managedRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let archives_root = match existing_managed_root(&archives_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Ok(import_failure(
                    "placement",
                    "archivesRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let staging_root = match ensure_managed_root(&staging_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Ok(import_failure(
                    "placement",
                    "stagingRootUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        if path_is_within(&managed_root, &source_path)
            || archives_root
                .as_ref()
                .is_some_and(|root| path_is_within(root, &source_path))
        {
            self.finish_transition_preserving_session();
            return Ok(import_rejected(
                "invalidPlacement",
                "Choose a repository outside the App-managed repositories and archives.".into(),
            ));
        }

        let mut candidate = match SidecarSupervisor::spawn(launch) {
            Ok(candidate) => candidate,
            Err(error) => {
                self.finish_transition_preserving_session();
                return Ok(import_failure(
                    "spawn",
                    "sidecarUnavailable",
                    &error.user_message(),
                    None,
                ));
            }
        };
        let source_protocol_path = match repository_path_for_protocol(&source_path) {
            Ok(path) => path,
            Err(error) => {
                return Ok(self.finish_import_candidate_failure(
                    candidate,
                    "preflight",
                    "invalidPath",
                    &error.user_message(),
                    None,
                    None,
                ));
            }
        };

        let inspection = match candidate
            .command(strict_repository_inspection_command(&source_protocol_path))
            .map_err(DesktopRuntimeError::from)
            .and_then(|response| parse_repository_inspection_details(&response))
        {
            Ok(inspection) => inspection,
            Err(error) => {
                return Ok(self.finish_import_candidate_failure(
                    candidate,
                    "inspection",
                    "inspectionFailed",
                    &error.user_message(),
                    None,
                    None,
                ));
            }
        };
        if !is_import_source_status(&inspection.status) {
            let result =
                import_inspection_rejection(&inspection.status, &inspection.required_action);
            self.finish_failed_candidate(candidate);
            return Ok(result);
        }

        let duplicate = match find_duplicate_managed_repository_by_repository(
            &managed_root,
            &source_path,
            &mut candidate,
        ) {
            Ok(duplicate) => duplicate,
            Err(error) => {
                return Ok(self.finish_import_candidate_failure(
                    candidate,
                    "duplicate",
                    "duplicateCheckFailed",
                    &error.user_message(),
                    None,
                    None,
                ));
            }
        };
        if let Some(name) = duplicate {
            self.finish_failed_candidate(candidate);
            return Ok(ImportRepositoryResult::Rejected {
                reason: "duplicateWatchedSave".into(),
                message: format!(
                    "This repository watches the same save as the managed repository {name}."
                ),
                status: None,
                cleanup_failure: None,
            });
        }

        let source_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("repository");
        let base_name = managed_repository_name(
            &PathBuf::from(source_name).with_extension("dat"),
            imported_at,
        );
        let target_path = match repository_path_for_protocol(&managed_root.join(base_name)) {
            Ok(path) => path,
            Err(error) => {
                return Ok(self.finish_import_candidate_failure(
                    candidate,
                    "preflight",
                    "invalidPath",
                    &error.user_message(),
                    None,
                    None,
                ));
            }
        };
        let imported = candidate.command(repository_import_command(
            &source_protocol_path,
            &target_path,
            &repository_path_for_protocol(&staging_root)?,
        ));
        let imported = match imported {
            Ok(response) => parse_repository_import_result(&response),
            Err(error) => Err(DesktopRuntimeError::from(error)),
        };
        let imported = match imported {
            Ok(imported) => imported,
            Err(error) => {
                return Ok(self.finish_import_candidate_failure(
                    candidate,
                    "command",
                    "importCommandFailed",
                    &error.user_message(),
                    None,
                    None,
                ));
            }
        };

        let result = match imported {
            ImportProtocolResult::Rejected {
                reason,
                status,
                cleanup_failure,
            } => {
                self.finish_failed_candidate(candidate);
                ImportRepositoryResult::Rejected {
                    message: import_reason_message(&reason),
                    reason,
                    status,
                    cleanup_failure,
                }
            }
            ImportProtocolResult::Failed {
                reason,
                message,
                retained_path,
                source_state,
                phase,
                cleanup_failure,
            } => {
                self.finish_failed_candidate(candidate);
                ImportRepositoryResult::Failed {
                    phase,
                    reason,
                    message,
                    source_state,
                    residual_path: retained_path,
                    cleanup_failure,
                }
            }
            ImportProtocolResult::Copied {
                repo_path,
                source_status,
                cleanup_failure,
            } => {
                let imported_path =
                    match validate_published_managed_child(&managed_root, Path::new(&repo_path)) {
                        Ok(path) => path,
                        Err(error) => {
                            return Ok(self.finish_import_candidate_failure(
                                candidate,
                                "publication",
                                "invalidPublishedPath",
                                &error.user_message(),
                                None,
                                cleanup_failure.clone(),
                            ));
                        }
                    };
                let imported_protocol_path = match repository_path_for_protocol(&imported_path) {
                    Ok(path) => path,
                    Err(error) => {
                        return Ok(self.finish_import_candidate_failure(
                            candidate,
                            "publication",
                            "invalidPublishedPath",
                            &error.user_message(),
                            Some(imported_path.to_string_lossy().into_owned()),
                            cleanup_failure.clone(),
                        ));
                    }
                };
                let inspection = candidate
                    .command(strict_repository_inspection_command(
                        &imported_protocol_path,
                    ))
                    .map_err(DesktopRuntimeError::from)
                    .and_then(|response| parse_repository_inspection_details(&response));
                let inspection = match inspection {
                    Ok(inspection) => inspection,
                    Err(error) => {
                        let residual_path = imported_path.to_string_lossy().into_owned();
                        return Ok(self.finish_import_candidate_failure(
                            candidate,
                            "status",
                            "postCopyInspectionFailed",
                            &error.user_message(),
                            Some(residual_path),
                            cleanup_failure.clone(),
                        ));
                    }
                };
                let name = match imported_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                {
                    Some(name) => name,
                    None => {
                        return Ok(self.finish_import_candidate_failure(
                            candidate,
                            "status",
                            "invalidPublishedPath",
                            "The imported repository has an invalid managed name.",
                            Some(imported_path.to_string_lossy().into_owned()),
                            cleanup_failure.clone(),
                        ));
                    }
                };
                let result = ImportRepositoryResult::Imported {
                    name,
                    source_status,
                    status: inspection.status,
                    required_action: inspection.required_action,
                    cleanup_failure: cleanup_failure.clone(),
                };
                if let Err(error) = candidate.shutdown() {
                    self.finish_transition_preserving_session();
                    return Ok(ImportRepositoryResult::Failed {
                        phase: "status".into(),
                        reason: "sidecarShutdownFailed".into(),
                        message: error.user_message(),
                        source_state: "unchanged".into(),
                        residual_path: Some(imported_path.to_string_lossy().into_owned()),
                        cleanup_failure,
                    });
                }
                self.finish_transition_preserving_session();
                return Ok(result);
            }
        };
        self.finish_transition_preserving_session();
        Ok(result)
    }

    pub(crate) fn archive_and_reinitialize_managed_repository<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        input: ManagedRepositoryReplacementInput,
    ) -> Result<ManagedRepositoryReplacementResult, DesktopRuntimeError> {
        #[cfg(test)]
        if let Some(test_input) = self
            .replacement_test_input
            .lock()
            .map_err(|_| DesktopRuntimeError::Unavailable)?
            .take()
        {
            return self.archive_and_reinitialize_managed_repository_at(
                test_input.selected_path,
                managed_root(app, RepositoryLifecycle::Managed)?,
                managed_root(app, RepositoryLifecycle::Archived)?,
                test_input.launch,
                test_input.initialized_at,
                input.confirmation,
            );
        }

        let Some(selected) = app
            .dialog()
            .file()
            .set_title("Archive and reinitialize managed Silksong save history")
            .add_filter("Silksong save", &["dat"])
            .set_directory(initial_directory(
                current_save_location_platform(),
                &EnvironmentSaveLocationSystem,
            ))
            .blocking_pick_file()
        else {
            return Ok(ManagedRepositoryReplacementResult::Cancelled);
        };
        let selected_path = selected
            .into_path()
            .map_err(|_| DesktopRuntimeError::InvalidSaveFile)?;
        self.archive_and_reinitialize_managed_repository_at(
            selected_path,
            managed_root(app, RepositoryLifecycle::Managed)?,
            managed_root(app, RepositoryLifecycle::Archived)?,
            SidecarLaunch::for_app(app)?,
            self.archive_clock.now(),
            input.confirmation,
        )
    }

    #[cfg(test)]
    fn configure_replacement_command(
        &self,
        selected_path: PathBuf,
        launch: SidecarLaunch,
        initialized_at: chrono::DateTime<chrono::FixedOffset>,
    ) {
        self.replacement_test_input
            .lock()
            .expect("replacement test input lock")
            .replace(TestReplacementInput {
                selected_path,
                launch,
                initialized_at,
            });
    }

    fn archive_and_reinitialize_managed_repository_at(
        &self,
        selected_path: PathBuf,
        managed_root: PathBuf,
        archives_root: PathBuf,
        launch: SidecarLaunch,
        initialized_at: chrono::DateTime<chrono::FixedOffset>,
        confirmation: String,
    ) -> Result<ManagedRepositoryReplacementResult, DesktopRuntimeError> {
        if confirmation != REPLACEMENT_CONFIRMATION {
            return Ok(ManagedRepositoryReplacementResult::Failed {
                phase: "confirmation".into(),
                reason: "confirmationRequired".into(),
                message: "Confirm archive-and-reinitialize before replacing this repository."
                    .into(),
                rollback: "notAttempted".into(),
                managed_path: None,
                archive_path: None,
                replacement_residual_path: None,
            });
        }

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                return Ok(ManagedRepositoryReplacementResult::Busy);
            }
            if state.current_session.as_mut().is_some_and(|session| {
                session.sidecar.poll().is_ok()
                    && (session.sidecar.mutation_active()
                        || (session.lifecycle == RepositoryLifecycle::External && session.watching))
            }) {
                return Ok(ManagedRepositoryReplacementResult::BlockedByMutation);
            }
            state.transitioning = true;
        }

        let selected_path = match canonicalize_readable_regular_file(&selected_path) {
            Ok(path) => path,
            Err(DesktopRuntimeError::InvalidSaveFile) => {
                self.finish_transition_preserving_session();
                return Ok(replacement_failure(
                    "preflight",
                    "invalidSave",
                    "Select an existing readable Encoded Save file.",
                    "notAttempted",
                    None,
                    None,
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
        let selected_protocol_path = match repository_path_for_protocol(&selected_path) {
            Ok(path) => path,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };

        let preflight = match candidate.command(json!({
            "type": "save.inspect",
            "savePath": selected_protocol_path,
        })) {
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
            return Ok(replacement_failure(
                "preflight",
                "invalidSave",
                "The selected file could not be decoded as an Encoded Save.",
                "notAttempted",
                None,
                None,
                None,
            ));
        }

        let managed_root = match existing_managed_root(&managed_root) {
            Ok(Some(root)) => root,
            Ok(None) => {
                self.finish_failed_candidate(candidate);
                return Ok(replacement_failure(
                    "source",
                    "sourceNotFound",
                    "No managed repository is configured for the selected save.",
                    "notAttempted",
                    None,
                    None,
                    None,
                ));
            }
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let source = match find_replacement_source(&managed_root, &selected_path, &mut candidate) {
            Ok(source) => source,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let source = match source {
            ReplacementSourceDiscovery::Found(source) => source,
            ReplacementSourceDiscovery::NotFound => {
                self.finish_failed_candidate(candidate);
                return Ok(replacement_failure(
                    "source",
                    "differentWatchedSave",
                    "No managed repository watches the selected save.",
                    "notAttempted",
                    None,
                    None,
                    None,
                ));
            }
        };
        let archives_root = match ensure_managed_root(&archives_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let replacement_root = match ensure_managed_root(&managed_root) {
            Ok(root) => root,
            Err(error) => {
                self.finish_failed_candidate(candidate);
                return Err(error);
            }
        };
        let replacement_name = managed_repository_name(&selected_path, initialized_at);
        let claimed = match claim_managed_repository_directory(&replacement_root, &replacement_name)
        {
            Ok(claimed) => claimed,
            Err(_) => {
                self.finish_failed_candidate(candidate);
                return Ok(replacement_failure(
                    "directoryClaim",
                    "claimFailed",
                    "The replacement repository directory could not be claimed safely.",
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    None,
                ));
            }
        };

        let mut previous = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            state.current_session.take()
        };
        if let Some(session) = previous.as_mut() {
            if session.watching {
                if send_watcher_command(session, "watcher.stop").is_err() {
                    let replacement_residual_path =
                        cleanup_replacement_claim(&replacement_root, &claimed);
                    let candidate_cleanup_error =
                        candidate.shutdown().err().map(|error| error.user_message());
                    let message = replacement_cleanup_message(
                        "The current App-owned watcher could not be stopped safely.",
                        replacement_residual_path.as_deref(),
                        candidate_cleanup_error.as_deref(),
                    );
                    self.finish_transition(previous);
                    return Ok(replacement_failure(
                        "session",
                        "sessionShutdownFailed",
                        &message,
                        "notAttempted",
                        Some(source.path.to_string_lossy().into_owned()),
                        None,
                        replacement_residual_path,
                    ));
                }
                session.watching = false;
            }
            if session.sidecar.shutdown().is_err() {
                let replacement_residual_path =
                    cleanup_replacement_claim(&replacement_root, &claimed);
                let candidate_cleanup_error =
                    candidate.shutdown().err().map(|error| error.user_message());
                let message = replacement_cleanup_message(
                    "The current Repo Session could not be closed safely.",
                    replacement_residual_path.as_deref(),
                    candidate_cleanup_error.as_deref(),
                );
                self.finish_transition(previous);
                return Ok(replacement_failure(
                    "session",
                    "sessionShutdownFailed",
                    &message,
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    replacement_residual_path,
                ));
            }
        }

        let source_protocol_path = match repository_path_for_protocol(&source.path) {
            Ok(path) => path,
            Err(error) => {
                let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                let _ = candidate.shutdown();
                self.finish_transition(None);
                return Ok(replacement_failure(
                    "archive",
                    "invalidPath",
                    &error.user_message(),
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    residual,
                ));
            }
        };
        let replacement_protocol_path = match repository_path_for_protocol(&claimed.path) {
            Ok(path) => path,
            Err(error) => {
                let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                let _ = candidate.shutdown();
                self.finish_transition(None);
                return Ok(replacement_failure(
                    "directoryClaim",
                    "invalidPath",
                    &error.user_message(),
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    residual,
                ));
            }
        };
        let archive_name = archive_placement_name(
            &source.name,
            ArchivePlacementPurpose::Reinitialize,
            initialized_at,
        );
        let archive_target_path =
            match repository_path_for_protocol(&archives_root.join(&archive_name)) {
                Ok(path) => path,
                Err(error) => {
                    let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                    let _ = candidate.shutdown();
                    self.finish_transition(None);
                    return Ok(replacement_failure(
                        "archive",
                        "invalidPath",
                        &error.user_message(),
                        "notAttempted",
                        Some(source.path.to_string_lossy().into_owned()),
                        None,
                        residual,
                    ));
                }
            };
        let operation_id = format!(
            "desktop-replacement-{}-{}",
            initialized_at.timestamp_millis(),
            REPLACEMENT_OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        );
        let prepared = match candidate.command(json!({
            "type": "repository.replacement.prepare",
            "operationId": operation_id,
            "sourcePath": source_protocol_path,
            "targetPath": archive_target_path,
            "expectedWatchedSavePath": selected_protocol_path,
        })) {
            Ok(response) => parse_repository_replacement_preparation(&response),
            Err(error) => Err(error.into()),
        };
        let prepared = match prepared {
            Ok(ReplacementPreparation::Prepared { archive_path }) => archive_path,
            Ok(ReplacementPreparation::Rejected { reason, message }) => {
                let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                let _ = candidate.shutdown();
                self.finish_transition(None);
                return Ok(replacement_failure(
                    "archive",
                    &reason,
                    &message,
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    residual,
                ));
            }
            Ok(ReplacementPreparation::Failed { reason, message }) => {
                let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                let _ = candidate.shutdown();
                self.finish_transition(None);
                return Ok(replacement_failure(
                    "archive",
                    &reason,
                    &message,
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    residual,
                ));
            }
            Err(error) => {
                let residual = cleanup_replacement_claim(&replacement_root, &claimed);
                let _ = candidate.shutdown();
                self.finish_transition(None);
                return Ok(replacement_failure(
                    "archive",
                    "sidecarUnavailable",
                    &error.user_message(),
                    "notAttempted",
                    Some(source.path.to_string_lossy().into_owned()),
                    None,
                    residual,
                ));
            }
        };
        let managed_path = source.path.to_string_lossy().into_owned();
        let archive_path = if Path::new(&prepared).is_absolute() {
            prepared
        } else {
            let result = rollback_replacement_after_failure(
                &mut candidate,
                &operation_id,
                &replacement_root,
                &claimed,
                false,
                &managed_path,
                Some(prepared.clone()),
                "archive",
                "invalidArchivePath",
                "The sidecar returned an invalid archive path.",
            );
            self.finish_transition(None);
            return Ok(result);
        };

        let initialization = candidate.command(json!({
            "type": "repository.initialize",
            "repoPath": replacement_protocol_path,
            "watchedSavePath": selected_protocol_path,
        }));
        match initialization {
            Ok(response) => match parse_managed_initialization_result(&response) {
                Ok(ManagedInitializationOutcome::Initialized) => {}
                Ok(ManagedInitializationOutcome::Failed { phase, reason }) => {
                    let result = rollback_replacement_after_failure(
                        &mut candidate,
                        &operation_id,
                        &replacement_root,
                        &claimed,
                        false,
                        &managed_path,
                        Some(archive_path.clone()),
                        &phase,
                        "replacementInitializationFailed",
                        &reason,
                    );
                    self.finish_transition(None);
                    return Ok(result);
                }
                Err(error) => {
                    let result = rollback_replacement_after_failure(
                        &mut candidate,
                        &operation_id,
                        &replacement_root,
                        &claimed,
                        false,
                        &managed_path,
                        Some(archive_path.clone()),
                        "repository",
                        "replacementInitializationFailed",
                        &error.user_message(),
                    );
                    self.finish_transition(None);
                    return Ok(result);
                }
            },
            Err(_error) => {
                let result = rollback_replacement_after_failure(
                    &mut candidate,
                    &operation_id,
                    &replacement_root,
                    &claimed,
                    false,
                    &managed_path,
                    Some(archive_path.clone()),
                    "repository",
                    "replacementInitializationFailed",
                    "The replacement repository could not be initialized.",
                );
                self.finish_transition(None);
                return Ok(result);
            }
        }

        let opened = match candidate.command(json!({
            "type": "session.open",
            "repoPath": replacement_protocol_path,
            "access": "readWrite",
        })) {
            Ok(response) => response,
            Err(_error) => {
                let result = rollback_replacement_after_failure(
                    &mut candidate,
                    &operation_id,
                    &replacement_root,
                    &claimed,
                    false,
                    &managed_path,
                    Some(archive_path.clone()),
                    "session",
                    "sessionOpenFailed",
                    "The replacement Repo Session could not be opened.",
                );
                self.finish_transition(None);
                return Ok(result);
            }
        };
        let connection = match parse_connection(&opened) {
            Ok(connection) => connection,
            Err(error) => {
                let result = rollback_replacement_after_failure(
                    &mut candidate,
                    &operation_id,
                    &replacement_root,
                    &claimed,
                    true,
                    &managed_path,
                    Some(archive_path.clone()),
                    "session",
                    "sessionOpenFailed",
                    &error.user_message(),
                );
                self.finish_transition(None);
                return Ok(result);
            }
        };
        let mut new_session = ManagedSession {
            connection,
            repo_path: replacement_protocol_path.clone(),
            sidecar: candidate,
            watching: false,
            lifecycle: RepositoryLifecycle::Managed,
        };
        if send_watcher_command(&mut new_session, "watcher.start").is_err() {
            let mut candidate = new_session.sidecar;
            let result = rollback_replacement_after_failure(
                &mut candidate,
                &operation_id,
                &replacement_root,
                &claimed,
                true,
                &managed_path,
                Some(archive_path.clone()),
                "watcher",
                "watcherStartFailed",
                "The replacement watcher could not be started.",
            );
            self.finish_transition(None);
            return Ok(result);
        }
        new_session.watching = true;

        let resolved = new_session.sidecar.command(json!({
            "type": "repository.replacement.resolve",
            "operationId": operation_id,
            "decision": "commit",
        }));
        let resolution = match resolved {
            Ok(response) => parse_repository_replacement_resolution(&response),
            Err(error) => Err(error.into()),
        };
        match resolution {
            Ok(ReplacementResolution::Committed { cleanup_warning }) => {
                self.finish_transition(Some(new_session));
                Ok(ManagedRepositoryReplacementResult::Succeeded {
                    managed_path,
                    archive_path,
                    cleanup_warning,
                })
            }
            Ok(_) | Err(_) => {
                let mut candidate = new_session.sidecar;
                let result = rollback_replacement_after_failure(
                    &mut candidate,
                    &operation_id,
                    &replacement_root,
                    &claimed,
                    true,
                    &managed_path,
                    Some(archive_path),
                    "commit",
                    "commitFailed",
                    "The replacement could not be committed safely.",
                );
                self.finish_transition(None);
                Ok(result)
            }
        }
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
        self.library_with_launch(app, SidecarLaunch::for_app(app)?)
    }

    fn library_with_launch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        launch: SidecarLaunch,
    ) -> Result<RepositoryLibrary, DesktopRuntimeError> {
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
        let staging_root = staging_root(app)?;
        let snapshot_name = archive_placement_name(
            &input.name,
            ArchivePlacementPurpose::PreMigration,
            Local::now().fixed_offset(),
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

        let response = candidate.command(repository_migration_prepare_command(
            &repo_path,
            &inspection_id,
            &snapshot_path,
            &repository_path_for_protocol(&staging_root)?,
        ));
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

    fn archive_repository<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        input: ArchiveRepositoryInput,
    ) -> Result<ArchiveRepositoryResult, DesktopRuntimeError> {
        self.archive_repository_with_launch(
            app,
            input,
            SidecarLaunch::for_app(app)?,
            self.archive_clock.now(),
        )
    }

    fn archive_repository_with_launch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        input: ArchiveRepositoryInput,
        launch: SidecarLaunch,
        archived_at: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<ArchiveRepositoryResult, DesktopRuntimeError> {
        if input.lifecycle != RepositoryLifecycle::Managed {
            return Err(DesktopRuntimeError::InvalidDirectory);
        }
        let source_path = resolve_library_child(app, RepositoryLifecycle::Managed, &input.name)?;
        let repositories_root =
            existing_managed_root(&managed_root(app, RepositoryLifecycle::Managed)?)?
                .ok_or(DesktopRuntimeError::InvalidDirectory)?;
        let archives_root =
            ensure_managed_root(&managed_root(app, RepositoryLifecycle::Archived)?)?;
        self.archive_repository_at(
            source_path,
            repositories_root,
            archives_root,
            input.name,
            launch,
            archived_at,
        )
    }

    fn archive_repository_at(
        &self,
        source_path: PathBuf,
        managed_root: PathBuf,
        archives_root: PathBuf,
        source_name: String,
        launch: SidecarLaunch,
        archived_at: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<ArchiveRepositoryResult, DesktopRuntimeError> {
        let source_path = canonicalize_repository_path(&source_path)?;
        if source_path.parent() != Some(managed_root.as_path()) {
            return Err(DesktopRuntimeError::InvalidDirectory);
        }
        let source_protocol_path = repository_path_for_protocol(&source_path)?;
        let archive_name =
            archive_placement_name(&source_name, ArchivePlacementPurpose::User, archived_at);
        let target_path = repository_path_for_protocol(&archives_root.join(&archive_name))?;

        let (mut source_session, source_was_current) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopRuntimeError::Unavailable)?;
            if state.transitioning || state.pending_migration.is_some() {
                return Ok(ArchiveRepositoryResult::Busy);
            }
            let source_is_current = state.current_session.as_ref().is_some_and(|session| {
                session.lifecycle == RepositoryLifecycle::Managed
                    && session.repo_path == source_protocol_path
            });
            state.transitioning = true;
            (
                if source_is_current {
                    state.current_session.take()
                } else {
                    None
                },
                source_is_current,
            )
        };

        if let Some(session) = source_session.as_mut() {
            if session.watching {
                if send_watcher_command(session, "watcher.stop").is_err() {
                    self.finish_archive_transition(source_session, source_was_current);
                    return Ok(ArchiveRepositoryResult::Failed {
                        reason: "sessionShutdownFailed".into(),
                        message: Some("The App-owned watcher could not be stopped safely.".into()),
                    });
                }
                session.watching = false;
            }
            if session.sidecar.shutdown().is_err() {
                self.finish_archive_transition(source_session, source_was_current);
                return Ok(ArchiveRepositoryResult::Failed {
                    reason: "sessionShutdownFailed".into(),
                    message: Some("The Repo Session could not be closed safely.".into()),
                });
            }
        }

        let mut candidate = match SidecarSupervisor::spawn(launch) {
            Ok(candidate) => candidate,
            Err(error) => {
                self.finish_archive_transition(None, source_was_current);
                return Err(error);
            }
        };
        let response = candidate.command(json!({
            "type": "repository.archive",
            "sourcePath": source_protocol_path,
            "targetPath": target_path,
        }));
        let result = response
            .map_err(DesktopRuntimeError::from)
            .and_then(|response| parse_archive_repository_result(&response));
        let shutdown = candidate.shutdown();
        self.finish_archive_transition(None, source_was_current);
        match (result, shutdown) {
            (Ok(result), _) => Ok(result),
            (Err(error), _) => Err(error),
        }
    }

    fn finish_archive_transition(&self, session: Option<ManagedSession>, source_was_current: bool) {
        if let Ok(mut state) = self.state.lock() {
            if source_was_current {
                state.current_session = session;
            }
            state.transitioning = false;
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

    fn finish_import_candidate_failure(
        &self,
        mut candidate: SidecarSupervisor,
        phase: &str,
        reason: &str,
        message: &str,
        residual_path: Option<String>,
        cleanup_failure: Option<String>,
    ) -> ImportRepositoryResult {
        let message = match candidate.shutdown() {
            Ok(()) => message.to_owned(),
            Err(_) => {
                format!("{message} The temporary import sidecar could not be cleaned up safely.")
            }
        };
        self.finish_transition_preserving_session();
        import_failure_with_cleanup(phase, reason, &message, residual_path, cleanup_failure)
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

#[tauri::command]
pub async fn desktop_import_repository<R: Runtime>(
    app: AppHandle<R>,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<ImportRepositoryResult, String> {
    let result = workflow
        .import_repository(&app)
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub async fn desktop_archive_and_reinitialize_managed_repository<R: Runtime>(
    app: AppHandle<R>,
    workflow: State<'_, DesktopWorkflow>,
    input: ManagedRepositoryReplacementInput,
) -> Result<ManagedRepositoryReplacementResult, String> {
    let result = workflow
        .archive_and_reinitialize_managed_repository(&app, input)
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
pub fn desktop_get_repository_library<R: Runtime>(
    app: AppHandle<R>,
    workflow: State<'_, DesktopWorkflow>,
) -> Result<RepositoryLibrary, String> {
    workflow.library(&app).map_err(|error| error.user_message())
}

#[tauri::command]
pub fn desktop_open_library_entry<R: Runtime>(
    app: AppHandle<R>,
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
pub fn desktop_archive_repository<R: Runtime>(
    app: AppHandle<R>,
    workflow: State<'_, DesktopWorkflow>,
    input: ArchiveRepositoryInput,
) -> Result<ArchiveRepositoryResult, String> {
    let result = workflow
        .archive_repository(&app, input)
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
pub fn desktop_close_repository<R: Runtime>(
    app: AppHandle<R>,
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
pub fn desktop_start_watching<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, DesktopWorkflow>,
) -> Result<(), String> {
    let result = runtime
        .control_watcher("watcher.start")
        .map_err(|error| error.user_message());
    crate::update_repository_menu(&app);
    result
}

#[tauri::command]
pub fn desktop_stop_watching<R: Runtime>(
    app: AppHandle<R>,
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

fn canonicalize_import_source(path: &Path) -> Result<PathBuf, DesktopRuntimeError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    canonicalize_repository_path(path)
}

fn validate_published_managed_child(
    root: &Path,
    published_path: &Path,
) -> Result<PathBuf, DesktopRuntimeError> {
    let metadata =
        fs::symlink_metadata(published_path).map_err(|_| DesktopRuntimeError::InvalidDirectory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }

    let canonical = canonicalize_repository_path(published_path)?;
    if canonical.parent() != Some(root) {
        return Err(DesktopRuntimeError::InvalidDirectory);
    }
    Ok(canonical)
}

fn path_is_within(parent: &Path, child: &Path) -> bool {
    child == parent || child.starts_with(parent)
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

fn staging_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, DesktopRuntimeError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| DesktopRuntimeError::Unavailable)?
        .join("staging");
    ensure_managed_root(&root)
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
            let record = RepositoryLibraryEntry {
                name,
                lifecycle,
                status: status.clone(),
                required_action,
                current: is_current,
                watching: is_current && current.as_ref().is_some_and(|(_, _, watching)| *watching),
            };
            if lifecycle == RepositoryLifecycle::Archived && candidate.is_some() {
                library.archived.push(record);
            } else if status == "ready" || can_migrate_managed || can_rebuild_managed {
                library.managed.push(record);
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

#[derive(Clone, Copy)]
enum ArchivePlacementPurpose {
    User,
    PreMigration,
    Reinitialize,
}

fn archive_placement_name(
    managed_entry_name: &str,
    purpose: ArchivePlacementPurpose,
    timestamp: chrono::DateTime<chrono::FixedOffset>,
) -> String {
    let purpose = match purpose {
        ArchivePlacementPurpose::User => "user",
        ArchivePlacementPurpose::PreMigration => "pre-migration",
        ArchivePlacementPurpose::Reinitialize => "reinitialize",
    };
    format!(
        "{}--{}-{}",
        managed_entry_name,
        purpose,
        timestamp.format("%Y-%m-%dT%H-%M-%S%.3f%z"),
    )
}

fn advisory_repository_inspection_command(repo_path: &str) -> Value {
    repository_inspection_command(repo_path, "advisory")
}

fn repository_import_command(
    source_path: &str,
    target_path: &str,
    staging_root_path: &str,
) -> Value {
    json!({
        "type": "repository.import",
        "sourcePath": source_path,
        "targetPath": target_path,
        "stagingRootPath": staging_root_path,
    })
}

fn repository_migration_prepare_command(
    repo_path: &str,
    inspection_id: &str,
    snapshot_path: &str,
    staging_root_path: &str,
) -> Value {
    json!({
        "type": "repository.migration.prepare",
        "repoPath": repo_path,
        "inspectionId": inspection_id,
        "confirmation": "migrate-save-history-repository",
        "snapshotPath": snapshot_path,
        "stagingRootPath": staging_root_path,
    })
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

fn repository_watched_save_repositories_comparison_command(
    left_repo_path: &str,
    right_repo_path: &str,
) -> Value {
    json!({
        "type": "repository.compareWatchedSaveRepositories",
        "leftRepoPath": left_repo_path,
        "rightRepoPath": right_repo_path,
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

fn parse_repository_watched_save_repositories_comparison(
    response: &Value,
) -> Result<bool, DesktopRuntimeError> {
    if response.pointer("/result/type").and_then(Value::as_str)
        != Some("repository.watchedSaveRepositoriesCompared")
    {
        return Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid Watched Save repository comparison.".into(),
        ));
    }
    response
        .pointer("/result/same")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            DesktopRuntimeError::Protocol(
                "The Desktop sidecar returned an invalid Watched Save repository comparison."
                    .into(),
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

enum ImportProtocolResult {
    Copied {
        repo_path: String,
        source_status: String,
        cleanup_failure: Option<String>,
    },
    Rejected {
        reason: String,
        status: Option<String>,
        cleanup_failure: Option<String>,
    },
    Failed {
        phase: String,
        reason: String,
        message: String,
        source_state: String,
        retained_path: Option<String>,
        cleanup_failure: Option<String>,
    },
}

fn parse_repository_import_result(
    response: &Value,
) -> Result<ImportProtocolResult, DesktopRuntimeError> {
    let imported = response.pointer("/result/import").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid repository import result.".into(),
        )
    })?;
    match imported.get("status").and_then(Value::as_str) {
        Some("copied") => {
            let snapshot = imported.get("snapshot").ok_or_else(|| {
                DesktopRuntimeError::Protocol(
                    "The Desktop sidecar returned an invalid imported snapshot.".into(),
                )
            })?;
            let repo_path = snapshot
                .get("repoPath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid imported repository path.".into(),
                    )
                })?;
            let source_status = imported
                .get("sourceStatus")
                .and_then(Value::as_str)
                .filter(|status| {
                    matches!(
                        *status,
                        "ready" | "rebuildRequired" | "legacyConfig" | "migrationRequired"
                    )
                })
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid imported source status.".into(),
                    )
                })?;
            Ok(ImportProtocolResult::Copied {
                repo_path: repo_path.into(),
                source_status: source_status.into(),
                cleanup_failure: imported
                    .get("cleanupFailure")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        }
        Some("rejected") => Ok(ImportProtocolResult::Rejected {
            reason: imported
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("invalidSource")
                .into(),
            status: imported
                .get("sourceStatus")
                .and_then(Value::as_str)
                .map(str::to_owned),
            cleanup_failure: imported
                .get("cleanupFailure")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        Some("failed") => Ok(ImportProtocolResult::Failed {
            phase: imported
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("copy")
                .into(),
            reason: imported
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("copyFailed")
                .into(),
            message: imported
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The external repository could not be imported.")
                .into(),
            retained_path: imported
                .get("retainedPath")
                .and_then(Value::as_str)
                .map(str::to_owned),
            source_state: imported
                .get("sourceState")
                .and_then(Value::as_str)
                .unwrap_or("unchanged")
                .into(),
            cleanup_failure: imported
                .get("cleanupFailure")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown repository import status.".into(),
        )),
    }
}

fn is_import_source_status(status: &str) -> bool {
    matches!(
        status,
        "ready" | "rebuildRequired" | "legacyConfig" | "migrationRequired"
    )
}

fn import_inspection_rejection(status: &str, _required_action: &str) -> ImportRepositoryResult {
    let reason = match status {
        "newerIncompatible" => "newerIncompatible",
        _ => "invalidSource",
    };
    ImportRepositoryResult::Rejected {
        reason: reason.into(),
        message: import_reason_message(reason),
        status: Some(status.into()),
        cleanup_failure: None,
    }
}

fn import_rejected(reason: &str, message: String) -> ImportRepositoryResult {
    ImportRepositoryResult::Rejected {
        reason: reason.into(),
        message,
        status: None,
        cleanup_failure: None,
    }
}

fn import_failure(
    phase: &str,
    reason: &str,
    message: &str,
    residual_path: Option<String>,
) -> ImportRepositoryResult {
    import_failure_with_cleanup(phase, reason, message, residual_path, None)
}

fn import_failure_with_cleanup(
    phase: &str,
    reason: &str,
    message: &str,
    residual_path: Option<String>,
    cleanup_failure: Option<String>,
) -> ImportRepositoryResult {
    ImportRepositoryResult::Failed {
        phase: phase.into(),
        reason: reason.into(),
        message: message.into(),
        source_state: "unchanged".into(),
        residual_path,
        cleanup_failure,
    }
}

fn import_reason_message(reason: &str) -> String {
    match reason {
        "invalidPlacement" => {
            "Choose an external repository outside the App-managed library.".into()
        }
        "duplicateWatchedSave" => {
            "A managed repository already watches this save.".into()
        }
        "newerIncompatible" => {
            "This repository was created by a newer incompatible app. Update Desktop before importing it.".into()
        }
        "invalidSource" => {
            "This folder is not a compatible Save History Repository.".into()
        }
        "repositoryBusy" => "The external repository is busy with another write.".into(),
        "watcherAlreadyAcquired" => "Another process is already watching the external repository.".into(),
        _ => "The external repository could not be imported safely.".into(),
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
    let selected_save_path = repository_path_for_protocol(selected_save_path)?;
    for (name, candidate) in enumerate_direct_managed_repository_children(root)? {
        let candidate_path = repository_path_for_protocol(&candidate)?;
        let response = inspector
            .command(repository_watched_save_comparison_command(
                &candidate_path,
                &selected_save_path,
            ))
            .map_err(DesktopRuntimeError::from)?;
        if parse_repository_watched_save_comparison(&response)? {
            return Ok(Some(name));
        }
    }

    Ok(None)
}

fn find_duplicate_managed_repository_by_repository(
    root: &Path,
    source_path: &Path,
    inspector: &mut SidecarSupervisor,
) -> Result<Option<String>, DesktopRuntimeError> {
    let source_path = repository_path_for_protocol(source_path)?;
    for (name, candidate) in enumerate_direct_managed_repository_children(root)? {
        let candidate_path = repository_path_for_protocol(&candidate)?;
        let response = inspector
            .command(repository_watched_save_repositories_comparison_command(
                &candidate_path,
                &source_path,
            ))
            .map_err(DesktopRuntimeError::from)?;
        if parse_repository_watched_save_repositories_comparison(&response)? {
            return Ok(Some(name));
        }
    }

    Ok(None)
}

fn enumerate_direct_managed_repository_children(
    root: &Path,
) -> Result<Vec<(String, PathBuf)>, DesktopRuntimeError> {
    let mut children = Vec::new();
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
        children.push((entry.file_name().to_string_lossy().into_owned(), candidate));
    }
    Ok(children)
}

struct ReplacementSource {
    path: PathBuf,
    name: String,
}

enum ReplacementSourceDiscovery {
    Found(ReplacementSource),
    NotFound,
}

fn find_replacement_source(
    root: &Path,
    selected_save_path: &Path,
    inspector: &mut SidecarSupervisor,
) -> Result<ReplacementSourceDiscovery, DesktopRuntimeError> {
    let selected_save_path = repository_path_for_protocol(selected_save_path)?;
    let mut entries = fs::read_dir(root)
        .map_err(|_| DesktopRuntimeError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| DesktopRuntimeError::Unavailable)?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
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
        let inspection = inspector
            .command(strict_repository_inspection_command(&candidate_path))
            .map_err(DesktopRuntimeError::from)
            .and_then(|response| parse_repository_inspection_details(&response))?;
        if !matches!(
            inspection.status.as_str(),
            "ready" | "legacyConfig" | "migrationRequired"
        ) {
            continue;
        }
        let same = match inspector.command(repository_watched_save_comparison_command(
            &candidate_path,
            &selected_save_path,
        )) {
            Ok(response) => parse_repository_watched_save_comparison(&response)?,
            Err(SidecarError::Rejected { code, .. })
                if code == REPOSITORY_WATCHED_SAVE_COMPARE_FAILED =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if !same {
            continue;
        }
        return Ok(ReplacementSourceDiscovery::Found(ReplacementSource {
            path: candidate,
            name: entry.file_name().to_string_lossy().into_owned(),
        }));
    }

    Ok(ReplacementSourceDiscovery::NotFound)
}

fn replacement_cleanup_message(
    message: &str,
    replacement_residual_path: Option<&str>,
    candidate_cleanup_error: Option<&str>,
) -> String {
    let mut details = Vec::new();
    if let Some(path) = replacement_residual_path {
        details.push(format!("Replacement residual: {path}."));
    }
    if let Some(error) = candidate_cleanup_error {
        details.push(format!("Candidate cleanup also failed: {error}"));
    }
    if details.is_empty() {
        message.into()
    } else {
        format!("{message} {}", details.join(" "))
    }
}

fn cleanup_replacement_claim(root: &Path, claimed: &ManagedDirectoryClaim) -> Option<String> {
    remove_claimed_directory(root, claimed)
        .err()
        .and_then(|error| {
            error
                .residual_path
                .or_else(|| Some(claimed.path.clone()))
                .map(|path| path.to_string_lossy().into_owned())
        })
}

fn replacement_failure(
    phase: &str,
    reason: &str,
    message: &str,
    rollback: &str,
    managed_path: Option<String>,
    archive_path: Option<String>,
    replacement_residual_path: Option<String>,
) -> ManagedRepositoryReplacementResult {
    ManagedRepositoryReplacementResult::Failed {
        phase: phase.into(),
        reason: reason.into(),
        message: message.into(),
        rollback: rollback.into(),
        managed_path,
        archive_path,
        replacement_residual_path,
    }
}

// This private cleanup adapter keeps the failure report fields next to the exact cleanup actions;
// collapsing them into a generic transaction object would widen the Desktop/History boundary.
#[allow(clippy::too_many_arguments)]
fn rollback_replacement_after_failure(
    candidate: &mut SidecarSupervisor,
    operation_id: &str,
    replacement_root: &Path,
    claimed: &ManagedDirectoryClaim,
    candidate_has_session: bool,
    managed_path: &str,
    archive_path: Option<String>,
    phase: &str,
    reason: &str,
    message: &str,
) -> ManagedRepositoryReplacementResult {
    let mut replacement_residual_path = None;
    if !candidate_has_session {
        replacement_residual_path = cleanup_replacement_claim(replacement_root, claimed);
    }

    let rollback = candidate
        .command(json!({
            "type": "repository.replacement.resolve",
            "operationId": operation_id,
            "decision": "rollback",
        }))
        .map_err(DesktopRuntimeError::from)
        .and_then(|response| parse_repository_replacement_resolution(&response));

    if candidate_has_session {
        replacement_residual_path = cleanup_replacement_claim(replacement_root, claimed);
    }
    let shutdown_ok = candidate.shutdown().is_ok();

    match rollback {
        Ok(ReplacementResolution::RolledBack { cleanup_warning }) if shutdown_ok => {
            let message = if cleanup_warning.is_some() {
                format!("{message} History released its replacement lease with a warning.")
            } else {
                message.into()
            };
            replacement_failure(
                phase,
                reason,
                &message,
                "completed",
                Some(managed_path.into()),
                archive_path,
                replacement_residual_path,
            )
        }
        Ok(ReplacementResolution::RolledBack { .. }) => replacement_failure(
            phase,
            reason,
            &format!("{message} The replacement sidecar could not shut down cleanly."),
            "completed",
            Some(managed_path.into()),
            archive_path,
            replacement_residual_path,
        ),
        Ok(ReplacementResolution::RollbackFailed {
            message: rollback_message,
        }) => replacement_failure(
            phase,
            "rollbackFailed",
            &format!("{message} {}", rollback_message.unwrap_or_default()),
            "failed",
            Some(managed_path.into()),
            archive_path,
            replacement_residual_path,
        ),
        Ok(ReplacementResolution::Committed { .. }) | Err(_) => replacement_failure(
            phase,
            "rollbackFailed",
            &format!("{message} The archived repository could not be restored safely."),
            "failed",
            Some(managed_path.into()),
            archive_path,
            replacement_residual_path,
        ),
    }
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

fn parse_archive_repository_result(
    response: &Value,
) -> Result<ArchiveRepositoryResult, DesktopRuntimeError> {
    let archive = response.pointer("/result/archive").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid archive result.".into(),
        )
    })?;
    match archive.get("status").and_then(Value::as_str) {
        Some("archived") => {
            let name = archive
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid archive name.".into(),
                    )
                })?;
            Ok(ArchiveRepositoryResult::Archived { name: name.into() })
        }
        Some("failed") => Ok(ArchiveRepositoryResult::Failed {
            reason: archive
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("moveFailed")
                .into(),
            message: archive
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown archive result.".into(),
        )),
    }
}

enum ReplacementPreparation {
    Prepared { archive_path: String },
    Rejected { reason: String, message: String },
    Failed { reason: String, message: String },
}

fn parse_repository_replacement_preparation(
    response: &Value,
) -> Result<ReplacementPreparation, DesktopRuntimeError> {
    let preparation = response.pointer("/result/preparation").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid replacement preparation.".into(),
        )
    })?;
    match preparation.get("status").and_then(Value::as_str) {
        Some("prepared") => {
            let archive_path = preparation
                .get("destinationPath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid replacement archive path.".into(),
                    )
                })?;
            let _source_status = preparation
                .get("sourceStatus")
                .and_then(Value::as_str)
                .filter(|status| matches!(*status, "ready" | "legacyConfig" | "migrationRequired"))
                .ok_or_else(|| {
                    DesktopRuntimeError::Protocol(
                        "The Desktop sidecar returned an invalid replacement source status.".into(),
                    )
                })?;
            Ok(ReplacementPreparation::Prepared {
                archive_path: archive_path.into(),
            })
        }
        Some("rejected") => {
            let reason = preparation
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("sourceNotEligible");
            Ok(ReplacementPreparation::Rejected {
                reason: reason.into(),
                message: replacement_reason_message(reason),
            })
        }
        Some("failed") => {
            let reason = preparation
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("moveFailed");
            Ok(ReplacementPreparation::Failed {
                reason: reason.into(),
                message: preparation
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| replacement_reason_message(reason)),
            })
        }
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown replacement preparation status.".into(),
        )),
    }
}

enum ReplacementResolution {
    Committed { cleanup_warning: Option<String> },
    RolledBack { cleanup_warning: Option<String> },
    RollbackFailed { message: Option<String> },
}

fn parse_repository_replacement_resolution(
    response: &Value,
) -> Result<ReplacementResolution, DesktopRuntimeError> {
    let resolution = response.pointer("/result/resolution").ok_or_else(|| {
        DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an invalid replacement resolution.".into(),
        )
    })?;
    let warning = resolution
        .get("cleanupWarning")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match resolution.get("status").and_then(Value::as_str) {
        Some("committed") => Ok(ReplacementResolution::Committed {
            cleanup_warning: warning,
        }),
        Some("rolledBack") => Ok(ReplacementResolution::RolledBack {
            cleanup_warning: warning,
        }),
        Some("rollbackFailed") => Ok(ReplacementResolution::RollbackFailed {
            message: resolution
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => Err(DesktopRuntimeError::Protocol(
            "The Desktop sidecar returned an unknown replacement resolution status.".into(),
        )),
    }
}

fn replacement_reason_message(reason: &str) -> String {
    match reason {
        "confirmationRequired" => {
            "Confirm archive-and-reinitialize before replacing this repository.".into()
        }
        "invalidPlacement" => "The managed repository is not in an App-owned directory.".into(),
        "sourceNotEligible" => "The managed repository is not eligible for replacement.".into(),
        "differentWatchedSave" => "The managed repository watches a different save.".into(),
        "repositoryBusy" => "The managed repository is busy with another write.".into(),
        "watcherAlreadyAcquired" => "Another watcher is already using this repository.".into(),
        _ => "The managed repository could not be replaced safely.".into(),
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
        io::{Read, Write},
        net::{Shutdown, TcpStream},
        path::{Path, PathBuf},
        process::Command,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
        time::Duration,
    };

    use chrono::{FixedOffset, TimeZone, Timelike};
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};
    use tauri::{
        App, Manager, WebviewWindow,
        ipc::{CallbackFn, InvokeBody},
        test::{
            INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
        },
        webview::InvokeRequest,
    };

    use super::{
        ArchivePlacementPurpose, ArchiveRepositoryResult, DEVELOPMENT_SIDECAR_ENTRY,
        DesktopRuntime, DesktopRuntimeError, ImportRepositoryResult, ManagedInitializationResult,
        OpenExternalRepositoryResult, PendingRepositoryMigration, PickStaticEncodedSaveResult,
        REPLACEMENT_CONFIRMATION, RepositoryLifecycle, RepositoryOpenIntent, SaveLocationPlatform,
        SaveLocationSystem, SidecarLaunch, SidecarSupervisor, StaticSaveFileSystem,
        StaticSaveInspection, StaticSaveInspector, StaticSavePicker,
        advisory_repository_inspection_command, archive_placement_name,
        canonicalize_repository_path, development_sidecar_launch,
        inspect_static_encoded_save_with_adapters, managed_repository_name,
        menu_static_save_result, natural_name_cmp, repository_open_inspection_command,
        sidecar_launch_for_resource_directory, workspace_root,
    };

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct FixedArchiveClock(chrono::DateTime<chrono::FixedOffset>);

    impl super::ArchiveClock for FixedArchiveClock {
        fn now(&self) -> chrono::DateTime<chrono::FixedOffset> {
            self.0
        }
    }

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
    fn snapshot_commands_forward_the_desktop_staging_root() {
        assert_eq!(
            super::repository_import_command("/source", "/target", "/staging"),
            json!({
                "type": "repository.import",
                "sourcePath": "/source",
                "targetPath": "/target",
                "stagingRootPath": "/staging",
            })
        );
        assert_eq!(
            super::repository_migration_prepare_command(
                "/repository",
                "inspection",
                "/snapshot",
                "/staging",
            ),
            json!({
                "type": "repository.migration.prepare",
                "repoPath": "/repository",
                "inspectionId": "inspection",
                "confirmation": "migrate-save-history-repository",
                "snapshotPath": "/snapshot",
                "stagingRootPath": "/staging",
            })
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
    fn imports_a_copy_into_managed_library_without_opening_or_watching_it() {
        let temp = TestDirectory::new();
        let source = temp.path().join("external-repository");
        let managed_root = temp.path().join("repositories");
        let archives_root = temp.path().join("archives");
        fs::create_dir(&source).expect("create source repository");
        fs::write(source.join("durable-file"), "source remains unchanged")
            .expect("write source content");
        let script = temp.path().join("import-sidecar.mjs");
        fs::write(
            &script,
            import_fixture_sidecar_source(source.to_str().expect("UTF-8 source path"), false),
        )
        .expect("write import fixture");

        let runtime = DesktopRuntime::default();
        let timestamp = test_initialization_time();
        let result = runtime
            .import_repository_at(
                source.clone(),
                managed_root.clone(),
                archives_root,
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: script,
                    node: PathBuf::from("node"),
                },
                timestamp,
            )
            .expect("import repository");

        let name = match result {
            ImportRepositoryResult::Imported {
                name,
                source_status,
                status,
                required_action,
                ..
            } => {
                assert_eq!(source_status, "ready");
                assert_eq!(status, "rebuildRequired");
                assert_eq!(required_action, "rebuildReadModel");
                name
            }
            _ => panic!("unexpected import result"),
        };
        let target = managed_root.join(name);
        assert!(target.is_dir());
        assert_eq!(
            fs::read_to_string(source.join("durable-file")).expect("read source"),
            "source remains unchanged"
        );
        assert_eq!(
            fs::read_to_string(target.join("durable-file")).expect("read imported copy"),
            "source remains unchanged"
        );
        assert!(runtime.connection().is_err());
        assert!(!runtime.repository_menu_state().close_enabled);
    }

    #[test]
    fn import_spawn_failure_is_structured_and_preserves_source() {
        let temp = TestDirectory::new();
        let source = temp.path().join("external-repository");
        fs::create_dir(&source).expect("create source repository");
        fs::write(source.join("durable-file"), "source remains").expect("write source content");
        let runtime = DesktopRuntime::default();

        let result = runtime
            .import_repository_at(
                source.clone(),
                temp.path().join("repositories"),
                temp.path().join("archives"),
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: temp.path().join("missing-sidecar.mjs"),
                    node: PathBuf::from("node"),
                },
                test_initialization_time(),
            )
            .expect("structured import failure");

        assert!(matches!(
            result,
            ImportRepositoryResult::Failed {
                phase,
                reason,
                source_state,
                ..
            } if phase == "spawn" && reason == "sidecarUnavailable" && source_state == "unchanged"
        ));
        assert_eq!(
            fs::read_to_string(source.join("durable-file")).expect("read source"),
            "source remains"
        );
    }

    #[test]
    fn import_inspection_duplicate_and_command_failures_are_structured() {
        for failure in ["inspection", "duplicate", "command"] {
            let temp = TestDirectory::new();
            let source = temp.path().join(format!("external-{failure}"));
            let managed_root = temp.path().join("repositories");
            fs::create_dir(&source).expect("create source repository");
            fs::write(source.join("durable-file"), "source remains").expect("write source content");
            if failure == "duplicate" {
                fs::create_dir_all(managed_root.join("existing-managed"))
                    .expect("create managed duplicate candidate");
            }
            let script = temp.path().join("import-failure-sidecar.mjs");
            fs::write(
                &script,
                import_fixture_sidecar_source_with_failure(
                    source.to_str().expect("UTF-8 source path"),
                    false,
                    failure,
                ),
            )
            .expect("write failure fixture");

            let result = DesktopRuntime::default()
                .import_repository_at(
                    source,
                    managed_root,
                    temp.path().join("archives"),
                    temp.path().join("staging"),
                    SidecarLaunch::Development {
                        entry: script,
                        node: PathBuf::from("node"),
                    },
                    test_initialization_time(),
                )
                .expect("structured import failure");

            let expected = match failure {
                "inspection" => ("inspection", "inspectionFailed"),
                "duplicate" => ("duplicate", "duplicateCheckFailed"),
                "command" => ("command", "importCommandFailed"),
                _ => unreachable!(),
            };
            assert!(matches!(
                result,
                ImportRepositoryResult::Failed {
                    phase,
                    reason,
                    source_state,
                    ..
                } if phase == expected.0 && reason == expected.1 && source_state == "unchanged"
            ));
        }
    }

    #[test]
    fn import_retains_a_published_copy_when_status_inspection_fails() {
        let temp = TestDirectory::new();
        let source = temp.path().join("external-repository");
        let managed_root = temp.path().join("repositories");
        fs::create_dir(&source).expect("create source repository");
        fs::write(source.join("durable-file"), "source remains").expect("write source content");
        let script = temp.path().join("status-failure-sidecar.mjs");
        fs::write(
            &script,
            import_fixture_sidecar_source_with_failure(
                source.to_str().expect("UTF-8 source path"),
                false,
                "status",
            ),
        )
        .expect("write status failure fixture");

        let result = DesktopRuntime::default()
            .import_repository_at(
                source.clone(),
                managed_root,
                temp.path().join("archives"),
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: script,
                    node: PathBuf::from("node"),
                },
                test_initialization_time(),
            )
            .expect("structured post-copy failure");

        let retained_path = match result {
            ImportRepositoryResult::Failed {
                phase,
                reason,
                source_state,
                residual_path: Some(path),
                ..
            } => {
                assert_eq!(phase, "status");
                assert_eq!(reason, "postCopyInspectionFailed");
                assert_eq!(source_state, "unchanged");
                path
            }
            _ => panic!("expected retained import copy failure"),
        };
        assert!(Path::new(&retained_path).is_dir());
        assert_eq!(
            fs::read_to_string(source.join("durable-file")).expect("read source"),
            "source remains"
        );
    }

    #[test]
    fn import_preserves_cleanup_warning_after_post_copy_failures() {
        for failure in ["status-cleanup", "shutdown-cleanup"] {
            let temp = TestDirectory::new();
            let source = temp.path().join("external-repository");
            let managed_root = temp.path().join("repositories");
            fs::create_dir(&source).expect("create source repository");
            fs::write(source.join("durable-file"), "source remains").expect("write source content");
            let script = temp.path().join("post-copy-failure-sidecar.mjs");
            fs::write(
                &script,
                import_fixture_sidecar_source_with_failure(
                    source.to_str().expect("UTF-8 source path"),
                    false,
                    failure,
                ),
            )
            .expect("write failure fixture");

            let result = DesktopRuntime::default()
                .import_repository_at(
                    source.clone(),
                    managed_root,
                    temp.path().join("archives"),
                    temp.path().join("staging"),
                    SidecarLaunch::Development {
                        entry: script,
                        node: PathBuf::from("node"),
                    },
                    test_initialization_time(),
                )
                .expect("structured post-copy failure");

            match (failure, result) {
                (
                    "status-cleanup",
                    ImportRepositoryResult::Failed {
                        phase,
                        reason,
                        cleanup_failure: Some(cleanup_failure),
                        residual_path: Some(residual_path),
                        ..
                    },
                ) => {
                    assert_eq!(phase, "status");
                    assert_eq!(reason, "postCopyInspectionFailed");
                    assert_eq!(cleanup_failure, "leaseReleaseFailed");
                    assert!(Path::new(&residual_path).is_dir());
                }
                (
                    "shutdown-cleanup",
                    ImportRepositoryResult::Failed {
                        phase,
                        reason,
                        cleanup_failure: Some(cleanup_failure),
                        residual_path: Some(residual_path),
                        ..
                    },
                ) => {
                    assert_eq!(phase, "status");
                    assert_eq!(reason, "sidecarShutdownFailed");
                    assert_eq!(cleanup_failure, "leaseReleaseFailed");
                    assert!(Path::new(&residual_path).is_dir());
                }
                _ => panic!("unexpected structured post-copy result"),
            }
            assert_eq!(
                fs::read_to_string(source.join("durable-file")).expect("read source"),
                "source remains"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_a_symlinked_managed_root_as_a_structured_failure() {
        use std::os::unix::fs::symlink;

        let temp = TestDirectory::new();
        let source = temp.path().join("external-repository");
        let outside = temp.path().join("outside");
        let managed_root = temp.path().join("repositories");
        fs::create_dir(&source).expect("create source repository");
        fs::create_dir(&outside).expect("create outside root");
        symlink(&outside, &managed_root).expect("create managed root symlink");
        fs::write(source.join("durable-file"), "source remains").expect("write source content");

        let result = DesktopRuntime::default()
            .import_repository_at(
                source.clone(),
                managed_root,
                temp.path().join("archives"),
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: temp.path().join("unused.mjs"),
                    node: PathBuf::from("node"),
                },
                test_initialization_time(),
            )
            .expect("structured placement failure");

        assert!(matches!(
            result,
            ImportRepositoryResult::Failed { phase, reason, .. }
                if phase == "placement" && reason == "managedRootUnavailable"
        ));
        assert!(
            fs::read_dir(outside)
                .expect("read outside root")
                .next()
                .is_none()
        );
        assert!(source.join("durable-file").is_file());
    }

    #[test]
    fn import_duplicate_preflight_checks_direct_managed_children_and_preserves_source() {
        let temp = TestDirectory::new();
        let source = temp.path().join("external-repository");
        let managed_root = temp.path().join("repositories");
        let managed_child = managed_root.join("existing-managed");
        fs::create_dir(&source).expect("create source repository");
        fs::create_dir_all(&managed_child).expect("create managed child");
        fs::write(source.join("durable-file"), "source remains").expect("write source content");
        let script = temp.path().join("duplicate-sidecar.mjs");
        fs::write(
            &script,
            import_fixture_sidecar_source(source.to_str().expect("UTF-8 source path"), true),
        )
        .expect("write duplicate fixture");

        let result = DesktopRuntime::default()
            .import_repository_at(
                source.clone(),
                managed_root.clone(),
                temp.path().join("archives"),
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: script,
                    node: PathBuf::from("node"),
                },
                test_initialization_time(),
            )
            .expect("duplicate preflight");

        assert!(matches!(
            result,
            ImportRepositoryResult::Rejected { reason, .. } if reason == "duplicateWatchedSave"
        ));
        assert!(managed_child.is_dir());
        assert!(source.join("durable-file").is_file());
        assert!(
            fs::read_dir(&managed_root)
                .expect("read managed root")
                .filter_map(Result::ok)
                .all(|entry| entry.file_name() == "existing-managed")
        );
    }

    #[test]
    fn import_rejects_an_active_external_session_without_changing_it() {
        let temp = TestDirectory::new();
        let repository = temp.path().join("external-session");
        fs::create_dir(&repository).expect("create external repository");
        let open_script = temp.path().join("open-sidecar.mjs");
        fs::write(
            &open_script,
            fixture_sidecar_source(repository.to_str().expect("UTF-8 repository path"), "ready"),
        )
        .expect("write open fixture");
        let runtime = DesktopRuntime::default();
        runtime
            .open_repository_path_with_launch(
                repository,
                SidecarLaunch::Development {
                    entry: open_script,
                    node: PathBuf::from("node"),
                },
            )
            .expect("open external session");
        let connection = runtime.connection().expect("external connection");

        let result = runtime
            .import_repository_at(
                temp.path().join("not-selected-after-guard"),
                temp.path().join("repositories"),
                temp.path().join("archives"),
                temp.path().join("staging"),
                SidecarLaunch::Development {
                    entry: temp.path().join("unused.mjs"),
                    node: PathBuf::from("node"),
                },
                test_initialization_time(),
            )
            .expect("external session import rejection");

        assert!(matches!(
            result,
            ImportRepositoryResult::Rejected { reason, .. } if reason == "externalSession"
        ));
        assert_eq!(
            runtime.connection().expect("connection remains").endpoint,
            connection.endpoint
        );
        runtime.shutdown().expect("shutdown external session");
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
    fn desktop_archive_moves_an_uninspectable_direct_child_with_user_naming_policy() {
        let temp = TestDirectory::new();
        let managed_root = temp.path().join("repositories");
        let archives_root = temp.path().join("archives");
        let source = managed_root.join("opaque-repository");
        fs::create_dir_all(&source).expect("create opaque managed child");
        fs::create_dir(&archives_root).expect("create archives root");
        fs::write(source.join("keep"), b"opaque").expect("write opaque content");
        let script = temp.path().join("archive-sidecar.mjs");
        fs::write(
            &script,
            r#"
import fs from "node:fs";
import path from "node:path";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
write({ protocolVersion: 11, kind: "event", event: { type: "process.ready" } });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.command.type === "repository.archive") {
      const destination = request.command.targetPath;
      fs.renameSync(request.command.sourcePath, destination);
      write({ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true,
        result: { type: "repository.archiveResult", archive: { status: "archived", repoPath: destination, name: path.basename(destination) } } });
    } else if (request.command.type === "process.shutdown") {
      write({ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true,
        result: { type: "process.shutdownComplete" } });
      process.exit(0);
    }

  }
});
"#,
        )
        .expect("write archive fixture");
        let timestamp = test_initialization_time();
        let expected_name = archive_placement_name(
            "opaque-repository",
            ArchivePlacementPurpose::User,
            timestamp,
        );

        let result = DesktopRuntime::default().archive_repository_at(
            fs::canonicalize(&source).expect("canonical source"),
            fs::canonicalize(&managed_root).expect("canonical managed root"),
            fs::canonicalize(&archives_root).expect("canonical archives root"),
            "opaque-repository".into(),
            SidecarLaunch::Development {
                entry: script,
                node: PathBuf::from("node"),
            },
            timestamp,
        );

        assert!(matches!(
            result,
            Ok(ArchiveRepositoryResult::Archived { name }) if name == expected_name
        ));
        assert!(!source.exists());
        assert_eq!(
            fs::read(archives_root.join(expected_name).join("keep"))
                .expect("read archived content"),
            b"opaque"
        );
        assert_eq!(
            archive_placement_name(
                "opaque-repository",
                ArchivePlacementPurpose::PreMigration,
                timestamp,
            ),
            format!(
                "opaque-repository--pre-migration-{}",
                timestamp.format("%Y-%m-%dT%H-%M-%S%.3f%z")
            )
        );
    }

    #[test]
    fn real_desktop_archive_stops_its_session_and_opens_an_exact_read_only_archive() {
        let desktop = TestDesktopApp::new();
        let save_path = desktop.root().join("slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &save_path).expect("copy Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        let archives_root = desktop.root().join("archives");
        let timestamp = test_initialization_time();
        let source_name = managed_repository_name(&save_path, timestamp);
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        let launch = real_sidecar_launch();

        assert!(matches!(
            workflow.initialize_managed_repository_with_launch(
                save_path.clone(),
                managed_root.clone(),
                launch.clone(),
                timestamp,
            ),
            Ok(ManagedInitializationResult::Initialized)
        ));
        assert!(
            workflow
                .close_requires_confirmation()
                .expect("initialized watcher is active")
        );

        fs::create_dir_all(&archives_root).expect("create archives root");
        let archive_base =
            archive_placement_name(&source_name, ArchivePlacementPurpose::User, timestamp);
        fs::create_dir(archives_root.join(&archive_base)).expect("create name collision");

        let result: Value = desktop
            .invoke(
                "desktop_archive_repository",
                json!({ "input": { "lifecycle": "managed", "name": source_name } }),
            )
            .expect("public Desktop archive should succeed");
        let archived_name = result
            .get("name")
            .and_then(Value::as_str)
            .expect("archived result name")
            .to_owned();
        assert_eq!(result.get("kind").and_then(Value::as_str), Some("archived"));
        assert_eq!(archived_name, format!("{archive_base}-2"));
        assert!(!managed_root.join(&source_name).exists());
        assert!(archives_root.join(&archived_name).is_dir());
        assert!(
            desktop
                .invoke::<super::RepoSessionConnection>(
                    "desktop_get_repo_session_connection",
                    json!({}),
                )
                .is_err()
        );

        let opened: Value = desktop
            .invoke(
                "desktop_open_library_entry",
                json!({
                    "input": {
                        "lifecycle": "archived",
                        "name": archived_name,
                        "intent": "open",
                    },
                }),
            )
            .expect("public Desktop archive open should succeed");
        assert_eq!(opened.get("kind").and_then(Value::as_str), Some("opened"));
        let connection: super::RepoSessionConnection = desktop
            .invoke("desktop_get_repo_session_connection", json!({}))
            .expect("public Desktop connection should be available");
        assert_eq!(connection.access, "readOnly");
        assert!(
            desktop
                .invoke::<Value>("desktop_start_watching", json!({}))
                .is_err()
        );
        assert_eq!(
            node_http_request(&connection, "GET", "/api/v1/export?commit=HEAD~0", None),
            (200, fs::read(&fixture).expect("read Encoded Save fixture"))
        );
        let (checkpoint_status, _) =
            node_http_request(&connection, "POST", "/api/v1/checkpoints", Some("{}"));
        assert_eq!(checkpoint_status, 403);
        let (observations_status, observations) =
            node_http_request(&connection, "GET", "/api/v1/observations", None);
        assert_eq!(observations_status, 200);
        let observations: Value =
            serde_json::from_slice(&observations).expect("parse observation response");
        assert_eq!(
            observations
                .get("entries")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1),
            "stopping for archive must not create a final observation",
        );
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close should stop archived reader");
    }

    #[test]
    fn real_desktop_archive_and_reinitialize_commits_only_after_new_session_and_watcher_start() {
        let desktop = TestDesktopApp::new();
        let save_path = desktop.root().join("slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &save_path).expect("copy Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        let archives_root = desktop.root().join("archives");
        let timestamp = test_initialization_time();
        let source_name = managed_repository_name(&save_path, timestamp);
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        let launch = real_sidecar_launch();

        assert!(matches!(
            workflow.initialize_managed_repository_with_launch(
                save_path.clone(),
                managed_root.clone(),
                launch.clone(),
                timestamp,
            ),
            Ok(ManagedInitializationResult::Initialized)
        ));
        assert!(
            workflow
                .close_requires_confirmation()
                .expect("old watcher is active")
        );

        workflow.configure_replacement_command(save_path, launch, timestamp);
        let result: Value = desktop
            .invoke(
                "desktop_archive_and_reinitialize_managed_repository",
                json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
            )
            .expect("public Desktop replacement should return a structured result");
        assert_eq!(
            result.get("kind").and_then(Value::as_str),
            Some("succeeded")
        );
        let managed_path = result
            .get("managedPath")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("replacement result: {result:?}"))
            .to_owned();
        let archive_path = result
            .get("archivePath")
            .and_then(Value::as_str)
            .expect("replacement archive path")
            .to_owned();
        assert_eq!(
            managed_path,
            managed_root
                .join(&source_name)
                .to_string_lossy()
                .into_owned()
        );
        assert!(archive_path.starts_with(archives_root.to_string_lossy().as_ref()));
        assert!(result.get("cleanupWarning").is_none());
        assert!(!managed_root.join(&source_name).exists());
        assert!(
            archives_root
                .join(archive_placement_name(
                    &source_name,
                    ArchivePlacementPurpose::Reinitialize,
                    timestamp,
                ))
                .is_dir()
        );
        assert!(
            workflow
                .close_requires_confirmation()
                .expect("replacement watcher is active")
        );
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close should stop replacement session");
    }

    #[test]
    fn public_desktop_replacement_refuses_a_different_watched_save_identity() {
        let desktop = TestDesktopApp::new();
        let first_save = desktop.root().join("first-slot.dat");
        let selected_save = desktop.root().join("selected-slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &first_save).expect("copy first Encoded Save fixture");
        fs::copy(&fixture, &selected_save).expect("copy selected Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        let timestamp = test_initialization_time();
        let source_name = managed_repository_name(&first_save, timestamp);
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        assert!(matches!(
            workflow.initialize_managed_repository_with_launch(
                first_save,
                managed_root.clone(),
                real_sidecar_launch(),
                timestamp,
            ),
            Ok(ManagedInitializationResult::Initialized)
        ));

        workflow.configure_replacement_command(selected_save, real_sidecar_launch(), timestamp);
        let result: Value = desktop
            .invoke(
                "desktop_archive_and_reinitialize_managed_repository",
                json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
            )
            .expect("identity mismatch should be a structured result");
        assert_eq!(result.get("kind").and_then(Value::as_str), Some("failed"));
        assert_eq!(
            result.get("reason").and_then(Value::as_str),
            Some("differentWatchedSave")
        );
        assert_eq!(
            result.get("rollback").and_then(Value::as_str),
            Some("notAttempted")
        );
        assert!(managed_root.join(&source_name).is_dir());
        assert!(!desktop.root().join("archives").exists());
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close after identity mismatch");
    }

    #[test]
    fn public_desktop_replacement_refuses_an_active_external_watcher() {
        let desktop = TestDesktopApp::new();
        let repository = desktop.root().join("external-repository");
        let selected_save = desktop.root().join("selected-slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::create_dir(&repository).expect("create external repository");
        fs::copy(&fixture, &selected_save).expect("copy selected Encoded Save fixture");
        let timestamp = test_initialization_time();
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        assert!(matches!(
            workflow.open_repository_path_with_launch(
                repository,
                replacement_fixture_launch(desktop.root(), "success", "success", false),
            ),
            Ok(OpenExternalRepositoryResult::Opened)
        ));
        desktop
            .invoke::<Value>("desktop_start_watching", json!({}))
            .expect("public external watcher start");
        workflow.configure_replacement_command(
            selected_save,
            replacement_fixture_launch(desktop.root(), "success", "success", false),
            timestamp,
        );

        let result: Value = desktop
            .invoke(
                "desktop_archive_and_reinitialize_managed_repository",
                json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
            )
            .expect("active watcher refusal should be structured");
        assert_eq!(
            result.get("kind").and_then(Value::as_str),
            Some("blockedByMutation")
        );
        desktop
            .invoke::<Value>("desktop_stop_watching", json!({}))
            .expect("public external watcher stop");
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close after active-work refusal");
    }

    #[test]
    fn public_desktop_replacement_reports_baseline_and_repository_failures_after_rollback() {
        for initialization in ["baseline", "repository"] {
            let desktop = TestDesktopApp::new();
            let selected_save = desktop.root().join("selected-slot.dat");
            let fixture = workspace_root()
                .expect("workspace root")
                .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
            fs::copy(&fixture, &selected_save).expect("copy selected Encoded Save fixture");
            let managed_root = desktop.root().join("repositories");
            let source = managed_root.join("existing-managed-repository");
            fs::create_dir_all(&source).expect("create managed source");
            let timestamp = test_initialization_time();
            let workflow = desktop.app.state::<super::DesktopWorkflow>();
            workflow.configure_replacement_command(
                selected_save,
                replacement_fixture_launch(desktop.root(), initialization, "success", false),
                timestamp,
            );

            let result: Value = desktop
                .invoke(
                    "desktop_archive_and_reinitialize_managed_repository",
                    json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
                )
                .expect("replacement failure should be structured");
            assert_eq!(result.get("kind").and_then(Value::as_str), Some("failed"));
            assert_eq!(
                result.get("phase").and_then(Value::as_str),
                Some(initialization)
            );
            assert_eq!(
                result.get("reason").and_then(Value::as_str),
                Some("replacementInitializationFailed")
            );
            assert_eq!(
                result.get("rollback").and_then(Value::as_str),
                Some("completed")
            );
            assert!(result.get("managedPath").and_then(Value::as_str).is_some());
            assert!(result.get("archivePath").and_then(Value::as_str).is_some());
            assert!(result.get("replacementResidualPath").is_none());
            assert!(source.is_dir());
            assert_eq!(
                fs::read_dir(&managed_root)
                    .expect("read managed root")
                    .count(),
                1
            );
        }
    }

    #[test]
    fn public_desktop_replacement_reports_all_locations_when_rollback_fails() {
        let desktop = TestDesktopApp::new();
        let selected_save = desktop.root().join("selected-slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &selected_save).expect("copy selected Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        let source = managed_root.join("existing-managed-repository");
        fs::create_dir_all(&source).expect("create managed source");
        let timestamp = test_initialization_time();
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        workflow.configure_replacement_command(
            selected_save,
            replacement_fixture_launch(desktop.root(), "baseline", "failed", true),
            timestamp,
        );

        let result: Value = desktop
            .invoke(
                "desktop_archive_and_reinitialize_managed_repository",
                json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
            )
            .expect("rollback failure should be structured");
        assert_eq!(result.get("kind").and_then(Value::as_str), Some("failed"));
        assert_eq!(
            result.get("reason").and_then(Value::as_str),
            Some("rollbackFailed")
        );
        assert_eq!(
            result.get("rollback").and_then(Value::as_str),
            Some("failed")
        );
        let managed_path = result
            .get("managedPath")
            .and_then(Value::as_str)
            .expect("rollback failure managed path");
        let archive_path = result
            .get("archivePath")
            .and_then(Value::as_str)
            .expect("rollback failure archive path");
        let replacement_residual_path = result
            .get("replacementResidualPath")
            .and_then(Value::as_str)
            .expect("rollback failure replacement residual path");
        assert_eq!(managed_path, source.to_string_lossy());
        assert!(Path::new(archive_path).is_dir());
        assert!(Path::new(replacement_residual_path).is_dir());
        assert!(!source.exists());
    }

    #[test]
    fn public_desktop_replacement_skips_an_uncomparable_managed_child() {
        let desktop = TestDesktopApp::new();
        let selected_save = desktop.root().join("selected-slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &selected_save).expect("copy selected Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        fs::create_dir_all(managed_root.join("a-uncomparable")).expect("create malformed child");
        fs::create_dir_all(managed_root.join("b-valid")).expect("create valid child");
        let timestamp = test_initialization_time();
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        workflow.configure_replacement_command(
            selected_save,
            replacement_discovery_fixture_launch(desktop.root()),
            timestamp,
        );

        let result: Value = desktop
            .invoke(
                "desktop_archive_and_reinitialize_managed_repository",
                json!({ "input": { "confirmation": REPLACEMENT_CONFIRMATION } }),
            )
            .expect("public replacement should skip an uncomparable child");
        assert_eq!(
            result.get("kind").and_then(Value::as_str),
            Some("succeeded")
        );
        assert_eq!(
            result.get("managedPath").and_then(Value::as_str),
            Some(managed_root.join("b-valid").to_string_lossy().as_ref(),)
        );
        assert!(
            fs::read_to_string(desktop.root().join("uncomparable-comparison"))
                .is_ok_and(|contents| contents == "seen")
        );
        assert!(managed_root.join("a-uncomparable").is_dir());
        assert!(!managed_root.join("b-valid").exists());
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close after source discovery");
    }

    #[test]
    fn public_desktop_archive_drains_an_admitted_checkpoint_before_moving() {
        let desktop = TestDesktopApp::new();
        let save_path = desktop.root().join("slot.dat");
        let fixture = workspace_root()
            .expect("workspace root")
            .join("packages/core/src/decode/fixtures/minimal-valid-save.dat");
        fs::copy(&fixture, &save_path).expect("copy Encoded Save fixture");
        let managed_root = desktop.root().join("repositories");
        let timestamp = test_initialization_time();
        let source_name = managed_repository_name(&save_path, timestamp);
        let workflow = desktop.app.state::<super::DesktopWorkflow>();
        assert!(matches!(
            workflow.initialize_managed_repository_with_launch(
                save_path,
                managed_root.clone(),
                real_sidecar_launch(),
                timestamp,
            ),
            Ok(ManagedInitializationResult::Initialized)
        ));
        let connection: super::RepoSessionConnection = desktop
            .invoke("desktop_get_repo_session_connection", json!({}))
            .expect("public Desktop connection should be available");

        let checkpoint_body = r#"{"allowUnchanged":true}"#;
        let (mut checkpoint, mut checkpoint_response) =
            begin_admitted_checkpoint(&connection, checkpoint_body);
        let archive_webview = desktop.webview.clone();
        let archive_name = source_name.clone();
        let archive = thread::spawn(move || {
            invoke_public_desktop_command::<Value>(
                &archive_webview,
                "desktop_archive_repository",
                json!({
                    "input": { "lifecycle": "managed", "name": archive_name },
                }),
            )
        });

        let admission_deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !http_admission_is_closed(&connection) {
            assert!(
                std::time::Instant::now() < admission_deadline,
                "archive should close Repo Session HTTP admission"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            managed_root.join(&source_name).is_dir(),
            "the source must remain until admitted work drains and the session closes"
        );

        checkpoint
            .write_all(checkpoint_body.as_bytes())
            .expect("finish admitted checkpoint body");
        checkpoint
            .shutdown(Shutdown::Write)
            .expect("finish checkpoint request");
        checkpoint
            .read_to_end(&mut checkpoint_response)
            .expect("read admitted checkpoint response");

        let archived = archive
            .join()
            .expect("public archive command thread")
            .expect("public archive command result");
        let archived_name = archived
            .get("name")
            .and_then(Value::as_str)
            .expect("archived result name")
            .to_owned();
        assert!(!managed_root.join(&source_name).exists());
        assert!(
            desktop
                .root()
                .join("archives")
                .join(&archived_name)
                .is_dir()
        );

        let library: Value = desktop
            .invoke("desktop_get_repository_library", json!({}))
            .expect("public library refresh after archive");
        assert!(
            library
                .get("archived")
                .and_then(Value::as_array)
                .is_some_and(|entries| entries.iter().any(|entry| {
                    entry.get("name").and_then(Value::as_str) == Some(archived_name.as_str())
                }))
        );
        let opened: Value = desktop
            .invoke(
                "desktop_open_library_entry",
                json!({
                    "input": {
                        "lifecycle": "archived",
                        "name": archived_name,
                        "intent": "open",
                    },
                }),
            )
            .expect("public archived reader open");
        assert_eq!(opened.get("kind").and_then(Value::as_str), Some("opened"));
        let archived_connection: super::RepoSessionConnection = desktop
            .invoke("desktop_get_repo_session_connection", json!({}))
            .expect("public archived connection");
        let (status, observations) =
            node_http_request(&archived_connection, "GET", "/api/v1/observations", None);
        assert_eq!(status, 200);
        let observations: Value =
            serde_json::from_slice(&observations).expect("parse observations");
        let entries = observations
            .get("entries")
            .and_then(Value::as_array)
            .expect("observation entries");
        assert_eq!(entries.len(), 2, "archive must not add a final observation");
        assert_eq!(
            entries[0]
                .pointer("/observation/trigger")
                .and_then(Value::as_str),
            Some("manualCheckpoint"),
            "the already-admitted checkpoint must complete before the move"
        );
        desktop
            .invoke::<Value>("desktop_close_repository", json!({}))
            .expect("public Desktop close should stop archived reader");
    }

    #[cfg(unix)]
    #[test]
    fn real_desktop_archive_rejects_unsafe_sources_and_keeps_failed_moves_in_place() {
        use std::os::unix::fs::symlink;

        let desktop = TestDesktopApp::new();
        let managed_root = desktop.root().join("repositories");
        let archives_root = desktop.root().join("archives");
        fs::create_dir_all(&managed_root).expect("create managed root");
        fs::create_dir(&archives_root).expect("create archives root");
        let source_name = "x".repeat(240);
        let source = managed_root.join(&source_name);
        fs::create_dir(&source).expect("create long-name managed child");
        fs::write(source.join("keep"), b"unchanged").expect("write source marker");
        symlink(&source, managed_root.join("linked")).expect("create managed symlink");
        for name in ["linked".to_owned(), "../outside".to_owned()] {
            assert!(
                desktop
                    .invoke::<Value>(
                        "desktop_archive_repository",
                        json!({ "input": { "lifecycle": "managed", "name": name } }),
                    )
                    .is_err()
            );
        }

        let failed: Value = desktop
            .invoke(
                "desktop_archive_repository",
                json!({ "input": { "lifecycle": "managed", "name": source_name } }),
            )
            .expect("move failure is a structured public Desktop result");
        assert_eq!(failed.get("kind").and_then(Value::as_str), Some("failed"));
        assert_eq!(
            failed.get("reason").and_then(Value::as_str),
            Some("moveFailed")
        );
        assert_eq!(
            fs::read(source.join("keep")).expect("failed source remains"),
            b"unchanged"
        );
        assert_eq!(
            fs::read_dir(&archives_root)
                .expect("read archives root")
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_public_library_scan_classifies_only_archive_child_directories_as_archived() {
        use std::os::unix::fs::symlink;

        let desktop = TestDesktopApp::new();
        let managed_root = desktop.root().join("repositories");
        let archives_root = desktop.root().join("archives");
        let opaque = managed_root.join("opaque");
        fs::create_dir_all(&opaque).expect("create opaque managed child");
        fs::create_dir(&archives_root).expect("create archives root");
        fs::write(opaque.join("keep"), b"opaque").expect("write opaque marker");
        let result: Value = desktop
            .invoke(
                "desktop_archive_repository",
                json!({ "input": { "lifecycle": "managed", "name": "opaque" } }),
            )
            .expect("public Desktop uninspectable archive move should succeed");
        let archived_name = result
            .get("name")
            .and_then(Value::as_str)
            .expect("archived result name")
            .to_owned();
        fs::write(archives_root.join("not-a-directory"), b"opaque")
            .expect("write regular archive child");
        symlink(
            archives_root.join(&archived_name),
            archives_root.join("linked-directory"),
        )
        .expect("create archive symlink child");

        let library: Value = desktop
            .invoke("desktop_get_repository_library", json!({}))
            .expect("public Desktop library scan should succeed");
        let archived = library
            .get("archived")
            .and_then(Value::as_array)
            .expect("archived entries");
        assert_eq!(archived.len(), 1);
        assert_eq!(
            archived[0].get("name").and_then(Value::as_str),
            Some(archived_name.as_str())
        );
        assert_eq!(
            archived[0].get("status").and_then(Value::as_str),
            Some("invalid")
        );

        let attention = library
            .get("attention")
            .and_then(Value::as_array)
            .expect("attention entries");
        assert_eq!(attention.len(), 2);
        for name in ["linked-directory", "not-a-directory"] {
            assert!(attention.iter().any(|entry| {
                entry.get("name").and_then(Value::as_str) == Some(name)
                    && entry.get("status").and_then(Value::as_str) == Some("invalid")
            }));
        }
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
  write({{ protocolVersion: 11, kind: "response", requestId, ok: true, result }});
}}
function failure(requestId, code, message) {{
  write({{ protocolVersion: 11, kind: "response", requestId, ok: false, error: {{ code, message }} }});
}}

write({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }});
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

    fn replacement_fixture_launch(
        temp: &Path,
        initialization: &str,
        rollback: &str,
        leave_residual: bool,
    ) -> SidecarLaunch {
        let script = temp.join(format!(
            "replacement-sidecar-{}.mjs",
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(
            &script,
            replacement_fixture_sidecar_source(initialization, rollback, leave_residual),
        )
        .expect("write replacement fixture");
        SidecarLaunch::Development {
            entry: script,
            node: PathBuf::from("node"),
        }
    }

    fn replacement_discovery_fixture_launch(temp: &Path) -> SidecarLaunch {
        let script = temp.join(format!(
            "replacement-discovery-sidecar-{}.mjs",
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let comparison_marker =
            serde_json::to_string(&temp.join("uncomparable-comparison").to_string_lossy())
                .expect("serialize comparison marker path");
        let source = r#"
import fs from "node:fs";
import path from "node:path";
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function response(requestId, result) {
  write({ protocolVersion: 11, kind: "response", requestId, ok: true, result });
}
function failure(requestId) {
  write({ protocolVersion: 11, kind: "response", requestId, ok: false, error: { code: "repository_watched_save_compare_failed", message: "uncomparable Watched Save should be skipped" } });
}
function inspection() {
  return { status: "ready", requiredAction: "open", capabilities: ["read", "write"] };
}
const comparisonMarker = __COMPARISON_MARKER__;
let sourcePath;
let archivePath;

write({ protocolVersion: 11, kind: "event", event: { type: "process.ready" } });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.command.type === "save.inspect") {
      response(request.requestId, { type: "save.inspected", decodedSave: { player: "Hornet" } });
    } else if (request.command.type === "repository.inspect") {
      response(request.requestId, { type: "repository.inspected", inspection: inspection() });
    } else if (request.command.type === "repository.compareWatchedSave") {
      if (request.command.repoPath.includes("a-uncomparable")) {
        fs.writeFileSync(comparisonMarker, "seen");
        failure(request.requestId);
      } else {
        response(request.requestId, { type: "repository.watchedSaveCompared", same: true });
      }
    } else if (request.command.type === "repository.replacement.prepare") {
      sourcePath = request.command.sourcePath;
      archivePath = request.command.targetPath;
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.renameSync(sourcePath, archivePath);
      response(request.requestId, { type: "repository.replacementPrepared", preparation: { status: "prepared", destinationPath: archivePath, sourceStatus: "ready" } });
    } else if (request.command.type === "repository.initialize") {
      response(request.requestId, { type: "repository.initializationResult", initialization: { status: "initialized" } });
    } else if (request.command.type === "session.open") {
      response(request.requestId, { type: "session.opened", access: request.command.access, connection: { endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" } });
    } else if (request.command.type === "watcher.start") {
      response(request.requestId, { type: "watcher.started" });
    } else if (request.command.type === "repository.replacement.resolve") {
      response(request.requestId, { type: "repository.replacementResolved", resolution: { status: "committed", sourcePath, destinationPath: archivePath } });
    } else if (request.command.type === "process.shutdown") {
      response(request.requestId, { type: "process.shutdownComplete" });
      process.exit(0);
    }
  }
});
"#
        .replace("__COMPARISON_MARKER__", &comparison_marker);
        fs::write(&script, source).expect("write discovery fixture");
        SidecarLaunch::Development {
            entry: script,
            node: PathBuf::from("node"),
        }
    }

    fn replacement_fixture_sidecar_source(
        initialization: &str,
        rollback: &str,
        leave_residual: bool,
    ) -> String {
        format!(
            r#"
import fs from "node:fs";
import path from "node:path";
const initialization = {initialization:?};
const rollback = {rollback:?};
const leaveResidual = {leave_residual};
let sourcePath;
let archivePath;

function write(message) {{
  process.stdout.write(JSON.stringify(message) + "\n");
}}
function response(requestId, result) {{
  write({{ protocolVersion: 11, kind: "response", requestId, ok: true, result }});
}}
function failure(requestId, code, message) {{
  write({{ protocolVersion: 11, kind: "response", requestId, ok: false, error: {{ code, message }} }});
}}

write({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }});
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
      response(request.requestId, {{ type: "save.inspected", decodedSave: {{ player: "Hornet" }} }});
      continue;
    }}
    if (type === "repository.inspect") {{
      response(request.requestId, {{
        type: "repository.inspected",
        inspection: {{ status: "ready", requiredAction: "open", capabilities: ["read", "write"] }},
      }});
      continue;
    }}
    if (type === "repository.compareWatchedSave") {{
      response(request.requestId, {{ type: "repository.watchedSaveCompared", same: true }});
      continue;
    }}
    if (type === "repository.replacement.prepare") {{
      sourcePath = request.command.sourcePath;
      archivePath = request.command.targetPath;
      fs.mkdirSync(path.dirname(archivePath), {{ recursive: true }});
      fs.renameSync(sourcePath, archivePath);
      response(request.requestId, {{
        type: "repository.replacementPrepared",
        preparation: {{ status: "prepared", destinationPath: archivePath, sourceStatus: "ready" }},
      }});
      continue;
    }}
    if (type === "repository.initialize") {{
      if (initialization !== "success") {{
        if (leaveResidual) {{
          const replacementPath = `${{request.command.repoPath}}.other`;
          fs.mkdirSync(replacementPath);
          fs.writeFileSync(path.join(replacementPath, "residual"), "keep");
          fs.rmSync(request.command.repoPath, {{ recursive: true, force: true }});
          fs.renameSync(replacementPath, request.command.repoPath);
        }}
        response(request.requestId, {{
          type: "repository.initializationResult",
          initialization: {{
            status: "failed",
            phase: initialization === "repository" ? "repository" : "baseline",
            reason: initialization === "repository" ? "historyFailed" : "observationFailed",
          }},
        }});
      }} else {{
        response(request.requestId, {{ type: "repository.initializationResult", initialization: {{ status: "initialized" }} }});
      }}
      continue;
    }}
    if (type === "session.open") {{
      response(request.requestId, {{ type: "session.opened", access: request.command.access, connection: {{ endpoint: "http://127.0.0.1:4312", bearerToken: "test-token" }} }});
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
    if (type === "repository.replacement.resolve") {{
      if (request.command.decision === "rollback") {{
        if (rollback === "failed") {{
          response(request.requestId, {{
            type: "repository.replacementResolved",
            resolution: {{ status: "rollbackFailed", sourcePath, destinationPath: archivePath, message: "fixture rollback failed" }},
          }});
        }} else {{
          fs.renameSync(archivePath, sourcePath);
          response(request.requestId, {{
            type: "repository.replacementResolved",
            resolution: {{ status: "rolledBack", sourcePath, destinationPath: archivePath }},
          }});
        }}
      }} else {{
        response(request.requestId, {{
          type: "repository.replacementResolved",
          resolution: {{ status: "committed", sourcePath, destinationPath: archivePath }},
        }});
      }}
      continue;
    }}
    if (type === "process.shutdown") {{
      response(request.requestId, {{ type: "process.shutdownComplete" }});
      process.exit(0);
    }}
    failure(request.requestId, "unknown_command", `fixture command was unexpected: ${{type}}`);
  }}
}});
"#,
            initialization = initialization,
            rollback = rollback,
            leave_residual = leave_residual,
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
  write({{ protocolVersion: 11, kind: "response", requestId, ok: true, result }});
}}
function failure(requestId, code, message) {{
  write({{ protocolVersion: 11, kind: "response", requestId, ok: false, error: {{ code, message }} }});
}}
function mutation(status) {{
  write({{ protocolVersion: 11, kind: "event", event: {{ type: "mutation.activity", mutation: "repositoryRebuild", status }} }});
}}
function inspection() {{
  const ready = repositoryStatus === "ready";
  return {{
    status: ready ? "ready" : "rebuildRequired",
    requiredAction: ready ? "open" : "rebuildReadModel",
    capabilities: ready ? ["read"] : ["read", "rebuildReadModel"],
  }};
}}

write({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }});
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
process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
      process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }} else {{
      result = {{ type: request.command.type === "watcher.start" ? "watcher.started" : "watcher.stopped" }};
    }}
    process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
    if (request.command.type === "session.open" && {status:?} === "mutation") {{
      process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "event", event: {{ type: "mutation.activity", mutation: "manualCheckpoint", status: "started" }} }}) + "\n");
    }}
  }}
}});
"#
        )
    }

    fn import_fixture_sidecar_source(source: &str, duplicate: bool) -> String {
        import_fixture_sidecar_source_with_failure(source, duplicate, "none")
    }

    fn import_fixture_sidecar_source_with_failure(
        source: &str,
        duplicate: bool,
        failure: &str,
    ) -> String {
        let source = serde_json::to_string(source).expect("serialize source path");
        let failure = serde_json::to_string(failure).expect("serialize import failure");
        format!(
            r#"
import fs from "node:fs";
const source = {source};
const duplicate = {duplicate};
const failure = {failure};
const failureKind = failure.replace(/-cleanup$/, "");
const cleanupFailure = failure.endsWith("-cleanup") ? "leaseReleaseFailed" : undefined;
process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
let buffer = "";
function response(request, result) {{
  process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
}}
function failureResponse(request, code, message) {{
  process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: false, error: {{ code, message }} }}) + "\n");
}}
process.stdin.on("data", (chunk) => {{
  buffer += chunk;
  for (;;) {{
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const command = request.command;
    if (command.type === "repository.inspect") {{
      if (failureKind === "inspection" || (failureKind === "status" && command.repoPath !== source)) {{
        failureResponse(request, "repository_inspect_failed", "fixture inspection failed");
        continue;
      }}
      const status = command.repoPath === source ? "ready" : "rebuildRequired";
      response(request, {{ type: "repository.inspected", inspection: {{
        status,
        requiredAction: status === "ready" ? "open" : "rebuildReadModel",
        capabilities: ["read"]
      }} }});
      continue;
    }}
    if (command.type === "repository.compareWatchedSaveRepositories") {{
      if (failureKind === "duplicate") {{
        failureResponse(request, "repository_watched_save_repositories_compare_failed", "fixture duplicate check failed");
        continue;
      }}
      response(request, {{ type: "repository.watchedSaveRepositoriesCompared", same: duplicate }});
      continue;
    }}
    if (command.type === "repository.import") {{
      if (failureKind === "command") {{
        failureResponse(request, "repository_import_failed", "fixture import command failed");
        continue;
      }}
      fs.cpSync(command.sourcePath, command.targetPath, {{ recursive: true }});
      response(request, {{ type: "repository.importResult", import: {{
        status: "copied",
        sourceStatus: "ready",
        snapshot: {{ repoPath: command.targetPath, directoryDigest: "a".repeat(64) }},
        ...(cleanupFailure === undefined ? {{}} : {{ cleanupFailure }})
      }} }});
      continue;
    }}
    if (command.type === "process.shutdown") {{
      if (failureKind === "shutdown") {{
        failureResponse(request, "shutdown_failed", "fixture shutdown failed");
        continue;
      }}
      response(request, {{ type: "process.shutdownComplete" }});
      process.exit(0);
    }}
    throw new Error("unexpected import fixture command");
  }}
}});
"#,
            source = source,
            duplicate = duplicate,
            failure = failure,
        )
    }

    fn unexpected_exit_fixture_sidecar_source(repository: &str) -> String {
        let repository = serde_json::to_string(repository).expect("serialize repository path");
        format!(
            r#"
const repository = {repository};
process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
  process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
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
process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "event", event: {{ type: "process.ready" }} }}) + "\n");
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
  process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      continue;
    }}
    if (request.command.type === "session.open") {{
      const error = {{
        protocolVersion: 11,
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
      process.stdout.write(JSON.stringify({{ protocolVersion: 11, kind: "response", requestId: request.requestId, ok: true, result }}) + "\n");
      process.exit(0);
    }}
    throw new Error("unexpected candidate command");
  }}
}});
"#
        )
    }

    fn real_sidecar_launch() -> SidecarLaunch {
        development_sidecar_launch(workspace_root().expect("workspace root"))
            .expect("built Desktop sidecar")
    }

    fn node_http_request(
        connection: &super::RepoSessionConnection,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> (u16, Vec<u8>) {
        let output = Command::new(if cfg!(windows) { "node.exe" } else { "node" })
            .arg("--input-type=module")
            .arg("--eval")
            .arg(
                r#"
const [endpoint, token, method, path, body] = process.argv.slice(1);
const response = await fetch(`${endpoint}${path}`, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body === "" ? {} : { "Content-Type": "application/json" }),
  },
  ...(body === "" ? {} : { body }),
});
process.stdout.write(`${response.status}\n`);
process.stdout.write(Buffer.from(await response.arrayBuffer()));
"#,
            )
            .args([
                &connection.endpoint,
                &connection.token,
                method,
                path,
                body.unwrap_or(""),
            ])
            .output()
            .expect("run Node HTTP client");
        assert!(
            output.status.success(),
            "Node HTTP client failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
        let newline = output
            .stdout
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("HTTP status separator");
        let status = std::str::from_utf8(&output.stdout[..newline])
            .expect("UTF-8 HTTP status")
            .parse()
            .expect("numeric HTTP status");
        (status, output.stdout[(newline + 1)..].to_vec())
    }

    fn begin_admitted_checkpoint(
        connection: &super::RepoSessionConnection,
        body: &str,
    ) -> (TcpStream, Vec<u8>) {
        let address = connection
            .endpoint
            .strip_prefix("http://")
            .expect("loopback HTTP endpoint");
        let mut socket = TcpStream::connect(address).expect("connect admitted checkpoint");
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("set checkpoint read timeout");
        write!(
            socket,
            "POST /api/v1/checkpoints HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nExpect: 100-continue\r\n\r\n",
            connection.token,
            body.len(),
        )
        .expect("send admitted checkpoint headers");

        let mut response = Vec::new();
        while !String::from_utf8_lossy(&response).contains("100 Continue") {
            let mut chunk = [0_u8; 1024];
            let read = socket.read(&mut chunk).expect("read checkpoint admission");
            assert!(read > 0, "checkpoint closed before admission");
            response.extend_from_slice(&chunk[..read]);
        }
        (socket, response)
    }

    fn http_admission_is_closed(connection: &super::RepoSessionConnection) -> bool {
        let address = connection
            .endpoint
            .strip_prefix("http://")
            .expect("loopback HTTP endpoint");
        let Ok(mut socket) = TcpStream::connect(address) else {
            return true;
        };
        let _ = socket.set_read_timeout(Some(Duration::from_millis(100)));
        if write!(
            socket,
            "GET /api/v1/watcher HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            connection.token,
        )
        .is_err()
        {
            return true;
        }
        let _ = socket.shutdown(Shutdown::Write);
        let mut response = String::new();
        match socket.read_to_string(&mut response) {
            Ok(_) => response.contains(" 503 ") || response.is_empty(),
            Err(error) => !matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
        }
    }

    struct TestDesktopApp {
        app: App<MockRuntime>,
        webview: WebviewWindow<MockRuntime>,
        root: PathBuf,
    }

    impl TestDesktopApp {
        fn new() -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let mut context = mock_context(noop_assets());
            context.config_mut().identifier = format!(
                "io.github.ffff2004.silksong-git-test-{}-{sequence}",
                std::process::id()
            );
            let app = mock_builder()
                .manage(super::DesktopWorkflow {
                    state: Default::default(),
                    archive_clock: Box::new(FixedArchiveClock(test_initialization_time())),
                    replacement_test_input: Mutex::new(None),
                })
                .invoke_handler(tauri::generate_handler![
                    super::desktop_get_repo_session_connection,
                    super::desktop_get_repository_library,
                    super::desktop_open_library_entry,
                    super::desktop_archive_repository,
                    super::desktop_archive_and_reinitialize_managed_repository,
                    super::desktop_close_repository,
                    super::desktop_start_watching,
                    super::desktop_stop_watching,
                ])
                .build(context)
                .expect("build mock Desktop App");
            let menu = crate::install_repository_menu(&app).expect("install test repository menu");
            app.manage(menu);
            let webview = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .expect("build mock Desktop WebView");
            let root = app
                .path()
                .app_local_data_dir()
                .expect("resolve mock App Local Data");
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("create mock App Local Data");
            Self { app, webview, root }
        }

        fn root(&self) -> &Path {
            &self.root
        }

        fn invoke<T: DeserializeOwned>(&self, command: &str, body: Value) -> Result<T, Value> {
            invoke_public_desktop_command(&self.webview, command, body)
        }
    }

    fn invoke_public_desktop_command<T: DeserializeOwned>(
        webview: &WebviewWindow<MockRuntime>,
        command: &str,
        body: Value,
    ) -> Result<T, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("valid test IPC URL"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().expect("deserialize IPC response"))
    }

    impl Drop for TestDesktopApp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
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
