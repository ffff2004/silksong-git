use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let version_path = manifest_directory.join("../../desktop-sidecar/src/protocol-version.json");
    println!("cargo:rerun-if-changed={}", version_path.display());

    let version_definition = fs::read_to_string(&version_path)
        .expect("read Desktop sidecar protocol version definition");
    let version = serde_json::from_str::<ProtocolVersion>(&version_definition)
        .expect("parse Desktop sidecar protocol version definition")
        .version;
    let generated = format!("pub const VERSION: u8 = {version};\n");
    let output_path = PathBuf::from(env::var("OUT_DIR").expect("Cargo build output directory"))
        .join("desktop_sidecar_protocol.rs");
    fs::write(output_path, generated).expect("write generated Desktop sidecar protocol version");

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_get_repo_session_connection",
            "desktop_open_external_repository",
            "desktop_initialize_managed_repository",
            "desktop_archive_and_reinitialize_managed_repository",
            "desktop_pick_static_encoded_save",
            "desktop_reopen_repository",
            "desktop_start_watching",
            "desktop_stop_watching",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}

#[derive(serde::Deserialize)]
struct ProtocolVersion {
    version: u8,
}
