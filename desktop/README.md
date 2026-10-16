# desktop

Morfa's desktop app (Tauri 2): the hosted editor in a native window, plus local fonts, native menus, a window per
file with "Open recent", deep links (`morfa://file/<id>`), `.rdesign` files through native dialogs and updates.
Everything about it — running, security, builds for Linux/macOS/Windows, the smoke run and the signing
checklist — is in [docs/desktop.md](../docs/desktop.md).

```sh
desktop/scripts/check.sh          # fmt, clippy, tests (the gate's "desktop" step)
desktop/scripts/build-linux.sh    # AppImage + .deb
desktop/scripts/smoke.sh          # the Linux build end to end under xvfb (needs the test cluster env)
```
