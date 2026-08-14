//! Production-shaped Desktop runtime layout resolution and preflight.
//!
//! This module deliberately knows nothing about Tauri windows or repository
//! workflows. Adapters supply installation lookup and owned-process behavior;
//! this module returns either one immutable launch plan or a path-free failure
//! code.

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fmt::{Display, Formatter},
    fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    str::FromStr,
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize, de};
use serde_json::{Value, json};

use crate::desktop_sidecar_protocol::VERSION as PROTOCOL_VERSION;

pub(crate) const NODE_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const GIT_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_STREAM_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_QUEUED_FRAMES: usize = 16;
const NODE_PROBE_SCRIPT: &str = r#"
const nodeMajor = Number(process.versions.node.split('.')[0]);
let sqlite = 'unavailable';
try {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE probe (value TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO probe (value) VALUES (?)');
  insert.run('ready');
  const select = database.prepare('SELECT value FROM probe');
  const row = select.get();
  if (row.value !== 'ready') throw new Error('unexpected probe value');
  database.close();
  sqlite = 'prepared-write-read-close';
} catch {}
process.stdout.write(JSON.stringify({ nodeMajor, sqlite }) + '\n');
if (sqlite !== 'prepared-write-read-close') process.exitCode = 1;
"#;

#[derive(Clone, Copy)]
pub struct RuntimePreflightLimits {
    node: Duration,
    git: Duration,
    ready: Duration,
    shutdown: Duration,
}

impl RuntimePreflightLimits {
    pub const fn new(node: Duration, git: Duration, ready: Duration, shutdown: Duration) -> Self {
        Self {
            node,
            git,
            ready,
            shutdown,
        }
    }
}

const DEFAULT_PREFLIGHT_LIMITS: RuntimePreflightLimits = RuntimePreflightLimits {
    node: NODE_PREFLIGHT_TIMEOUT,
    git: GIT_PREFLIGHT_TIMEOUT,
    ready: READY_TIMEOUT,
    shutdown: SHUTDOWN_TIMEOUT,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenEnvironment(BTreeMap<OsString, OsString>);

impl FrozenEnvironment {
    pub(crate) fn capture(git: Option<&Path>) -> Self {
        Self::from_entries(std::env::vars_os(), git)
    }

    fn from_entries(
        entries: impl IntoIterator<Item = (OsString, OsString)>,
        git: Option<&Path>,
    ) -> Self {
        let mut values = entries
            .into_iter()
            .filter(|(key, _)| !is_node_or_path_key(key))
            .collect::<BTreeMap<_, _>>();
        if let Some(git) = git {
            // This is deliberately the manifest-owned Git directory rather
            // than an inherited search path: the bundled sidecar's business
            // Git must be the bundled Git that preflight checked.
            values.insert(
                OsString::from("PATH"),
                git.parent()
                    .expect("manifest Git path always has a parent")
                    .as_os_str()
                    .to_os_string(),
            );
        }
        Self(values)
    }

    fn apply(&self, command: &mut Command) {
        command.env_clear().envs(&self.0);
    }
}

fn is_node_or_path_key(key: &OsStr) -> bool {
    key.to_string_lossy()
        .to_ascii_uppercase()
        .starts_with("NODE_")
        || key.to_string_lossy().eq_ignore_ascii_case("PATH")
}

/// Owns launch and reaping policy for preflight children. Common protocol code
/// depends only on this seam; platform process-tree mechanics stay in adapters.
pub trait OwnedProcessAdapter: Send + Sync {
    fn spawn(&self, command: &mut Command) -> Result<Child, RuntimePreflightError>;
    /// Returns true only when the adapter could not confirm full cleanup.
    fn cleanup(&self, child: &mut Child) -> bool;
}

pub struct PlatformOwnedProcessAdapter;

impl OwnedProcessAdapter for PlatformOwnedProcessAdapter {
    fn spawn(&self, command: &mut Command) -> Result<Child, RuntimePreflightError> {
        platform_process::spawn(command)
    }

    fn cleanup(&self, child: &mut Child) -> bool {
        platform_process::cleanup(child)
    }
}

static PLATFORM_PROCESS_ADAPTER: PlatformOwnedProcessAdapter = PlatformOwnedProcessAdapter;

/// The only platform-specific inputs to layout resolution.
pub trait RuntimeLayoutAdapter {
    /// The platform-owned resource root. Every layout is read from the fixed
    /// `resourceRoot/runtime/manifest.json` location beneath this directory.
    fn resource_root(&self) -> &Path;
    fn runtime_root(&self) -> PathBuf {
        self.resource_root().join("runtime")
    }
    fn manifest_path(&self) -> PathBuf {
        self.runtime_root().join("manifest.json")
    }
    /// Select the system Node executable once from the launch environment.
    /// It must already be absolute because launch environments do not inherit
    /// `PATH` after the final environment is frozen.
    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError>;
    /// Select the system Git executable once from the launch environment.
    fn git_program(&self) -> Result<PathBuf, RuntimePreflightError>;
    fn process_adapter(&self) -> &dyn OwnedProcessAdapter {
        &PLATFORM_PROCESS_ADAPTER
    }
}

/// Selects a system executable using the platform's normal command lookup.
/// The production implementation is deliberately tiny; the seam lets the
/// public preflight tests observe selection without replacing process or
/// protocol behavior.
pub trait SystemExecutableSelector {
    fn select(&self, name: &str) -> Option<PathBuf>;
}

struct WhichSystemExecutableSelector;

impl SystemExecutableSelector for WhichSystemExecutableSelector {
    fn select(&self, name: &str) -> Option<PathBuf> {
        which::which(name).ok()
    }
}

/// The one Tauri resource-root adapter used by both development and installed
/// Desktop execution. Tauri supplies its `resource_dir`; development differs
/// only because Tauri copies the staged simulated tree there.
///
pub struct TauriResourceRuntimeLayoutAdapter {
    resource_root: PathBuf,
    system_executable_selector: Box<dyn SystemExecutableSelector>,
}

impl TauriResourceRuntimeLayoutAdapter {
    pub fn new(resource_root: PathBuf) -> Self {
        Self::with_system_executable_selector(resource_root, WhichSystemExecutableSelector)
    }

    pub fn with_system_executable_selector(
        resource_root: PathBuf,
        selector: impl SystemExecutableSelector + 'static,
    ) -> Self {
        Self {
            resource_root,
            system_executable_selector: Box::new(selector),
        }
    }
}

impl RuntimeLayoutAdapter for TauriResourceRuntimeLayoutAdapter {
    fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError> {
        select_system_program(
            self.system_executable_selector.as_ref(),
            "node",
            RuntimePreflightErrorCode::NodeUnavailable,
        )
    }

    fn git_program(&self) -> Result<PathBuf, RuntimePreflightError> {
        select_system_program(
            self.system_executable_selector.as_ref(),
            "git",
            RuntimePreflightErrorCode::GitUnavailable,
        )
    }
}

fn select_system_program(
    selector: &dyn SystemExecutableSelector,
    name: &str,
    unavailable_code: RuntimePreflightErrorCode,
) -> Result<PathBuf, RuntimePreflightError> {
    let path = selector
        .select(name)
        .ok_or_else(|| RuntimePreflightError::new(unavailable_code))?;
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(RuntimePreflightError::new(unavailable_code))
    }
}

/// An already-resolved, preflighted runtime invocation.
///
/// Its representation remains private so callers cannot pair an arbitrary
/// Node executable with an entry point, or an executable with unrelated Git.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchPlan(ResolvedRuntimeLaunchPlan);

#[derive(Clone, Debug, PartialEq, Eq)]
enum ResolvedRuntimeLaunchPlan {
    SystemNodeEntry {
        node: PathBuf,
        entry: PathBuf,
        git: PathBuf,
        environment: FrozenEnvironment,
    },
    BundledExecutable {
        executable: PathBuf,
        git: PathBuf,
        environment: FrozenEnvironment,
    },
}

impl RuntimeLaunchPlan {
    /// Builds the command used by both the preflight probe and later Rust-side
    /// business sidecars. The plan is already frozen; this method does not
    /// rediscover executables or read the manifest.
    pub(crate) fn command(&self) -> Command {
        let (program, arguments, environment) = match &self.0 {
            ResolvedRuntimeLaunchPlan::SystemNodeEntry {
                node,
                entry,
                environment,
                ..
            } => (node, vec![entry.as_os_str()], environment),
            ResolvedRuntimeLaunchPlan::BundledExecutable {
                executable,
                environment,
                ..
            } => (executable, Vec::new(), environment),
        };
        let mut command = Command::new(program);
        command.args(arguments);
        environment.apply(&mut command);
        command
    }
}

#[derive(Clone, Debug)]
pub enum RuntimePreflight {
    Ready(RuntimeLaunchPlan),
    Unavailable(RuntimePreflightError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimePreflightErrorCode {
    ManifestUnavailable,
    ManifestInvalid,
    LayoutMismatch,
    RuntimeResourceUnavailable,
    NodeUnavailable,
    NodeVersionUnreadable,
    UnsupportedNodeMajor,
    NodeSqliteUnavailable,
    GitUnavailable,
    GitVersionUnreadable,
    UnsupportedGitVersion,
    SidecarSpawnFailed,
    SidecarReadyTimeout,
    SidecarProtocolMismatch,
    SidecarProtocolInvalid,
    SidecarShutdownFailed,
    SidecarOutputLimitExceeded,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimePreflightError {
    pub code: RuntimePreflightErrorCode,
    pub cleanup_incomplete: bool,
}

impl RuntimePreflightError {
    pub const fn new(code: RuntimePreflightErrorCode) -> Self {
        Self {
            code,
            cleanup_incomplete: false,
        }
    }

    fn with_cleanup(mut self, cleanup_incomplete: bool) -> Self {
        self.cleanup_incomplete = cleanup_incomplete;
        self
    }
}

impl Display for RuntimePreflightError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self.code {
            RuntimePreflightErrorCode::ManifestUnavailable => {
                "Desktop runtime layout is unavailable."
            }
            RuntimePreflightErrorCode::ManifestInvalid => "Desktop runtime layout is invalid.",
            RuntimePreflightErrorCode::LayoutMismatch => {
                "Desktop runtime layout does not match this build."
            }
            RuntimePreflightErrorCode::RuntimeResourceUnavailable => {
                "Desktop runtime resources are unavailable."
            }
            RuntimePreflightErrorCode::NodeUnavailable => {
                "The required Node.js runtime is unavailable."
            }
            RuntimePreflightErrorCode::NodeVersionUnreadable => {
                "The Node.js runtime version could not be verified."
            }
            RuntimePreflightErrorCode::UnsupportedNodeMajor => {
                "This Desktop build requires Node.js 24."
            }
            RuntimePreflightErrorCode::NodeSqliteUnavailable => {
                "The Node.js runtime does not provide the required SQLite support."
            }
            RuntimePreflightErrorCode::GitUnavailable => "The required Git runtime is unavailable.",
            RuntimePreflightErrorCode::GitVersionUnreadable => {
                "The Git runtime version could not be verified."
            }
            RuntimePreflightErrorCode::UnsupportedGitVersion => {
                "The installed Git runtime is not supported."
            }
            RuntimePreflightErrorCode::SidecarSpawnFailed => {
                "The Desktop Local History runtime could not start."
            }
            RuntimePreflightErrorCode::SidecarReadyTimeout => {
                "The Desktop Local History runtime did not become ready in time."
            }
            RuntimePreflightErrorCode::SidecarProtocolMismatch => {
                "The Desktop Local History runtime uses an incompatible protocol."
            }
            RuntimePreflightErrorCode::SidecarProtocolInvalid => {
                "The Desktop Local History runtime returned an invalid response."
            }
            RuntimePreflightErrorCode::SidecarShutdownFailed => {
                "The Desktop Local History runtime did not shut down cleanly."
            }
            RuntimePreflightErrorCode::SidecarOutputLimitExceeded => {
                "The Desktop Local History runtime produced unsafe output."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RuntimePreflightError {}

pub fn preflight(adapter: &impl RuntimeLayoutAdapter) -> RuntimePreflight {
    preflight_with_limits(adapter, DEFAULT_PREFLIGHT_LIMITS)
}

pub fn preflight_with_limits(
    adapter: &impl RuntimeLayoutAdapter,
    limits: RuntimePreflightLimits,
) -> RuntimePreflight {
    match resolve(adapter) {
        Ok(plan) => match probe(&plan, adapter.process_adapter(), limits) {
            Ok(()) => RuntimePreflight::Ready(plan),
            Err(error) => RuntimePreflight::Unavailable(error),
        },
        Err(error) => RuntimePreflight::Unavailable(error),
    }
}

fn resolve(
    adapter: &impl RuntimeLayoutAdapter,
) -> Result<RuntimeLaunchPlan, RuntimePreflightError> {
    if !adapter.resource_root().is_absolute() {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestUnavailable,
        ));
    }
    let manifest = read_manifest(&adapter.manifest_path())?;
    match manifest {
        Manifest::System { sidecar } => {
            ensure_system_build()?;
            // Complete both selections before returning either selection
            // failure. This keeps the startup contract exactly one lookup for
            // each command and, importantly, still performs no functional
            // validation until both entries are frozen.
            let node_result = adapter.node_program();
            let git_result = adapter.git_program();
            let node = node_result?;
            let git = git_result?;
            if !node.is_absolute() {
                return Err(RuntimePreflightError::new(
                    RuntimePreflightErrorCode::NodeUnavailable,
                ));
            }
            if !git.is_absolute() {
                return Err(RuntimePreflightError::new(
                    RuntimePreflightErrorCode::GitUnavailable,
                ));
            }
            Ok(RuntimeLaunchPlan(
                ResolvedRuntimeLaunchPlan::SystemNodeEntry {
                    node,
                    entry: resolve_resource(&adapter.runtime_root(), &sidecar)?,
                    environment: FrozenEnvironment::capture(Some(&git)),
                    git,
                },
            ))
        }
        Manifest::Bundled { sidecar, git } => {
            ensure_bundled_build()?;
            let git = resolve_resource(&adapter.runtime_root(), &git)?;
            Ok(RuntimeLaunchPlan(
                ResolvedRuntimeLaunchPlan::BundledExecutable {
                    executable: resolve_resource(&adapter.runtime_root(), &sidecar)?,
                    environment: FrozenEnvironment::capture(Some(&git)),
                    git,
                },
            ))
        }
    }
}

fn ensure_system_build() -> Result<(), RuntimePreflightError> {
    #[cfg(not(feature = "runtime-system"))]
    return Err(RuntimePreflightError::new(
        RuntimePreflightErrorCode::LayoutMismatch,
    ));
    #[cfg(feature = "runtime-system")]
    Ok(())
}

fn ensure_bundled_build() -> Result<(), RuntimePreflightError> {
    #[cfg(not(feature = "runtime-bundled"))]
    return Err(RuntimePreflightError::new(
        RuntimePreflightErrorCode::LayoutMismatch,
    ));
    #[cfg(feature = "runtime-bundled")]
    Ok(())
}

#[derive(Debug)]
enum Manifest {
    System {
        sidecar: Vec<String>,
    },
    Bundled {
        sidecar: Vec<String>,
        git: Vec<String>,
    },
}

fn read_manifest(path: &Path) -> Result<Manifest, RuntimePreflightError> {
    let metadata = fs::metadata(path)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestUnavailable))?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestInvalid,
        ));
    }
    let contents = fs::read(path)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestUnavailable))?;
    let mut deserializer = serde_json::Deserializer::from_slice(&contents);
    let value = StrictJsonValue::deserialize(&mut deserializer)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestInvalid))?;
    deserializer
        .end()
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestInvalid))?;
    parse_manifest(&value.0)
}

/// `serde_json::Value` normally accepts duplicate object keys by retaining the
/// last value. Layout manifests are a strict security boundary, so reject them
/// at every nesting level before validating their shape.
struct StrictJsonValue(Value);

impl<'de> Deserialize<'de> for StrictJsonValue {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;

        impl<'de> de::Visitor<'de> for StrictVisitor {
            type Value = StrictJsonValue;

            fn expecting(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON value without duplicate object keys")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictJsonValue(Value::Bool(value)))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictJsonValue(Value::Number(value.into())))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictJsonValue(Value::Number(value.into())))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| StrictJsonValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(StrictJsonValue(Value::String(value.to_owned())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictJsonValue(Value::String(value)))
            }

            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<StrictJsonValue>()? {
                    values.push(value.0);
                }
                Ok(StrictJsonValue(Value::Array(values)))
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, StrictJsonValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(de::Error::custom("duplicate JSON object key"));
                    }
                }
                Ok(StrictJsonValue(Value::Object(values)))
            }
        }

        deserializer.deserialize_any(StrictVisitor)
    }
}

fn parse_manifest(value: &Value) -> Result<Manifest, RuntimePreflightError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestInvalid))?;
    let layout_type = object_value(object, "layout")
        .and_then(Value::as_object)
        .and_then(|layout| object_value(layout, "type"))
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestInvalid))?;
    match layout_type {
        "system" => {
            exact_keys(object, &["layoutVersion", "layout", "sidecar"])?;
            exact_object_keys(object_value(object, "layout").unwrap(), &["type"])?;
            let sidecar = object_value(object, "sidecar").ok_or_else(malformed)?;
            exact_object_keys(sidecar, &["type", "path"])?;
            if sidecar.pointer("/type").and_then(Value::as_str) != Some("nodeEntry")
                || object_value(object, "layoutVersion").and_then(Value::as_u64) != Some(1)
            {
                return Err(RuntimePreflightError::new(
                    RuntimePreflightErrorCode::ManifestInvalid,
                ));
            }
            Ok(Manifest::System {
                sidecar: segments(sidecar.pointer("/path").ok_or_else(malformed)?)?,
            })
        }
        "bundled" => {
            exact_keys(object, &["layoutVersion", "layout", "sidecar", "git"])?;
            exact_object_keys(object_value(object, "layout").unwrap(), &["type"])?;
            let sidecar = object_value(object, "sidecar").ok_or_else(malformed)?;
            let git = object_value(object, "git").ok_or_else(malformed)?;
            exact_object_keys(sidecar, &["type", "path"])?;
            exact_object_keys(git, &["path"])?;
            if sidecar.pointer("/type").and_then(Value::as_str) != Some("embeddedExecutable")
                || object_value(object, "layoutVersion").and_then(Value::as_u64) != Some(1)
            {
                return Err(RuntimePreflightError::new(
                    RuntimePreflightErrorCode::ManifestInvalid,
                ));
            }
            Ok(Manifest::Bundled {
                sidecar: segments(sidecar.pointer("/path").ok_or_else(malformed)?)?,
                git: segments(git.pointer("/path").ok_or_else(malformed)?)?,
            })
        }
        _ => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestInvalid,
        )),
    }
}

fn malformed() -> RuntimePreflightError {
    RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestInvalid)
}

fn object_value<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key)
}

fn exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
) -> Result<(), RuntimePreflightError> {
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(malformed());
    }
    Ok(())
}

fn exact_object_keys(value: &Value, expected: &[&str]) -> Result<(), RuntimePreflightError> {
    value
        .as_object()
        .ok_or_else(malformed)
        .and_then(|object| exact_keys(object, expected))
}

fn segments(value: &Value) -> Result<Vec<String>, RuntimePreflightError> {
    let values = value.as_array().ok_or_else(malformed)?;
    if values.is_empty() {
        return Err(malformed());
    }
    values
        .iter()
        .map(|value| {
            let segment = value.as_str().ok_or_else(malformed)?;
            if segment.is_empty()
                || segment == "."
                || segment == ".."
                || segment.contains(['/', '\\', '\0'])
                || has_windows_drive_prefix(segment)
            {
                return Err(malformed());
            }
            Ok(segment.to_owned())
        })
        .collect()
}

fn has_windows_drive_prefix(segment: &str) -> bool {
    matches!(
        segment.as_bytes(),
        [drive, b':', ..] if drive.is_ascii_alphabetic()
    )
}

fn resolve_segments(root: &Path, segments: &[String]) -> Result<PathBuf, RuntimePreflightError> {
    if !root.is_absolute() {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestUnavailable,
        ));
    }
    // Do not canonicalize: copied installations may not exist yet and symlink
    // policy belongs to the platform adapter, not layout parsing.
    Ok(segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment)))
}

fn resolve_resource(root: &Path, segments: &[String]) -> Result<PathBuf, RuntimePreflightError> {
    let path = resolve_segments(root, segments)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(path),
        _ => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeResourceUnavailable,
        )),
    }
}

#[derive(Debug)]
struct ToolOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
}

#[derive(Clone, Copy)]
struct ToolErrorCodes {
    spawn: RuntimePreflightErrorCode,
    failure: RuntimePreflightErrorCode,
    output: RuntimePreflightErrorCode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeProbeOutput {
    #[serde(rename = "nodeMajor")]
    node_major: u64,
    sqlite: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct GitCoreVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

fn probe(
    plan: &RuntimeLaunchPlan,
    processes: &dyn OwnedProcessAdapter,
    limits: RuntimePreflightLimits,
) -> Result<(), RuntimePreflightError> {
    match &plan.0 {
        ResolvedRuntimeLaunchPlan::SystemNodeEntry {
            node,
            git,
            environment,
            ..
        } => {
            let node_output = run_tool(
                node,
                &[OsStr::new("--eval"), OsStr::new(NODE_PROBE_SCRIPT)],
                environment,
                limits.node,
                processes,
                ToolErrorCodes {
                    spawn: RuntimePreflightErrorCode::NodeUnavailable,
                    failure: RuntimePreflightErrorCode::NodeVersionUnreadable,
                    output: RuntimePreflightErrorCode::NodeVersionUnreadable,
                },
            )?;
            validate_node_probe(&node_output)?;
            let git_output = run_tool(
                git,
                &[OsStr::new("--version")],
                environment,
                limits.git,
                processes,
                ToolErrorCodes {
                    spawn: RuntimePreflightErrorCode::GitUnavailable,
                    failure: RuntimePreflightErrorCode::GitVersionUnreadable,
                    output: RuntimePreflightErrorCode::GitVersionUnreadable,
                },
            )?;
            validate_git_probe(&git_output)?;
        }
        ResolvedRuntimeLaunchPlan::BundledExecutable {
            git, environment, ..
        } => {
            let git_output = run_tool(
                git,
                &[OsStr::new("--version")],
                environment,
                limits.git,
                processes,
                ToolErrorCodes {
                    spawn: RuntimePreflightErrorCode::GitUnavailable,
                    failure: RuntimePreflightErrorCode::GitVersionUnreadable,
                    output: RuntimePreflightErrorCode::GitVersionUnreadable,
                },
            )?;
            validate_git_probe(&git_output)?;
        }
    }
    probe_sidecar(plan, processes, limits)
}

fn run_tool(
    program: &Path,
    arguments: &[&OsStr],
    environment: &FrozenEnvironment,
    timeout: Duration,
    processes: &dyn OwnedProcessAdapter,
    error_codes: ToolErrorCodes,
) -> Result<ToolOutput, RuntimePreflightError> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    environment.apply(&mut command);
    let mut child = processes
        .spawn(&mut command)
        .map_err(|_| RuntimePreflightError::new(error_codes.spawn))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let cleanup = processes.cleanup(&mut child);
            return Err(RuntimePreflightError::new(error_codes.spawn).with_cleanup(cleanup));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let cleanup = processes.cleanup(&mut child);
            return Err(RuntimePreflightError::new(error_codes.spawn).with_cleanup(cleanup));
        }
    };
    let stdout_reader = bounded_output(stdout);
    let stderr_reader = bounded_output(stderr);
    let result = wait_for_exit(&mut child, timeout);
    let cleanup = processes.cleanup(&mut child);
    let stdout_result = stdout_reader.recv_timeout(Duration::from_secs(1));
    let stderr_result = stderr_reader.recv_timeout(Duration::from_secs(1));
    let outcome = match (stdout_result, stderr_result) {
        (Ok(Err(())), _) | (_, Ok(Err(()))) => Err(RuntimePreflightError::new(error_codes.output)),
        (Ok(Ok(stdout)), Ok(Ok(_stderr))) => match result {
            Ok(status) => Ok(ToolOutput { status, stdout }),
            Err(_) => Err(RuntimePreflightError::new(error_codes.failure)),
        },
        _ => Err(RuntimePreflightError::new(error_codes.failure)),
    };
    augment_cleanup(outcome, cleanup)
}

fn validate_node_probe(output: &ToolOutput) -> Result<(), RuntimePreflightError> {
    let result = parse_single_json_line::<NodeProbeOutput>(&output.stdout).ok_or_else(|| {
        RuntimePreflightError::new(RuntimePreflightErrorCode::NodeVersionUnreadable)
    })?;
    if result.node_major != 24 {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::UnsupportedNodeMajor,
        ));
    }
    if !output.status.success() || result.sqlite != "prepared-write-read-close" {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::NodeSqliteUnavailable,
        ));
    }
    Ok(())
}

fn validate_git_probe(output: &ToolOutput) -> Result<(), RuntimePreflightError> {
    let version = parse_git_version(&output.stdout).ok_or_else(|| {
        RuntimePreflightError::new(RuntimePreflightErrorCode::GitVersionUnreadable)
    })?;
    if !output.status.success() {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::GitVersionUnreadable,
        ));
    }
    if version
        < (GitCoreVersion {
            major: 2,
            minor: 34,
            patch: 0,
        })
        || version.major >= 3
    {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::UnsupportedGitVersion,
        ));
    }
    Ok(())
}

fn parse_single_json_line<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Option<T> {
    let text = std::str::from_utf8(bytes).ok()?;
    let line = text.strip_suffix('\n').unwrap_or(text);
    if line.contains(['\n', '\r']) {
        return None;
    }
    serde_json::from_str(line).ok()
}

fn parse_git_version(bytes: &[u8]) -> Option<GitCoreVersion> {
    let text = std::str::from_utf8(bytes).ok()?;
    let line = text.strip_suffix('\n').unwrap_or(text);
    if line.contains(['\n', '\r']) {
        return None;
    }
    let version = line.strip_prefix("git version ")?;
    let mut index = 0;
    let mut core = [0_u64; 3];
    for (part_index, part) in core.iter_mut().enumerate() {
        let start = index;
        while version
            .as_bytes()
            .get(index)
            .is_some_and(u8::is_ascii_digit)
        {
            index += 1;
        }
        if start == index {
            return None;
        }
        *part = u64::from_str(&version[start..index]).ok()?;
        if part_index < 2 {
            if version.as_bytes().get(index) != Some(&b'.') {
                return None;
            }
            index += 1;
        }
    }
    let suffix = &version[index..];
    if suffix.chars().any(char::is_control)
        || suffix
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || (suffix.starts_with('.')
            && suffix[1..]
                .chars()
                .all(|character| character == '.' || character.is_ascii_digit()))
    {
        return None;
    }
    Some(GitCoreVersion {
        major: core[0],
        minor: core[1],
        patch: core[2],
    })
}

fn probe_sidecar(
    plan: &RuntimeLaunchPlan,
    processes: &dyn OwnedProcessAdapter,
    limits: RuntimePreflightLimits,
) -> Result<(), RuntimePreflightError> {
    let mut command = plan.command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = processes
        .spawn(&mut command)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::SidecarSpawnFailed))?;
    let input = match child.stdin.take() {
        Some(input) => input,
        None => {
            let cleanup = processes.cleanup(&mut child);
            return Err(
                RuntimePreflightError::new(RuntimePreflightErrorCode::SidecarSpawnFailed)
                    .with_cleanup(cleanup),
            );
        }
    };
    let output = match child.stdout.take() {
        Some(output) => output,
        None => {
            let cleanup = processes.cleanup(&mut child);
            return Err(
                RuntimePreflightError::new(RuntimePreflightErrorCode::SidecarSpawnFailed)
                    .with_cleanup(cleanup),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let cleanup = processes.cleanup(&mut child);
            return Err(
                RuntimePreflightError::new(RuntimePreflightErrorCode::SidecarSpawnFailed)
                    .with_cleanup(cleanup),
            );
        }
    };
    let frames = bounded_frames(output);
    let stderr_reader = bounded_output(stderr);
    let outcome = probe_protocol(&mut child, input, &frames, limits);
    let cleanup = processes.cleanup(&mut child);
    let outcome = match stderr_reader.recv_timeout(Duration::from_secs(1)) {
        Ok(Err(())) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::SidecarOutputLimitExceeded,
        )),
        _ => outcome,
    };
    augment_cleanup(outcome, cleanup)
}

fn augment_cleanup<T>(
    outcome: Result<T, RuntimePreflightError>,
    cleanup_incomplete: bool,
) -> Result<T, RuntimePreflightError> {
    match outcome {
        Err(error) => Err(error.with_cleanup(cleanup_incomplete)),
        Ok(_) if cleanup_incomplete => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::SidecarShutdownFailed,
        )
        .with_cleanup(true)),
        Ok(value) => Ok(value),
    }
}

fn probe_protocol(
    child: &mut Child,
    mut input: ChildStdin,
    frames: &Receiver<Result<Value, RuntimePreflightErrorCode>>,
    limits: RuntimePreflightLimits,
) -> Result<(), RuntimePreflightError> {
    let ready = receive_frame(
        frames,
        limits.ready,
        RuntimePreflightErrorCode::SidecarReadyTimeout,
    )?;
    if !is_ready(&ready) {
        return Err(protocol_error(&ready));
    }
    if serde_json::to_writer(
        &mut input,
        &json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "command",
            "requestId": "runtime-layout-probe",
            "command": { "type": "process.shutdown" },
        }),
    )
    .is_err()
        || input.write_all(b"\n").is_err()
        || input.flush().is_err()
    {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::SidecarShutdownFailed,
        ));
    }
    let response = receive_frame(
        frames,
        limits.shutdown,
        RuntimePreflightErrorCode::SidecarShutdownFailed,
    )?;
    if !is_shutdown_complete(&response) {
        return Err(protocol_error(&response));
    }
    match wait_for_exit(child, limits.shutdown) {
        Ok(status) if status.success() => Ok(()),
        Ok(_) | Err(_) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::SidecarShutdownFailed,
        )),
    }
}

fn protocol_error(message: &Value) -> RuntimePreflightError {
    RuntimePreflightError::new(
        if message.get("protocolVersion").and_then(Value::as_u64)
            != Some(u64::from(PROTOCOL_VERSION))
        {
            RuntimePreflightErrorCode::SidecarProtocolMismatch
        } else {
            RuntimePreflightErrorCode::SidecarProtocolInvalid
        },
    )
}

fn is_ready(message: &Value) -> bool {
    message.get("protocolVersion").and_then(Value::as_u64) == Some(u64::from(PROTOCOL_VERSION))
        && message.get("kind").and_then(Value::as_str) == Some("event")
        && message.pointer("/event/type").and_then(Value::as_str) == Some("process.ready")
}

fn is_shutdown_complete(message: &Value) -> bool {
    message.get("protocolVersion").and_then(Value::as_u64) == Some(u64::from(PROTOCOL_VERSION))
        && message.get("kind").and_then(Value::as_str) == Some("response")
        && message.get("requestId").and_then(Value::as_str) == Some("runtime-layout-probe")
        && message.get("ok").and_then(Value::as_bool) == Some(true)
        && message.pointer("/result/type").and_then(Value::as_str)
            == Some("process.shutdownComplete")
}

fn receive_frame(
    frames: &Receiver<Result<Value, RuntimePreflightErrorCode>>,
    timeout: Duration,
    timeout_code: RuntimePreflightErrorCode,
) -> Result<Value, RuntimePreflightError> {
    match frames.recv_timeout(timeout) {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(code)) => Err(RuntimePreflightError::new(code)),
        Err(RecvTimeoutError::Timeout) => Err(RuntimePreflightError::new(timeout_code)),
        Err(RecvTimeoutError::Disconnected) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::SidecarProtocolMismatch,
        )),
    }
}

fn bounded_frames<R: Read + Send + 'static>(
    stream: R,
) -> Receiver<Result<Value, RuntimePreflightErrorCode>> {
    let (sender, receiver) = mpsc::sync_channel(MAX_QUEUED_FRAMES);
    thread::spawn(move || read_frames(stream, sender));
    receiver
}

fn read_frames<R: Read>(
    mut stream: R,
    sender: SyncSender<Result<Value, RuntimePreflightErrorCode>>,
) {
    let mut total = 0usize;
    let mut frame = Vec::new();
    let mut bytes = [0_u8; 1024];
    loop {
        match stream.read(&mut bytes) {
            Ok(0) => return,
            Ok(count) => {
                total += count;
                if total > MAX_STREAM_BYTES {
                    let _ = sender.send(Err(RuntimePreflightErrorCode::SidecarOutputLimitExceeded));
                    return;
                }
                for byte in &bytes[..count] {
                    if *byte == b'\n' {
                        let parsed = serde_json::from_slice(&frame)
                            .map_err(|_| RuntimePreflightErrorCode::SidecarProtocolInvalid);
                        frame.clear();
                        if sender.send(parsed).is_err() {
                            return;
                        }
                    } else {
                        frame.push(*byte);
                        if frame.len() > MAX_STREAM_BYTES {
                            let _ = sender
                                .send(Err(RuntimePreflightErrorCode::SidecarOutputLimitExceeded));
                            return;
                        }
                    }
                }
            }
            Err(_) => {
                let _ = sender.send(Err(RuntimePreflightErrorCode::SidecarProtocolMismatch));
                return;
            }
        }
    }
}

fn bounded_output<R: Read + Send + 'static>(stream: R) -> Receiver<Result<Vec<u8>, ()>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut total = 0usize;
        let mut buffer = [0_u8; 1024];
        let mut output = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    total += count;
                    if total > MAX_STREAM_BYTES {
                        let _ = sender.send(Err(()));
                        return;
                    }
                    output.extend_from_slice(&buffer[..count]);
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(Ok(output));
    });
    receiver
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<std::process::ExitStatus, ()> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => return Err(()),
            Err(_) => return Err(()),
        }
    }
}

mod platform_process {
    use super::*;

    pub(super) fn spawn(command: &mut Command) -> Result<Child, RuntimePreflightError> {
        #[cfg(target_os = "linux")]
        linux::configure_owned_group(command);
        command.spawn().map_err(|_| {
            RuntimePreflightError::new(RuntimePreflightErrorCode::RuntimeResourceUnavailable)
        })
    }

    pub(super) fn cleanup(child: &mut Child) -> bool {
        #[cfg(target_os = "linux")]
        return linux::cleanup_tree(child);
        #[cfg(not(target_os = "linux"))]
        {
            if child.try_wait().ok().flatten().is_none() && child.kill().is_err() {
                return true;
            }
            wait_for_exit(child, Duration::from_secs(1)).is_err()
        }
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::*;

        unsafe extern "C" {
            fn kill(process: i32, signal: i32) -> i32;
        }

        const SIGTERM: i32 = 15;
        const SIGKILL: i32 = 9;

        pub(super) fn configure_owned_group(command: &mut Command) {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        pub(super) fn cleanup_tree(child: &mut Child) -> bool {
            let process_group = -(child.id() as i32);
            // The child owns a fresh process group, so this never signals the app.
            unsafe { kill(process_group, SIGTERM) };
            if process_group_gone(process_group, Duration::from_millis(250)) {
                let _ = child.try_wait();
                return false;
            }
            unsafe { kill(process_group, SIGKILL) };
            let reaped = process_group_gone(process_group, Duration::from_secs(1));
            let _ = wait_for_exit(child, Duration::from_secs(1));
            !reaped
        }

        fn process_group_gone(process_group: i32, timeout: Duration) -> bool {
            let deadline = Instant::now() + timeout;
            loop {
                // signal 0 checks the process group without mutating it. ESRCH means
                // the owned group, including any descendants, has been reaped.
                if unsafe { kill(process_group, 0) } != 0 {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_environment_removes_ambient_node_and_path_case_insensitively() {
        let environment = FrozenEnvironment::from_entries(
            [
                (OsString::from("NODE_OPTIONS"), OsString::from("unsafe")),
                (
                    OsString::from("nOdE_extra_ca_certs"),
                    OsString::from("unsafe"),
                ),
                (OsString::from("NODE_PATH"), OsString::from("unsafe")),
                (OsString::from("path"), OsString::from("ambient-lower")),
                (OsString::from("PaTh"), OsString::from("ambient-mixed")),
                (OsString::from("SAFE"), OsString::from("kept")),
            ],
            Some(Path::new("/copied/runtime/bin/git")),
        );
        assert_eq!(
            environment.0.get(OsStr::new("SAFE")),
            Some(&OsString::from("kept"))
        );
        assert_eq!(
            environment.0.get(OsStr::new("PATH")),
            Some(&OsString::from("/copied/runtime/bin"))
        );
        let path_keys = environment
            .0
            .keys()
            .filter(|key| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
            .collect::<Vec<_>>();
        assert_eq!(path_keys, vec![&OsString::from("PATH")]);
        assert_eq!(
            environment
                .0
                .keys()
                .filter(|key| is_node_or_path_key(key))
                .count(),
            1,
            "the final child environment has exactly one canonical PATH and no NODE_* keys"
        );
    }

    #[test]
    fn cleanup_incomplete_augments_the_protocol_error() {
        let error = augment_cleanup::<()>(
            Err(RuntimePreflightError::new(
                RuntimePreflightErrorCode::SidecarProtocolInvalid,
            )),
            true,
        )
        .expect_err("cleanup must not hide protocol error");
        assert_eq!(
            error.code,
            RuntimePreflightErrorCode::SidecarProtocolInvalid
        );
        assert!(error.cleanup_incomplete);
    }
}
