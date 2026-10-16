---
name: morfa-design
description: Use when the person wants a screen, page or component designed in Morfa, a Morfa frame turned into code, or a picture put into a Morfa file.
---

# Working in Morfa

Morfa is a design tool like Figma. The `morfa` tools read and change the person's design files; every change shows live in an open
editor and lands in the file's version history. The first call asks the person to sign in to Morfa in the browser.

- **Design**: find the file (`morfa_list_files`, or a link the person gives you) or make one (`morfa_create_file`). Build the screen
  frame with auto layout first, then one `morfa_create_layers` call per section. Read before changing; `morfa_undo` takes back your own
  newest change.
- **Pictures you have**: a file on this computer goes in with `morfa_upload_image`, then `curl -sS -T <file> "<uploadUrl>"`, then
  `morfa_place_image` with the `uploadId`. A public link or a small picture (base64) goes straight to `morfa_place_image`.
- **Code**: `morfa_get_code` for a frame in the project's stack (React, Vue, HTML, Tailwind…), then adapt it to the project's components.
- **Finish** with `morfa_show_file` so the person gets a link that opens the result in Morfa.
