mod desktop_runtime;
mod security;

use tauri::{
    Manager,
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;

use crate::desktop_runtime::DesktopRuntime;

const MAIN_WINDOW_LABEL: &str = "main";

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
        .manage(DesktopRuntime::default())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime::desktop_get_repo_session_connection,
            desktop_runtime::desktop_open_external_repository,
            desktop_runtime::desktop_start_watching,
            desktop_runtime::desktop_stop_watching,
        ])
        .setup(|app| {
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
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let _ = app.state::<DesktopRuntime>().shutdown();
            }
        });
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
    use serde_json::Value;

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
                "allow-desktop-open-external-repository",
                "allow-desktop-start-watching",
                "allow-desktop-stop-watching",
            ])
        );
    }
}
