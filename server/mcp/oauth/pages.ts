// The sign-in pages of the MCP server (docs/mcp-server.md §Sign-in): one card on the app's origin, server-rendered, no client bundle.
// Each page has its own Content-Security-Policy with a nonce for its one stylesheet and its one script and no inline handler; none
// may be framed, none sends a referrer to another site, none loads a picture (a client's picture would tell its host who looks).
// Text from outside (a client's name, a person's name) is escaped, and nothing a client wrote reaches a page but its name, always
// next to the hosts its answers go to.
import {randomBytes} from 'node:crypto';
import type {Response} from 'express';
import {redirectOrigin} from './shared';

const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ESCAPES[char]!);

/* Light and dark follow the system. Interaction is a 160 ms press and colour change, gone under reduced motion. */
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#111;--muted:#5f5f5c;--card:#fff;--line:rgb(0 0 0/.12);--ring:0 0 0 1px rgb(0 0 0/.06),0 1px 2px rgb(0 0 0/.06),0 12px 32px -16px rgb(0 0 0/.18);--btn:#111;--btn-fg:#fff;--focus:#2563eb;--warn-bg:#fff4dc;--warn-fg:#5a3a00;--error:#b3261e;--ease:cubic-bezier(.2,0,0,1);--text:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f0f;--fg:#f4f4f2;--muted:#a3a3a0;--card:#1a1a1a;--line:rgb(255 255 255/.14);--ring:0 0 0 1px rgb(255 255 255/.08);--btn:#f4f4f2;--btn-fg:#111;--focus:#7c9bff;--warn-bg:#3a2d10;--warn-fg:#ffd98a;--error:#ff8a80}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:450 16px/1.5 var(--text);-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:480px;padding:28px 24px;border-radius:16px;background:var(--card);box-shadow:var(--ring)}
.brand{margin:0 0 20px;font-weight:700;font-size:15px;letter-spacing:-.01em}
h1{margin:0 0 8px;font-size:21px;font-weight:650;line-height:1.3;letter-spacing:-.01em;text-wrap:balance}
.host{display:inline-block;max-width:100%;padding:0 7px;border:1px solid var(--line);border-radius:7px;font:550 14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;vertical-align:1px}
.lead,.meta{margin:0 0 12px;text-wrap:pretty}
.meta,.note{font-size:14px;color:var(--muted)}
.meta b{color:var(--fg);font-weight:600;overflow-wrap:anywhere}
.warn,.error{margin:0 0 16px;padding:10px 14px;border-radius:10px;font-size:14px}
.warn{background:var(--warn-bg);color:var(--warn-fg)}
.error{border:1px solid var(--error);color:var(--error)}
ul.rights{margin:16px 0 0;padding:0;list-style:none;border:1px solid var(--line);border-radius:12px}
ul.rights li{padding:12px 14px}
ul.rights li+li{border-top:1px solid var(--line)}
ul.rights b{display:block;font-weight:600}
ul.rights span{font-size:14px;color:var(--muted)}
.note{margin:16px 0 0}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.button,.allow,.deny{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 22px;border-radius:10px;font:600 15px/1 var(--text);text-decoration:none;cursor:pointer;transition:transform 160ms var(--ease),background-color 160ms var(--ease),opacity 160ms var(--ease)}
.button.primary,.allow{border:0;background:var(--btn);color:var(--btn-fg)}
.button,.deny{border:1px solid var(--line);background:transparent;color:var(--fg)}
.allow:active,.deny:active,.button:active{transform:scale(.97)}
.field{display:block;margin:16px 0 6px;font-weight:600}
.input{width:100%;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);font:inherit}
.error[hidden]{display:none}
.link{padding:0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:6px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`.replace(/\n/g, '');

/* The one script: the "Not you? Sign out" link signs the person out and comes back, and the name form signs the person in (POST /api/auth/name)
   and goes on to the consent page. The server checks everything again; the script holds no data. */
const SCRIPT = `(function(){var out=document.getElementById('signout');if(out)out.addEventListener('click',function(){out.disabled=true;fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.assign(out.getAttribute('data-return'));},function(){out.disabled=false;});});var form=document.getElementById('name-form');if(form)form.addEventListener('submit',function(event){event.preventDefault();var button=form.querySelector('button'),problem=document.getElementById('name-error'),fail=function(text){problem.textContent=text;problem.hidden=false;button.disabled=false;};button.disabled=true;problem.hidden=true;fetch('/api/auth/name',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({name:form.elements.name.value})}).then(function(response){return response.json().catch(function(){return {};}).then(function(body){if(response.ok)location.assign(form.getAttribute('data-return'));else fail(body.error||'Could not sign in. Try again.');});},function(){fail('Could not sign in. Try again.');});});})();`;

type Parts = {title: string; body: string; script?: boolean; formTargets?: readonly string[]};

/** Sends a page with its policy. `formTargets`: origins the consent form may be redirected on to (Chrome checks form-action there). */
export function sendPage(res: Response, status: number, parts: Parts): void {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    ...(parts.script ? [`script-src 'nonce-${nonce}'`, "connect-src 'self'"] : []),
    `form-action 'self'${(parts.formTargets ?? []).map(origin => ' ' + origin).join('')}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  res.status(status);
  res.setHeader('Content-Security-Policy', csp);
  // Not no-referrer: a browser sends `Origin: null` on a form post from such a page, and the consent form's same-origin check needs it.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // helmet's same-origin would cut the link between an assistant's sign-in window and the assistant.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cache-Control', 'no-store');
  res
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark"><title>${escapeHtml(parts.title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main class="card"><p class="brand">Morfa</p>${parts.body}</main>${parts.script ? `<script nonce="${nonce}">${SCRIPT}</script>` : ''}</body></html>`,
    );
}

const HOME = '<a class="button" href="/">Open Morfa</a>';

/** A plain refusal: what went wrong in a sentence. The only text on it is ours. */
export const sendErrorPage = (
  res: Response,
  status: number,
  message: string,
  lead = 'Could not connect',
): void =>
  sendPage(res, status, {
    title: 'Connect to Morfa',
    body: `<h1>${escapeHtml(lead)}</h1><p class="lead">${escapeHtml(message)}</p><div class="actions">${HOME}</div>`,
  });

/** The server is not open to this account. The page names the account: a person with two accounts may be signed in to the other. */
export const sendNotForEveryonePage = (res: Response, name?: string | null): void =>
  sendPage(res, 403, {
    title: 'Connect to Morfa',
    script: !!name,
    body:
      '<h1>Connecting assistants is not open to every account yet</h1><p class="lead">We will open it gradually. Nothing is connected.</p>' +
      (name
        ? `<p class="meta">You are signed in as ${escapeHtml(name)}. Need another account? <button type="button" class="link" id="signout" data-return="/">Sign out</button>, then start connecting in the assistant again.</p>`
        : '') +
      `<div class="actions">${HOME}</div>`,
  });

/** Not signed in: the name form (it signs in without leaving the page and goes on to the consent page), or sign in in the app and continue. */
export function sendSignInPage(res: Response, requestId: string): void {
  const consent = `/oauth/consent?req=${escapeHtml(requestId)}`;
  sendPage(res, 200, {
    title: 'Sign in to Morfa',
    script: true,
    body:
      '<h1>Sign in to Morfa to connect the assistant</h1>' +
      '<p class="lead">After that we will ask what it may do with your files.</p>' +
      `<form id="name-form" data-return="${consent}"><label class="field" for="name">Your name</label>` +
      '<input class="input" id="name" name="name" type="text" autocomplete="nickname" maxlength="100" required autofocus>' +
      '<p class="error" id="name-error" role="alert" hidden></p>' +
      '<div class="actions"><button type="submit" class="button primary">Continue</button></div></form>' +
      `<p class="note">Already signed in to Morfa in another tab? <a href="${consent}">Continue</a></p>`,
  });
}

export type ConsentView = {
  clientName: string;
  clientHost: string;
  redirectUri: string;
  name: string;
  requestId: string;
  csrf: string;
  /** The assistant asks to change files too (the `write` right). */
  write: boolean;
};

/** The consent screen: who is asking (its name, and the hosts its answer goes to), what it may do, "Allow" or "Cancel". The name
 *  is the client's own word, so the page always says it was not checked. */
export function sendConsentPage(res: Response, view: ConsentView): void {
  const body =
    `<h1>${escapeHtml(view.clientName)} is asking for access to Morfa</h1>` +
    `<p class="meta">The response will be sent to <span class="host">${escapeHtml(view.clientHost)}</span></p>` +
    '<p class="warn">The application chose its own name and we have not verified it. Allow only if you are connecting the assistant yourself.</p>' +
    `<p class="meta">You are signed in as <b>${escapeHtml(view.name)}</b>. Not you? <button type="button" class="link" id="signout" data-return="/oauth/consent?req=${escapeHtml(view.requestId)}">Sign out</button></p>` +
    '<ul class="rights">' +
    '<li><b>Read your files</b><span>files, their pages, layers, styles and variables, code for designs; your own and those of teams you belong to</span></li>' +
    (view.write
      ? '<li><b>Change files you can edit</b><span>create files and pages, add, edit and delete layers, add styles. Changes show up right away in an open editor, the assistant can undo them, and they appear in the version history</span></li>'
      : '<li><b>Change nothing</b><span>the assistant cannot create, edit or delete files</span></li>') +
    '</ul>' +
    `<p class="note">${view.write ? 'The assistant works with what you ask it to.' : 'The assistant sees only what you ask it to read.'} You can turn off access at any time in Morfa settings.</p>` +
    `<form method="post" action="/oauth/consent"><input type="hidden" name="req" value="${escapeHtml(view.requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">` +
    '<div class="actions"><button type="submit" class="allow" name="decision" value="allow">Allow</button><button type="submit" class="deny" name="decision" value="deny">Cancel</button></div></form>';
  const target = redirectOrigin(view.redirectUri);
  sendPage(res, 200, {title: 'Access to Morfa', body, script: true, formTargets: target ? [target] : []});
}
