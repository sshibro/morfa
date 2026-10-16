//! Updates through Tauri's updater (docs/desktop.md §Updates). The endpoint and public key in tauri.conf.json are
//! placeholders until the owner makes the signing key: until then "Check for updates…" says so and the start-up
//! check stays quiet.

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::shell::PRODUCT;

/// The public key placeholder shipped in tauri.conf.json.
pub const PLACEHOLDER_KEY: &str = "MORFA_UPDATER_PUBLIC_KEY_PLACEHOLDER";

pub fn configured(pubkey: &str) -> bool {
    let pubkey = pubkey.trim();
    !pubkey.is_empty() && pubkey != PLACEHOLDER_KEY && !pubkey.contains("PLACEHOLDER")
}

fn pubkey<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Looks for an update; `asked`: the user chose the menu item, so every outcome is reported.
pub fn check<R: Runtime>(app: AppHandle<R>, asked: bool) {
    if !configured(&pubkey(&app)) {
        if asked {
            app.dialog()
                .message("Updates are not set up in this build yet.")
                .title(PRODUCT)
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        let found = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        match found {
            Ok(Some(update)) => {
                let text = format!(
                    "Version {} is available (you have {}). Install and restart?",
                    update.version, update.current_version
                );
                let app_for_answer = app.clone();
                app.dialog()
                    .message(text)
                    .title(PRODUCT)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Install".into(),
                        "Later".into(),
                    ))
                    .show(move |yes| {
                        if !yes {
                            return;
                        }
                        tauri::async_runtime::spawn(async move {
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(()) => app_for_answer.restart(),
                                Err(error) => {
                                    app_for_answer
                                        .dialog()
                                        .message(format!("Couldn't update: {error}"))
                                        .title(PRODUCT)
                                        .kind(MessageDialogKind::Error)
                                        .show(|_| {});
                                }
                            }
                        });
                    });
            }
            Ok(None) if asked => {
                app.dialog()
                    .message("You have the latest version.")
                    .title(PRODUCT)
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
            Err(error) if asked => {
                app.dialog()
                    .message(format!("Couldn't check for updates: {error}"))
                    .title(PRODUCT)
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_placeholder_is_not_a_key() {
        assert!(!super::configured(super::PLACEHOLDER_KEY));
        assert!(!super::configured(""));
        assert!(super::configured(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6"
        ));
    }

    #[test]
    fn the_config_ships_the_placeholder() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["pubkey"],
            super::PLACEHOLDER_KEY
        );
        assert!(
            config["plugins"]["updater"]["endpoints"][0]
                .as_str()
                .unwrap()
                .starts_with("https://")
        );
    }
}
