import type {DesignDocument, NodeId} from '../../../shared/design/types';
import {worldBox, unionRects, type Rect} from '../../../shared/design/geometry';
import {pageBackground} from '../../../shared/design/defaults';
import {DESIGN_TEMPLATES, type BuildOptions, type DesignTemplate, type TemplateId} from '../../../shared/design/templates';
import {createFontRegistry, type DesignFontRegistry} from '../engine/fonts';
import {createImageCache} from '../engine/images';
import {paintNodeTree} from '../engine/render';

// The heavy half of "New file ▾", loaded when the gallery first opens: the template builders, a font
// registry to measure them with real type, and the painter for their cards. Building waits for the
// template's faces (at most a moment), so a new file opens already laid out in its own fonts.

export {DESIGN_TEMPLATES, type DesignTemplate, type TemplateId};

let fonts: DesignFontRegistry | null = null;
const registry = () => (fonts ??= createFontRegistry());
const images = createImageCache();

const FONT_WAIT_MS = 2500;

/** Loads the template's faces; resolves when they are usable or after a short wait (then fallbacks measure). */
export async function loadTemplateFonts(template: DesignTemplate): Promise<void> {
  const registryNow = registry();
  const loads = template.fonts.flatMap(font => font.weights.map(weight => registryNow.ensure({family: font.family, weight, italic: false, size: 16}).catch(() => undefined)));
  if (!loads.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(loads), new Promise(resolve => {timer = setTimeout(resolve, FONT_WAIT_MS);})]);
  clearTimeout(timer);
}

/** A fresh document of the template (new ids every time), measured with the loaded fonts. `options`: the template's own choices
 *  (the marketplace card's marketplace and set). */
export async function buildTemplate(id: TemplateId, options: Omit<BuildOptions, 'measurer' | 'newId'> = {}): Promise<DesignDocument> {
  const template = DESIGN_TEMPLATES.find(entry => entry.id === id);
  if (!template) throw new Error('There is no such template.');
  await loadTemplateFonts(template);
  return template.build({...options, measurer: registry().measurer});
}

/** What a card shows of a template: the first page's first `count` layers (all by default), fitted, or from
 *  the top-left corner showing `crop` of their width. */
const FRAMING: Record<TemplateId, {count?: number; crop?: number; pad: number}> = {
  blank: {pad: 0},
  mobile: {count: 3, pad: 0.07},
  site: {count: 1, crop: 1, pad: 0},
  presentation: {count: 1, pad: 0.08},
  social: {pad: 0.07},
  'ui-kit': {count: 1, crop: 0.56, pad: 0},
  marketplace: {count: 1, pad: 0.08},
};

/** Paints a template's card picture into `canvas` (its pixel size is the caller's). */
export function paintTemplateCard(canvas: HTMLCanvasElement, id: TemplateId, doc: DesignDocument): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const page = doc.nodes[doc.pages[0]];
  const background = pageBackground(page);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgb(${Math.round(background.r * 255)} ${Math.round(background.g * 255)} ${Math.round(background.b * 255)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const framing = FRAMING[id];
  const all: NodeId[] = (page?.children ?? []).filter(child => doc.nodes[child]?.visible);
  const ids = framing.count ? all.slice(0, framing.count) : all;
  const bounds: Rect | null = unionRects(ids.map(child => worldBox(doc, child)));
  if (!bounds || !ids.length) return;
  const padX = canvas.width * framing.pad, padY = canvas.height * framing.pad;
  const room = {width: canvas.width - padX * 2, height: canvas.height - padY * 2};
  let scale: number, x: number, y: number;
  if (framing.crop) {
    scale = room.width / (bounds.width * framing.crop);
    x = padX - bounds.x * scale;
    y = padY - bounds.y * scale;
  } else {
    scale = Math.min(room.width / bounds.width, room.height / bounds.height);
    x = (canvas.width - bounds.width * scale) / 2 - bounds.x * scale;
    y = (canvas.height - bounds.height * scale) / 2 - bounds.y * scale;
  }
  paintNodeTree({ctx, transform: [[scale, 0, x], [0, scale, y]], scale}, doc, ids, {images, fonts: registry(), clip: {x: 0, y: 0, width: canvas.width, height: canvas.height}});
}
