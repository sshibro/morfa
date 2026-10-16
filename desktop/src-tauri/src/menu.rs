//! Native menus (docs/desktop.md §Menus). The editor sends its own main menu (src/design/editor/chrome/commands.ts
//! `EDITOR_MENU`, resolved against the live command registry) and the shell lays it out as a native menu bar beside
//! its own items: windows, "Open file…", "Open recent", updates.
//!
//! Keyboard: the web app keeps its own key handling. On macOS every command shows its shortcut as a real key
//! equivalent: WKWebView hands each key to the page first and only an unhandled key reaches the menu, so nothing is
//! stolen. On Windows and Linux the menu would take the key before the page (GTK accelerators, the Win32 message
//! loop), so editor commands only *show* their shortcut in the label; only the shell's own items (⌃N, ⌃O, ⌃W, ⌃Q —
//! keys the editor does not use) are bound there.

use serde::Deserialize;

use crate::recent::RecentFile;

/// The editor's menu as the web bridge sends it (src/desktop/menu.ts `WebMenu`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct WebMenu {
    pub sections: Vec<WebSection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct WebSection {
    pub label: String,
    pub items: Vec<WebItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WebItem {
    #[serde(rename_all = "camelCase")]
    Command {
        id: String,
        label: String,
        /// src/design/ui/shortcuts.ts form: `Shift+Mod+KeyZ`.
        #[serde(default)]
        shortcut: Option<String>,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        checked: Option<bool>,
        /// A command that works through the browser's clipboard events (copy, cut, paste).
        #[serde(default)]
        clipboard: Option<String>,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<WebItem>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// A key combination parsed from the editor's shortcut string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shortcut {
    pub code: String,
    pub mod_key: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

/// `Shift+Mod+KeyZ` → the parts (`Mod` is ⌘ on a Mac, Ctrl elsewhere; the last part is a `KeyboardEvent.code`).
pub fn parse_shortcut(text: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = text.split('+').filter(|part| !part.is_empty()).collect();
    let (code, modifiers) = parts.split_last()?;
    let mut shortcut = Shortcut {
        code: (*code).to_owned(),
        mod_key: false,
        shift: false,
        alt: false,
        ctrl: false,
    };
    for modifier in modifiers {
        match *modifier {
            "Mod" => shortcut.mod_key = true,
            "Shift" => shortcut.shift = true,
            "Alt" => shortcut.alt = true,
            "Ctrl" => shortcut.ctrl = true,
            _ => return None,
        }
    }
    key_name(&shortcut.code)?;
    Some(shortcut)
}

/// The key as an accelerator names it, and as a label shows it on a Mac and elsewhere.
fn key_name(code: &str) -> Option<(String, String, String)> {
    let simple = |accel: &str, mac: &str, other: &str| {
        Some((accel.to_owned(), mac.to_owned(), other.to_owned()))
    };
    if let Some(letter) = code
        .strip_prefix("Key")
        .filter(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_uppercase())
    {
        return simple(letter, letter, letter);
    }
    if let Some(digit) = code
        .strip_prefix("Digit")
        .filter(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
    {
        return simple(digit, digit, digit);
    }
    match code {
        "Backspace" => simple("Backspace", "⌫", "Backspace"),
        "Delete" => simple("Delete", "⌦", "Delete"),
        "Enter" => simple("Enter", "↩", "Enter"),
        "Escape" => simple("Escape", "⎋", "Esc"),
        "Tab" => simple("Tab", "⇥", "Tab"),
        "Space" => simple("Space", "Space", "Space"),
        "ArrowLeft" => simple("ArrowLeft", "←", "Left"),
        "ArrowRight" => simple("ArrowRight", "→", "Right"),
        "ArrowUp" => simple("ArrowUp", "↑", "Up"),
        "ArrowDown" => simple("ArrowDown", "↓", "Down"),
        "PageUp" => simple("PageUp", "⇞", "PgUp"),
        "PageDown" => simple("PageDown", "⇟", "PgDn"),
        "Home" => simple("Home", "↖", "Home"),
        "End" => simple("End", "↘", "End"),
        "Minus" => simple("Minus", "-", "-"),
        "Equal" => simple("Equal", "=", "="),
        "BracketLeft" => simple("BracketLeft", "[", "["),
        "BracketRight" => simple("BracketRight", "]", "]"),
        "Backslash" => simple("Backslash", "\\", "\\"),
        "Semicolon" => simple("Semicolon", ";", ";"),
        "Quote" => simple("Quote", "'", "'"),
        "Comma" => simple("Comma", ",", ","),
        "Period" => simple("Period", ".", "."),
        "Slash" => simple("Slash", "/", "/"),
        "Backquote" => simple("Backquote", "`", "`"),
        _ => {
            let n: u8 = code
                .strip_prefix('F')?
                .parse()
                .ok()
                .filter(|n| (1..=24).contains(n))?;
            Some((format!("F{n}"), format!("F{n}"), format!("F{n}")))
        }
    }
}

/// The accelerator string Tauri parses (`Shift+CmdOrCtrl+Z`).
pub fn accelerator(shortcut: &Shortcut) -> String {
    let (key, _, _) = key_name(&shortcut.code).expect("parse_shortcut checked the key");
    let mut parts = Vec::new();
    if shortcut.ctrl {
        parts.push("Ctrl");
    }
    if shortcut.alt {
        parts.push("Alt");
    }
    if shortcut.shift {
        parts.push("Shift");
    }
    if shortcut.mod_key {
        parts.push("CmdOrCtrl");
    }
    let mut text = parts.join("+");
    if !text.is_empty() {
        text.push('+');
    }
    text.push_str(&key);
    text
}

/// The shortcut as people read it: `⇧⌘Z` on a Mac (src/design/ui/shortcuts.ts `formatShortcut`), `Ctrl+Shift+Z` elsewhere.
pub fn shortcut_label(shortcut: &Shortcut, platform: Platform) -> String {
    let (_, mac_key, other_key) = key_name(&shortcut.code).expect("parse_shortcut checked the key");
    if platform == Platform::Mac {
        let mut text = String::new();
        if shortcut.ctrl {
            text.push('⌃');
        }
        if shortcut.alt {
            text.push('⌥');
        }
        if shortcut.shift {
            text.push('⇧');
        }
        if shortcut.mod_key {
            text.push('⌘');
        }
        return text + &mac_key;
    }
    let mut parts = Vec::new();
    if shortcut.ctrl || shortcut.mod_key {
        parts.push("Ctrl");
    }
    if shortcut.alt {
        parts.push("Alt");
    }
    if shortcut.shift {
        parts.push("Shift");
    }
    parts.push(&other_key);
    parts.join("+")
}

/// Ids of the shell's own items (lib.rs handles them).
pub mod ids {
    pub const NEW_WINDOW: &str = "app:new-window";
    pub const OPEN_PORTABLE: &str = "app:open-portable";
    pub const CLOSE_WINDOW: &str = "app:close-window";
    pub const FILES: &str = "app:files";
    pub const RELOAD: &str = "app:reload";
    pub const CHECK_UPDATES: &str = "app:check-updates";
    pub const QUIT: &str = "app:quit";
    pub const RECENT_CLEAR: &str = "recent:clear";
    /// `recent:<file id>`.
    pub const RECENT_PREFIX: &str = "recent:file:";
    /// `web:<command id>`: sent back to the window's page.
    pub const WEB_PREFIX: &str = "web:";
}

/// The native menu, independent of Tauri so it can be tested; lib.rs turns it into a `tauri::menu::Menu`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Item {
        id: String,
        label: String,
        accelerator: Option<String>,
        enabled: bool,
        checked: Option<bool>,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<Entry>,
    },
    /// A native item the system implements (macOS app and window menus, the clipboard trio).
    Native(NativeItem),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeItem {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Copy,
    Cut,
    Paste,
    Minimize,
    Zoom,
    Fullscreen,
    CloseWindow,
}

fn item(id: &str, label: &str, accelerator: Option<&str>) -> Entry {
    Entry::Item {
        id: id.into(),
        label: label.into(),
        accelerator: accelerator.map(Into::into),
        enabled: true,
        checked: None,
    }
}

/// One editor command as a native item, with the platform's shortcut policy (module comment).
fn web_command(
    id: &str,
    label: &str,
    shortcut: Option<&str>,
    enabled: bool,
    checked: Option<bool>,
    clipboard: Option<&str>,
    platform: Platform,
) -> Entry {
    // On a Mac the clipboard commands are the system's own items: they send copy:/cut:/paste: to the web view, which
    // fires the page's clipboard events (the editor's copy and paste work through them, CanvasView.tsx).
    if platform == Platform::Mac {
        match clipboard {
            Some("copy") => return Entry::Native(NativeItem::Copy),
            Some("cut") => return Entry::Native(NativeItem::Cut),
            Some("paste") => return Entry::Native(NativeItem::Paste),
            _ => {}
        }
    }
    let shortcut = shortcut.and_then(parse_shortcut);
    let (label, accelerator) = match (&shortcut, platform) {
        (Some(shortcut), Platform::Mac) => (label.to_owned(), Some(accelerator(shortcut))),
        // Win32 menus right-align what follows a tab, like a real accelerator; GTK shows it after a gap.
        (Some(shortcut), _) => (
            format!("{label}\t{}", shortcut_label(shortcut, platform)),
            None,
        ),
        (None, _) => (label.to_owned(), None),
    };
    Entry::Item {
        id: format!("{}{id}", ids::WEB_PREFIX),
        label,
        accelerator,
        enabled,
        checked,
    }
}

fn web_items(items: &[WebItem], platform: Platform, depth: usize) -> Vec<Entry> {
    let mut out = Vec::new();
    for entry in items {
        match entry {
            WebItem::Command {
                id,
                label,
                shortcut,
                enabled,
                checked,
                clipboard,
            } => {
                if id.is_empty() || id.len() > 200 {
                    continue;
                }
                out.push(web_command(
                    id,
                    label,
                    shortcut.as_deref(),
                    *enabled,
                    *checked,
                    clipboard.as_deref(),
                    platform,
                ));
            }
            WebItem::Separator => out.push(Entry::Separator),
            // Two levels are plenty (the editor has "Copy as", "Boolean operations"); deeper ones are dropped.
            WebItem::Submenu { label, items } if depth < 3 => {
                let children = web_items(items, platform, depth + 1);
                if children.iter().any(|child| *child != Entry::Separator) {
                    out.push(Entry::Submenu {
                        label: label.clone(),
                        items: children,
                    });
                }
            }
            WebItem::Submenu { .. } => {}
        }
    }
    tidy(out)
}

/// No separator first, last or twice in a row.
fn tidy(entries: Vec<Entry>) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry == Entry::Separator && out.last().is_none_or(|last| *last == Entry::Separator) {
            continue;
        }
        out.push(entry);
    }
    while out.last() == Some(&Entry::Separator) {
        out.pop();
    }
    out
}

fn recent_menu(recent: &[RecentFile]) -> Entry {
    let mut items: Vec<Entry> = recent
        .iter()
        .map(|file| {
            let label = if file.name.trim().is_empty() {
                file.id.clone()
            } else {
                file.name.clone()
            };
            item(&format!("{}{}", ids::RECENT_PREFIX, file.id), &label, None)
        })
        .collect();
    if items.is_empty() {
        items.push(Entry::Item {
            id: "recent:none".into(),
            label: "No recent files".into(),
            accelerator: None,
            enabled: false,
            checked: None,
        });
    } else {
        items.push(Entry::Separator);
        items.push(item(ids::RECENT_CLEAR, "Clear list", None));
    }
    Entry::Submenu {
        label: "Open recent".into(),
        items,
    }
}

/// The whole menu bar: the shell's "Morfa" items, then the editor's sections (the editor's "File" merges into the
/// shell's), then "Window".
pub fn plan(web: &WebMenu, recent: &[RecentFile], platform: Platform, product: &str) -> Vec<Entry> {
    let mac = platform == Platform::Mac;
    let mut bar = Vec::new();
    if mac {
        bar.push(Entry::Submenu {
            label: product.into(),
            items: vec![
                Entry::Native(NativeItem::About),
                item(ids::CHECK_UPDATES, "Check for updates…", None),
                Entry::Separator,
                Entry::Native(NativeItem::Services),
                Entry::Separator,
                Entry::Native(NativeItem::Hide),
                Entry::Native(NativeItem::HideOthers),
                Entry::Native(NativeItem::ShowAll),
                Entry::Separator,
                Entry::Native(NativeItem::Quit),
            ],
        });
    }
    let mut file = vec![
        item(ids::NEW_WINDOW, "New window", Some("CmdOrCtrl+N")),
        item(ids::FILES, "All files", None),
        item(
            ids::OPEN_PORTABLE,
            "Open file from computer…",
            Some("CmdOrCtrl+O"),
        ),
        recent_menu(recent),
        Entry::Separator,
    ];
    let mut sections = web.sections.iter().peekable();
    // The editor's "File" comes first in EDITOR_MENU: its items join the shell's file menu.
    if let Some(first) = sections.peek().filter(|section| section.label == "File") {
        file.extend(web_items(&first.items, platform, 1));
        file.push(Entry::Separator);
        sections.next();
    }
    file.push(item(ids::CLOSE_WINDOW, "Close window", Some("CmdOrCtrl+W")));
    if !mac {
        file.push(Entry::Separator);
        file.push(item(ids::QUIT, "Exit", Some("CmdOrCtrl+Q")));
    }
    bar.push(Entry::Submenu {
        label: "File".into(),
        items: tidy(file),
    });
    let mut has_edit = false;
    for section in sections {
        let items = web_items(&section.items, platform, 1);
        if items.is_empty() {
            continue;
        }
        has_edit |= section.label == "Edit";
        bar.push(Entry::Submenu {
            label: section.label.clone(),
            items,
        });
    }
    // Without the editor (the file browser, sign-in) a Mac still needs the clipboard items, or ⌘C/⌘V do nothing in fields.
    if mac && !has_edit {
        bar.insert(
            2,
            Entry::Submenu {
                label: "Edit".into(),
                items: vec![
                    Entry::Native(NativeItem::Cut),
                    Entry::Native(NativeItem::Copy),
                    Entry::Native(NativeItem::Paste),
                ],
            },
        );
    }
    let mut window = Vec::new();
    if mac {
        window.extend([
            Entry::Native(NativeItem::Minimize),
            Entry::Native(NativeItem::Zoom),
            Entry::Native(NativeItem::Fullscreen),
            Entry::Separator,
        ]);
    }
    window.push(item(ids::RELOAD, "Reload", None));
    if !mac {
        window.push(item(ids::CHECK_UPDATES, "Check for updates…", None));
    }
    bar.push(Entry::Submenu {
        label: "Window".into(),
        items: window,
    });
    bar
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str, shortcut: Option<&str>) -> WebItem {
        WebItem::Command {
            id: id.into(),
            label: id.to_uppercase(),
            shortcut: shortcut.map(Into::into),
            enabled: true,
            checked: None,
            clipboard: None,
        }
    }

    #[test]
    fn parses_and_formats_shortcuts() {
        let undo = parse_shortcut("Shift+Mod+KeyZ").unwrap();
        assert_eq!(accelerator(&undo), "Shift+CmdOrCtrl+Z");
        assert_eq!(shortcut_label(&undo, Platform::Mac), "⇧⌘Z");
        assert_eq!(shortcut_label(&undo, Platform::Linux), "Ctrl+Shift+Z");
        let align = parse_shortcut("Alt+Mod+KeyR").unwrap();
        assert_eq!(accelerator(&align), "Alt+CmdOrCtrl+R");
        assert_eq!(shortcut_label(&align, Platform::Mac), "⌥⌘R");
        assert_eq!(
            accelerator(&parse_shortcut("Shift+Digit1").unwrap()),
            "Shift+1"
        );
        assert_eq!(
            accelerator(&parse_shortcut("Ctrl+Alt+BracketLeft").unwrap()),
            "Ctrl+Alt+BracketLeft"
        );
        assert_eq!(
            shortcut_label(&parse_shortcut("Mod+Backslash").unwrap(), Platform::Windows),
            "Ctrl+\\"
        );
        assert_eq!(accelerator(&parse_shortcut("F2").unwrap()), "F2");
        assert_eq!(parse_shortcut("Hyper+KeyZ"), None);
        assert_eq!(parse_shortcut("Mod+KeyZZ"), None);
        assert_eq!(parse_shortcut("Mod+NumpadAdd"), None);
        assert_eq!(parse_shortcut(""), None);
    }

    #[test]
    fn accelerators_parse_in_tauri() {
        for text in [
            "Shift+Mod+KeyZ",
            "Alt+Mod+KeyR",
            "Shift+Digit1",
            "Ctrl+Alt+BracketLeft",
            "Mod+Backslash",
            "Mod+Equal",
            "Mod+Minus",
            "Shift+Mod+Digit0",
            "Delete",
            "Backspace",
            "Mod+Enter",
            "Shift+ArrowUp",
            "F12",
        ] {
            let accel = accelerator(&parse_shortcut(text).unwrap());
            assert!(
                accel.parse::<muda::accelerator::Accelerator>().is_ok(),
                "{text} → {accel} must parse"
            );
        }
    }

    #[test]
    fn mac_binds_editor_keys_others_show_them() {
        let web = WebMenu {
            sections: vec![WebSection {
                label: "Edit".into(),
                items: vec![command("edit.undo", Some("Mod+KeyZ"))],
            }],
        };
        let find = |bar: &[Entry]| -> Entry {
            let Entry::Submenu { items, .. } = bar
                .iter()
                .find(|entry| matches!(entry, Entry::Submenu { label, .. } if label == "Edit"))
                .unwrap()
            else {
                unreachable!()
            };
            items[0].clone()
        };
        assert_eq!(
            find(&plan(&web, &[], Platform::Mac, "Morfa")),
            Entry::Item {
                id: "web:edit.undo".into(),
                label: "EDIT.UNDO".into(),
                accelerator: Some("CmdOrCtrl+Z".into()),
                enabled: true,
                checked: None
            }
        );
        assert_eq!(
            find(&plan(&web, &[], Platform::Linux, "Morfa")),
            Entry::Item {
                id: "web:edit.undo".into(),
                label: "EDIT.UNDO\tCtrl+Z".into(),
                accelerator: None,
                enabled: true,
                checked: None
            }
        );
    }

    #[test]
    fn clipboard_commands_are_native_on_a_mac() {
        let copy = WebItem::Command {
            id: "edit.copy".into(),
            label: "Copy".into(),
            shortcut: Some("Mod+KeyC".into()),
            enabled: true,
            checked: None,
            clipboard: Some("copy".into()),
        };
        let web = WebMenu {
            sections: vec![WebSection {
                label: "Edit".into(),
                items: vec![copy],
            }],
        };
        let mac = plan(&web, &[], Platform::Mac, "Morfa");
        assert!(
            matches!(&mac[2], Entry::Submenu { label, items } if label == "Edit" && items == &vec![Entry::Native(NativeItem::Copy)])
        );
        let linux = plan(&web, &[], Platform::Linux, "Morfa");
        assert!(
            matches!(&linux[1], Entry::Submenu { items, .. } if matches!(&items[0], Entry::Item { id, .. } if id == "web:edit.copy"))
        );
    }

    #[test]
    fn merges_the_file_menu_and_lists_recent_files() {
        let web = WebMenu {
            sections: vec![
                WebSection {
                    label: "File".into(),
                    items: vec![
                        WebItem::Separator,
                        command("file.save-portable", None),
                        WebItem::Separator,
                        WebItem::Separator,
                    ],
                },
                WebSection {
                    label: "View".into(),
                    items: vec![WebItem::Submenu {
                        label: "Empty".into(),
                        items: vec![WebItem::Separator],
                    }],
                },
                WebSection {
                    label: "Object".into(),
                    items: vec![WebItem::Submenu {
                        label: "Boolean operations".into(),
                        items: vec![command("object.boolean-union", Some("Alt+Shift+KeyU"))],
                    }],
                },
            ],
        };
        let recent = [RecentFile {
            id: "f1".into(),
            name: "Landing".into(),
            opened_at: 1,
        }];
        let bar = plan(&web, &recent, Platform::Linux, "Morfa");
        let labels: Vec<&str> = bar
            .iter()
            .map(|entry| {
                if let Entry::Submenu { label, .. } = entry {
                    label.as_str()
                } else {
                    ""
                }
            })
            .collect();
        assert_eq!(
            labels,
            ["File", "Object", "Window"],
            "an empty section is left out"
        );
        let Entry::Submenu { items: file, .. } = &bar[0] else {
            unreachable!()
        };
        let ids: Vec<String> = file
            .iter()
            .map(|entry| match entry {
                Entry::Item { id, .. } => id.clone(),
                Entry::Separator => "-".into(),
                Entry::Submenu { label, .. } => label.clone(),
                Entry::Native(native) => format!("{native:?}"),
            })
            .collect();
        assert_eq!(
            ids,
            [
                "app:new-window",
                "app:files",
                "app:open-portable",
                "Open recent",
                "-",
                "web:file.save-portable",
                "-",
                "app:close-window",
                "-",
                "app:quit"
            ]
        );
        let Entry::Submenu {
            items: recent_items,
            ..
        } = &file[3]
        else {
            unreachable!()
        };
        assert!(
            matches!(&recent_items[0], Entry::Item { id, label, .. } if id == "recent:file:f1" && label == "Landing")
        );
        let empty = plan(&WebMenu::default(), &[], Platform::Mac, "Morfa");
        assert!(matches!(&empty[0], Entry::Submenu { label, .. } if label == "Morfa"));
        assert!(
            matches!(&empty[2], Entry::Submenu { label, .. } if label == "Edit"),
            "a Mac without the editor keeps the clipboard menu"
        );
    }

    #[test]
    fn reads_the_bridge_json() {
        let json = r#"{"sections":[{"label":"Edit","items":[
            {"type":"command","id":"edit.undo","label":"Undo","shortcut":"Mod+KeyZ","enabled":false},
            {"type":"separator"},
            {"type":"submenu","label":"Copy as","items":[{"type":"command","id":"edit.copy-css","label":"CSS","checked":true}]}
        ]}]}"#;
        let menu: WebMenu = serde_json::from_str(json).unwrap();
        assert_eq!(menu.sections[0].items.len(), 3);
        assert!(matches!(
            &menu.sections[0].items[0],
            WebItem::Command { enabled: false, .. }
        ));
        assert!(
            matches!(&menu.sections[0].items[2], WebItem::Submenu { items, .. } if matches!(&items[0], WebItem::Command { checked: Some(true), enabled: true, .. }))
        );
    }
}
