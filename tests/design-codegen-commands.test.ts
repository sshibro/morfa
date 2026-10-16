import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesignStore} from '../src/design/engine/store';
import {getCommand, runCommand, shortcutMatches, type CommandContext} from '../src/design/engine/commands/registry';
import {CODE_COMMAND_IDS, REACT_EXPORT_DIALOG, registerCodeCommands, selectionText, VUE_EXPORT_DIALOG, type CodeCommandDeps} from '../src/design/engine/commands/code';
import {highlight, languageOf} from '../src/design/panels/code/highlight';
import {boxModel, exportAssets, fileTabLabel, layoutRows, stylesUsed, typographyRows} from '../src/design/panels/code/inspect';
import {layerMenuItems} from '../src/design/panels/left/commands';
import type {MenuItem} from '../src/design/ui/menu-model';
import {collectTokens} from '../shared/design/codegen/tokens';
import {measurer, showcaseFile} from './design-codegen-fixture';

// "Copy as…" and "Export to React…", the "Code" tab's highlighter and its dev-mode numbers.

function setup(selection: string[]) {
  const doc = showcaseFile();
  const store = createDesignStore({doc, pageId: 'p', measurer});
  store.setSelection(selection);
  const written: string[] = [];
  const toasts: [string, string | undefined][] = [];
  const dialogs: [string, Record<string, unknown> | undefined][] = [];
  const deps: CodeCommandDeps = {
    fonts: {measurer, ensure: async () => {}, isLoaded: () => true, families: () => [], cssFont: () => '16px sans-serif', onLoad: () => () => {}},
    images: {get: () => null, size: () => null, whenReady: async () => {}, onChange: () => () => {}},
    toast: (message, kind) => toasts.push([message, kind]),
    openDialog: (id, params) => dialogs.push([id, params]),
    clipboard: {writeText: async (text: string) => {written.push(text);}},
  };
  const unregister = registerCodeCommands(deps);
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  const run = async (id: string) => {
    const command = getCommand(id);
    assert.ok(command, `${id} is registered`);
    await command.run(ctx);
  };
  return {store, ctx, written, toasts, dialogs, run, unregister};
}

test('the commands use the main menu ids and "Copy as PNG" is ⇧⌘C', () => {
  const {unregister} = setup([]);
  try {
    for (const id of CODE_COMMAND_IDS) assert.ok(getCommand(id), id);
    assert.equal(getCommand('edit.copy-css')!.label, 'Copy as CSS');
    const png = getCommand('edit.copy-png')!;
    assert.ok(shortcutMatches(png.shortcut!, {code: 'KeyC', metaKey: true, shiftKey: true, altKey: false, ctrlKey: false}, true));
    assert.ok(shortcutMatches(png.shortcut!, {code: 'KeyC', metaKey: false, shiftKey: true, altKey: false, ctrlKey: true}, false), 'Ctrl+Shift+C off Mac');
  } finally {
    unregister();
  }
  assert.equal(getCommand('edit.copy-css'), undefined, 'unregistering removes them');
});

test('"Copy as CSS" and "Copy as text" write the clipboard', async () => {
  const {run, written, toasts, ctx, unregister} = setup(['name', 'badge']);
  try {
    await run('edit.copy-css');
    assert.match(written[0], /^\/\* Name \*\/\n/);
    assert.match(written[0], /font: var\(--font-headings-h2\);/);
    assert.match(written[0], /\/\* Badge \*\/\n[\s\S]*right: 24px;/);
    await run('edit.copy-text');
    assert.equal(written[1], 'Ethiopia Yirgacheffe\nNew');
    assert.deepEqual(toasts.map(([message]) => message), ['CSS copied', 'Text copied']);
    ctx.store.setSelection(['photo']);
    assert.equal(runCommand('edit.copy-text', ctx), false, 'nothing to copy without text');
  } finally {
    unregister();
  }
});

test('text of a frame reads top to bottom, then left to right, wherever the layers sit in the list', () => {
  const doc = showcaseFile();
  assert.equal(selectionText(doc, ['card']), 'New\nEthiopia Yirgacheffe\nNotes: jasmine and bergamot. Learn more on the site\nAcidity: high\nBody: light\nBuy');
});

test('"Copy as PNG" says so when the browser cannot put a picture in the clipboard', async () => {
  const {run, toasts, unregister} = setup(['badge']);
  const saved = (globalThis as {ClipboardItem?: unknown}).ClipboardItem;
  delete (globalThis as {ClipboardItem?: unknown}).ClipboardItem;
  try {
    await run('edit.copy-png');
    assert.deepEqual(toasts, [['This browser cannot put images on the clipboard. Save the PNG via "Export".', 'error']]);
  } finally {
    (globalThis as {ClipboardItem?: unknown}).ClipboardItem = saved;
    unregister();
  }
});

test('"Export to React…" opens the dialog with the selection', async () => {
  const {run, dialogs, unregister} = setup(['card']);
  try {
    await run('file.export-react');
    assert.deepEqual(dialogs, [[REACT_EXPORT_DIALOG, {ids: ['card'], pageId: 'p'}]]);
  } finally {
    unregister();
  }
});

test('"Export to Vue…" opens the same dialog for a Vue project, with the selection', async () => {
  const {run, dialogs, unregister} = setup(['card']);
  try {
    await run('file.export-vue');
    assert.deepEqual(dialogs, [[VUE_EXPORT_DIALOG, {ids: ['card'], pageId: 'p'}]]);
  } finally {
    unregister();
  }
});

test('the highlighter keeps every character and colours what it knows', () => {
  const tsx = `import {Button} from './Button';\n\nexport function Card({title = 'Coffee'}: CardProps) {\n  return <div className={styles.root} data-x="1">{title} /* not a comment */</div>;\n}\n/* multi-line\n   comment */`;
  const lines = highlight(tsx, 'tsx');
  assert.deepEqual(lines.map(line => line.map(token => token.text).join('')), tsx.split('\n'));
  const kinds = (line: number, text: string) => lines[line].filter(token => token.text === text).map(token => token.kind);
  assert.deepEqual(kinds(0, 'import'), ['keyword']);
  assert.deepEqual(kinds(0, "'./Button'"), ['string']);
  assert.deepEqual(kinds(2, 'Card'), ['type']);
  assert.deepEqual(kinds(3, 'div'), ['tag', 'tag']);
  assert.deepEqual(kinds(3, 'className'), ['attr']);
  assert.equal(lines[6][0].kind, 'comment', 'a block comment continues on the next line');
  const css = highlight('.root {\n  color: #0D99FF;\n  padding: 12px 24px;\n}\n', 'css');
  assert.equal(css.length, 4);
  assert.deepEqual(css[1].filter(t => t.kind !== 'plain' && t.kind !== 'punct').map(t => [t.kind, t.text]), [['prop', 'color'], ['number', '#0D99FF']]);
  assert.equal(css[0][0].kind, 'selector');
  assert.equal(languageOf('src/components/Button.module.css'), 'css');
  assert.equal(languageOf('package.json'), 'json');
  // A single-file component: the script as TypeScript, the template as HTML, the style as CSS.
  assert.equal(languageOf('src/components/Button.vue'), 'vue');
  const vue = `<script setup lang="ts">\nconst size = 'large';\n</script>\n\n<template>\n  <button :class="$style.root">{{ size }}</button>\n</template>\n\n<style module>\n.root {\n  color: #0D99FF;\n}\n</style>`;
  const sfc = highlight(vue, 'vue');
  assert.deepEqual(sfc.map(line => line.map(token => token.text).join('')), vue.split('\n'));
  assert.deepEqual(sfc[1].filter(t => t.text === 'const').map(t => t.kind), ['keyword']);
  assert.deepEqual(sfc[5].filter(t => t.text === 'button').map(t => t.kind), ['tag', 'tag']);
  assert.equal(sfc[9][0].kind, 'selector');
});

test('dev-mode numbers: size, auto layout, typography, colours with tokens, export settings', () => {
  const doc = showcaseFile();
  const tokens = collectTokens(doc);
  const badge = boxModel(doc, doc.nodes.badge);
  assert.deepEqual([badge.width, badge.height, badge.x, badge.y, badge.inFlow], [60, 24, 236, 28, false]);
  assert.deepEqual(layoutRows(doc.nodes.card)!.map(row => [row.label, row.value]), [['Direction', 'Vertical'], ['Gap', '16px'], ['Padding', '16px'], ['Alignment', 'Start · Start']]);
  const type = typographyRows(doc.nodes.name, tokens)!;
  assert.equal(type.style, 'Headings/H2');
  assert.deepEqual(type.rows.map(row => row.copy), ["font-family: 'Inter';", 'font-weight: 600;', 'font-size: 24px;', 'line-height: 32px;', 'letter-spacing: -0.01em;']);
  const styles = stylesUsed(doc, ['card'], tokens);
  assert.deepEqual(styles.slice(0, 2).map(entry => [entry.kind, entry.value, entry.token]), [['fill', '#1A1A1A', '--color-surface-card'], ['effect', '0 8px 24px rgba(0, 0, 0, 0.12)', '--shadow-card']]);
  assert.ok(styles.some(entry => entry.token === '--color-text-primary'));
  const withExport = {...doc, nodes: {...doc.nodes, badge: {...doc.nodes.badge, exportSettings: [{format: 'PNG' as const, suffix: '@2x', constraint: {type: 'SCALE' as const, value: 2}}]}}};
  assert.deepEqual(exportAssets(withExport, ['card']).map(asset => [asset.fileName, asset.label]), [['badge@2x.png', 'PNG 2x']]);
});

test('a long file name keeps the ending that tells the files apart in the "Code" tab', () => {
  assert.equal(fileTabLabel('src/components/Button.tsx'), 'Button.tsx');
  const tsx = fileTabLabel('src/screens/OnlaynZapisKotorayaRabotaetZaVas.tsx');
  const css = fileTabLabel('src/screens/OnlaynZapisKotorayaRabotaetZaVas.module.css');
  assert.ok([...tsx].length <= 24 && [...css].length <= 24, `${tsx} ${css}`);
  assert.match(tsx, /^OnlaynZapis.*….*\.tsx$/);
  assert.match(css, /^Onlayn.*….*\.module\.css$/);
  assert.notEqual(tsx, css);
  assert.equal(fileTabLabel('A-very-long-file-name-without-an-extension-at-all', 12).length, 12);
});

test('the layers panel row menu offers "Copy as" with the canvas menu’s id', async () => {
  const {ctx, written, unregister} = setup(['card']);
  try {
    const labels = (items: readonly MenuItem[]): string[] => items.flatMap(item => (item.type === 'separator' ? ['—'] : item.type === 'submenu' ? [`${item.id} ${item.label} ▸ ${labels(item.items).join(', ')}`] : 'label' in item ? [item.label] : []));
    const items = layerMenuItems(ctx, {onRename: () => {}});
    const copyAs = items.find(item => item.type === 'submenu' && item.id === 'menu:copy-as');
    assert.ok(copyAs, labels(items).join('\n'));
    assert.deepEqual(labels([copyAs]), ['menu:copy-as Copy as ▸ Copy as text, Copy as CSS, Copy as SVG, Copy as PNG']);
    const css = (copyAs as Extract<MenuItem, {type: 'submenu'}>).items.find(item => 'label' in item && item.label === 'Copy as CSS') as Extract<MenuItem, {onSelect: unknown}>;
    await css.onSelect!();
    assert.match(written.at(-1) ?? '', /Product card/);
  } finally {
    unregister();
  }
});
