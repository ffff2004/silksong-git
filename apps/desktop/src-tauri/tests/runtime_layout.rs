#[cfg(feature = "runtime-system")]
use std::process::{Child, Command};
#[cfg(feature = "runtime-system")]
use std::sync::atomic::AtomicUsize;
#[cfg(all(target_os = "linux", feature = "runtime-system"))]
use std::thread;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(feature = "runtime-system")]
use silksong_git_desktop_lib::runtime_layout::{OwnedProcessAdapter, PlatformOwnedProcessAdapter};
use silksong_git_desktop_lib::runtime_layout::{
    RuntimeLayoutAdapter, RuntimePreflight, RuntimePreflightError, RuntimePreflightErrorCode,
    RuntimePreflightLimits, TauriResourceRuntimeLayoutAdapter, preflight_with_limits,
};

static TREE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const FAST_LIMITS: RuntimePreflightLimits = RuntimePreflightLimits::new(
    Duration::from_millis(250),
    Duration::from_millis(250),
    Duration::from_millis(250),
    Duration::from_millis(250),
);

struct CopiedTree {
    resource_root: PathBuf,
    node: PathBuf,
}

impl CopiedTree {
    fn runtime_root(&self) -> PathBuf {
        self.resource_root.join("runtime")
    }

    fn manifest(&self) -> PathBuf {
        self.runtime_root().join("manifest.json")
    }

    fn tauri_resource_adapter(&self) -> TauriResourceRuntimeLayoutAdapter {
        TauriResourceRuntimeLayoutAdapter::new(self.resource_root.clone())
    }
}

#[cfg(feature = "runtime-system")]
struct IncompleteCleanupTree(CopiedTree);

#[cfg(feature = "runtime-system")]
struct IncompleteCleanup;

#[cfg(feature = "runtime-system")]
impl OwnedProcessAdapter for IncompleteCleanup {
    fn spawn(&self, command: &mut Command) -> Result<Child, RuntimePreflightError> {
        PlatformOwnedProcessAdapter.spawn(command)
    }

    fn cleanup(&self, child: &mut Child) -> bool {
        let _ = PlatformOwnedProcessAdapter.cleanup(child);
        INCOMPLETE_CLEANUP_CALLS.fetch_add(1, Ordering::Relaxed) > 0
    }
}

#[cfg(feature = "runtime-system")]
static INCOMPLETE_CLEANUP: IncompleteCleanup = IncompleteCleanup;
#[cfg(feature = "runtime-system")]
static INCOMPLETE_CLEANUP_CALLS: AtomicUsize = AtomicUsize::new(0);

impl RuntimeLayoutAdapter for CopiedTree {
    fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError> {
        Ok(self.node.clone())
    }
}

#[cfg(feature = "runtime-system")]
impl RuntimeLayoutAdapter for IncompleteCleanupTree {
    fn resource_root(&self) -> &Path {
        self.0.resource_root()
    }

    fn node_program(&self) -> Result<PathBuf, RuntimePreflightError> {
        self.0.node_program()
    }

    fn process_adapter(&self) -> &dyn OwnedProcessAdapter {
        &INCOMPLETE_CLEANUP
    }
}

fn copied_tree(layout: &str, behavior: &str) -> CopiedTree {
    let root = std::env::temp_dir().join(format!(
        "silksong-git-runtime-layout-integration-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
        TREE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    let runtime_root = root.join("runtime");
    fs::create_dir_all(runtime_root.join("bin")).expect("create copied installation tree");
    let fixture = PathBuf::from(env!("CARGO_BIN_EXE_runtime_layout_fixture"));
    let node = runtime_root.join("bin/runtime-layout-fixture");
    fs::copy(fixture, &node).expect("copy Rust fixture executable");
    let sidecar = match layout {
        "system" => runtime_root.join(format!("sidecar-{behavior}.js")),
        "bundled" => runtime_root.join(format!("bin/sidecar-{behavior}")),
        _ => panic!("unknown layout"),
    };
    if layout == "system" {
        fs::write(&sidecar, "fixture entry").expect("write system entry");
    } else {
        fs::copy(&node, &sidecar).expect("copy bundled sidecar fixture");
    }
    let manifest = match layout {
        "system" => format!(
            r#"{{"layoutVersion":1,"layout":{{"type":"system"}},"sidecar":{{"type":"nodeEntry","path":["{}"]}}}}"#,
            sidecar
                .file_name()
                .expect("sidecar name")
                .to_str()
                .expect("UTF-8 sidecar name"),
        ),
        "bundled" => format!(
            r#"{{"layoutVersion":1,"layout":{{"type":"bundled"}},"sidecar":{{"type":"embeddedExecutable","path":["bin","{}"]}},"git":{{"path":["bin","runtime-layout-fixture"]}}}}"#,
            sidecar
                .file_name()
                .expect("sidecar name")
                .to_str()
                .expect("UTF-8 sidecar name"),
        ),
        _ => unreachable!(),
    };
    let manifest_path = runtime_root.join("manifest.json");
    fs::write(&manifest_path, manifest).expect("write manifest");
    CopiedTree {
        resource_root: root,
        node,
    }
}

fn unavailable(adapter: &impl RuntimeLayoutAdapter) -> RuntimePreflightError {
    match preflight_with_limits(adapter, FAST_LIMITS) {
        RuntimePreflight::Unavailable(error) => error,
        RuntimePreflight::Ready(_) => panic!("fixture should be unavailable"),
    }
}

#[test]
fn copied_system_tree_observes_ready_protocol_timeout_and_output() {
    #[cfg(feature = "runtime-system")]
    {
        let tree = copied_tree("system", "ready");
        assert!(matches!(
            preflight_with_limits(&tree, FAST_LIMITS),
            RuntimePreflight::Ready(_)
        ));
    }
    #[cfg(feature = "runtime-system")]
    for (behavior, code) in [
        ("malformed", RuntimePreflightErrorCode::RuntimeProtocol),
        ("timeout", RuntimePreflightErrorCode::RuntimeTimedOut),
        ("output", RuntimePreflightErrorCode::RuntimeOutputExceeded),
        ("no-shutdown", RuntimePreflightErrorCode::RuntimeTimedOut),
        ("no-exit", RuntimePreflightErrorCode::RuntimeTimedOut),
    ] {
        let tree = copied_tree("system", behavior);
        assert_eq!(unavailable(&tree).code, code);
    }
}

#[test]
fn copied_bundled_tree_observes_ready_and_never_falls_back_to_system() {
    #[cfg(feature = "runtime-bundled")]
    {
        let tree = copied_tree("bundled", "ready");
        assert!(matches!(
            preflight_with_limits(&tree, FAST_LIMITS),
            RuntimePreflight::Ready(_)
        ));
    }
    #[cfg(feature = "runtime-system")]
    {
        let tree = copied_tree("bundled", "ready");
        assert_eq!(
            unavailable(&tree).code,
            RuntimePreflightErrorCode::ManifestIncompatible
        );
    }
}

#[test]
fn tauri_resource_adapter_uses_the_fixed_runtime_manifest_location() {
    let tree = copied_tree("system", "ready");
    let adapter = tree.tauri_resource_adapter();
    let expected_runtime = tree.resource_root.join("runtime");
    let expected_manifest = expected_runtime.join("manifest.json");

    assert_eq!(adapter.runtime_root(), expected_runtime);
    assert_eq!(adapter.manifest_path(), expected_manifest);
}

#[cfg(feature = "runtime-system")]
#[test]
fn unqualified_tauri_system_runtime_is_safely_unavailable() {
    let tree = copied_tree("system", "ready");

    assert_eq!(
        unavailable(&tree.tauri_resource_adapter()).code,
        RuntimePreflightErrorCode::RuntimeUnavailable
    );
}

#[cfg(feature = "runtime-bundled")]
#[test]
fn tauri_bundled_runtime_is_ready_from_the_same_resource_root_adapter() {
    let tree = copied_tree("bundled", "ready");

    assert!(matches!(
        preflight_with_limits(&tree.tauri_resource_adapter(), FAST_LIMITS),
        RuntimePreflight::Ready(_)
    ));
}

#[test]
fn strict_manifest_rejects_unknown_layout_mismatch_duplicate_keys_and_unsafe_segments() {
    let tree = copied_tree("system", "ready");
    for invalid in [
        r#"{"layoutVersion":1,"layout":{"type":"system"},"sidecar":{"type":"nodeEntry","path":["ok"]},"unknown":true}"#,
        r#"{"layoutVersion":1,"layout":{"type":"bundled"},"sidecar":{"type":"nodeEntry","path":["ok"]}}"#,
        r#"{"layoutVersion":1,"layout":{"type":"system","type":"bundled"},"sidecar":{"type":"nodeEntry","path":["ok"]}}"#,
    ] {
        fs::write(tree.manifest(), invalid).expect("replace manifest");
        assert_eq!(
            unavailable(&tree).code,
            RuntimePreflightErrorCode::ManifestMalformed
        );
    }

    for segment in ["", ".", "..", "/", "\\", "a/b", "a\\b", "a\0b", "C:"] {
        let encoded = serde_json::to_string(segment).expect("serialize test segment");
        fs::write(
            tree.manifest(),
            format!(
                r#"{{"layoutVersion":1,"layout":{{"type":"system"}},"sidecar":{{"type":"nodeEntry","path":[{encoded}]}}}}"#
            ),
        )
        .expect("replace manifest");
        assert_eq!(
            unavailable(&tree).code,
            RuntimePreflightErrorCode::ManifestMalformed,
            "must reject unsafe segment {segment:?}"
        );
    }
}

#[cfg(feature = "runtime-system")]
#[test]
fn copied_system_tree_accepts_an_absolute_noncanonical_resource_root() {
    let mut tree = copied_tree("system", "ready");
    tree.resource_root.push(".");

    assert!(matches!(
        preflight_with_limits(&tree, FAST_LIMITS),
        RuntimePreflight::Ready(_)
    ));
}

#[cfg(feature = "runtime-system")]
#[test]
fn injected_process_adapter_preserves_the_primary_protocol_error() {
    INCOMPLETE_CLEANUP_CALLS.store(0, Ordering::Relaxed);
    let tree = IncompleteCleanupTree(copied_tree("system", "malformed"));
    match preflight_with_limits(&tree, FAST_LIMITS) {
        RuntimePreflight::Unavailable(error) => {
            assert_eq!(error.code, RuntimePreflightErrorCode::RuntimeProtocol);
            assert!(error.cleanup_incomplete);
        }
        RuntimePreflight::Ready(_) => panic!("malformed fixture must be unavailable"),
    }
}

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn linux_owned_process_adapter_reaps_a_real_live_descendant_after_timeout() {
    let tree = copied_tree("system", "descendant");
    let marker = tree.runtime_root().join("descendant-pid");
    unsafe { std::env::set_var("RUNTIME_LAYOUT_DESCENDANT_PID", &marker) };
    let error = unavailable(&tree);
    unsafe { std::env::remove_var("RUNTIME_LAYOUT_DESCENDANT_PID") };
    assert_eq!(error.code, RuntimePreflightErrorCode::RuntimeTimedOut);
    // A descendant can remain a kernel zombie until this container's init
    // reaps it. The adapter reports that uncertainty rather than replacing the
    // original timeout with a generic shutdown error.
    assert!(error.cleanup_incomplete);
    let pid = fs::read_to_string(marker).expect("fixture recorded live descendant pid");
    for _ in 0..20 {
        let status = fs::read_to_string(Path::new("/proc").join(pid.trim()).join("status"));
        if status.is_err() || status.is_ok_and(|status| status.contains("State:\tZ")) {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("owned process adapter left the fixture descendant alive");
}
