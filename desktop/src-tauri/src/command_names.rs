// The shell's commands, shared by build.rs (the app manifest that makes an `allow-<command>` permission of each) and
// the crate (shell.rs grants all but `retry` to the app's origin). Keep in step with `handlers!` in commands.rs.
pub const BUILD_COMMANDS: &[&str] = &["connect", "set_menu", "report_location", "list_fonts", "read_font", "save_portable", "pick_portable", "take_portable", "open_window", "retry"];
