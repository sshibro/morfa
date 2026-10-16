# Access

Morfa asks for a **name** and nothing else. On the first visit the sign-in screen asks "What should we call you?"; the person
types a display name and is in. There are no passwords, e-mail codes, confirmation letters or outside sign-in providers
(Yandex ID, VK ID, Google and the rest are gone). Several people can open the same files at once and see each other by
those names.

The code is `POST /api/auth/name` in `server/accounts.ts`, the rules a name must meet in `shared/sign-in.ts`, and the screen in
`src/auth/` (`SignIn.tsx`, `NameSignInForm.tsx`).

## Read this before putting Morfa on a network

**Anyone who can reach the server can sign in as anyone, by typing their name.** Morfa does not check who a person is. A
public deployment must therefore sit on a private network (a VPN, an office or home network), or behind a reverse proxy that
you run and that authenticates people before a request reaches Morfa (HTTP basic auth, your single sign-on, a tunnel with
access control, and so on). Do not expose it to the open internet without one. The operators' list (below) and the account
allowlists are only as strong as the secrecy of the names in them.

## How name entry works

1. The sign-in screen has one field. The person types a name and presses Continue.
2. `POST /api/auth/name` with `{"name": "…"}` checks the name, finds or makes the account, and sets the session cookie. The
   answer is the account (`id`, `name`, `email`, see "The account" below).
3. A person who has just signed in lands on the file browser, like anyone who opens the app, unless the address names a file
   (`#design/<id>`) or carries an invite link (`?designInvite=…`), which the design area takes after the sign-in.
4. Signing out (`POST /api/auth/logout`) ends the session.

The session itself is as it always was: a random token in an HttpOnly cookie (`forma_session`, `__Host-forma_session` in
production, `SameSite=Lax`, `Secure` in production) whose SHA-256 is stored in `sessions`, seven days long. Every write needs
an `Origin` that is the app's own (`APP_ORIGIN`), and a tab that names another account than its cookie's gets `409`.
A new sign-in in a browser ends the session that browser had.

### The rules of a name

- Whitespace is collapsed to single spaces and the ends are trimmed; the text is Unicode-composed (NFC).
- 1 to 50 characters, with at least one letter or digit.
- No control characters, invisible or direction-changing marks (zero-width space, bidi overrides), and none of `@`, `<`, `>`.
- The name is the display name others see. Changing it later (`PUT /api/settings`) does not change which name signs in to the
  account.

### The same name is the same account

The mapping is deterministic. The name is compatibility-folded (NFKC) and lower-cased, and the account is looked up by that
key: "Anna", "anna" and " ANNA " are one person, a space is not a hyphen, and "Anna" and "Anna P" are two people. The first
spelling typed stays as the display name. Nobody can prove that a name is theirs, so whoever types a name first owns it, and
whoever types it later is that account. Pick names that do not collide with other people in your group.

Two people typing a new name at the same moment find one account, never two (a database lock on the key).

An account that was closed keeps its name until the next maintenance pass erases it; typing that name in the meantime is
refused ("This account is closed."). After the erasure the name is free again and makes a new, empty account.

### Limits

`POST /api/auth/name` is rate limited per client address (60 attempts in 15 minutes). Behind a reverse proxy set
`TRUST_PROXY=1` so the limit counts people and not the proxy.

## The account

Accounts are rows in `users`. A name account has:

- `name`: the display name as first typed;
- `email`: not an e-mail. It is the name's key at a reserved domain: `anna petrova@name.invalid` for "Anna Petrova". `.invalid`
  can never receive mail, and Morfa never sends mail to such an address (`server/mail.ts`);
- `email_verified = 1`, which for these accounts means only that the key belongs to exactly this account (the database keeps
  such keys unique), which is what the allowlists below rely on;
- an empty `password`.

The old columns and tables of the provider sign-in (`identities`, `account_email_codes`, the sign-in budget) stay in the schema
because migrations are never edited; nothing reads or writes them any more.

### Operators and allowlists

`MORFA_OPERATORS`, `DESIGN_TOOL_ACCOUNTS`, `MCP_ACCOUNTS` and the other account lists are comma separated; an entry is an
account id (`id` of `GET /api/auth/me`) or an address compared in lower case. To make a person an operator, write their name's
key: for the name "Anna Petrova", `MORFA_OPERATORS=anna petrova@name.invalid`. The operators' console (`#admin`, `docs/admin.md`)
shows every account's address, and `GET /api/auth/me` returns your own. An operator signs in like everyone else, by typing the
name, and the account menu then offers "Admin console".

## Invites and sharing

There are no mailboxes to invite, so invitations are links only:

- **Team invite links** (`?designInvite=<token>`): anyone who opens the link and enters a name joins the team with the link's role.
  The sign-in screen says so, and the design area takes the token after the sign-in.
- **File links**: a file's "anyone with the link" access (view or edit) works for any signed-in name.

Invitations by e-mail address (to teams and to files) were removed together with proven addresses.

## The MCP server

The MCP server's OAuth consent (`/oauth/authorize`, `/oauth/consent`, `docs/mcp-server.md`) relies on the same session. Signed
out, the consent flow shows a small page with the same name field (it calls `POST /api/auth/name` and goes on to the consent
page); signed in, it asks directly. The consent page names the signed-in account by its display name.

## Desktop and development

Nothing needs to be switched on for local development: start the API and the app and type any name. There is no development-only
sign-in and no loopback restriction; the name entry is the sign-in everywhere, production included.

## Where things are

| Piece | File |
|---|---|
| The route, the account lookup, rate limit | `server/accounts.ts` |
| Name rules, key, texts | `shared/sign-in.ts` |
| Sessions, cookie | `server/auth.ts` |
| The screen | `src/auth/SignIn.tsx`, `src/auth/NameSignInForm.tsx` |
| Allowlists of accounts | `server/account-list.ts` |
| Operators | `server/admin/operators.ts` |
| MCP consent | `server/mcp/oauth/` |
