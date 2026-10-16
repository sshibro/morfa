# The MCP server

A person's own AI assistant (Claude, Claude Code, Cursor, ChatGPT, anything that speaks MCP) reads their Morfa files and writes code
from them. The server is read-focused, with optional editing (§Editing).

- **Address**: `APP_ORIGIN/mcp`, so `https://app.morfa.example/mcp` in production. It is a remote server over streamable HTTP, stateless,
  and serves both protocol eras (the 2025 `initialize` handshake and 2026's).
- **Sign-in**: OAuth 2.1 on the app's own origin, with the person's normal Morfa session (the name they signed in with). Nothing to copy or paste.
- **Rights**: `read`, and `write` while editing is on (§Editing). Every file goes through the files API's own access rule
  (`server/design/file-access.ts` `fileAccess`). An assistant sees exactly what its person can open in Morfa, nothing in the trash, and
  changes only what its person may edit.
- **Off by default.** `ENABLE_MCP_SERVER=1` (with `ENABLE_DESIGN_TOOL=1`) and `MCP_ACCOUNTS` (ids or proven e-mails, `*` for everyone;
  unset is nobody). Off, `/mcp`, `/oauth/*` and the well-known documents are not routes at all. Editing needs `ENABLE_MCP_EDITS=1` too.

## Tools

All five are read-only (`readOnlyHint`, not destructive, idempotent, closed world). Descriptions are written for the model, in English.
A file or layer is named by a Morfa link (what "Copy link to layer" copies: `…/#design/<file>?node=<layer>`) or by ids.

| Tool | What it returns |
| --- | --- |
| `morfa_list_files` | The files the account can open (own, its teams', shared with it), newest first, with a name filter. |
| `morfa_get_file` | Pages in order and each page's top-level frames with sizes and layer counts; how many components, styles, variables. |
| `morfa_get_layers` | One layer's tree: geometry, text, the component an instance comes from and its properties, styles used, and dev mode's CSS. Up to 12 levels and 600 layers. |
| `morfa_get_code` | Code from the "Code" tab's own writers: `react` (CSS Modules), `react-tailwind`, `react-inline`, `css`, `svg`, `tokens`. Up to 4000 layers; answers are capped and name the files left out. |
| `morfa_get_variables` | Variables by collection with a value per mode, and the colour, text and effect styles. |

Not in this version: Vue output (the separate Vue export ask). The editing tools and `morfa_look_at` are in §Editing.

Tool errors are results with `isError: true` and `{code, message, fix}` (`unauthorized`, `not_found`, `invalid_input`, `too_large`,
`rate_limited`, `unavailable`, `internal`, and for edits `insufficient_scope`, `forbidden`, `refused`, `conflict`); nothing of an unexpected exception reaches the caller. Another person's file is the same
`not_found` as one that does not exist.

## Editing

While `ENABLE_MCP_EDITS=1` (on top of the switches above) the server offers the `write` right and ten more tools, so a person's own
assistant can build and change designs in the editor, with their own model. The tools list and the server's instructions follow the
switch at every request; switched off, a connection that has `write` reads only, and the editing tools are refused as unknown.

| Tool | What it does |
| --- | --- |
| `morfa_create_file` | A new empty file with one page, in the person's own files. |
| `morfa_add_page` | A new page in a file. |
| `morfa_create_layers` | Frames, text, shapes, image placeholders and component instances, with auto layout, nested in one call. New top-level screens land in a row to the right of what is on the page. |
| `morfa_update_layers` | Change, move, resize, reorder or re-parent layers; text, fills, strokes, effects, auto layout, constraints. |
| `morfa_delete_layers` | Remove layers. |
| `morfa_duplicate_layers` | Copy layers, optionally into another parent. |
| `morfa_add_color_styles` | Save a palette as colour styles. |
| `morfa_place_image` | A picture the assistant already has into a layer or as a new layer: a public link, an image from the ChatGPT conversation (`file`, see below), base64 in the call, or an `uploadId`. |
| `morfa_upload_image` | An upload address for a bigger file on the person's computer: the assistant (Claude Code, Codex) sends it with `curl -T`, then places it. |
| `morfa_undo` | Take back the connection's own newest change in a file (or one named change). |

`morfa_look_at` (read-only) returns a PNG of layers; it is listed only where the render service is configured
(`designRasterEngine()==='service'` and its URL), which a default deployment does not have.

How it works (`server/mcp/edits.ts`, `server/mcp/edit-tools.ts`): a tool call loads the file, runs the canvas tools
(`src/design/canvas-tools/executor.ts`, with the input checks of `shared/design/canvas-tools-check.ts`) on a headless store, and saves the result through the editor's merge
save (`patchDesignDocument`), so the change appears at once in every open editor as a teammate's change and lands in version history.
Inputs use the file's real layer ids. Only own layers of a file the account may edit; never the library page, a board, or a file in the
trash. The person's assistant runs on its own model: Morfa draws no pictures itself.

Pictures the assistant brings (`server/mcp/uploads.ts`): one ChatGPT or Codex generated, one the person pasted into the chat, a file on
their computer. They go through the editor's own upload pipeline (`storeDesignImage`: decoded, re-encoded, counted in storage, PNG,
JPEG, WebP, AVIF, GIF up to 20 MB). A link is fetched with the link previews' guard (`fetchChecked`: public
addresses only, every redirect checked, 20 s). ChatGPT passes an image from the chat as `{download_url, file_id, mime_type, file_name}`
into the argument the tool names in `_meta["openai/fileParams"]`. Base64 must fit the 1 MiB call. An upload address
(`/mcp/uploads/<secret>`, PUT or POST of the raw bytes, any origin) takes one picture within 10 minutes; only its SHA-256 is stored, in
PostgreSQL table `mcp_uploads`, and it acts through the connection's newest live token with the same checks as a call (`write`,
editing on, the file editable). A received picture can be placed in its own file for 24 hours; the row goes with the connection or the
file. Claude.ai cannot hand a remote tool an image pasted into its chat yet; there the assistant uses a link, or the person drops the
picture into the file in Morfa.

Undo: the editor's ⌘Z holds only the person's own steps (as for a teammate), so each change an assistant makes is kept with its inverse
in PostgreSQL table `mcp_edits` (the newest 50 per connection and file, none older than 30 days; gone with the connection, the file
and the account). `morfa_undo` refuses with `conflict` when someone changed the same layers since.

Writes check the connection again inside the save's own transaction (`server/mcp/authority.ts` `lockMcpWriter`, called from
`assertCustomerAuthority`): the token and grant are locked, still live, still `write`, editing still on. A file under the live
collaboration lease (`DESIGN_COLLAB=rust`) refuses merge saves, so edits there answer `unavailable`.

## In the chat

`morfa_show_file` (read-only) answers with a card the host draws in the conversation (`server/mcp/app-card.ts`): an MCP App, the
`ui://morfa/file-card.html` resource (`text/html;profile=mcp-app`, named by the tool's `_meta.ui.resourceUri` and, for ChatGPT,
`openai/outputTemplate`), with the file's or frame's name, what it holds and "Open in Morfa". The page loads nothing from anywhere and
asks the host to open the link (`ui/open-link`, or ChatGPT's `openExternal`). Only this tool has the card, and the instructions ask for it
once, at the end, so a conversation is not a column of cards. A host without MCP Apps shows the tool's text, which has the link.

## Calls

`server/mcp/router.ts` reads the body itself (1 MiB), checks Host and Origin (the app's host; loopback too outside production; no
browser origins in production), then `server/mcp/auth.ts` gates the request:

- no credential: every request gets a 401 with `WWW-Authenticate: Bearer … resource_metadata=…`, the handshake too (Claude's directory
  requires it); ChatGPT (`MCP_TOOL_ERROR_AUTH_CLIENTS`), which starts sign-in from a tool result, gets its handshake and tool list and the
  challenge inside a tool's answer;
- an unknown, expired, revoked or closed-account token: the same 401, `invalid_token`;
- a live token of an account no longer in `MCP_ACCOUNTS`: 403 `account_not_enabled`;
- 120 calls a minute per connection, 60 a minute per address without one (in process memory), and `MCP_DAILY_CALLS` tool calls a
  UTC day per account across all its assistants (default 2000, counted in PostgreSQL table `mcp_daily_calls`).

Each tool reads in one read-only, repeatable-read transaction, and the connection is checked inside it and again after it, so a
revoked connection gets no bytes. A call has 30 seconds (`morfa_place_image` 60).

## Sign-in

`server/mcp/oauth/`: dynamic client registration (RFC 7591, public clients, PKCE S256 required), RFC 8414 and RFC 9728 metadata,
RFC 8707 resource audience, RFC 7009 revocation. Access tokens last an hour; refresh tokens 30 days and are replaced on every use (an
old one presented again revokes its family, except a retry within 30 seconds). Secrets are stored only as sha256.

The flow: `/oauth/authorize` checks the request and binds it to the browser with a cookie. Signed in, the person goes to
`/oauth/consent`; not signed in, they get a page with the name field of the app's sign-in (`sendSignInPage` in `server/mcp/oauth/pages.ts`), which
signs in and goes on to the consent page. The consent page names the assistant,
the address it returns to and the account, and says what it may do: only read, or (with `write`) change the files the person can
edit. "Allow" issues a single-use code. A client that asks to authenticate other than `none` (ChatGPT may prefer
`private_key_jwt`) is registered as a public client, which the registration answer says; OpenID Connect's `openid`, `profile` and
`email` in a request are passed over. A client that names no scope gets every right on
offer; `read` alone is a read-only connection; asking again replaces the connection's rights with the ones just allowed.

## Connections

`GET /api/mcp/connections` lists the account's assistants (name, host, when connected, last used), the address to give them; `DELETE /api/mcp/connections/:id` ("Disconnect") ends one at once.
`/api/config` carries `mcpServer` (the address) for an account the server is open to.

In the app (`src/design/assistants`, a place of its own, not a setting): the file browser's sidebar
has a "Claude and ChatGPT" card, shown only where `GET /api/mcp/connections` answers. It draws the assistants joined to
Morfa (their own marks; a connected one's line turns solid) and opens "Connections": what connecting gives, three steps each for Claude,
ChatGPT and coding assistants with the address to copy and a link to their settings, and the connected assistants with "Disconnect".
While open it reads the list every 4 s, so an
assistant allowed in another tab appears on its own. `tests/e2e/design-assistants.spec.ts` (the e2e server opens MCP per account
through `/__e2e/mcp`).

Closing an account revokes its connections; erasing it deletes its grants, codes, tokens and counts
(`server/launch/lifecycle.ts`).

## Connecting an assistant

Neither Claude nor ChatGPT lets a site add a connector to someone's account (no deep link as of 2026-10-12), and Morfa is not listed
in their directories for now: people add it themselves. The "Connections" screen's "Add to Claude" /
"Add to ChatGPT" copies the address and opens the page where it is pasted. The icon: `serverInfo.icons` (the app's `logo-512.png` and
`favicon.svg`) for clients that read it (Codex); claude.ai shows the favicon of the server's registrable domain (morfa.example) from Google's
favicon service (community findings, anthropics/claude-ai-mcp#152); ChatGPT lets the creator of a custom app set its logo under Manage.

- **Claude (claude.ai, Desktop; every plan, Free allows one custom connector)**: Customize → Connectors
  (`https://claude.ai/customize/connectors`) → Add custom connector → `https://app.morfa.example/mcp`, then "Allow".
- **Claude Code**: the plugin in this repository (`.claude-plugin/marketplace.json`, `integrations/claude-plugin`: the server plus a
  short skill on working in Morfa): `/plugin marketplace add <github-owner>/morfa`, then `/plugin install morfa@morfa`; needs the repository
  public. Without it: `claude mcp add --transport http morfa https://app.morfa.example/mcp`, then `/mcp` to sign in.
- **Codex**: in `~/.codex/config.toml`, `[mcp_servers.morfa]` with `url = "https://app.morfa.example/mcp"`, then `codex mcp login morfa`.
- **Cursor**: in `~/.cursor/mcp.json`, `{"mcpServers": {"morfa": {"url": "https://app.morfa.example/mcp"}}}`.
- **ChatGPT** (web): `https://chatgpt.com/plugins` → "+" → "Add custom MCP server" (Developer mode on in Settings → Apps → Advanced
  settings where asked) with `https://app.morfa.example/mcp` and OAuth. OpenAI's help (2026-10) says full write access for custom apps is
  rolling out to Business and Enterprise/Edu, and personal plans may get read and fetch only: there ChatGPT can read but not edit. ChatGPT registers itself (dynamic registration, redirect `https://chatgpt.com/…`), sends
  `resource` and checks `iss`; each tool names the rights it needs (`_meta.securitySchemes`), which is how ChatGPT knows to offer its
  sign-in. It asks before running a changing tool.

Then ask, for example: "Build this screen in React + Tailwind" with a link copied from the editor.

## Before turning it on

1. Merge and deploy (migration 025, and 026 for editing).
2. Production's Caddy routes `/mcp`, `/mcp/*` (upload addresses), `/oauth/*` and `/.well-known/oauth-*` to the api (`deploy/caddy/morfa-routes.caddy`).
3. Set `ENABLE_MCP_SERVER=1` and `MCP_ACCOUNTS` (start with a few ids, or `*`); `ENABLE_MCP_EDITS=1` for editing.

## Development

The API on 3400 and Vite on 5400; Vite proxies `/mcp`, `/oauth` and the well-known documents. The canonical address in development is
`http://127.0.0.1:5400/mcp`; tokens issued for `localhost:3400` and the other loopback ports are accepted too. Try it with
`npx @modelcontextprotocol/inspector` against that address.

Tests: `tests/mcp-server.test.ts`, `tests/mcp-design-read.test.ts` and `tests/mcp-edits.test.ts` (no database),
`tests/postgresql-mcp-server.test.ts` (the whole flow: register, authorize, consent, token, every tool, "Disconnect", the limits,
erasure), `tests/postgresql-mcp-edits.test.ts` (building in a file with an editor open, undo, refusals, the switch) and
`tests/postgresql-mcp-server-migration.test.ts`, `tests/postgresql-mcp-edits-migration.test.ts`.
