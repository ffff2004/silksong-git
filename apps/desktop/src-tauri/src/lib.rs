mod security;

use tauri::{
    Manager,
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;

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
        .run(tauri::generate_context!())
        .expect("failed to run Silksong Git");
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
    fn main_window_capability_grants_no_guest_permissions() {
        let capability: Value = serde_json::from_str(CAPABILITY).expect("valid capability");

        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(capability["permissions"], serde_json::json!([]));
    }
}
