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
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, de};
use serde_json::{Value, json};

use crate::desktop_sidecar_protocol::VERSION as PROTOCOL_VERSION;

pub(crate) const NODE_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const GIT_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_STREAM_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_QUEUED_FRAMES: usize = 16;

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
    /// The system Node executable is chosen by the platform adapter before
    /// preflight. It must already be absolute because launch environments do
    /// not inherit `PATH`.
    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError>;
    fn process_adapter(&self) -> &dyn OwnedProcessAdapter {
        &PLATFORM_PROCESS_ADAPTER
    }
}

/// The one Tauri resource-root adapter used by both development and installed
/// Desktop execution. Tauri supplies its `resource_dir`; development differs
/// only because Tauri copies the staged simulated tree there.
///
/// A real SystemRuntime Node selector is a startup platform-adapter concern,
/// but it is not qualified by this ticket. The production adapter therefore
/// keeps a system layout safely unavailable instead of treating staging
/// metadata as an executable selector. Controlled adapter tests supply their
/// own absolute fixture program to exercise the shared resolver and preflight.
pub struct TauriResourceRuntimeLayoutAdapter {
    resource_root: PathBuf,
}

impl TauriResourceRuntimeLayoutAdapter {
    pub fn new(resource_root: PathBuf) -> Self {
        Self { resource_root }
    }
}

impl RuntimeLayoutAdapter for TauriResourceRuntimeLayoutAdapter {
    fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError> {
        Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeUnavailable,
        ))
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
        environment: FrozenEnvironment,
    },
    BundledExecutable {
        executable: PathBuf,
        git: PathBuf,
        environment: FrozenEnvironment,
    },
}

impl RuntimeLaunchPlan {
    pub(crate) fn command(&self) -> Command {
        let (program, arguments, environment) = match &self.0 {
            ResolvedRuntimeLaunchPlan::SystemNodeEntry {
                node,
                entry,
                environment,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimePreflightErrorCode {
    ManifestUnavailable,
    ManifestMalformed,
    ManifestIncompatible,
    RuntimeUnavailable,
    RuntimeTimedOut,
    RuntimeOutputExceeded,
    RuntimeProtocol,
    RuntimeShutdown,
    RuntimeExited,
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
            RuntimePreflightErrorCode::ManifestMalformed => "Desktop runtime layout is invalid.",
            RuntimePreflightErrorCode::ManifestIncompatible => {
                "Desktop runtime layout does not match this build."
            }
            RuntimePreflightErrorCode::RuntimeUnavailable => {
                "Desktop Local History runtime is unavailable."
            }
            RuntimePreflightErrorCode::RuntimeTimedOut => {
                "Desktop Local History runtime did not respond in time."
            }
            RuntimePreflightErrorCode::RuntimeOutputExceeded => {
                "Desktop Local History runtime produced unsafe output."
            }
            RuntimePreflightErrorCode::RuntimeProtocol => {
                "Desktop Local History runtime returned an incompatible response."
            }
            RuntimePreflightErrorCode::RuntimeShutdown => {
                "Desktop Local History runtime did not shut down cleanly."
            }
            RuntimePreflightErrorCode::RuntimeExited => {
                "Desktop Local History runtime exited unexpectedly."
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
            let node = adapter.node_program()?;
            if !node.is_absolute() {
                return Err(RuntimePreflightError::new(
                    RuntimePreflightErrorCode::RuntimeUnavailable,
                ));
            }
            Ok(RuntimeLaunchPlan(
                ResolvedRuntimeLaunchPlan::SystemNodeEntry {
                    node,
                    entry: resolve_segments(&adapter.runtime_root(), &sidecar)?,
                    environment: FrozenEnvironment::capture(None),
                },
            ))
        }
        Manifest::Bundled { sidecar, git } => {
            ensure_bundled_build()?;
            let git = resolve_segments(&adapter.runtime_root(), &git)?;
            Ok(RuntimeLaunchPlan(
                ResolvedRuntimeLaunchPlan::BundledExecutable {
                    executable: resolve_segments(&adapter.runtime_root(), &sidecar)?,
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
        RuntimePreflightErrorCode::ManifestIncompatible,
    ));
    #[cfg(feature = "runtime-system")]
    Ok(())
}

fn ensure_bundled_build() -> Result<(), RuntimePreflightError> {
    #[cfg(not(feature = "runtime-bundled"))]
    return Err(RuntimePreflightError::new(
        RuntimePreflightErrorCode::ManifestIncompatible,
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
            RuntimePreflightErrorCode::ManifestMalformed,
        ));
    }
    let contents = fs::read(path)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestUnavailable))?;
    let mut deserializer = serde_json::Deserializer::from_slice(&contents);
    let value = StrictJsonValue::deserialize(&mut deserializer)
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestMalformed))?;
    deserializer
        .end()
        .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestMalformed))?;
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
        .ok_or_else(|| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestMalformed))?;
    let layout_type = object_value(object, "layout")
        .and_then(Value::as_object)
        .and_then(|layout| object_value(layout, "type"))
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestMalformed))?;
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
                    RuntimePreflightErrorCode::ManifestMalformed,
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
                    RuntimePreflightErrorCode::ManifestMalformed,
                ));
            }
            Ok(Manifest::Bundled {
                sidecar: segments(sidecar.pointer("/path").ok_or_else(malformed)?)?,
                git: segments(git.pointer("/path").ok_or_else(malformed)?)?,
            })
        }
        _ => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestMalformed,
        )),
    }
}

fn malformed() -> RuntimePreflightError {
    RuntimePreflightError::new(RuntimePreflightErrorCode::ManifestMalformed)
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

fn probe(
    plan: &RuntimeLaunchPlan,
    processes: &dyn OwnedProcessAdapter,
    limits: RuntimePreflightLimits,
) -> Result<(), RuntimePreflightError> {
    match &plan.0 {
        ResolvedRuntimeLaunchPlan::SystemNodeEntry {
            node, environment, ..
        } => {
            run_tool(
                node,
                &[OsStr::new("--version")],
                environment,
                limits.node,
                processes,
            )?;
        }
        ResolvedRuntimeLaunchPlan::BundledExecutable {
            git, environment, ..
        } => {
            run_tool(
                git,
                &[OsStr::new("--version")],
                environment,
                limits.git,
                processes,
            )?;
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
) -> Result<(), RuntimePreflightError> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    environment.apply(&mut command);
    let mut child = processes.spawn(&mut command)?;
    let stdout = child.stdout.take().ok_or_else(unavailable)?;
    let stderr = child.stderr.take().ok_or_else(unavailable)?;
    let stdout_reader = bounded_stream(stdout);
    let stderr_reader = bounded_stream(stderr);
    let result = wait_for_exit(&mut child, timeout);
    let cleanup = processes.cleanup(&mut child);
    let stdout_result = stdout_reader.recv_timeout(Duration::from_millis(100));
    let stderr_result = stderr_reader.recv_timeout(Duration::from_millis(100));
    let outcome = if stream_exceeded(stdout_result) || stream_exceeded(stderr_result) {
        Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeOutputExceeded,
        ))
    } else {
        match result {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err(RuntimePreflightError::new(
                RuntimePreflightErrorCode::RuntimeUnavailable,
            )),
            Err(code) => Err(RuntimePreflightError::new(code)),
        }
    };
    augment_cleanup(outcome, cleanup)
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
    let mut child = processes.spawn(&mut command)?;
    let input = child.stdin.take().ok_or_else(unavailable)?;
    let output = child.stdout.take().ok_or_else(unavailable)?;
    let stderr = child.stderr.take().ok_or_else(unavailable)?;
    let frames = bounded_frames(output);
    let stderr_reader = bounded_stream(stderr);
    let outcome = probe_protocol(&mut child, input, &frames, limits);
    let cleanup = processes.cleanup(&mut child);
    let stderr_outcome = stderr_reader.recv_timeout(Duration::from_millis(100));
    let outcome = if stream_exceeded(stderr_outcome) {
        Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeOutputExceeded,
        ))
    } else {
        outcome
    };
    augment_cleanup(outcome, cleanup)
}

fn augment_cleanup(
    outcome: Result<(), RuntimePreflightError>,
    cleanup_incomplete: bool,
) -> Result<(), RuntimePreflightError> {
    match outcome {
        Err(error) => Err(error.with_cleanup(cleanup_incomplete)),
        Ok(()) if cleanup_incomplete => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeShutdown,
        )
        .with_cleanup(true)),
        Ok(()) => Ok(()),
    }
}

fn probe_protocol(
    child: &mut Child,
    mut input: ChildStdin,
    frames: &Receiver<Result<Value, RuntimePreflightErrorCode>>,
    limits: RuntimePreflightLimits,
) -> Result<(), RuntimePreflightError> {
    let ready = receive_frame(frames, limits.ready)?;
    if !is_ready(&ready) {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeProtocol,
        ));
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
            RuntimePreflightErrorCode::RuntimeUnavailable,
        ));
    }
    let response = receive_frame(frames, limits.shutdown)?;
    if !is_shutdown_complete(&response) {
        return Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeShutdown,
        ));
    }
    match wait_for_exit(child, limits.shutdown) {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeExited,
        )),
        Err(code) => Err(RuntimePreflightError::new(code)),
    }
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
) -> Result<Value, RuntimePreflightError> {
    match frames.recv_timeout(timeout) {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(code)) => Err(RuntimePreflightError::new(code)),
        Err(RecvTimeoutError::Timeout) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeTimedOut,
        )),
        Err(RecvTimeoutError::Disconnected) => Err(RuntimePreflightError::new(
            RuntimePreflightErrorCode::RuntimeExited,
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
                    let _ = sender.send(Err(RuntimePreflightErrorCode::RuntimeOutputExceeded));
                    return;
                }
                for byte in &bytes[..count] {
                    if *byte == b'\n' {
                        let parsed = serde_json::from_slice(&frame)
                            .map_err(|_| RuntimePreflightErrorCode::RuntimeProtocol);
                        frame.clear();
                        if sender.send(parsed).is_err() {
                            return;
                        }
                    } else {
                        frame.push(*byte);
                        if frame.len() > MAX_STREAM_BYTES {
                            let _ =
                                sender.send(Err(RuntimePreflightErrorCode::RuntimeOutputExceeded));
                            return;
                        }
                    }
                }
            }
            Err(_) => {
                let _ = sender.send(Err(RuntimePreflightErrorCode::RuntimeExited));
                return;
            }
        }
    }
}

fn bounded_stream<R: Read + Send + 'static>(stream: R) -> Receiver<bool> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut total = 0usize;
        let mut buffer = [0_u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    total += count;
                    if total > MAX_STREAM_BYTES {
                        let _ = sender.send(true);
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(false);
    });
    receiver
}

fn stream_exceeded(result: Result<bool, RecvTimeoutError>) -> bool {
    matches!(result, Ok(true))
}

fn wait_for_exit(
    child: &mut Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, RuntimePreflightErrorCode> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => return Err(RuntimePreflightErrorCode::RuntimeTimedOut),
            Err(_) => return Err(RuntimePreflightErrorCode::RuntimeExited),
        }
    }
}

mod platform_process {
    use super::*;

    pub(super) fn spawn(command: &mut Command) -> Result<Child, RuntimePreflightError> {
        #[cfg(target_os = "linux")]
        linux::configure_owned_group(command);
        command
            .spawn()
            .map_err(|_| RuntimePreflightError::new(RuntimePreflightErrorCode::RuntimeUnavailable))
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

fn unavailable() -> RuntimePreflightError {
    RuntimePreflightError::new(RuntimePreflightErrorCode::RuntimeUnavailable)
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
                    OsString::from("node_extra_ca_certs"),
                    OsString::from("unsafe"),
                ),
                (OsString::from("Path"), OsString::from("ambient")),
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
        assert!(
            !environment
                .0
                .keys()
                .any(|key| is_node_or_path_key(key) && key != OsStr::new("PATH"))
        );
    }

    #[test]
    fn cleanup_incomplete_augments_the_protocol_error() {
        let error = augment_cleanup(
            Err(RuntimePreflightError::new(
                RuntimePreflightErrorCode::RuntimeProtocol,
            )),
            true,
        )
        .expect_err("cleanup must not hide protocol error");
        assert_eq!(error.code, RuntimePreflightErrorCode::RuntimeProtocol);
        assert!(error.cleanup_incomplete);
    }
}
