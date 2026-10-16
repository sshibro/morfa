include!("src/command_names.rs");

fn main() {
    // An app manifest makes every command need a permission: none is callable unless a capability grants it.
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(BUILD_COMMANDS));
    tauri_build::try_build(attributes).expect("tauri-build");
}
