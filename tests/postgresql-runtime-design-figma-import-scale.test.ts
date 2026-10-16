import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {collabApp, type Account} from './helpers/collab-app';
import {figmaKit, NUXT_LIKE} from './helpers/figma-kit';
import {figKit} from './helpers/fig-kit';
import {FigmaApiError} from '../src/figma-import/figma-client';
import {readFigmaFile, runFigmaImport, type FigmaRead, type ImportStage, type RunDeps} from '../src/design/import/figma/run-import';
import {depsFor, readSource, type PageCall} from '../src/design/import/figma/import-deps';
import {MAX_FIGMA_RESPONSE_BYTES} from '../shared/figma/limits';
import type {FigmaFile, FigmaNode} from '../shared/design/figma-import';

// Big files at scale: a Nuxt-UI-shaped kit imported end to end with big files on — the import's
// own code (src/design/import/figma/run-import.ts) against a fake Figma that answers as the real one (an answer over 80 MB is refused,
// so a big file is read page by page) and the real server — then opened as the editor opens a big file (the skeleton, a page).
// MORFA_IMPORT_KIT_PAGES sets the size (default 12 pages, about 15 000 layers: the gate's run); the bound in STATUS is measured at
// 125 pages (about 150 000 layers), MORFA_IMPORT_REPORT=1 prints the phases, the time and the peak RSS. The same kit saved as a .fig
// (the dialog's default tab: no Figma calls, the file unpacked where the import runs) goes through the same import and save;
// MORFA_IMPORT_SOURCE=link or fig runs one of the two.

const PAGES = Number(process.env.MORFA_IMPORT_KIT_PAGES ?? 12);
const REPORT = process.env.MORFA_IMPORT_REPORT === '1';
/** The fake Figma's answer cap: Figma's own by default; MORFA_IMPORT_FIGMA_CAP (bytes) lowers it, so a kit of any size is read page by page. */
const FIGMA_CAP = Number(process.env.MORFA_IMPORT_FIGMA_CAP ?? MAX_FIGMA_RESPONSE_BYTES);

/** A fake Figma REST client over `file`: whole when the answer fits Figma's cap, else `tooLarge`, as the client reports it. */
function fakeFigma(file: FigmaFile, pictures: Record<string, string>) {
  const byId = new Map<string, FigmaNode>();
  const sizes = new Map<string, number>();
  const pages = file.document!.children!;
  for (const page of pages) {
    const stack: FigmaNode[] = [page];
    while (stack.length) {
      const node = stack.pop()!;
      byId.set(node.id, node);
      stack.push(...(node.children ?? []));
    }
    sizes.set(page.id, JSON.stringify(page).length);
    for (const child of page.children ?? []) sizes.set(child.id, JSON.stringify(child).length);
  }
  const whole = [...pages].reduce((sum, page) => sum + sizes.get(page.id)!, 0);
  const tooLarge = () => new FigmaApiError({kind: 'bad', status: 200, tooLarge: true});
  const shallow = (node: FigmaNode, depth: number): FigmaNode => (depth <= 0 ? {...node, children: undefined} : {...node, children: node.children?.map(child => shallow(child, depth - 1))});
  const calls = {file: [] as number[], nodes: 0};
  const client: RunDeps['client'] = {
    async file(_key, depth) {
      calls.file.push(depth ?? 0);
      if (!depth) {
        if (whole > FIGMA_CAP) throw tooLarge();
        return structuredClone(file);
      }
      return {...file, document: {...file.document!, children: pages.map(page => shallow(page, depth - 1))}};
    },
    async nodes(_key, ids) {
      calls.nodes++;
      const bytes = ids.reduce((sum, id) => sum + (sizes.get(id) ?? 1000), 0);
      if (bytes > FIGMA_CAP) throw tooLarge();
      // As Figma answers: each node with the components its subtree shows or holds, and their sets.
      const answer = (id: string) => {
        const document = structuredClone(byId.get(id)!);
        const components: NonNullable<FigmaFile['components']> = {};
        const componentSets: NonNullable<FigmaFile['componentSets']> = {};
        const stack = [document];
        while (stack.length) {
          const node = stack.pop()!;
          for (const ref of [node.type === 'COMPONENT' ? node.id : undefined, node.componentId])
            if (ref && file.components?.[ref]) {
              components[ref] = file.components[ref]!;
              const set = file.components[ref]!.componentSetId;
              if (set && file.componentSets?.[set]) componentSets[set] = file.componentSets[set]!;
            }
          stack.push(...(node.children ?? []));
        }
        return {document, components, componentSets};
      };
      return {nodes: Object.fromEntries(ids.filter(id => byId.has(id)).map(id => [id, answer(id)]))};
    },
    async imageFills() {
      return pictures;
    },
  };
  return {client, calls};
}

async function importKit(t: test.TestContext, c: Awaited<ReturnType<typeof collabApp>>, source: 'link' | 'fig') {
  const owner = await c.account(source, 'Anna');
  const sharp = (await import('sharp')).default;
  const png = await sharp({create: {width: 1600, height: 1200, channels: 3, background: '#4a7'}}).png().toBuffer();
  const kit = figmaKit({...NUXT_LIKE, pages: PAGES, borrow: true, pictures: 12});
  const fig = source === 'fig' ? figKit({...NUXT_LIKE, pages: PAGES, borrow: true, pictures: 12}) : null;
  const layers = fig ? fig.layers : [...kit.layersByPage.values()].reduce((a, b) => a + b, 0);
  const pictures = Object.fromEntries(Array.from({length: 12}, (_, k) => ['a'.repeat(39) + k.toString(16), `https://figma.example/img/${k}`]));
  const figma = fakeFigma(kit.file, pictures);

  const request = async (who: Account, url: string, init: RequestInit = {}) => {
    const response = await fetch(c.base + url, {...init, headers: {cookie: c.cookie(who), ...(init.headers as Record<string, string>)}});
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${response.status}`), {status: response.status, details: data});
    return data;
  };
  const calls: Pick<RunDeps, PageCall> = {
    createFile: data => request(owner, '/api/design-files', {method: 'POST', body: JSON.stringify(data), headers: {'content-type': 'application/json'}}),
    uploadImage: (fileId, picture, name) => {
      const form = new FormData();
      form.append('file', picture, name + '.png');
      return request(owner, `/api/design-files/${fileId}/images`, {method: 'POST', body: form});
    },
    replaceDocument: (fileId, baseVersion, document) =>
      request(owner, `/api/design-files/${fileId}/document`, {method: 'PUT', body: new Blob([JSON.stringify({baseVersion, document})]), headers: {'content-type': 'application/json'}}),
    patchDocument: (fileId, body) => request(owner, `/api/design-files/${fileId}/document`, {method: 'PATCH', body, headers: {'content-type': 'application/json'}}),
    eraseFile: fileId => request(owner, `/api/design-files/${fileId}?permanent=1`, {method: 'DELETE'}),
  };
  const quiet = {sleep: async () => undefined, yieldToUi: async () => undefined};
  const deps: RunDeps = {client: figma.client, download: async () => new Blob([new Uint8Array(png)], {type: 'image/png'}), shrink: async () => null, ...calls, ...quiet};

  // Phases and the process's peak memory (the server runs in this process too: the peak is both sides').
  const phases: string[] = [];
  let peak = process.memoryUsage().rss,
    last = performance.now(),
    stage = 'start';
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
  t.after(() => clearInterval(sampler));
  const onStage = (next: ImportStage) => {
    if (next.stage === stage) return;
    phases.push(`${stage} ${Math.round(performance.now() - last)} ms`);
    stage = next.stage;
    last = performance.now();
  };
  const started = performance.now();
  let read: FigmaRead;
  let runDeps = deps;
  if (fig) {
    const zip = fig.zip;
    const held = await readSource({kind: 'fig', fileKey: 'fig:kit', file: new Blob([zip as Uint8Array<ArrayBuffer>]), fileName: 'Nuxt UI.fig'}, calls, undefined, onStage);
    read = held.read;
    runDeps = {...depsFor(held, null, calls), ...quiet};
    assert.ok(read.whole);
  } else {
    read = await readFigmaFile('KIT', deps, undefined, onStage);
    assert.equal(read.whole, JSON.stringify(kit.file).length <= FIGMA_CAP, 'read whole only when Figma would answer whole');
  }
  const outcome = await runFigmaImport(read, read.pages.map(page => page.id), runDeps, undefined, onStage);
  onStage({stage: 'save'} as ImportStage);
  phases.push(`${stage} ${Math.round(performance.now() - last)} ms`);
  const importMs = performance.now() - started;
  assert.deepEqual(outcome.report.items.filter(item => item.group === 'limits').map(item => item.key), [], 'nothing left out under the big-files caps');
  assert.equal(outcome.imagesCopied, 12);

  // Opened as the editor opens a big file: the skeleton, then a page.
  const openStarted = performance.now();
  // `always`: the skeleton even when the file is under the fixed caps (the gate's small kit), as a big one opens.
  const skeleton = await request(owner, `/api/design-files/${outcome.fileId}?pages=skeleton&always=1`);
  const counts = skeleton.partial?.layers as Record<string, number> | undefined;
  const firstPage = skeleton.document.pages[1] as string;
  const page = await request(owner, `/api/design-files/${outcome.fileId}/pages/${encodeURIComponent(firstPage)}`);
  const openMs = performance.now() - openStarted;
  const stored = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : Object.keys(page.nodes).length;
  assert.ok(stored >= layers * 0.95, `layers stored ${stored} of ${layers}`);
  assert.ok(Object.keys(page.nodes).length > 100);
  if (REPORT)
    console.log(
      JSON.stringify({
        source,
        layers,
        pages: PAGES + 1,
        whole: read.whole,
        figmaCalls: {file: figma.calls.file, nodes: figma.calls.nodes},
        importS: +(importMs / 1000).toFixed(1),
        phases,
        openS: +(openMs / 1000).toFixed(1),
        peakRssMiB: Math.round(peak / 1048576),
        load: os.loadavg().map(value => value.toFixed(2)).join(' '),
      }),
    );
}

test('Stage G: a Nuxt-UI-shaped kit imports with big files on and opens', {timeout: 7_200_000}, async t => {
  const c = await collabApp(t, {env: {DESIGN_BIG_FILES: '1'}});
  const {setBigFiles} = await import('../shared/design/big-files');
  setBigFiles(true);
  t.after(() => setBigFiles(null));
  const only = process.env.MORFA_IMPORT_SOURCE;
  if (only !== 'fig') await t.test('from a Figma link', sub => importKit(sub, c, 'link'));
  if (only !== 'link') await t.test('from the same kit saved as a .fig', sub => importKit(sub, c, 'fig'));
});
