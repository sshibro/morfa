# Morfa desktop

The desktop app for macOS, Windows and Linux (Tauri 2). It works like
Figma's: a native window around the **same hosted editor**, plus what a browser cannot do.

- The window shows `https://app.morfa.example` (a debug build: the dev server `http://127.0.0.1:5400`). There is no
  second copy of the editor: every web release reaches the desktop app at once. Sign-in is the app's own web flow;
  the web view keeps its cookies between runs.
- Native: the system's **local fonts** in the font picker, **native menus** with the editor's shortcuts, **one
  window per file** with "Open recent", **deep links** (`morfa://file/<id>`, `https://app.morfa.example/#design/<id>`),
  `.rdesign` portable files through **native open/save dialogs** and "Open with", drag-and-drop of pictures onto the
  canvas, **auto-update** (Tauri's updater; the key and endpoint are the operator's).
- No server is reachable → a bundled "No connection to Morfa" page retries by itself and loads the app when it answers.

```
desktop/
  src-tauri/            the shell (Rust, Tauri 2.12; its own Cargo workspace — the root one excludes desktop/)
    src/shell.rs        windows, navigation policy, menus, deep links, files from the system, start-up
    src/commands.rs     the IPC (10 commands) + commands/tests.rs (through Tauri's mock runtime and real ACL)
    src/origin.rs       which addresses load in a window; links.rs deep links; menu.rs the native menu layout;
    src/fonts.rs        local fonts (fontdb); portable.rs .rdesign on disk; recent.rs "Open recent";
    src/reach.rs        the offline probe; updates.rs the updater
    capabilities/       the offline page's single permission; the app origin's is added at start (shell.rs)
    tauri.conf.json     bundle, deep-link scheme, file association, updater placeholders, CSP of bundled pages
  offline/              the bundled "No connection" page
  scripts/              check.sh · build-linux.sh · build-macos.sh · build-windows.ps1 · smoke.sh + smoke.ts
src/desktop/            the web side: host.ts (in the main bundle: empty hooks, ~1 KiB) and the lazy bridge
```

## Running it

```sh
# once: Rust (rust-toolchain.toml), Node 22, and on Linux the system libraries:
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
cd desktop && npm ci                       # the Tauri CLI only

npm run dev                               # (repo root) the app on 5400
cd desktop/src-tauri && cargo run          # a debug shell → http://127.0.0.1:5400
MORFA_APP_ORIGIN=https://app.morfa.example cargo run   # any build, another origin
```

`MORFA_APP_ORIGIN` (and optionally `MORFA_LANDING_ORIGIN`) choose the origin at run time; plain `http` is accepted
only for 127.0.0.1/localhost. Release builds default to production.

## Security

- **What loads in a window** (`origin.rs` `classify`, used by `on_navigation` and `on_new_window`): the app's origin;
  the landing's (`morfa.example`, for its links); the bundled offline page. Any other `http(s)`/`mailto` link opens in the
  system browser; `file:`, `data:`, `javascript:` … are refused. `window.open` of an app address (a file in a new
  tab, the prototype player) opens a Morfa window instead.
- **Who may call the shell**: every command needs a permission (build.rs app manifest). At start the shell grants
  the nine app commands to exactly one remote origin, the configured app (`shell.rs app_capability`, pattern
  `https://app.morfa.example/*`); the offline page gets only `retry`; the landing and everything else get nothing. Each
  command checks the caller's origin again. `commands/tests.rs` proves both with Tauri's real ACL.
- **No shell, no file system** for the web: no `shell`/`fs` plugins are exposed. Files are chosen in native dialogs
  and written only where the user said (`save_portable`, atomic write); `pick_portable` reads only the chosen
  `.rdesign` (≤ 50 MB); fonts are read by the ids the list gave, never by path.
- **CSP**: bundled pages run under `default-src 'none'; script-src 'self'; …` (tauri.conf.json). The hosted app sets no
  CSP today (server/app.ts `helmet({contentSecurityPolicy: false})`); a strict one there would cover the desktop app
  too — an open item on the server side, not changed here.
- The page marker `window.__MORFA_DESKTOP__` is set only on the app's origin; the web bridge loads only when Tauri's
  IPC is there as well.

## Local fonts

`list_fonts` scans the system once (fontdb: fontconfig folders on Linux, `/Library/Fonts` + `~/Library/Fonts` +
system folders on macOS, the Windows font folders) and answers Chrome-shaped `FontData` (family, fullName,
postscriptName, style). The bridge installs `window.queryLocalFonts` over it; the editor's registry
(`src/design/engine/fonts.ts`) then lists local families **without a prompt** (like Figma desktop) and loads each face
from its **bytes** (`read_font`): the same bytes go to the canvas `FontFace` and to the Rust text engine
(`text_add_face`), so text shapes the same in both and does not depend on WebKit's `local()` (which Safari limits to
system fonts). Faces inside collections (`.ttc`) are drawn through `local()`. macOS private UI fonts (`.SF…`) are hidden.

## Menus

The editor publishes its main menu (`EDITOR_MENU` through the live command lookup) and the bridge sends it to the
shell whenever it changes (labels, shortcuts, enabled and check marks; re-read after a key, a click, or a command). The
shell lays it out as a native menu bar: "File" (the shell's New window ⌘N, All files, Open file from computer… ⌘O,
Open recent, then the editor's file commands, Close window ⌘W), the editor's sections, "Window" (and on macOS the
app menu with About, Hide, Quit). Choosing an item runs the same command in the page.

**Keyboard stays the web app's.** macOS: editor items carry real key equivalents — WKWebView gives every key to the
page first and only unhandled ones reach the menu, so nothing is stolen; copy/cut/paste are the system's own items
(they fire the page's clipboard events, which the editor handles). Windows/Linux: menus there take keys before the
page, so editor items only *show* the shortcut in their label; only the shell's own ⌃N/⌃O/⌃W/⌃Q (unused by the
editor) are bound. While a text field has focus, the menu's Undo/Redo/Select all act on the field.

## Windows, recent files, deep links

- One window per file: a deep link, "Open recent" or `open_window` to a file already open focuses its window.
  In-page navigation (the file browser opening a file) stays in its window, like a browser tab.
- The bridge reports the window's file and title (`report_location`): the window title follows, and "Open
  recent" keeps the last 10 (`<app config dir>/recent.json`: ids and names only).
- `morfa://file/<id>`, `morfa://files` and app URLs `https://app.morfa.example/#design/<id>` open in the app: on Linux and
  Windows a second launch hands its arguments to the running app (single instance) — this is how the system delivers
  `morfa://` links there; on macOS through the system's "open URL". `.rdesign` files given as arguments or through
  "Open with" open as a new file. The .deb and the installers register the `morfa` scheme and the `.rdesign` type (on Linux:
  `src-tauri/linux/morfa.desktop` passes links and files with `%U`, `linux/morfa-mime.xml` maps `*.rdesign` to
  `application/x-morfa-design`); an AppImage registers the scheme for the user at first start.
- **https links outside the app** (a link to `app.morfa.example/#design/…` clicked in the browser) open in the browser
  unless the system routes that domain to the app: on macOS that needs Associated Domains (an entitlement and an
  `apple-app-site-association` file on app.morfa.example — see the checklist below). The fragment never reaches a server, so
  the web app itself could offer "Open in app" → `morfa://file/<id>` (a later step).

## Portable files and pictures

"Save to computer (.rdesign)" (editor menu and file browser) goes through `saveBlob`, which in the desktop app
calls the native save dialog (`save_portable`: raw bytes, file name in a header, `.rdesign` added, atomic write).
"Open file from computer…" (editor menu, the shell's ⌘O, "Open with", arguments) reads through the native open dialog
and opens the file as a new file, then shows it. Dropping pictures onto the canvas uses the editor's own HTML5 drop
(Tauri's drop handler is off for that reason).

## Updates

Tauri's updater checks `plugins.updater.endpoints` (placeholder `https://updates.morfa.example/desktop/{{target}}/{{arch}}/{{current_version}}`)
and verifies each download with `plugins.updater.pubkey` (placeholder `MORFA_UPDATER_PUBLIC_KEY_PLACEHOLDER`). While the
placeholder is there the start-up check is silent and "Check for updates…" says updates are not configured. Builds
make updater artifacts (`.sig`) only when `TAURI_SIGNING_PRIVATE_KEY` is set.

## Builds

| Platform | Command (one command, on that platform) | Output (`desktop/src-tauri/target/…`) |
|---|---|---|
| Linux | `desktop/scripts/build-linux.sh` | `release/bundle/appimage/Morfa_<v>_amd64.AppImage`, `release/bundle/deb/Morfa_<v>_amd64.deb` |
| macOS | `desktop/scripts/build-macos.sh` (on a Mac) | `universal-apple-darwin/release/bundle/dmg/Morfa_<v>_universal.dmg`, `…/macos/Morfa.app` |
| Windows | `powershell -ExecutionPolicy Bypass -File desktop\scripts\build-windows.ps1` | `release\bundle\msi\Morfa_<v>_x64_ru-RU.msi` |

Linux builds run in a container. The macOS and Windows scripts need
their own platform (WKWebView / WebView2 and the platforms' packagers) and have not been run yet.

## Checks

- `desktop/scripts/check.sh`: `cargo fmt --check`, `clippy --all-targets -D warnings` (also with the `smoke` feature),
  `cargo test` (origins, links, menu layout and accelerators, fonts, portable files, recent list, the offline probe,
  updater placeholders, and every command through the mock runtime with the real ACL). `scripts/gate.sh` runs it as
  the `desktop` step and records SKIP with the missing libraries when webkit2gtk is absent.
- Web side: `tests/design-desktop-bridge.test.ts`, `tests/design-desktop-fonts.test.ts` (in `npm run test:design`).

### Smoke run

`MORFA_TEST_ENV_FILE=<state>/cluster.env desktop/scripts/smoke.sh` (Linux; needs `xvfb`, `dbus`, `webkit2gtk-driver`
and `cargo install tauri-driver`): builds the shell with the `smoke` feature (the save/open dialogs answer from
`MORFA_DESKTOP_SMOKE_SAVE` / `_OPEN` — WebDriver cannot click native dialogs; release builds never have the feature),
starts the isolated e2e server, and drives the app with WebDriver on a virtual display: the window loads the app, a
person signs in through the web form, a file opens with a text in a local font that the editor's catalogue does not
ship and that face is drawn from the shell's bytes, "Save to computer" writes the portable file, and a second
launch with `morfa://file/<id>` opens that file in a new window (and an app URL to it focuses that window).

`SMOKE_OFFLINE=1 SMOKE_BINARY=<built app> desktop/scripts/smoke.sh` checks a release build whose server cannot be
reached (production before it exists): the window shows the bundled "No connection to Morfa" page, without the app marker.

## Release checklist

Nothing here is in the repository; placeholders stand in for each.

1. **Updater key** (all platforms): `npx tauri signer generate -w ~/.tauri/morfa-updater.key` (in `desktop/`). Keep the
   private key and its password off the repository (a password manager + the release machine's keychain). Put the
   **public** key into `desktop/src-tauri/tauri.conf.json` `plugins.updater.pubkey`, replacing the placeholder.
2. **Update endpoint**: a static host for `https://updates.morfa.example/desktop/<target>/<arch>/<current_version>`
   answering Tauri's update JSON (`version`, `notes`, `pub_date`, `platforms.<target>-<arch>.{url, signature}`) or
   `204` when there is none; or change `endpoints` to a single `latest.json`. Upload the bundles and their `.sig`
   files from step 1's builds (`TAURI_SIGNING_PRIVATE_KEY=… desktop/scripts/build-*.sh`).
3. **macOS signing + notarisation**: an Apple Developer ID Application certificate in the Mac's keychain; set
   `APPLE_SIGNING_IDENTITY` and either `APPLE_ID` + `APPLE_PASSWORD` (app-specific) + `APPLE_TEAM_ID` or an App Store
   Connect API key (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`), then `desktop/scripts/build-macos.sh`.
   Check: `spctl -a -vv Morfa.app`, `xcrun stapler validate Morfa_<v>_universal.dmg`.
4. **Windows signing**: a code-signing certificate (OV or EV) installed for the user; `$env:MORFA_WINDOWS_CERT_THUMBPRINT`
   (and `$env:MORFA_WINDOWS_TIMESTAMP_URL` for the CA's timestamp server), then `build-windows.ps1`. Check:
   `Get-AuthenticodeSignature Morfa_<v>_x64_ru-RU.msi`. (An EV key on a hardware token needs `bundle.windows.signCommand`
   with the vendor's tool instead of a thumbprint.)
5. **Linux**: nothing to sign for the AppImage/.deb themselves; for an apt repository, a GPG key of the publisher's.
6. **App icon**: done 2026-10-09. `desktop/icon-source/morfa-1024.png` is the app icon (`assets/brand/morfa-app-icon.svg`)
   on Apple's grid (an 824 px body centred on 1024, radius 185); `src-tauri/icons` came from it through
   `cd desktop && npx tauri icon icon-source/morfa-1024.png -o src-tauri/icons`, with the `android/`, `ios/`, `Square*` and
   `StoreLogo` files removed. Repeat both steps when the icon changes.
7. **Optional — https links open the app on macOS**: an Associated Domains entitlement (`applinks:app.morfa.example`)
   in `bundle.macOS.entitlements`, and `https://app.morfa.example/.well-known/apple-app-site-association` naming the
   team id and bundle id `example.morfa.desktop`.
8. **Sign-in**: the window only loads the app. Sign-in is a name typed into the app's own screen
   (`docs/authentication.md`), so it works in the desktop window like in a browser; no other host is involved. Should
   Morfa ever add providers whose pages live on other domains, either allow those hosts in `origin.rs` (`classify`)
   or sign in in the system browser and hand the session back with a `morfa://` link.
