//! The shell's IPC: the only calls the web app can make (src/desktop/ipc.ts mirrors these names and types).
//!
//! Who may call: Tauri's ACL lets only the app's origin through (shell.rs adds that one capability at start, the
//! bundled offline page gets `retry` alone, capabilities/offline.json), and every command checks the caller's
//! origin again. Nothing here takes a path from the web: files are chosen in native dialogs, fonts are read by the id
//! the list gave.

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{Manager, Runtime, State, Webview};

use crate::fonts::{FontCatalog, FontInfo};
use crate::links::{Target, valid_file_id};
use crate::menu::WebMenu;
use crate::portable;
use crate::recent::name_from_title;
use crate::shell::{Ask, HostEvent, Shell};

/// Every command, for `generate_handler!` and the app manifest (build.rs lists the same names).
#[macro_export]
macro_rules! handlers {
    () => {
        tauri::generate_handler![
            $crate::commands::connect,
            $crate::commands::set_menu,
            $crate::commands::report_location,
            $crate::commands::list_fonts,
            $crate::commands::read_font,
            $crate::commands::save_portable,
            $crate::commands::pick_portable,
            $crate::commands::take_portable,
            $crate::commands::open_window,
            $crate::commands::retry
        ]
    };
}

/// What the bridge learns when it connects.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub version: String,
    pub platform: &'static str,
    pub app_origin: String,
    pub window: String,
}

/// A portable file the shell read for the page (dialog, "Open with", drop on the dock icon).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub token: String,
    pub name: String,
    pub size: u64,
}

/// Defense in depth behind the ACL: the calling page must be the app.
fn require_app<R: Runtime>(shell: &Shell, webview: &Webview<R>) -> Result<(), String> {
    match webview.url() {
        Ok(url) if shell.origins.is_app(&url) => Ok(()),
        _ => Err("This command is only available to the Morfa app.".into()),
    }
}

/// The bridge subscribes to host events (menu commands, files to open); queued ones arrive now.
#[tauri::command]
pub fn connect<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    events: Channel<HostEvent>,
) -> Result<HostInfo, String> {
    require_app(&shell, &webview)?;
    let label = webview.label().to_owned();
    shell.connect(&label, events);
    Ok(HostInfo {
        version: webview.app_handle().package_info().version.to_string(),
        platform: std::env::consts::OS,
        app_origin: shell.origins.app_origin(),
        window: label,
    })
}

/// The editor's menu for this window (or an empty one when the window leaves the editor).
#[tauri::command]
pub fn set_menu<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    menu: WebMenu,
) -> Result<(), String> {
    require_app(&shell, &webview)?;
    if menu.sections.len() > 20 {
        return Err("The menu is too large.".into());
    }
    shell.set_web_menu(webview.app_handle(), webview.label(), menu);
    Ok(())
}

/// The window now shows `file_id` (or the file browser when absent): "Open recent" and the window title follow.
#[tauri::command]
pub fn report_location<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    file_id: Option<String>,
    title: String,
) -> Result<(), String> {
    require_app(&shell, &webview)?;
    let file_id = file_id.filter(|id| valid_file_id(id));
    let title: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect();
    if let Some(window) = webview.app_handle().get_webview_window(webview.label())
        && !title.trim().is_empty()
    {
        let _ = window.set_title(&title);
    }
    shell.located(
        webview.app_handle(),
        webview.label(),
        file_id.as_deref(),
        &name_from_title(&title),
    );
    Ok(())
}

/// The system's fonts (scanned once, on the first call, off the main thread).
#[tauri::command]
pub async fn list_fonts<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
) -> Result<Vec<FontInfo>, String> {
    require_app(&shell, &webview)?;
    Ok(shell.fonts().await.list())
}

/// One listed font's file, as raw bytes.
#[tauri::command]
pub async fn read_font<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    id: u32,
) -> Result<Response, String> {
    require_app(&shell, &webview)?;
    let catalog: Arc<FontCatalog> = shell.fonts().await;
    let bytes = tauri::async_runtime::spawn_blocking(move || catalog.read(id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Response::new(bytes))
}

/// The file name the page suggests, percent-encoded in a header (raw bodies carry no other arguments).
fn suggested_name(request: &Request<'_>) -> String {
    let raw = request
        .headers()
        .get("x-morfa-name")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    portable::file_name(
        &url::form_urlencoded::parse(format!("n={raw}").as_bytes())
            .next()
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default(),
    )
}

/// "Save to computer": the body is the portable file; the native save dialog picks where. Answers the saved
/// file's name, or null when the dialog was closed.
#[tauri::command]
pub async fn save_portable<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    require_app(&shell, &webview)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a file.".into());
    };
    if bytes.len() as u64 > portable::MAX_BYTES {
        return Err("The file is larger than 50 MB.".into());
    }
    let name = suggested_name(&request);
    let Some(path) = shell
        .choose(Ask::Save {
            window: webview.label().to_owned(),
            name,
        })
        .await
    else {
        return Ok(None);
    };
    let path = portable::with_extension(path);
    let bytes = bytes.clone();
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || portable::write(&written, &bytes))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Some(
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ))
}

/// "Open file from computer…" through the native dialog: the chosen file waits under a token for `take_portable`.
#[tauri::command]
pub async fn pick_portable<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
) -> Result<Option<PickedFile>, String> {
    require_app(&shell, &webview)?;
    let Some(path) = shell
        .choose(Ask::Open {
            window: webview.label().to_owned(),
        })
        .await
    else {
        return Ok(None);
    };
    let picked = tauri::async_runtime::spawn_blocking(move || {
        portable::read(&path).map(|bytes| (path, bytes))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Some(shell.keep_picked(&picked.0, picked.1)))
}

/// The bytes of a picked file, once.
#[tauri::command]
pub fn take_portable<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    token: String,
) -> Result<Response, String> {
    require_app(&shell, &webview)?;
    shell
        .take_picked(&token)
        .map(Response::new)
        .ok_or_else(|| "The file is already open or was not found.".into())
}

/// A new window at an app route: `designs` or `design/<id>`. A window already showing that file is focused instead.
#[tauri::command]
pub fn open_window<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    hash: String,
) -> Result<(), String> {
    require_app(&shell, &webview)?;
    let target = target_of_hash(&hash).ok_or("No such section.")?;
    shell.open_target(webview.app_handle(), target);
    Ok(())
}

/// `designs` / `design/<id>` (with or without `#`) as a target.
pub fn target_of_hash(hash: &str) -> Option<Target> {
    let hash = hash.trim_start_matches('#');
    if hash == "designs" || hash.is_empty() {
        return Some(Target::Files);
    }
    let id = hash.strip_prefix("design/")?;
    valid_file_id(id).then(|| Target::File(id.to_owned()))
}

/// The offline page's "Retry": loads the app in this window when its server answers. Only the bundled page calls it.
#[tauri::command]
pub async fn retry<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    hash: Option<String>,
) -> Result<bool, String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    if shell.origins.classify(&url) != crate::origin::Navigation::Shell {
        return Err("Only for the offline page.".into());
    }
    let origins = shell.origins.clone();
    let reachable = tauri::async_runtime::spawn_blocking(move || {
        crate::reach::reachable(&origins.app, crate::shell::PROBE_TIMEOUT)
    })
    .await
    .unwrap_or(false);
    if !reachable {
        return Ok(false);
    }
    let hash = hash
        .as_deref()
        .and_then(target_of_hash)
        .map(|target| match target {
            Target::File(id) => format!("design/{id}"),
            _ => "designs".into(),
        });
    webview
        .navigate(shell.origins.app_url(hash.as_deref().unwrap_or("designs")))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// Used by shell.rs when a file reaches the app outside the page (arguments, the dock, the menu).
pub fn picked_event(picked: PickedFile) -> HostEvent {
    HostEvent::Portable {
        token: picked.token,
        name: picked.name,
    }
}

#[cfg(test)]
mod tests;
