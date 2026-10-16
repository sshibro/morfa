import type {DesignDocument, ImageRef, NodeId} from '../../../../shared/design/types';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {cssForLayers} from '../../../../shared/design/codegen/css';
import {exportSvg} from '../../../../shared/design/svg-export';
import {topLevelSelection} from '../../../../shared/design/tree';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import type {FontRegistry, ImageCache} from '../contracts';
import {exportRaster, ExportError} from '../export-raster';
import {catalogueFamilies} from '../fonts';
import {registerCommand, type Command, type CommandContext} from './registry';

// "Copy as" (CSS, SVG, PNG, text), "Export to React…" and "Export to Vue…" (docs/design-tool.md
// §Design to code). Text goes through the clipboard's text API; a PNG needs `ClipboardItem`, and when the
// browser refuses it the toast says so instead of pretending. The helpers below (fetching pictures,
// saving files) are shared with the "Code" tab and the export dialog.

export type CodeCommandDeps = {
  fonts: FontRegistry;
  images: ImageCache;
  toast(message: string, kind?: 'success' | 'error'): void;
  openDialog(id: string, params?: Record<string, unknown>): void;
  /** Defaults to navigator.clipboard (tests pass their own). */
  clipboard?: Pick<Clipboard, 'writeText'> & Partial<Pick<Clipboard, 'write'>>;
};

/** The dialog id `openDialog` receives for "Export to React…". */
export const REACT_EXPORT_DIALOG = 'react-export';
/** The dialog id `openDialog` receives for "Export to Vue…" (the same dialog, writing a Vue project). */
export const VUE_EXPORT_DIALOG = 'vue-export';

export const CODE_COMMAND_IDS = ['edit.copy-text', 'edit.copy-css', 'edit.copy-svg', 'edit.copy-png', 'file.export-react', 'file.export-vue'] as const;

// ── Shared browser helpers ─────────────────────────────────────────────────────────────────────

let fallbacks: Map<string, string> | null = null;

/** The catalogue's fallback stack for a family ("Arial, sans-serif"), for generated CSS. */
export function fontFallback(family: string): string | undefined {
  fallbacks ??= new Map(catalogueFamilies().map(font => [font.family, font.fallback]));
  return fallbacks.get(family);
}

/** Saves a blob as a file through a temporary link. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Bytes of the file's pictures (same-origin /uploads with the session cookie), a few at a time.
 *  Missing or refused pictures are listed instead of failing the whole export. */
export async function fetchPictures(urls: ReadonlyMap<string, string>, concurrency = 4): Promise<{bytes: Map<string, Uint8Array>; failed: string[]}> {
  const bytes = new Map<string, Uint8Array>();
  const failed: string[] = [];
  const queue = [...urls];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, url] = next;
      try {
        if (!/^(\/(?!\/)|blob:|data:image\/)/.test(url)) throw new Error('not same-origin');
        const response = await fetch(url, {credentials: 'same-origin'});
        if (!response.ok) throw new Error(String(response.status));
        bytes.set(key, new Uint8Array(await response.arrayBuffer()));
      } catch {
        failed.push(key);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, queue.length)}, worker));
  return {bytes, failed};
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** data: URLs of the pictures used under `ids`, for an SVG that carries its images. */
export async function pictureData(doc: DesignDocument, ids: readonly NodeId[]): Promise<Map<ImageRef, string>> {
  const refs = new Set<ImageRef>();
  const stack = [...ids];
  for (let visited = 0; stack.length && visited < 20_000; visited++) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    for (const paint of node.fills) if (paint.type === 'IMAGE' && paint.imageRef) refs.add(paint.imageRef);
    if (node.children) stack.push(...node.children);
  }
  const urls = new Map([...refs].map(ref => [ref, doc.images[ref]?.url ?? ''] as const).filter(([, url]) => !!url));
  const {bytes} = await fetchPictures(urls);
  const out = new Map<ImageRef, string>();
  for (const [ref, data] of bytes) {
    const url = doc.images[ref]?.url ?? '';
    const type = /\.png(\?|$)/i.test(url) ? 'image/png' : /\.gif(\?|$)/i.test(url) ? 'image/gif' : /\.jpe?g(\?|$)/i.test(url) ? 'image/jpeg' : 'image/webp';
    out.set(ref, await blobToDataUrl(new Blob([data as Uint8Array<ArrayBuffer>], {type})));
  }
  return out;
}

/** Text of the text layers in the selection, in reading order: inside each container top to bottom,
 *  then left to right, by where the layers sit (the children list is paint order, not reading order). */
export function selectionText(doc: DesignDocument, ids: readonly NodeId[]): string {
  const texts: string[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node || node.visible === false || depth > 256) return;
    if (node.type === 'TEXT' && node.text) texts.push(node.text.characters);
    const children = (node.children ?? []).map(child => doc.nodes[child]).filter(Boolean);
    children.sort((a, b) => (Math.abs(a.y - b.y) > 0.5 ? a.y - b.y : a.x - b.x));
    for (const child of children) visit(child.id, depth + 1);
  };
  for (const id of ids) visit(id, 0);
  return texts.join('\n');
}

const hasTextInside = (doc: DesignDocument, ids: readonly NodeId[]) => selectionText(doc, ids).length > 0;

async function writeText(deps: CodeCommandDeps, ctx: CommandContext, text: string): Promise<boolean> {
  try {
    const clipboard = deps.clipboard ?? ctx.clipboard ?? globalThis.navigator?.clipboard;
    if (!clipboard) throw new Error('no clipboard');
    await clipboard.writeText(text);
    return true;
  } catch {
    deps.toast('The browser did not grant access to the clipboard. Allow it for this site and try again.', 'error');
    return false;
  }
}

const selected = (ctx: CommandContext) => {
  const {doc, selection} = ctx.store.getState();
  return topLevelSelection(doc, selection);
};

// ── Commands ───────────────────────────────────────────────────────────────────────────────────

export function codeCommands(deps: CodeCommandDeps): Command[] {
  const hasSelection = (ctx: CommandContext) => ctx.store.getState().selection.length > 0;
  return [
    {
      id: 'edit.copy-text',
      label: 'Copy as text',
      group: 'edit',
      enabled: ctx => hasTextInside(ctx.store.getState().doc, selected(ctx)),
      run: async ctx => {
        const text = selectionText(ctx.store.getState().doc, selected(ctx));
        if (text && await writeText(deps, ctx, text)) deps.toast('Text copied');
      },
    },
    {
      id: 'edit.copy-css',
      label: 'Copy as CSS',
      group: 'edit',
      enabled: hasSelection,
      run: async ctx => {
        const css = cssForLayers(ctx.store.getState().doc, selected(ctx), {fontFallback});
        if (css && await writeText(deps, ctx, css)) deps.toast('CSS copied');
      },
    },
    {
      id: 'edit.copy-svg',
      label: 'Copy as SVG',
      group: 'edit',
      enabled: hasSelection,
      run: async ctx => {
        // The command's own document: it spans awaits (pictures), and the store's table may be written in place meanwhile.
        const doc = snapshotDocument(ctx.store.getState().doc);
        const ids = selected(ctx);
        const pictures = await pictureData(doc, ids);
        const svg = exportSvg(doc, ids, {measurer: ctx.store.measurer, imageData: ref => pictures.get(ref)});
        if (await writeText(deps, ctx, svg)) deps.toast('SVG copied');
      },
    },
    {
      id: 'edit.copy-png',
      label: 'Copy as PNG',
      group: 'edit',
      shortcut: {code: 'KeyC', mod: true, shift: true},
      enabled: hasSelection,
      run: async ctx => {
        const doc = snapshotDocument(ctx.store.getState().doc);
        const ids = selected(ctx);
        const clipboard = deps.clipboard ?? globalThis.navigator?.clipboard;
        const Item = (globalThis as {ClipboardItem?: typeof ClipboardItem}).ClipboardItem;
        if (!clipboard?.write || !Item) {
          deps.toast('This browser cannot put images on the clipboard. Save the PNG via "Export".', 'error');
          return;
        }
        // The blob is handed over as a promise, so Safari still counts the click as the user's gesture.
        const png = exportRaster(doc, ids, {format: 'PNG', constraint: {type: 'SCALE', value: 2}}, {images: deps.images, fonts: deps.fonts, booleanGeometry});
        try {
          await clipboard.write([new Item({'image/png': png})]);
          deps.toast('PNG copied');
        } catch {
          const exported = await png.then(() => null, (reason: unknown) => reason);
          deps.toast(exported instanceof ExportError ? exported.message : 'The browser did not allow writing the image to the clipboard. Save the PNG via "Export".', 'error');
        }
      },
    },
    {
      id: 'file.export-react',
      label: 'Export to React…',
      group: 'file',
      run: ctx => deps.openDialog(REACT_EXPORT_DIALOG, {ids: [...ctx.store.getState().selection], pageId: ctx.store.getState().pageId}),
    },
    {
      id: 'file.export-vue',
      label: 'Export to Vue…',
      group: 'file',
      run: ctx => deps.openDialog(VUE_EXPORT_DIALOG, {ids: [...ctx.store.getState().selection], pageId: ctx.store.getState().pageId}),
    },
  ];
}

/** Registers the commands; returns the undo of the registration (call it when the editor closes). */
export function registerCodeCommands(deps: CodeCommandDeps): () => void {
  const undo = codeCommands(deps).map(registerCommand);
  return () => undo.forEach(fn => fn());
}
