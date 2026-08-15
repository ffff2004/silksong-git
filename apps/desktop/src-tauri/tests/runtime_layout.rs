#[cfg(feature = "runtime-system")]
use std::sync::Arc;
#[cfg(feature = "runtime-system")]
use std::sync::atomic::AtomicUsize;
#[cfg(target_os = "linux")]
use std::thread;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use std::{
    process::{Child, Command},
    sync::Mutex,
};

use silksong_git_desktop_lib::runtime_layout::SystemExecutableSelector;
use silksong_git_desktop_lib::runtime_layout::{OwnedProcessAdapter, PlatformOwnedProcessAdapter};
use silksong_git_desktop_lib::runtime_layout::{
    RuntimeLayoutAdapter, RuntimePreflight, RuntimePreflightError, RuntimePreflightErrorCode,
    RuntimePreflightLimits, TauriResourceRuntimeLayoutAdapter, preflight_with_limits,
};

static TREE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "linux")]
static RUNTIME_LAYOUT_TEST_LOCK: Mutex<()> = Mutex::new(());
const FAST_LIMITS: RuntimePreflightLimits = RuntimePreflightLimits::new(
    Duration::from_millis(250),
    Duration::from_millis(250),
    Duration::from_millis(250),
    Duration::from_millis(250),
);

struct CopiedTree {
    resource_root: PathBuf,
    node: PathBuf,
    git: PathBuf,
    #[cfg(feature = "runtime-bundled")]
    sidecar: PathBuf,
}

#[cfg(target_os = "linux")]
struct AmbientEnvironmentGuard {
    original: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}

#[cfg(target_os = "linux")]
impl AmbientEnvironmentGuard {
    fn install(entries: &[(std::ffi::OsString, std::ffi::OsString)]) -> Self {
        let original = std::env::vars_os()
            .filter(|(key, _)| {
                let normalized = key.to_string_lossy().to_ascii_lowercase();
                normalized == "path"
                    || normalized.starts_with("node_")
                    || normalized.starts_with("git_")
            })
            .collect();
        Self::remove_runtime_keys();
        for (key, value) in entries {
            // This test is serialized and restores the exact prior values in Drop.
            unsafe { std::env::set_var(key, value) };
        }
        Self { original }
    }

    fn remove_runtime_keys() {
        for key in std::env::vars_os()
            .map(|(key, _)| key)
            .filter(|key| {
                let normalized = key.to_string_lossy().to_ascii_lowercase();
                normalized == "path"
                    || normalized.starts_with("node_")
                    || normalized.starts_with("git_")
            })
            .collect::<Vec<_>>()
        {
            unsafe { std::env::remove_var(key) };
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for AmbientEnvironmentGuard {
    fn drop(&mut self) {
        Self::remove_runtime_keys();
        for (key, value) in &self.original {
            unsafe { std::env::set_var(key, value) };
        }
    }
}

#[cfg(target_os = "linux")]
fn lock_runtime_layout_test() -> std::sync::MutexGuard<'static, ()> {
    RUNTIME_LAYOUT_TEST_LOCK
        .lock()
        .expect("runtime-layout test lock")
}

impl Drop for CopiedTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.resource_root);
    }
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
        INCOMPLETE_CLEANUP_CALLS.fetch_add(1, Ordering::Relaxed) >= 2
    }
}

#[cfg(feature = "runtime-system")]
static INCOMPLETE_CLEANUP: IncompleteCleanup = IncompleteCleanup;
#[cfg(feature = "runtime-system")]
static INCOMPLETE_CLEANUP_CALLS: AtomicUsize = AtomicUsize::new(0);

#[cfg(feature = "runtime-system")]
struct MutableExecutableSelector {
    events: Arc<Mutex<Vec<String>>>,
    node: Arc<Mutex<PathBuf>>,
    git: Arc<Mutex<PathBuf>>,
}

#[cfg(feature = "runtime-system")]
struct MissingSystemExecutableSelector {
    missing: &'static str,
}

#[cfg(feature = "runtime-system")]
impl SystemExecutableSelector for MissingSystemExecutableSelector {
    fn select(&self, name: &str) -> Option<PathBuf> {
        (name != self.missing).then(|| PathBuf::from("/unused/system-runtime"))
    }
}

#[cfg(feature = "runtime-bundled")]
struct UnexpectedSystemSelection;

#[cfg(feature = "runtime-bundled")]
impl SystemExecutableSelector for UnexpectedSystemSelection {
    fn select(&self, name: &str) -> Option<PathBuf> {
        panic!("BundledRuntime must not select system executable {name}")
    }
}

impl SystemExecutableSelector for CopiedTree {
    fn select(&self, name: &str) -> Option<PathBuf> {
        match name {
            "node" => Some(self.node.clone()),
            "git" => Some(self.git.clone()),
            _ => None,
        }
    }
}

#[cfg(feature = "runtime-system")]
impl SystemExecutableSelector for MutableExecutableSelector {
    fn select(&self, name: &str) -> Option<PathBuf> {
        self.events
            .lock()
            .expect("selection events lock")
            .push(format!("select:{name}"));
        match name {
            "node" => Some(self.node.lock().expect("node selection lock").clone()),
            "git" => Some(self.git.lock().expect("git selection lock").clone()),
            _ => None,
        }
    }
}

#[cfg(feature = "runtime-system")]
struct ObservingProcessAdapter {
    events: Arc<Mutex<Vec<String>>>,
    git_parent: PathBuf,
}

#[cfg(feature = "runtime-system")]
impl OwnedProcessAdapter for ObservingProcessAdapter {
    fn spawn(&self, command: &mut Command) -> Result<Child, RuntimePreflightError> {
        let mut path = None;
        for (key, value) in command.get_envs() {
            let normalized = key.to_string_lossy().to_ascii_lowercase();
            if normalized == "path" {
                path = value.map(PathBuf::from);
            }
            assert!(!normalized.starts_with("node_"));
        }
        assert_eq!(path, Some(self.git_parent.clone()));
        self.events
            .lock()
            .expect("process events lock")
            .push("spawn".to_owned());
        PlatformOwnedProcessAdapter.spawn(command)
    }

    fn cleanup(&self, child: &mut Child) -> bool {
        PlatformOwnedProcessAdapter.cleanup(child)
    }
}

#[cfg(feature = "runtime-system")]
struct ObservedSystemAdapter {
    base: TauriResourceRuntimeLayoutAdapter,
    process: ObservingProcessAdapter,
}

#[cfg(feature = "runtime-system")]
impl RuntimeLayoutAdapter for ObservedSystemAdapter {
    fn resource_root(&self) -> &Path {
        self.base.resource_root()
    }

    fn system_executable_selector(&self) -> Option<&dyn SystemExecutableSelector> {
        self.base.system_executable_selector()
    }

    fn process_adapter(&self) -> &dyn OwnedProcessAdapter {
        &self.process
    }
}

struct UnrelatedCwdProcess(PathBuf);

impl OwnedProcessAdapter for UnrelatedCwdProcess {
    fn spawn(&self, command: &mut Command) -> Result<Child, RuntimePreflightError> {
        command.current_dir(&self.0);
        PlatformOwnedProcessAdapter.spawn(command)
    }

    fn cleanup(&self, child: &mut Child) -> bool {
        PlatformOwnedProcessAdapter.cleanup(child)
    }
}

struct UnrelatedCwdTree {
    tree: CopiedTree,
    process: UnrelatedCwdProcess,
}

impl RuntimeLayoutAdapter for UnrelatedCwdTree {
    fn resource_root(&self) -> &Path {
        self.tree.resource_root()
    }

    fn system_executable_selector(&self) -> Option<&dyn SystemExecutableSelector> {
        Some(&self.tree)
    }

    fn process_adapter(&self) -> &dyn OwnedProcessAdapter {
        &self.process
    }
}

impl RuntimeLayoutAdapter for CopiedTree {
    fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    fn system_executable_selector(&self) -> Option<&dyn SystemExecutableSelector> {
        Some(self)
    }
}

#[cfg(feature = "runtime-system")]
impl RuntimeLayoutAdapter for IncompleteCleanupTree {
    fn resource_root(&self) -> &Path {
        self.0.resource_root()
    }

    fn system_executable_selector(&self) -> Option<&dyn SystemExecutableSelector> {
        Some(&self.0)
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
    let node = runtime_root.join("bin/node-runtime-layout-fixture");
    fs::copy(fixture, &node).expect("copy Rust fixture executable");
    let git = runtime_root.join("bin/git");
    fs::copy(env!("CARGO_BIN_EXE_runtime_layout_fixture"), &git)
        .expect("copy Git fixture executable");
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
            r#"{{"layoutVersion":1,"layout":{{"type":"bundled"}},"sidecar":{{"type":"embeddedExecutable","path":["bin","{}"]}},"git":{{"path":["bin","git"]}}}}"#,
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
        git,
        #[cfg(feature = "runtime-bundled")]
        sidecar,
    }
}

#[cfg(feature = "runtime-system")]
fn copy_fixture_named(tree: &CopiedTree, name: &str) -> PathBuf {
    let path = tree.runtime_root().join("bin").join(name);
    fs::copy(env!("CARGO_BIN_EXE_runtime_layout_fixture"), &path)
        .expect("copy named runtime fixture");
    path
}

#[cfg(feature = "runtime-bundled")]
fn copy_git_fixture_named(tree: &CopiedTree, name: &str) -> PathBuf {
    let path = tree.runtime_root().join("bin").join(name).join("git");
    fs::create_dir_all(path.parent().expect("Git fixture parent")).expect("create Git fixture dir");
    fs::copy(env!("CARGO_BIN_EXE_runtime_layout_fixture"), &path)
        .expect("copy named Git runtime fixture");
    let sidecar_segments = manifest_segments(&tree.runtime_root(), &tree.sidecar);
    let git_segments = manifest_segments(&tree.runtime_root(), &path);
    fs::write(
        tree.manifest(),
        format!(
            r#"{{"layoutVersion":1,"layout":{{"type":"bundled"}},"sidecar":{{"type":"embeddedExecutable","path":{}}},"git":{{"path":{}}}}}"#,
            serde_json::to_string(&sidecar_segments).expect("serialize sidecar path"),
            serde_json::to_string(&git_segments).expect("serialize Git path"),
        ),
    )
    .expect("update bundled Git manifest");
    path
}

#[cfg(feature = "runtime-bundled")]
fn manifest_segments(root: &Path, path: &Path) -> Vec<String> {
    path.strip_prefix(root)
        .expect("manifest entry is beneath runtime root")
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .expect("fixture path is UTF-8")
                .to_owned()
        })
        .collect()
}

fn unavailable(adapter: &impl RuntimeLayoutAdapter) -> RuntimePreflightError {
    match preflight_with_limits(adapter, FAST_LIMITS) {
        RuntimePreflight::Unavailable(error) => error,
        RuntimePreflight::Ready(_) => panic!("fixture should be unavailable"),
    }
}

#[cfg(feature = "runtime-bundled")]
fn no_fallback_bundled_adapter(tree: &CopiedTree) -> TauriResourceRuntimeLayoutAdapter {
    TauriResourceRuntimeLayoutAdapter::with_system_executable_selector(
        tree.resource_root.clone(),
        UnexpectedSystemSelection,
    )
}

#[test]
fn copied_system_tree_observes_ready_protocol_timeout_and_output() {
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
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
        (
            "malformed",
            RuntimePreflightErrorCode::SidecarProtocolInvalid,
        ),
        ("timeout", RuntimePreflightErrorCode::SidecarReadyTimeout),
        (
            "output",
            RuntimePreflightErrorCode::SidecarOutputLimitExceeded,
        ),
        (
            "no-shutdown",
            RuntimePreflightErrorCode::SidecarShutdownFailed,
        ),
        ("no-exit", RuntimePreflightErrorCode::SidecarShutdownFailed),
    ] {
        let tree = copied_tree("system", behavior);
        assert_eq!(unavailable(&tree).code, code);
    }
}

#[cfg(feature = "runtime-system")]
#[test]
fn system_candidates_cover_missing_incompatible_and_vendor_versions() {
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
    let mut node_missing = copied_tree("system", "ready");
    node_missing.node = node_missing.runtime_root().join("bin/missing-node");
    assert_eq!(
        unavailable(&node_missing).code,
        RuntimePreflightErrorCode::NodeUnavailable
    );

    let mut node_incompatible = copied_tree("system", "ready");
    node_incompatible.node = copy_fixture_named(&node_incompatible, "node-incompatible-fixture");
    assert_eq!(
        unavailable(&node_incompatible).code,
        RuntimePreflightErrorCode::UnsupportedNodeMajor
    );

    let mut node_sqlite_missing = copied_tree("system", "ready");
    node_sqlite_missing.node =
        copy_fixture_named(&node_sqlite_missing, "node-sqlite-missing-fixture");
    assert_eq!(
        unavailable(&node_sqlite_missing).code,
        RuntimePreflightErrorCode::NodeSqliteUnavailable
    );

    let mut git_missing = copied_tree("system", "ready");
    git_missing.git = git_missing.runtime_root().join("bin/missing-git");
    assert_eq!(
        unavailable(&git_missing).code,
        RuntimePreflightErrorCode::GitUnavailable
    );

    let mut git_malformed = copied_tree("system", "ready");
    git_malformed.git = copy_fixture_named(&git_malformed, "git-malformed-fixture");
    assert_eq!(
        unavailable(&git_malformed).code,
        RuntimePreflightErrorCode::GitVersionUnreadable
    );
    for fixture_name in [
        "git-extra-line-fixture",
        "git-crlf-fixture",
        "git-control-fixture",
        "git-four-part-fixture",
        "git-multiline-fixture",
        "git-unsafe-suffix-fixture",
    ] {
        let mut malformed = copied_tree("system", "ready");
        malformed.git = copy_fixture_named(&malformed, fixture_name);
        assert_eq!(
            unavailable(&malformed).code,
            RuntimePreflightErrorCode::GitVersionUnreadable,
            "malformed Git fixture {fixture_name} must be rejected through preflight",
        );
    }

    for fixture_name in [
        "git-floor-fixture",
        "git-ceiling-fixture",
        "git-apple-fixture",
        "git-windows-fixture",
        "git-vendor-fixture",
    ] {
        let mut accepted = copied_tree("system", "ready");
        accepted.git = copy_fixture_named(&accepted, fixture_name);
        assert!(
            matches!(
                preflight_with_limits(&accepted, FAST_LIMITS),
                RuntimePreflight::Ready(_)
            ),
            "Git fixture {fixture_name} should be accepted by the public preflight"
        );
    }

    for (fixture_name, expected) in [
        (
            "git-incompatible-fixture",
            RuntimePreflightErrorCode::UnsupportedGitVersion,
        ),
        (
            "git-upper-bound-fixture",
            RuntimePreflightErrorCode::UnsupportedGitVersion,
        ),
    ] {
        let mut rejected = copied_tree("system", "ready");
        rejected.git = copy_fixture_named(&rejected, fixture_name);
        assert_eq!(
            unavailable(&rejected).code,
            expected,
            "Git fixture {fixture_name}"
        );
    }
}

#[cfg(feature = "runtime-system")]
#[test]
fn system_selector_errors_keep_priority_over_a_missing_manifest_sidecar() {
    #[cfg(target_os = "linux")]
    let _lock = lock_runtime_layout_test();

    let node_missing = copied_tree("system", "ready");
    fs::remove_file(node_missing.runtime_root().join("sidecar-ready.js"))
        .expect("remove system manifest-owned sidecar");
    let node_missing_adapter = TauriResourceRuntimeLayoutAdapter::with_system_executable_selector(
        node_missing.resource_root.clone(),
        MissingSystemExecutableSelector { missing: "node" },
    );
    assert_eq!(
        unavailable(&node_missing_adapter).code,
        RuntimePreflightErrorCode::NodeUnavailable
    );

    let git_missing = copied_tree("system", "ready");
    fs::remove_file(git_missing.runtime_root().join("sidecar-ready.js"))
        .expect("remove system manifest-owned sidecar");
    let git_missing_adapter = TauriResourceRuntimeLayoutAdapter::with_system_executable_selector(
        git_missing.resource_root.clone(),
        MissingSystemExecutableSelector { missing: "git" },
    );
    assert_eq!(
        unavailable(&git_missing_adapter).code,
        RuntimePreflightErrorCode::GitUnavailable
    );
}

#[cfg(feature = "runtime-system")]
#[test]
fn system_preflight_observes_the_restricted_environment_in_real_probe_children() {
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
    let mut tree = copied_tree("system", "env-check");
    tree.node = copy_fixture_named(&tree, "node-env-check-fixture");
    tree.git = copy_fixture_named(&tree, "git-env-check-fixture");

    assert!(matches!(
        preflight_with_limits(&tree, FAST_LIMITS),
        RuntimePreflight::Ready(_)
    ));
}

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn system_preflight_removes_mixed_case_ambient_runtime_keys_in_real_children() {
    let _lock = lock_runtime_layout_test();
    let ambient = AmbientEnvironmentGuard::install(&[
        ("nOdE_OPTIONS".into(), "unsafe-node-options".into()),
        ("nOdE_extra_ca_certs".into(), "unsafe-node-certs".into()),
        ("path".into(), "ambient-lower-path".into()),
        ("PaTh".into(), "ambient-mixed-path".into()),
    ]);

    let mut tree = copied_tree("system", "env-check");
    tree.node = copy_fixture_named(&tree, "node-env-check-fixture");
    tree.git = copy_fixture_named(&tree, "git-env-check-fixture");
    let ready = match preflight_with_limits(&tree, FAST_LIMITS) {
        RuntimePreflight::Ready(_) => true,
        RuntimePreflight::Unavailable(error) => {
            drop(ambient);
            panic!("mixed-case environment must pass restricted preflight: {error:?}");
        }
    };
    // The public Desktop workflow test launches this same frozen plan for
    // business work; this test supplies the mixed-case ambient inputs to the
    // real preflight children without mutating the process environment in
    // parallel with another test.
    drop(ambient);
    assert!(
        ready,
        "mixed-case environment must pass restricted preflight"
    );
}

#[cfg(feature = "runtime-system")]
#[test]
fn system_preflight_selects_each_program_once_before_validation_and_reuses_the_frozen_plan() {
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
    let tree = copied_tree("system", "ready");
    let events = Arc::new(Mutex::new(Vec::new()));
    let node = Arc::new(Mutex::new(tree.node.clone()));
    let git = Arc::new(Mutex::new(tree.git.clone()));
    let selector = MutableExecutableSelector {
        events: Arc::clone(&events),
        node: Arc::clone(&node),
        git: Arc::clone(&git),
    };
    let adapter = ObservedSystemAdapter {
        base: TauriResourceRuntimeLayoutAdapter::with_system_executable_selector(
            tree.resource_root.clone(),
            selector,
        ),
        process: ObservingProcessAdapter {
            events: Arc::clone(&events),
            git_parent: tree.git.parent().expect("fixture Git parent").to_path_buf(),
        },
    };

    let plan = match preflight_with_limits(&adapter, FAST_LIMITS) {
        RuntimePreflight::Ready(plan) => plan,
        RuntimePreflight::Unavailable(error) => {
            panic!("selection and probe should succeed: {error:?}")
        }
    };
    assert_eq!(
        *events.lock().expect("selection events lock"),
        vec![
            "select:node".to_owned(),
            "select:git".to_owned(),
            "spawn".to_owned(),
            "spawn".to_owned(),
            "spawn".to_owned(),
        ],
        "both selections must be frozen before Node, Git, and sidecar validation",
    );

    *node.lock().expect("node selection lock") = tree.runtime_root().join("missing-node");
    *git.lock().expect("git selection lock") = tree.runtime_root().join("missing-git");
    fs::write(
        tree.manifest(),
        r#"{"layoutVersion":1,"layout":{"type":"system"},"sidecar":{"type":"nodeEntry","path":["missing-sidecar.js"]}}"#,
    )
    .expect("replace manifest after preflight");

    assert_eq!(
        plan,
        plan.clone(),
        "a preflighted launch plan remains immutable after discovery changes"
    );
}

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn system_preflight_is_independent_of_the_desktop_process_cwd() {
    let _lock = lock_runtime_layout_test();
    let tree = copied_tree("system", "ready");
    let cwd = tree
        .resource_root
        .parent()
        .expect("temporary parent")
        .join("unrelated-cwd");
    fs::create_dir(&cwd).expect("create unrelated cwd");
    let adapter = UnrelatedCwdTree {
        tree,
        process: UnrelatedCwdProcess(cwd.clone()),
    };

    assert!(matches!(
        preflight_with_limits(&adapter, FAST_LIMITS),
        RuntimePreflight::Ready(_)
    ));
    fs::remove_dir_all(cwd).expect("remove unrelated cwd");
}

#[test]
fn copied_bundled_tree_observes_ready_and_never_falls_back_to_system() {
    #[cfg(feature = "runtime-bundled")]
    {
        let tree = copied_tree("bundled", "ready");
        let adapter = no_fallback_bundled_adapter(&tree);
        assert!(matches!(
            preflight_with_limits(&adapter, FAST_LIMITS),
            RuntimePreflight::Ready(_)
        ));

        let missing_git = copied_tree("bundled", "ready");
        fs::remove_file(&missing_git.git).expect("remove manifest-owned Git");
        let adapter = no_fallback_bundled_adapter(&missing_git);
        assert_eq!(
            unavailable(&adapter).code,
            RuntimePreflightErrorCode::RuntimeResourceUnavailable
        );

        let missing_sidecar = copied_tree("bundled", "ready");
        fs::remove_file(&missing_sidecar.sidecar).expect("remove manifest-owned sidecar");
        let adapter = no_fallback_bundled_adapter(&missing_sidecar);
        assert_eq!(
            unavailable(&adapter).code,
            RuntimePreflightErrorCode::RuntimeResourceUnavailable
        );
    }
    #[cfg(feature = "runtime-system")]
    {
        let tree = copied_tree("bundled", "ready");
        assert_eq!(
            unavailable(&tree).code,
            RuntimePreflightErrorCode::LayoutMismatch
        );
    }
}

#[cfg(feature = "runtime-bundled")]
#[test]
fn bundled_preflight_covers_protocol_timeout_output_shutdown_and_descendant_cleanup() {
    #[cfg(target_os = "linux")]
    let _lock = lock_runtime_layout_test();

    for (behavior, code) in [
        (
            "malformed",
            RuntimePreflightErrorCode::SidecarProtocolInvalid,
        ),
        ("timeout", RuntimePreflightErrorCode::SidecarReadyTimeout),
        (
            "output",
            RuntimePreflightErrorCode::SidecarOutputLimitExceeded,
        ),
        (
            "no-shutdown",
            RuntimePreflightErrorCode::SidecarShutdownFailed,
        ),
        ("no-exit", RuntimePreflightErrorCode::SidecarShutdownFailed),
    ] {
        let tree = copied_tree("bundled", behavior);
        assert_eq!(unavailable(&tree).code, code, "bundled sidecar {behavior}");
    }

    #[cfg(target_os = "linux")]
    {
        let tree = copied_tree("bundled", "descendant");
        let marker = tree.runtime_root().join("descendant-pid");
        let error = unavailable(&tree);
        assert_eq!(error.code, RuntimePreflightErrorCode::SidecarReadyTimeout);
        assert!(error.cleanup_incomplete);
        let pid = fs::read_to_string(marker).expect("fixture recorded live descendant pid");
        for _ in 0..20 {
            let status = fs::read_to_string(Path::new("/proc").join(pid.trim()).join("status"));
            if status.is_err() || status.is_ok_and(|status| status.contains("State:\tZ")) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("owned process adapter left the bundled fixture descendant alive");
    }
}

#[cfg(feature = "runtime-bundled")]
#[test]
fn bundled_git_uses_the_shared_compatibility_policy_and_requires_standard_name() {
    #[cfg(target_os = "linux")]
    let _lock = lock_runtime_layout_test();

    for fixture_name in [
        "git-floor-fixture",
        "git-ceiling-fixture",
        "git-apple-fixture",
        "git-windows-fixture",
        "git-vendor-fixture",
    ] {
        let mut tree = copied_tree("bundled", "ready");
        let git = copy_git_fixture_named(&tree, fixture_name);
        tree.git = git.clone();
        assert_eq!(
            tree.git, git,
            "the bundled manifest must select the copied standard-named Git"
        );
        assert!(
            matches!(
                preflight_with_limits(&tree, FAST_LIMITS),
                RuntimePreflight::Ready(_)
            ),
            "Git fixture {fixture_name} should be accepted by BundledRuntime"
        );
    }

    for (fixture_name, expected) in [
        (
            "git-malformed-fixture",
            RuntimePreflightErrorCode::GitVersionUnreadable,
        ),
        (
            "git-incompatible-fixture",
            RuntimePreflightErrorCode::UnsupportedGitVersion,
        ),
        (
            "git-upper-bound-fixture",
            RuntimePreflightErrorCode::UnsupportedGitVersion,
        ),
    ] {
        let tree = copied_tree("bundled", "ready");
        copy_git_fixture_named(&tree, fixture_name);
        assert_eq!(
            unavailable(&tree).code,
            expected,
            "Git fixture {fixture_name}"
        );
    }

    let tree = copied_tree("bundled", "ready");
    fs::write(
        tree.manifest(),
        r#"{"layoutVersion":1,"layout":{"type":"bundled"},"sidecar":{"type":"embeddedExecutable","path":["bin","sidecar-ready"]},"git":{"path":["bin","private-git"]}}"#,
    )
    .expect("write non-standard bundled Git manifest");
    assert_eq!(
        unavailable(&tree).code,
        RuntimePreflightErrorCode::ManifestInvalid
    );
}

#[cfg(all(feature = "runtime-bundled", target_os = "linux"))]
#[test]
fn bundled_preflight_is_cwd_independent_and_removes_only_runtime_ambient_keys() {
    let _lock = lock_runtime_layout_test();
    let ambient = AmbientEnvironmentGuard::install(&[
        ("nOdE_OPTIONS".into(), "unsafe-node-options".into()),
        ("nOdE_extra_ca_certs".into(), "unsafe-node-certs".into()),
        ("path".into(), "ambient-lower-path".into()),
        ("PaTh".into(), "ambient-mixed-path".into()),
        ("GIT_TEST_SENTINEL".into(), "retained-for-history".into()),
    ]);
    let tree = copied_tree("bundled", "env-check");
    let cwd = tree
        .resource_root
        .parent()
        .expect("temporary parent")
        .join("unrelated-cwd");
    fs::create_dir(&cwd).expect("create unrelated cwd");
    let adapter = UnrelatedCwdTree {
        tree,
        process: UnrelatedCwdProcess(cwd.clone()),
    };
    let ready = matches!(
        preflight_with_limits(&adapter, FAST_LIMITS),
        RuntimePreflight::Ready(_)
    );
    drop(ambient);
    fs::remove_dir_all(cwd).expect("remove unrelated cwd");
    assert!(
        ready,
        "bundled preflight should use absolute installed entries"
    );
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

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn tauri_system_runtime_reaches_real_selectors_before_sidecar_preflight() {
    let _lock = lock_runtime_layout_test();
    let tree = copied_tree("system", "ready");

    assert_eq!(
        unavailable(&tree.tauri_resource_adapter()).code,
        RuntimePreflightErrorCode::SidecarProtocolMismatch
    );
}

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn staged_linux_system_runtime_preflights_the_installed_sidecar_without_a_session() {
    let _lock = lock_runtime_layout_test();
    let resource_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug");
    let adapter = TauriResourceRuntimeLayoutAdapter::new(resource_root);

    let plan = match silksong_git_desktop_lib::runtime_layout::preflight(&adapter) {
        RuntimePreflight::Ready(plan) => plan,
        RuntimePreflight::Unavailable(error) => {
            panic!("installed Linux sidecar should pass the fresh probe: {error:?}")
        }
    };

    // The plan is opaque outside the crate. Desktop-side supervisor tests
    // exercise its later business launch path; this public preflight test
    // preserves the no-session startup boundary.
    assert_eq!(plan, plan.clone());
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
            RuntimePreflightErrorCode::ManifestInvalid
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
            RuntimePreflightErrorCode::ManifestInvalid,
            "must reject unsafe segment {segment:?}"
        );
    }
}

#[cfg(feature = "runtime-system")]
#[test]
fn copied_system_tree_accepts_an_absolute_noncanonical_resource_root() {
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
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
    #[cfg(all(target_os = "linux", feature = "runtime-system"))]
    let _lock = lock_runtime_layout_test();
    INCOMPLETE_CLEANUP_CALLS.store(0, Ordering::Relaxed);
    let tree = IncompleteCleanupTree(copied_tree("system", "malformed"));
    match preflight_with_limits(&tree, FAST_LIMITS) {
        RuntimePreflight::Unavailable(error) => {
            assert_eq!(
                error.code,
                RuntimePreflightErrorCode::SidecarProtocolInvalid
            );
            assert!(error.cleanup_incomplete);
        }
        RuntimePreflight::Ready(_) => panic!("malformed fixture must be unavailable"),
    }
}

#[cfg(all(target_os = "linux", feature = "runtime-system"))]
#[test]
fn linux_owned_process_adapter_reaps_a_real_live_descendant_after_timeout() {
    let _lock = lock_runtime_layout_test();
    let tree = copied_tree("system", "descendant");
    let marker = tree.runtime_root().join("descendant-pid");
    let error = unavailable(&tree);
    assert_eq!(error.code, RuntimePreflightErrorCode::SidecarReadyTimeout);
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
