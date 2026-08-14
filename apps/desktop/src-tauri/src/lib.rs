#[cfg(all(feature = "runtime-system", feature = "runtime-bundled"))]
compile_error!("runtime-system and runtime-bundled are mutually exclusive");
#[cfg(not(any(feature = "runtime-system", feature = "runtime-bundled")))]
compile_error!("one runtime layout feature must be selected");

mod desktop_runtime;
pub mod desktop_sidecar_protocol {
    include!(concat!(env!("OUT_DIR"), "/desktop_sidecar_protocol.rs"));
}
mod managed_initialization;
pub mod runtime_layout;
mod save_location;
mod security;

use std::thread;

use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, Submenu},
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::desktop_runtime::DesktopWorkflow;
use crate::runtime_layout::{
    RuntimeLaunchPlan, RuntimePreflight, RuntimePreflightError, RuntimePreflightErrorCode,
    TauriResourceRuntimeLayoutAdapter, preflight,
};

const MAIN_WINDOW_LABEL: &str = "main";

struct RepositoryMenu<R: tauri::Runtime> {
    close: MenuItem<R>,
    open_external: MenuItem<R>,
    start_watching: MenuItem<R>,
    stop_watching: MenuItem<R>,
}

/// Kept in Rust application state so every sidecar lifecycle receives the
/// exact launch plan that was validated before the WebView was created.
pub(crate) struct RuntimeLayoutState(RuntimePreflight);

impl RuntimeLayoutState {
    fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        Self(tauri_resource_runtime_preflight(app))
    }

    pub(crate) fn plan(&self) -> Result<RuntimeLaunchPlan, RuntimePreflightError> {
        match &self.0 {
            RuntimePreflight::Ready(plan) => Ok(plan.clone()),
            RuntimePreflight::Unavailable(error) => Err(error.clone()),
        }
    }
}

fn tauri_resource_runtime_preflight<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> RuntimePreflight {
    match app.path().resource_dir() {
        Ok(resource_root) => preflight(&TauriResourceRuntimeLayoutAdapter::new(resource_root)),
        Err(_) => RuntimePreflight::Unavailable(RuntimePreflightError::new(
            RuntimePreflightErrorCode::ManifestUnavailable,
        )),
    }
}

pub fn run() {
    tauri::Builder::default()
        // This must remain the first plugin so a second process exits before
        // initializing application state or creating another window.
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| focus_main_window(app),
        ))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopWorkflow::default())
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "repository-library" => navigate_to_library(app),
                "file-inspect-local-save" => inspect_local_save_from_menu(app),
                "repository-initialize" => initialize_managed_repository_from_menu(app),
                "repository-open-external" => open_external_from_menu(app),
                "repository-close" => {
                    if app.state::<DesktopWorkflow>().close().is_ok() {
                        navigate_to_library(app);
                    }
                }
                "repository-start-watching" => {
                    let _ = app.state::<DesktopWorkflow>().control_watcher("watcher.start");
                }
                "repository-stop-watching" => {
                    let _ = app.state::<DesktopWorkflow>().control_watcher("watcher.stop");
                }
                _ => {}
            }
            update_repository_menu(app);
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime::desktop_get_repo_session_connection,
            desktop_runtime::desktop_get_repository_library,
            desktop_runtime::desktop_open_library_entry,
            desktop_runtime::desktop_archive_repository,
            desktop_runtime::desktop_prepare_repository_migration,
            desktop_runtime::desktop_commit_repository_migration,
            desktop_runtime::desktop_close_repository,
            desktop_runtime::desktop_open_external_repository,
            desktop_runtime::desktop_initialize_managed_repository,
            desktop_runtime::desktop_import_repository,
            desktop_runtime::desktop_archive_and_reinitialize_managed_repository,
            desktop_runtime::desktop_pick_static_encoded_save,
            desktop_runtime::desktop_reopen_repository,
            desktop_runtime::desktop_start_watching,
            desktop_runtime::desktop_stop_watching,
        ])
        .setup(|app| {
            // This is intentionally before window construction. A failed
            // preflight still permits static inspection, but Local History
            // commands see a single safe unavailable state.
            app.manage(RuntimeLayoutState::for_app(app.handle()));
            let menu = install_repository_menu(app)?;
            app.manage(menu);
            update_repository_menu(app.handle());
            let app_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                .title("Silksong Git")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .on_navigation(security::is_allowed_navigation)
                .on_new_window(move |url, _features| {
                    if security::is_allowed_external_url(&url)
                        && let Err(error) = app_handle.opener().open_url(url.as_str(), None::<&str>)
                    {
                        eprintln!("failed to open validated external URL: {error}");
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Silksong Git")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let workflow = app.state::<DesktopWorkflow>();
                match workflow.close_requires_confirmation() {
                    Ok(false) => {
                        if workflow.shutdown().is_err() {
                            api.prevent_exit();
                        }
                    }
                    Err(_) => api.prevent_exit(),
                    Ok(true) => {
                        api.prevent_exit();
                        let app_handle = app.clone();
                        app.dialog()
                            .message("Watching will stop after all admitted work drains. Quit Silksong Git?")
                            .title("Stop watching and quit?")
                            .buttons(MessageDialogButtons::OkCancel)
                            .show(move |confirmed| {
                                if confirmed
                                    && app_handle.state::<DesktopWorkflow>().shutdown().is_ok()
                                {
                                    app_handle.exit(0);
                                }
                            });
                    }
                }
            }
        });
}

fn install_repository_menu<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> tauri::Result<RepositoryMenu<R>> {
    let inspect_local_save = MenuItem::with_id(
        app,
        "file-inspect-local-save",
        "Inspect local save…",
        true,
        None::<&str>,
    )?;
    let library = MenuItem::with_id(
        app,
        "repository-library",
        "Repository Library",
        true,
        None::<&str>,
    )?;
    let external = MenuItem::with_id(
        app,
        "repository-open-external",
        "Open External Repository…",
        true,
        None::<&str>,
    )?;
    let initialize = MenuItem::with_id(
        app,
        "repository-initialize",
        "Initialize Managed Repository…",
        true,
        None::<&str>,
    )?;
    let close = MenuItem::with_id(
        app,
        "repository-close",
        "Close Repository",
        true,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(
        app,
        "repository-start-watching",
        "Start Watching",
        true,
        None::<&str>,
    )?;
    let stop = MenuItem::with_id(
        app,
        "repository-stop-watching",
        "Stop Watching",
        true,
        None::<&str>,
    )?;
    let repository = Submenu::with_id_and_items(
        app,
        "repository",
        "Repository",
        true,
        &[&library, &initialize, &external, &close, &start, &stop],
    )?;
    let file = Submenu::with_id_and_items(app, "file", "File", true, &[&inspect_local_save])?;
    let menu = Menu::with_items(app, &[&file, &repository])?;
    app.set_menu(menu)?;
    Ok(RepositoryMenu {
        close,
        open_external: external,
        start_watching: start,
        stop_watching: stop,
    })
}

fn inspect_local_save_from_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let picker_app = app.clone();
    let initial_directory = desktop_runtime::static_save_picker_initial_directory();

    // `FileDialogBuilder::pick_file` is Tauri Dialog's documented main-thread
    // API. Posting it returns from this menu callback before the picker opens;
    // the plugin then initiates the native dialog on the UI event loop.
    let _ = dispatch_menu_static_save_picker(
        |task| app.run_on_main_thread(task),
        move || {
            picker_app
                .dialog()
                .file()
                .set_title("Inspect local Silksong save")
                .add_filter("Silksong save", &["dat"])
                .set_directory(initial_directory)
                .pick_file(move |selected| {
                    inspect_selected_save_after_picker(&picker_app, selected)
                });
        },
    );
}

/// Tauri's `run_on_main_thread` posts a task to the runtime event loop. The
/// injected poster lets the unit test prove that the menu callback has only
/// enqueued UI work; native GTK presentation remains a manual smoke boundary.
fn dispatch_menu_static_save_picker<E>(
    post_to_main_thread: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), E>,
    show_picker: impl FnOnce() + Send + 'static,
) -> Result<(), E> {
    post_to_main_thread(Box::new(show_picker))
}

fn inspect_selected_save_after_picker<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    selected: Option<tauri_plugin_dialog::FilePath>,
) {
    let inspect_app = app.clone();
    let emit_app = app.clone();

    // The picker callback must stay responsive. File validation and sidecar
    // decoding can block, so they run only after the native UI has returned a
    // selected path. The emitted event never contains that path or its bytes.
    thread::spawn(move || {
        let result = match selected {
            Some(file) => file
                .into_path()
                .map_err(|_| desktop_runtime::DesktopRuntimeError::InvalidSaveFile)
                .and_then(|path| {
                    desktop_runtime::inspect_selected_static_encoded_save(&inspect_app, &path)
                }),
            None => Ok(desktop_runtime::PickStaticEncodedSaveResult::Cancelled),
        };
        let _ = emit_app.emit(
            "desktop://static-save-picked",
            desktop_runtime::menu_static_save_result(result),
        );
    });
}

pub(crate) fn update_repository_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<DesktopWorkflow>().repository_menu_state();
    let menu = app.state::<RepositoryMenu<R>>();
    let _ = menu.close.set_enabled(state.close_enabled);
    let _ = menu.open_external.set_enabled(state.open_external_enabled);
    let _ = menu
        .start_watching
        .set_enabled(state.start_watching_enabled);
    let _ = menu.stop_watching.set_enabled(state.stop_watching_enabled);
}

fn navigate_to_library<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.eval("window.location.hash = '#/repositories';");
    }
}

fn open_external_from_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Open Save History Repository")
        .blocking_pick_folder()
    else {
        return;
    };
    let Ok(selected_path) = selected.into_path() else {
        return;
    };
    if matches!(
        app.state::<DesktopWorkflow>().open_repository_path(
            app,
            selected_path,
            desktop_runtime::RepositoryLifecycle::External
        ),
        Ok(desktop_runtime::OpenExternalRepositoryResult::Opened)
    ) {
        navigate_to_library(app);
    }
    update_repository_menu(app);
}

fn initialize_managed_repository_from_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Initialize managed Silksong save history")
        .add_filter("Silksong save", &["dat"])
        .set_directory(desktop_runtime::static_save_picker_initial_directory())
        .blocking_pick_file()
    else {
        return;
    };
    let Ok(selected_path) = selected.into_path() else {
        return;
    };
    if let Err(error) = app
        .state::<DesktopWorkflow>()
        .initialize_managed_repository(app, selected_path)
    {
        eprintln!("managed repository initialization failed: {error}");
    }
    update_repository_menu(app);
}

fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use serde_json::Value;

    use super::{RuntimeLayoutState, dispatch_menu_static_save_picker};
    use crate::runtime_layout::{
        RuntimePreflight, RuntimePreflightError, RuntimePreflightErrorCode,
    };

    const CONFIG: &str = include_str!("../tauri.conf.json");
    const CAPABILITY: &str = include_str!("../capabilities/main.json");

    #[test]
    fn configuration_has_stable_identity_and_one_programmatic_window() {
        let config: Value = serde_json::from_str(CONFIG).expect("valid Tauri config");

        assert_eq!(config["productName"], "Silksong Git");
        assert_eq!(config["identifier"], "io.github.ffff2004.silksong-git");
        assert_eq!(config["mainBinaryName"], "silksong-git");
        assert_eq!(config["app"]["windows"], serde_json::json!([]));
        assert_eq!(config["app"]["withGlobalTauri"], false);
        assert_eq!(config["build"]["frontendDist"], "../../web/dist-desktop");
    }

    #[test]
    fn configuration_keeps_a_strict_content_security_policy() {
        let config: Value = serde_json::from_str(CONFIG).expect("valid Tauri config");
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("CSP should be a string");

        for required in [
            "default-src 'self'",
            "script-src 'self'",
            "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ] {
            assert!(csp.contains(required), "missing {required}");
        }
        for forbidden in ["'unsafe-eval'", "https://", "http://*"] {
            assert!(!csp.contains(forbidden), "CSP contains {forbidden}");
        }
    }

    #[test]
    fn main_window_capability_grants_only_desktop_local_history_intents() {
        let capability: Value = serde_json::from_str(CAPABILITY).expect("valid capability");

        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-desktop-get-repo-session-connection",
                "allow-desktop-get-repository-library",
                "allow-desktop-open-library-entry",
                "allow-desktop-archive-repository",
                "allow-desktop-prepare-repository-migration",
                "allow-desktop-commit-repository-migration",
                "allow-desktop-close-repository",
                "allow-desktop-open-external-repository",
                "allow-desktop-initialize-managed-repository",
                "allow-desktop-import-repository",
                "allow-desktop-archive-and-reinitialize-managed-repository",
                "allow-desktop-pick-static-encoded-save",
                "allow-desktop-reopen-repository",
                "allow-desktop-start-watching",
                "allow-desktop-stop-watching",
                "core:event:default",
            ])
        );
    }

    #[test]
    fn local_save_menu_posts_the_picker_after_its_callback_returns() {
        let task = RefCell::new(None);
        let picker_started = Arc::new(AtomicBool::new(false));
        let picker_started_by_task = Arc::clone(&picker_started);

        dispatch_menu_static_save_picker(
            |work| {
                task.replace(Some(work));
                Ok::<_, ()>(())
            },
            move || {
                picker_started_by_task.store(true, Ordering::SeqCst);
            },
        )
        .expect("menu callback posts a main-thread picker task");

        assert!(!picker_started.load(Ordering::SeqCst));

        task.replace(None).expect("scheduled menu task")();

        assert!(picker_started.load(Ordering::SeqCst));
    }

    #[test]
    fn runtime_layout_state_preserves_precise_preflight_unavailability() {
        let expected = RuntimePreflightError {
            code: RuntimePreflightErrorCode::RuntimeProtocol,
            cleanup_incomplete: true,
        };
        let state = RuntimeLayoutState(RuntimePreflight::Unavailable(expected.clone()));

        assert_eq!(state.plan().expect_err("state is unavailable"), expected);
    }
}
