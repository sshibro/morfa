//! Morfa desktop (lane D1, docs/desktop.md): a Tauri 2 shell around the hosted app. The windows show
//! `https://app.morfa.example` (the dev server in a debug build); the web app stays the one editor. The shell adds what
//! a browser cannot: local fonts, native menus, windows per file with "Open recent", deep links, `.rdesign` files
//! through native dialogs, and updates. Its IPC (commands.rs) is reachable only from the app's origin.

pub mod commands;
pub mod fonts;
pub mod links;
pub mod menu;
pub mod origin;
pub mod portable;
pub mod reach;
pub mod recent;
mod shell;
mod updates;

pub use shell::run;

include!("command_names.rs");
