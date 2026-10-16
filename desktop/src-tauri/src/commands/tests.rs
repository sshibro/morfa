//! Every command through Tauri's mock runtime and the real ACL (the build's app manifest, the offline page's
//! capability and the app-origin capability shell.rs adds at start).

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::{CallbackFn, Channel, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::fonts::FontCatalog;
use crate::origin::Origins;
use crate::recent::Recent;
use crate::shell::{Ask, HostEvent, Shell, app_capability, configure};

struct Fixture {
    app: App<MockRuntime>,
    origins: Origins,
    dir: tempfile::TempDir,
    asked: Arc<Mutex<Vec<Ask>>>,
    answer: Arc<Mutex<Option<PathBuf>>>,
    // The app's "server": the reachability probe of new windows connects to it.
    _server: TcpListener,
}

fn fixture() -> Fixture {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", server.local_addr().unwrap().port());
    let origins = Origins::from_env(Some(&origin), Some("http://localhost:4401"), false).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let fonts_dir = dir.path().join("fonts");
    std::fs::create_dir(&fonts_dir).unwrap();
    if let Some(font) = crate::fonts::tests_support::some_system_font() {
        std::fs::copy(&font, fonts_dir.join(font.file_name().unwrap())).unwrap();
    }
    let shell = Shell::new(
        origins.clone(),
        Recent::load(dir.path().join("recent.json")),
    )
    .with_fonts(move || FontCatalog::from_dirs(&[&fonts_dir]))
    .without_native_menus();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let answer: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let (asked_by, answered_by) = (asked.clone(), answer.clone());
    shell.set_chooser(move |ask| {
        asked_by.lock().unwrap().push(ask);
        answered_by.lock().unwrap().clone()
    });
    let app = configure(mock_builder(), shell)
        .build(tauri::generate_context!(test = true))
        .unwrap();
    app.add_capability(app_capability(&origins)).unwrap();
    Fixture {
        app,
        origins,
        dir,
        asked,
        answer,
        _server: server,
    }
}

impl Fixture {
    fn window(&self, label: &str, url: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(&self.app, label, WebviewUrl::External(url.parse().unwrap()))
            .build()
            .unwrap()
    }

    fn app_window(&self, label: &str) -> WebviewWindow<MockRuntime> {
        self.window(label, self.origins.app_url("designs").as_str())
    }

    fn shell(&self) -> tauri::State<'_, Shell> {
        self.app.state::<Shell>()
    }
}

fn request(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    headers: &[(&'static str, &str)],
) -> Result<InvokeResponseBody, serde_json::Value> {
    let mut map = tauri::http::HeaderMap::new();
    for (name, value) in headers {
        map.insert(*name, value.parse().unwrap());
    }
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: window.url().unwrap(),
            body,
            headers: map,
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

fn call(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    request(window, cmd, InvokeBody::Json(args), &[]).map(|body| {
        body.deserialize::<serde_json::Value>()
            .unwrap_or(serde_json::Value::Null)
    })
}

fn raw(body: InvokeResponseBody) -> Vec<u8> {
    match body {
        InvokeResponseBody::Raw(bytes) => bytes,
        InvokeResponseBody::Json(json) => panic!("expected bytes, got {json}"),
    }
}

fn denied(result: Result<serde_json::Value, serde_json::Value>) -> bool {
    matches!(result, Err(serde_json::Value::String(text)) if text.contains("not allowed") || text.contains("only available") || text.contains("Only for"))
}

#[test]
fn only_the_app_origin_reaches_the_commands() {
    let f = fixture();
    let app = f.app_window("app");
    let landing = f.window("landing", f.origins.landing.as_str());
    let evil = f.window("evil", "https://evil.example/");
    let offline = f.window("offline", "tauri://localhost/index.html");
    for window in [&landing, &evil, &offline] {
        for cmd in [
            "set_menu",
            "report_location",
            "list_fonts",
            "read_font",
            "pick_portable",
            "take_portable",
            "open_window",
        ] {
            let args = serde_json::json!({"menu": {"sections": []}, "fileId": null, "title": "", "id": 0, "token": "x", "hash": "designs"});
            assert!(
                denied(call(window, cmd, args)),
                "{cmd} from {} must be refused",
                window.url().unwrap()
            );
        }
        assert!(denied(
            request(
                window,
                "save_portable",
                InvokeBody::Raw(b"{}".to_vec()),
                &[]
            )
            .map(|_| serde_json::Value::Null)
        ));
    }
    // The refusal is Tauri's ACL itself, before any command code runs.
    let refusal = call(&evil, "list_fonts", serde_json::json!({})).unwrap_err();
    assert!(
        refusal
            .as_str()
            .is_some_and(|text| text.contains("not allowed")),
        "{refusal}"
    );
    assert!(call(&app, "list_fonts", serde_json::json!({})).is_ok());
    assert!(
        denied(call(&app, "retry", serde_json::json!({"hash": null}))),
        "the app has no business with the offline page's command"
    );
    assert!(denied(call(
        &evil,
        "retry",
        serde_json::json!({"hash": null})
    )));
    // The offline page may retry: the "server" listens, so it answers true and loads the app.
    assert_eq!(
        call(&offline, "retry", serde_json::json!({"hash": "design/f1"})).unwrap(),
        serde_json::json!(true)
    );
}

#[test]
fn connect_answers_host_info_and_delivers_queued_events() {
    let f = fixture();
    let window = f.app_window("main");
    let info = call(
        &window,
        "connect",
        serde_json::json!({"events": "__CHANNEL__:7"}),
    )
    .unwrap();
    assert_eq!(info["appOrigin"], f.origins.app_origin());
    assert_eq!(info["window"], "main");
    assert_eq!(info["platform"], std::env::consts::OS);

    // Events sent before the page connects wait for it, then arrive in order.
    let shell = f.shell();
    shell.send(
        "late",
        HostEvent::Menu {
            command: "edit.undo".into(),
        },
    );
    shell.send("late", HostEvent::Files);
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = seen.clone();
    shell.connect(
        "late",
        Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        }),
    );
    shell.send(
        "late",
        HostEvent::Portable {
            token: "t".into(),
            name: "a.rdesign".into(),
        },
    );
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            r#"{"type":"menu","command":"edit.undo"}"#,
            r#"{"type":"files"}"#,
            r#"{"type":"portable","token":"t","name":"a.rdesign"}"#
        ]
    );
}

#[test]
fn set_menu_and_report_location() {
    let f = fixture();
    let window = f.app_window("main");
    let menu = serde_json::json!({"sections": [{"label": "Edit", "items": [{"type": "command", "id": "edit.undo", "label": "Undo", "shortcut": "Mod+KeyZ"}]}]});
    assert!(call(&window, "set_menu", serde_json::json!({"menu": menu})).is_ok());
    let too_big = serde_json::json!({"sections": (0..21).map(|i| serde_json::json!({"label": i.to_string(), "items": []})).collect::<Vec<_>>()});
    assert!(call(&window, "set_menu", serde_json::json!({"menu": too_big})).is_err());
    assert!(call(&window, "set_menu", serde_json::json!({"menu": {"sections": [{"label": "x", "items": [{"type": "bogus"}]}]}})).is_err(), "a malformed menu is refused");

    assert!(
        call(
            &window,
            "report_location",
            serde_json::json!({"fileId": "f1", "title": "Landing — Design"})
        )
        .is_ok()
    );
    assert!(
        call(
            &window,
            "report_location",
            serde_json::json!({"fileId": "../x", "title": "Bad — Design"})
        )
        .is_ok(),
        "a bad id is ignored"
    );
    assert!(
        call(
            &window,
            "report_location",
            serde_json::json!({"fileId": null, "title": "Design — files"})
        )
        .is_ok()
    );
    let recent = Recent::load(f.dir.path().join("recent.json"));
    assert_eq!(
        recent
            .files()
            .iter()
            .map(|file| (file.id.as_str(), file.name.as_str()))
            .collect::<Vec<_>>(),
        vec![("f1", "Landing")]
    );
}

#[test]
fn lists_and_reads_fonts() {
    let f = fixture();
    let window = f.app_window("main");
    let list = call(&window, "list_fonts", serde_json::json!({})).unwrap();
    let list = list.as_array().unwrap();
    assert!(
        call(&window, "read_font", serde_json::json!({"id": list.len()})).is_err(),
        "only listed ids read"
    );
    let Some(first) = list.first() else {
        eprintln!("no TrueType font on this machine: reading is not checked");
        return;
    };
    assert!(
        first["family"]
            .as_str()
            .is_some_and(|family| !family.is_empty())
    );
    assert!(
        first["postscriptName"].is_string()
            && first["style"].is_string()
            && first["weight"].is_number()
    );
    let bytes = raw(request(
        &window,
        "read_font",
        InvokeBody::Json(serde_json::json!({"id": first["id"]})),
        &[],
    )
    .unwrap());
    let on_disk: Vec<Vec<u8>> = std::fs::read_dir(f.dir.path().join("fonts"))
        .unwrap()
        .map(|entry| std::fs::read(entry.unwrap().path()).unwrap())
        .collect();
    assert!(on_disk.contains(&bytes));
}

#[test]
// The file name is Cyrillic on purpose: the header is percent-encoded UTF-8 and the saved path is non-ASCII.
fn saves_a_portable_file_where_the_dialog_says() {
    let f = fixture();
    let window = f.app_window("main");
    let target = f.dir.path().join("Мой файл");
    *f.answer.lock().unwrap() = Some(target.clone());
    let saved = request(
        &window,
        "save_portable",
        InvokeBody::Raw(b"{\"format\":\"morfa-design\"}".to_vec()),
        &[(
            "x-morfa-name",
            "%D0%9B%D0%B5%D0%BD%D0%B4%D0%B8%D0%BD%D0%B3%2Fv2",
        )],
    )
    .unwrap();
    assert_eq!(
        saved.deserialize::<Option<String>>().unwrap().as_deref(),
        Some("Мой файл.rdesign")
    );
    assert_eq!(
        std::fs::read(f.dir.path().join("Мой файл.rdesign")).unwrap(),
        b"{\"format\":\"morfa-design\"}"
    );
    assert_eq!(
        *f.asked.lock().unwrap(),
        vec![Ask::Save {
            window: "main".into(),
            name: "Лендинг v2.rdesign".into()
        }]
    );

    *f.answer.lock().unwrap() = None;
    let cancelled = request(
        &window,
        "save_portable",
        InvokeBody::Raw(b"{}".to_vec()),
        &[],
    )
    .unwrap();
    assert_eq!(
        cancelled.deserialize::<Option<String>>().unwrap(),
        None,
        "a closed dialog saves nothing"
    );
    assert!(
        call(
            &window,
            "save_portable",
            serde_json::json!({"bytes": [1, 2]})
        )
        .is_err(),
        "the file comes as a raw body"
    );
}

#[test]
fn picks_and_takes_a_portable_file_once() {
    let f = fixture();
    let window = f.app_window("main");
    let file = f.dir.path().join("plan.rdesign");
    std::fs::write(&file, b"{\"format\":\"morfa-design\"}").unwrap();
    *f.answer.lock().unwrap() = Some(file);
    let picked = call(&window, "pick_portable", serde_json::json!({})).unwrap();
    assert_eq!(picked["name"], "plan.rdesign");
    assert_eq!(picked["size"], 25);
    let token = picked["token"].as_str().unwrap().to_owned();
    let bytes = raw(request(
        &window,
        "take_portable",
        InvokeBody::Json(serde_json::json!({"token": token})),
        &[],
    )
    .unwrap());
    assert_eq!(bytes, b"{\"format\":\"morfa-design\"}");
    assert!(
        call(
            &window,
            "take_portable",
            serde_json::json!({"token": token})
        )
        .is_err(),
        "a file is taken once"
    );

    let other = f.dir.path().join("notes.txt");
    std::fs::write(&other, b"x").unwrap();
    *f.answer.lock().unwrap() = Some(other);
    assert!(
        call(&window, "pick_portable", serde_json::json!({})).is_err(),
        "only .rdesign files open"
    );
    *f.answer.lock().unwrap() = None;
    assert_eq!(
        call(&window, "pick_portable", serde_json::json!({})).unwrap(),
        serde_json::Value::Null
    );
}

#[test]
fn opens_windows_for_valid_routes_only() {
    let f = fixture();
    let window = f.app_window("main");
    assert!(
        call(
            &window,
            "open_window",
            serde_json::json!({"hash": "#design/../../etc"})
        )
        .is_err()
    );
    assert!(
        call(
            &window,
            "open_window",
            serde_json::json!({"hash": "javascript:alert(1)"})
        )
        .is_err()
    );
    assert!(
        call(
            &window,
            "open_window",
            serde_json::json!({"hash": "design/f9"})
        )
        .is_ok()
    );
    // The new window is made on its own thread after the probe.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while f.app.webview_windows().len() < 2 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let opened: Vec<String> = f
        .app
        .webview_windows()
        .values()
        .map(|w| w.url().unwrap().to_string())
        .collect();
    assert!(
        opened.contains(&f.origins.app_url("design/f9").to_string()),
        "{opened:?}"
    );
    // Asking again focuses that window instead of opening another.
    assert!(
        call(
            &window,
            "open_window",
            serde_json::json!({"hash": "design/f9"})
        )
        .is_ok()
    );
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(f.app.webview_windows().len(), 2);
}

#[test]
fn hashes_become_targets() {
    use crate::links::Target;
    assert_eq!(super::target_of_hash("designs"), Some(Target::Files));
    assert_eq!(
        super::target_of_hash("#design/a_b-1"),
        Some(Target::File("a_b-1".into()))
    );
    assert_eq!(super::target_of_hash("design/"), None);
    assert_eq!(super::target_of_hash("settings"), None);
}
