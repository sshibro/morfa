//! The shell's state and windows: one window per file (or the file browser), its menu, its bridge channel, and the
//! links and files that reach the app from the system.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::commands::{PickedFile, picked_event};
use crate::fonts::FontCatalog;
use crate::links::{Target, targets_from_args};
use crate::menu::{self, Entry, NativeItem, Platform, WebMenu, ids};
use crate::origin::{Navigation, Origins};
use crate::recent::Recent;

pub const PRODUCT: &str = "Morfa";
/// How long the start waits for the server before showing the offline page.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// The capability that gives the app's origin the shell's commands (`retry` is the offline page's).
const APP_PERMISSIONS: &[&str] = &[
    "allow-connect",
    "allow-set-menu",
    "allow-report-location",
    "allow-list-fonts",
    "allow-read-font",
    "allow-save-portable",
    "allow-pick-portable",
    "allow-take-portable",
    "allow-open-window",
];

/// What the shell tells a page (src/desktop/ipc.ts `HostEvent`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostEvent {
    /// A native menu item of the editor's was chosen.
    Menu { command: String },
    /// A portable file waits under `token` (take_portable): open it as a new file.
    Portable { token: String, name: String },
    /// Go to the file browser (in-page, through the editor's save guard).
    Files,
}

/// A question for the native file dialogs (tests answer it themselves).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    Save { window: String, name: String },
    Open { window: String },
}

type Chooser = Arc<dyn Fn(Ask) -> Option<PathBuf> + Send + Sync>;

#[derive(Default)]
struct WindowState {
    file: Option<String>,
    menu: WebMenu,
    channel: Option<Channel<HostEvent>>,
    pending: Vec<HostEvent>,
}

pub struct Shell {
    pub origins: Origins,
    platform: Platform,
    recent: Mutex<Recent>,
    fonts: tokio::sync::OnceCell<Arc<FontCatalog>>,
    font_source: Arc<dyn Fn() -> FontCatalog + Send + Sync>,
    windows: Mutex<HashMap<String, WindowState>>,
    picked: Mutex<HashMap<String, Vec<u8>>>,
    chooser: Mutex<Option<Chooser>>,
    next: AtomicU64,
    /// Off in the mock-runtime tests, which cannot attach a native menu (menu.rs tests the layout itself).
    native_menus: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

impl Shell {
    pub fn new(origins: Origins, recent: Recent) -> Self {
        Self {
            origins,
            platform: Platform::current(),
            recent: Mutex::new(recent),
            fonts: tokio::sync::OnceCell::new(),
            font_source: Arc::new(FontCatalog::system),
            windows: Mutex::new(HashMap::new()),
            picked: Mutex::new(HashMap::new()),
            chooser: Mutex::new(None),
            next: AtomicU64::new(1),
            native_menus: true,
        }
    }

    #[cfg(test)]
    pub fn without_native_menus(mut self) -> Self {
        self.native_menus = false;
        self
    }

    /// Where fonts come from (tests use a folder).
    pub fn with_fonts(mut self, source: impl Fn() -> FontCatalog + Send + Sync + 'static) -> Self {
        self.font_source = Arc::new(source);
        self
    }

    pub fn set_chooser(&self, chooser: impl Fn(Ask) -> Option<PathBuf> + Send + Sync + 'static) {
        *self.chooser.lock().unwrap() = Some(Arc::new(chooser));
    }

    pub async fn fonts(&self) -> Arc<FontCatalog> {
        let source = self.font_source.clone();
        self.fonts
            .get_or_init(|| async move {
                Arc::new(
                    tauri::async_runtime::spawn_blocking(move || source())
                        .await
                        .unwrap_or_default(),
                )
            })
            .await
            .clone()
    }

    pub async fn choose(&self, ask: Ask) -> Option<PathBuf> {
        let chooser = self.chooser.lock().unwrap().clone()?;
        tauri::async_runtime::spawn_blocking(move || chooser(ask))
            .await
            .ok()
            .flatten()
    }

    fn token(&self) -> String {
        format!(
            "p{}-{}",
            self.next.fetch_add(1, Ordering::Relaxed),
            now_ms()
        )
    }

    /// Keeps a read portable file for `take_portable` (at most a few at a time: older ones are dropped).
    pub fn keep_picked(&self, path: &Path, bytes: Vec<u8>) -> PickedFile {
        let token = self.token();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let size = bytes.len() as u64;
        let mut picked = self.picked.lock().unwrap();
        if picked.len() >= 8 {
            picked.clear();
        }
        picked.insert(token.clone(), bytes);
        PickedFile { token, name, size }
    }

    pub fn take_picked(&self, token: &str) -> Option<Vec<u8>> {
        self.picked.lock().unwrap().remove(token)
    }

    pub fn connect(&self, label: &str, channel: Channel<HostEvent>) {
        let mut windows = self.windows.lock().unwrap();
        let state = windows.entry(label.to_owned()).or_default();
        for event in state.pending.drain(..) {
            let _ = channel.send(event);
        }
        state.channel = Some(channel);
    }

    /// Sends to a window's page, or queues until its bridge connects.
    pub fn send(&self, label: &str, event: HostEvent) {
        let mut windows = self.windows.lock().unwrap();
        let state = windows.entry(label.to_owned()).or_default();
        match &state.channel {
            Some(channel) if channel.send(event.clone()).is_ok() => {}
            _ => {
                state.channel = None;
                state.pending.push(event);
            }
        }
    }

    fn file_window(&self, file: &str) -> Option<String> {
        self.windows
            .lock()
            .unwrap()
            .iter()
            .find(|(_, state)| state.file.as_deref() == Some(file))
            .map(|(label, _)| label.clone())
    }

    pub fn located<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
        file: Option<&str>,
        name: &str,
    ) {
        let left_editor = {
            let mut windows = self.windows.lock().unwrap();
            let state = windows.entry(label.to_owned()).or_default();
            state.file = file.map(Into::into);
            if file.is_none() && !state.menu.sections.is_empty() {
                state.menu = WebMenu::default();
                true
            } else {
                false
            }
        };
        let changed = file.is_some_and(|id| self.recent.lock().unwrap().touch(id, name, now_ms()));
        if changed {
            self.refresh_all_menus(app);
        } else if left_editor {
            self.refresh_menu(app, label);
        }
    }

    pub fn set_web_menu<R: Runtime>(&self, app: &AppHandle<R>, label: &str, menu: WebMenu) {
        {
            let mut windows = self.windows.lock().unwrap();
            let state = windows.entry(label.to_owned()).or_default();
            if state.menu == menu {
                return;
            }
            state.menu = menu;
        }
        self.refresh_menu(app, label);
    }

    fn forget(&self, label: &str) {
        self.windows.lock().unwrap().remove(label);
    }

    /// The menu bar of one window (Windows, Linux) or of the app while that window is in front (macOS).
    fn refresh_menu<R: Runtime>(&self, app: &AppHandle<R>, label: &str) {
        if !self.native_menus {
            return;
        }
        let Some(window) = app.get_webview_window(label) else {
            return;
        };
        let web = self
            .windows
            .lock()
            .unwrap()
            .get(label)
            .map(|state| state.menu.clone())
            .unwrap_or_default();
        let recent = self.recent.lock().unwrap().files().to_vec();
        let plan = menu::plan(&web, &recent, self.platform, PRODUCT);
        let result = build_menu(app, &plan).and_then(|built| {
            if self.platform == Platform::Mac {
                if window.is_focused().unwrap_or(true) {
                    app.set_menu(built)?;
                }
                Ok(())
            } else {
                window.set_menu(built).map(|_| ())
            }
        });
        if let Err(error) = result {
            eprintln!("morfa: menu for {label}: {error}");
        }
    }

    fn refresh_all_menus<R: Runtime>(&self, app: &AppHandle<R>) {
        let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
        if self.platform == Platform::Mac {
            if let Some(focused) = focused_label(app).or_else(|| labels.first().cloned()) {
                self.refresh_menu(app, &focused);
            }
            return;
        }
        for label in labels {
            self.refresh_menu(app, &label);
        }
    }

    /// Opens what a link, an argument or the menu asked for.
    pub fn open_target<R: Runtime>(&self, app: &AppHandle<R>, target: Target) {
        match target {
            Target::File(id) => match self.file_window(&id) {
                // A window for it exists, or is being made right now (the same link often arrives twice:
                // through the deep-link plugin and as a second launch's argument).
                Some(label) => {
                    if let Some(window) = app.get_webview_window(&label) {
                        focus(&window);
                    }
                }
                None => {
                    self.spawn_window(app, format!("design/{id}"), Some(id));
                }
            },
            Target::Files => match focused_label(app)
                .or_else(|| app.webview_windows().keys().next().cloned())
                .and_then(|label| app.get_webview_window(&label))
            {
                Some(window) => focus(&window),
                None => {
                    self.spawn_window(app, "designs".into(), None);
                }
            },
            Target::Portable(path) => match crate::portable::read(&path) {
                Ok(bytes) => {
                    let picked = self.keep_picked(&path, bytes);
                    let label =
                        focused_label(app).or_else(|| app.webview_windows().keys().next().cloned());
                    match label {
                        Some(label) => {
                            if let Some(window) = app.get_webview_window(&label) {
                                focus(&window);
                            }
                            self.send(&label, picked_event(picked));
                        }
                        None => {
                            let label = self.spawn_window(app, "designs".into(), None);
                            self.send(&label, picked_event(picked));
                        }
                    }
                }
                Err(error) => show_error(app, &error),
            },
        }
    }

    /// A new window at an app hash, created off the main thread (the reachability probe may take seconds).
    pub fn spawn_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        hash: String,
        file: Option<String>,
    ) -> String {
        let label = format!("w{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.windows.lock().unwrap().insert(
            label.clone(),
            WindowState {
                file,
                ..Default::default()
            },
        );
        let app = app.clone();
        let spawned = label.clone();
        std::thread::spawn(move || {
            if let Err(error) = create_window(&app, &spawned, &hash) {
                eprintln!("morfa: window {spawned}: {error}");
                // Forgotten, so the next link to that file tries again.
                app.state::<Shell>().forget(&spawned);
            }
        });
        label
    }

    /// The menu's own items; `web:` ones go to the page of the window in front.
    pub fn on_menu<R: Runtime>(&self, app: &AppHandle<R>, id: &str) {
        let front = focused_label(app);
        if let Some(command) = id.strip_prefix(ids::WEB_PREFIX) {
            if let Some(label) = front {
                self.send(
                    &label,
                    HostEvent::Menu {
                        command: command.to_owned(),
                    },
                );
            }
            return;
        }
        if let Some(file) = id.strip_prefix(ids::RECENT_PREFIX) {
            self.open_target(app, Target::File(file.to_owned()));
            return;
        }
        match id {
            ids::NEW_WINDOW => {
                self.spawn_window(app, "designs".into(), None);
            }
            ids::FILES => match front {
                Some(label) => self.send(&label, HostEvent::Files),
                None => {
                    self.spawn_window(app, "designs".into(), None);
                }
            },
            ids::OPEN_PORTABLE => {
                let app = app.clone();
                let window = front.unwrap_or_default();
                tauri::async_runtime::spawn(async move {
                    let shell = app.state::<Shell>();
                    if let Some(path) = shell.choose(Ask::Open { window }).await {
                        shell.open_target(&app, Target::Portable(path));
                    }
                });
            }
            ids::CLOSE_WINDOW => {
                if let Some(window) = front.and_then(|label| app.get_webview_window(&label)) {
                    let _ = window.close();
                }
            }
            ids::RELOAD => {
                if let Some(window) = front.and_then(|label| app.get_webview_window(&label)) {
                    let _ = window.reload();
                }
            }
            ids::RECENT_CLEAR => {
                self.recent.lock().unwrap().clear();
                self.refresh_all_menus(app);
            }
            ids::CHECK_UPDATES => crate::updates::check(app.clone(), true),
            ids::QUIT => app.exit(0),
            _ => {}
        }
    }
}

fn focus<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn focused_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

pub fn show_error<R: Runtime>(app: &AppHandle<R>, text: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    if app.try_state::<tauri_plugin_dialog::Dialog<R>>().is_none() {
        eprintln!("morfa: {text}");
        return;
    }
    app.dialog()
        .message(text)
        .title(PRODUCT)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// Marks the app's pages as running in the shell (src/desktop/detect.ts). Only on the app's origin: the landing and
/// the offline page never see it.
fn marker_script(origins: &Origins, version: &str) -> String {
    let info = serde_json::json!({"version": version, "platform": std::env::consts::OS});
    let origin = serde_json::to_string(&origins.app_origin()).unwrap_or_default();
    format!(
        "if (window.location.origin === {origin}) Object.defineProperty(window, '__MORFA_DESKTOP__', {{value: Object.freeze({info}), configurable: false, enumerable: false, writable: false}});"
    )
}

/// Builds a Morfa window. Shared by fresh windows and the ones the page opens with `window.open`.
fn window_builder<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, R, M> {
    let shell = manager.state::<Shell>();
    let origins = shell.origins.clone();
    let navigation_origins = origins.clone();
    let opener = manager.app_handle().clone();
    let app = manager.app_handle().clone();
    let version = manager.app_handle().package_info().version.to_string();
    WebviewWindowBuilder::new(manager, label, url)
        .title(PRODUCT)
        .inner_size(1440.0, 900.0)
        .min_inner_size(800.0, 560.0)
        // The editor handles dropped pictures itself (Rulers.tsx, HTML5 drop); Tauri's own drop handler would swallow them.
        .disable_drag_drop_handler()
        .initialization_script(marker_script(&origins, &version))
        .on_navigation(move |url| match navigation_origins.classify(url) {
            Navigation::App | Navigation::Landing | Navigation::Shell => true,
            Navigation::External => {
                open_external(&opener, url.as_str());
                false
            }
            Navigation::Refuse => false,
        })
        .on_new_window(move |url, features| new_window(&app, &origins, url, features))
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        })
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if app.try_state::<tauri_plugin_opener::Opener<R>>().is_some() {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

/// `window.open` from a page: the app's own addresses (a file in a new tab, the player, `about:blank` that the page
/// fills in a moment later) become Morfa windows; the web goes to the system browser.
fn new_window<R: Runtime>(
    app: &AppHandle<R>,
    origins: &Origins,
    url: url::Url,
    features: tauri::webview::NewWindowFeatures,
) -> NewWindowResponse<R> {
    match origins.classify(&url) {
        Navigation::App | Navigation::Shell => {
            let shell = app.state::<Shell>();
            let label = format!("w{}", shell.next.fetch_add(1, Ordering::Relaxed));
            shell
                .windows
                .lock()
                .unwrap()
                .insert(label.clone(), WindowState::default());
            let blank = WebviewUrl::External("about:blank".parse().expect("about:blank"));
            match window_builder(app, &label, blank)
                .window_features(features)
                .build()
            {
                Ok(window) => {
                    shell.refresh_menu(app, &label);
                    NewWindowResponse::Create { window }
                }
                Err(error) => {
                    eprintln!("morfa: new window: {error}");
                    shell.forget(&label);
                    NewWindowResponse::Deny
                }
            }
        }
        Navigation::Landing | Navigation::External => {
            open_external(app, url.as_str());
            NewWindowResponse::Deny
        }
        Navigation::Refuse => NewWindowResponse::Deny,
    }
}

/// A window at an app hash, or the offline page when the server cannot be reached.
fn create_window<R: Runtime>(app: &AppHandle<R>, label: &str, hash: &str) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let url = if crate::reach::reachable(&shell.origins.app, PROBE_TIMEOUT) {
        WebviewUrl::External(shell.origins.app_url(hash))
    } else {
        let to: String = url::form_urlencoded::byte_serialize(hash.as_bytes()).collect();
        WebviewUrl::App(format!("index.html?to={to}").into())
    };
    window_builder(app, label, url).build()?;
    shell.refresh_menu(app, label);
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, plan: &[Entry]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for entry in plan {
        if let Some(item) = build_entry(app, entry)? {
            menu.append(item.as_ref())?;
        }
    }
    Ok(menu)
}

fn build_entry<R: Runtime>(
    app: &AppHandle<R>,
    entry: &Entry,
) -> tauri::Result<Option<Box<dyn IsMenuItem<R>>>> {
    Ok(Some(match entry {
        Entry::Item {
            id,
            label,
            accelerator,
            enabled,
            checked: Some(checked),
        } => Box::new(CheckMenuItem::with_id(
            app,
            id.as_str(),
            label,
            *enabled,
            *checked,
            accelerator.as_deref(),
        )?),
        Entry::Item {
            id,
            label,
            accelerator,
            enabled,
            checked: None,
        } => Box::new(MenuItem::with_id(
            app,
            id.as_str(),
            label,
            *enabled,
            accelerator.as_deref(),
        )?),
        Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Entry::Submenu { label, items } => {
            let submenu = Submenu::new(app, label, true)?;
            for item in items {
                if let Some(child) = build_entry(app, item)? {
                    submenu.append(child.as_ref())?;
                }
            }
            Box::new(submenu)
        }
        Entry::Native(native) => Box::new(match native {
            NativeItem::About => {
                PredefinedMenuItem::about(app, Some(&format!("About {PRODUCT}")), None)?
            }
            NativeItem::Services => PredefinedMenuItem::services(app, Some("Services"))?,
            NativeItem::Hide => PredefinedMenuItem::hide(app, Some(&format!("Hide {PRODUCT}")))?,
            NativeItem::HideOthers => {
                PredefinedMenuItem::hide_others(app, Some("Hide others"))?
            }
            NativeItem::ShowAll => PredefinedMenuItem::show_all(app, Some("Show all"))?,
            NativeItem::Quit => {
                PredefinedMenuItem::quit(app, Some(&format!("Quit {PRODUCT}")))?
            }
            NativeItem::Copy => PredefinedMenuItem::copy(app, Some("Copy"))?,
            NativeItem::Cut => PredefinedMenuItem::cut(app, Some("Cut"))?,
            NativeItem::Paste => PredefinedMenuItem::paste(app, Some("Paste"))?,
            NativeItem::Minimize => PredefinedMenuItem::minimize(app, Some("Minimize"))?,
            NativeItem::Zoom => PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            NativeItem::Fullscreen => PredefinedMenuItem::fullscreen(app, Some("Enter full screen"))?,
            NativeItem::CloseWindow => PredefinedMenuItem::close_window(app, Some("Close window"))?,
        }),
    }))
}

/// The capability that opens the shell's commands to the app's origin, and nothing else (docs/desktop.md §Security).
pub fn app_capability(origins: &Origins) -> CapabilityBuilder {
    APP_PERMISSIONS.iter().fold(
        CapabilityBuilder::new("morfa-app-origin")
            .remote(origins.app_pattern())
            .window("*"),
        |capability, permission| capability.permission(*permission),
    )
}

/// Everything but the plugins and the real runtime: shared by `run` and the tests (commands/tests.rs).
pub fn configure<R: Runtime>(builder: tauri::Builder<R>, shell: Shell) -> tauri::Builder<R> {
    builder
        .manage(shell)
        .invoke_handler(crate::handlers!())
        .on_menu_event(|app, event| app.state::<Shell>().on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) if Platform::current() == Platform::Mac => window
                .state::<Shell>()
                .refresh_menu(window.app_handle(), window.label()),
            WindowEvent::Destroyed => window.state::<Shell>().forget(window.label()),
            _ => {}
        })
}

fn native_chooser<R: Runtime>(
    app: AppHandle<R>,
) -> impl Fn(Ask) -> Option<PathBuf> + Send + Sync + 'static {
    use tauri_plugin_dialog::DialogExt;
    move |ask| {
        #[cfg(feature = "smoke")]
        if let Some(path) = smoke_answer(&ask) {
            return Some(path);
        }
        let (window, dialog) = match &ask {
            Ask::Save { window, name } => (
                window,
                app.dialog()
                    .file()
                    .set_file_name(name)
                    .set_title("Save to computer"),
            ),
            Ask::Open { window } => (
                window,
                app.dialog().file().set_title("Open file from computer"),
            ),
        };
        let dialog = dialog.add_filter(PRODUCT, &["rdesign"]);
        let dialog = match app.get_webview_window(window) {
            Some(parent) => dialog.set_parent(&parent),
            None => dialog,
        };
        let chosen = match ask {
            Ask::Save { .. } => dialog.blocking_save_file(),
            Ask::Open { .. } => dialog.blocking_pick_file(),
        };
        chosen.and_then(|path| path.into_path().ok())
    }
}

/// The smoke run (scripts/smoke) cannot click a native dialog: a smoke build answers from the environment.
#[cfg(feature = "smoke")]
fn smoke_answer(ask: &Ask) -> Option<PathBuf> {
    let key = match ask {
        Ask::Save { .. } => "MORFA_DESKTOP_SMOKE_SAVE",
        Ask::Open { .. } => "MORFA_DESKTOP_SMOKE_OPEN",
    };
    std::env::var_os(key).map(PathBuf::from)
}

pub fn run() {
    let origins = match Origins::from_env(
        std::env::var("MORFA_APP_ORIGIN").ok().as_deref(),
        std::env::var("MORFA_LANDING_ORIGIN").ok().as_deref(),
        cfg!(debug_assertions),
    ) {
        Ok(origins) => origins,
        Err(error) => {
            eprintln!("morfa: {error}");
            std::process::exit(2);
        }
    };
    let builder = tauri::Builder::default()
        // First: a second launch hands its arguments (links, files) to this one and quits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let shell = app.state::<Shell>();
            let targets = targets_from_args(argv.iter().skip(1), Path::new(&cwd), &shell.origins);
            if targets.is_empty() {
                shell.open_target(app, Target::Files);
            }
            for target in targets {
                shell.open_target(app, target);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    let app = configure(builder, Shell::new(origins, Recent::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            let shell = app.state::<Shell>();
            app.add_capability(app_capability(&shell.origins))?;
            if let Ok(dir) = app.path().app_config_dir() {
                *shell.recent.lock().unwrap() = Recent::load(dir.join("recent.json"));
            }
            shell.set_chooser(native_chooser(handle.clone()));
            setup_links(&handle);
            let cwd = std::env::current_dir().unwrap_or_default();
            let targets = targets_from_args(std::env::args().skip(1), &cwd, &shell.origins);
            let first = targets.iter().find_map(|target| match target {
                Target::File(id) => Some(id.clone()),
                _ => None,
            });
            match &first {
                Some(id) => shell.spawn_window(&handle, format!("design/{id}"), Some(id.clone())),
                None => shell.spawn_window(&handle, "designs".into(), None),
            };
            for target in targets {
                if !matches!(&target, Target::File(id) if Some(id) == first.as_ref()) {
                    shell.open_target(&handle, target);
                }
            }
            crate::updates::check(handle, false);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("morfa: the app could not start");
    app.run(|app, event| {
        // macOS hands files and links to a running app as "opened" URLs.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            let shell = app.state::<Shell>();
            for url in urls {
                if url.scheme() == "file" {
                    if let Ok(path) = url.to_file_path() {
                        shell.open_target(app, Target::Portable(path));
                    }
                } else if let Some(target) = crate::links::parse_link(url.as_str(), &shell.origins)
                {
                    shell.open_target(app, target);
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = &event
        {
            app.state::<Shell>().open_target(app, Target::Files);
        }
        let _ = (app, event);
    });
}

fn setup_links<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    // AppImage and dev runs are not installed packages: register the scheme for this user (the .deb and the
    // Windows installer register it themselves).
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    let _ = app.deep_link().register_all();
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let shell = handle.state::<Shell>();
        for url in event.urls() {
            if let Some(target) = crate::links::parse_link(url.as_str(), &shell.origins) {
                shell.open_target(&handle, target);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_only_the_app_origin() {
        let origins = Origins::from_env(None, None, false).unwrap();
        let script = marker_script(&origins, "0.1.0");
        assert!(
            script.starts_with(r#"if (window.location.origin === "https://app.morfa.example")"#),
            "{script}"
        );
        assert!(script.contains("__MORFA_DESKTOP__") && script.contains(r#""version":"0.1.0""#));
    }

    #[test]
    fn the_capability_names_every_app_command_but_retry() {
        assert_eq!(APP_PERMISSIONS.len(), crate::BUILD_COMMANDS.len() - 1);
        for command in crate::BUILD_COMMANDS {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(
                APP_PERMISSIONS.contains(&permission.as_str()),
                *command != "retry",
                "{command}"
            );
        }
    }
}
