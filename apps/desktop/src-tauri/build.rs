fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_get_repo_session_connection",
            "desktop_open_external_repository",
            "desktop_reopen_repository",
            "desktop_start_watching",
            "desktop_stop_watching",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
