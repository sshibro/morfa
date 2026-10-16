// The file card an assistant shows in the chat (docs/mcp-server.md §In the chat): an MCP App (the `ui://` resource Claude and ChatGPT
// render beside a tool's answer, modelcontextprotocol.io/extensions/apps; ChatGPT also reads `openai/outputTemplate`) with the file's
// name, what it holds, and a button that opens it in Morfa. One tool shows it, morfa_show_file, so a conversation gets one card when the
// work is done rather than one per change. The page loads nothing from anywhere (no CSP domains): it only draws what the tool returned.
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod/v4';
import {mcpIssuer} from './config';
import {contentPages} from './edits';
import {fileLink, layerOf, targetOf} from './design-read';
import {openFile} from './files';
import {fileIdField, linkField, nodeIdField, READ_ONLY, type ToolDefinition} from './tools';

export const CARD_URI = 'ui://morfa/file-card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
/** What a tool carries to have its answer drawn as the card. */
export const CARD_META = {ui: {resourceUri: CARD_URI}, 'openai/outputTemplate': CARD_URI, 'openai/widgetAccessible': false};

export const showFileTool = (): ToolDefinition => ({
  name: 'morfa_show_file',
  title: 'Show a file in the chat',
  description:
    'Shows the person a card for a Morfa file (or one frame of it) in the conversation, with a button that opens it in Morfa. Call it once when you have finished building or changing something, so they can open the result; not after every change.',
  annotations: READ_ONLY,
  meta: CARD_META,
  inputSchema: z.strictObject({link: linkField, fileId: fileIdField, nodeId: nodeIdField}),
  async handler(input: {link?: string; fileId?: string; nodeId?: string}, principal) {
    const target = targetOf(input);
    const nodeId = input.nodeId ?? target.nodeId;
    const file = await openFile(principal, target.fileId);
    const frame = nodeId !== undefined ? layerOf(file.doc, nodeId) : undefined;
    const pages = contentPages(file.doc);
    const layers = pages.reduce((sum, id) => sum + (file.doc.nodes[id]?.children?.length ?? 0), 0);
    const link = fileLink(mcpIssuer(), file.id, frame ? nodeId : undefined);
    return {
      structured: {
        file: {id: file.id, name: file.name, version: file.version, link},
        frame: frame ? {id: nodeId, name: frame.name, width: Math.round(frame.width), height: Math.round(frame.height)} : null,
        pages: pages.length,
        layers,
      },
      text: `“${file.name}”${frame ? `, frame “${frame.name}”` : ''}: ${link}`,
    };
  },
});

/** The card's page: plain HTML, no outside requests, light and dark. */
export function cardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#141414;--muted:#6b6b76;--line:#e7e7ec;--accent:#4338ff;--accent-fg:#fff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#17171a;--fg:#f4f4f6;--muted:#9b9ba6;--line:#2c2c33;--accent:#8a82ff;--accent-fg:#0d0d10}}
:root[data-theme=dark]{--bg:#17171a;--fg:#f4f4f6;--muted:#9b9ba6;--line:#2c2c33;--accent:#8a82ff;--accent-fg:#0d0d10}
*{box-sizing:border-box}html,body{margin:0;background:transparent}
body{font:14px/1.45 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
.card{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--bg)}
.mark{flex:none;width:40px;height:40px;border-radius:10px;background:#c4c0ff;position:relative;overflow:hidden}
.mark i{position:absolute;inset:9px;border-radius:7px;background:#8a82ff}.mark b{position:absolute;inset:14px;border-radius:50%;background:#4338ff}
.text{min-width:0;flex:1}.name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a.open{flex:none;display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:10px;background:var(--accent);color:var(--accent-fg);
font-weight:600;text-decoration:none;transition:transform .2s cubic-bezier(.22,1,.36,1)}a.open:active{transform:scale(.97)}
</style></head>
<body><div class="card" hidden><div class="mark"><i></i><b></b></div><div class="text"><div class="name"></div><div class="meta"></div></div>
<a class="open" target="_blank" rel="noopener">Open in Morfa</a></div>
<script>
(() => {
  const card = document.querySelector('.card'), open = document.querySelector('.open');
  let ids = 0;
  const post = message => window.parent.postMessage({jsonrpc: '2.0', ...message}, '*');
  const request = (method, params) => post({id: ++ids, method, params});
  const size = () => post({method: 'ui/notifications/size-changed', params: {width: document.body.scrollWidth, height: document.body.scrollHeight}});
  function show(data) {
    if (!data || !data.file || !data.file.link) return;
    const f = data.file;
    card.querySelector('.name').textContent = data.frame ? data.frame.name : f.name;
    const parts = data.frame ? [f.name, data.frame.width + '×' + data.frame.height] : [data.pages + (data.pages === 1 ? ' page' : ' pages'), data.layers + (data.layers === 1 ? ' frame' : ' frames')];
    card.querySelector('.meta').textContent = parts.join(' · ');
    open.href = f.link;
    card.hidden = false;
    size();
  }
  open.addEventListener('click', event => {
    if (window.openai && window.openai.openExternal) { event.preventDefault(); window.openai.openExternal({href: open.href}); return; }
    if (window.parent !== window) { event.preventDefault(); request('ui/open-link', {url: open.href}); }
  });
  window.addEventListener('message', event => {
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/notifications/tool-result') show(m.params && m.params.structuredContent);
    if (m.id === 1 && m.result) {
      const theme = m.result.hostContext && m.result.hostContext.theme;
      if (theme) document.documentElement.dataset.theme = theme;
      post({method: 'ui/notifications/initialized', params: {}});
    }
    if (m.method === 'ui/notifications/host-context-changed' && m.params && m.params.theme) document.documentElement.dataset.theme = m.params.theme;
  });
  // ChatGPT hands the answer to window.openai as well.
  const fromOpenAi = () => window.openai && show(window.openai.toolOutput);
  window.addEventListener('openai:set_globals', fromOpenAi);
  fromOpenAi();
  request('ui/initialize', {protocolVersion: '2026-01-26', appInfo: {name: 'morfa-file-card', version: '1.0.0'}, appCapabilities: {}});
})();
</script></body></html>`;
}

/** Adds the card's page to a server whose tools show it. */
export function registerCard(server: McpServer): void {
  server.registerResource(
    'morfa-file-card',
    CARD_URI,
    {
      title: 'Morfa file card',
      description: 'A Morfa file with a button that opens it.',
      mimeType: CARD_MIME,
      _meta: {ui: {prefersBorder: false}, 'openai/widgetDescription': 'A card for a Morfa file with a button that opens it in Morfa.'},
    },
    async uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: CARD_MIME,
          text: cardHtml(),
          _meta: {ui: {csp: {connectDomains: [], resourceDomains: []}, prefersBorder: false}, 'openai/widgetCSP': {connect_domains: [], resource_domains: []}},
        },
      ],
    }),
  );
}
