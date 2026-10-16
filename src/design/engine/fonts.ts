import type {FontFamily} from '../../../shared/fonts';
import {fontFamilies} from '../../../shared/fonts';
import type {FontSpec, TextMeasurer} from '../../../shared/design/text-layout';
import {textFonts} from '../../../shared/design/text-engine';
import type {FontFamilyInfo, FontRegistry} from './contracts';
import type {Ctx2D} from './render/canvas';
import {context2d, createCanvas} from './render/canvas';
import {whenDesktopFonts} from '../../desktop/host';

// Fonts of design files (docs/design-tool.md §Client engine): the families of the site builder's
// catalogue (shared/fonts.ts, shared/font-library.ts), all with Cyrillic, under the names designers
// know ("Inter", "Roboto", "Montserrat"), plus the user's local fonts when the browser lets us list
// them. Faces load on demand from /fonts/<dir>/… with FontFace; until a face arrives canvas draws
// the family's fallback stack, and when it arrives the measurer's revision changes so every layout
// is measured again, and `onLoad` tells the renderer to repaint the text that uses it.
//
// Faces are registered under a private name ("dz Inter") so a font the visitor has installed, or
// a face the app's own CSS declares, never stands in for the file the design was made with.

/** Same ranges as the site fonts (shared/fonts.ts): each family ships a Cyrillic and a Latin file. */
const SUBSETS = [
  ['cyrillic', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  ['latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
] as const;

export const internalFamily = (family: string) => `dz ${family}`;
/** One collator for sorting family names (the order of `localeCompare(…, 'en')`). */
const BY_FAMILY = new Intl.Collator('en');
const quote = (name: string) => `"${name.replace(/["\\]/g, '\\$&')}"`;

/** The face CSS font matching picks for `desired` among `available` weights (CSS Fonts 4 §5.2). */
export function nearestWeight(available: readonly number[], desired: number): number {
  if (!available.length) return desired;
  const sorted = [...new Set(available)].sort((a, b) => a - b);
  if (sorted.includes(desired)) return desired;
  const below = sorted.filter(w => w < desired).reverse(), above = sorted.filter(w => w > desired);
  if (desired >= 400 && desired <= 500) {
    const upTo500 = above.filter(w => w <= 500);
    if (upTo500.length) return upTo500[0];
    if (below.length) return below[0];
    return above[0];
  }
  if (desired < 400) return below.length ? below[0] : above[0];
  return above.length ? above[0] : below[0];
}

/** Catalogue families once each, by name. */
export function catalogueFamilies(): FontFamily[] {
  const seen = new Map<string, FontFamily>();
  for (const font of Object.values(fontFamilies)) if (!seen.has(font.family)) seen.set(font.family, font);
  return [...seen.values()];
}

/** Weights a designer can pick: every hundred a variable family spans, or the static files. */
export function familyWeights(font: FontFamily): number[] {
  if (font.files) {
    const weights = new Set<number>();
    for (const file of font.files) {
      const [from, to = from] = String(file.weight).split(/\s+/).map(Number);
      for (let w = Math.ceil(from / 100) * 100; w <= to; w += 100) weights.add(w);
      weights.add(from);
    }
    return [...weights].filter(w => w >= 1 && w <= 1000).sort((a, b) => a - b);
  }
  if (!font.variable) return [...font.weights].sort((a, b) => a - b);
  const [min, max] = font.weights;
  const out: number[] = [];
  for (let w = Math.ceil(min / 100) * 100; w <= max; w += 100) out.push(w);
  if (!out.includes(min)) out.unshift(min);
  if (!out.includes(max)) out.push(max);
  return out;
}

export const familyHasItalic = (font: FontFamily) => !!font.files?.some(file => file.style === 'italic');

export type FaceSource = {url: string; weight: string; style: 'normal' | 'italic'; unicodeRange?: string};

/** The files to load so `weight`/`italic` draws with the family's own face. Italic falls back to the
 *  upright files (the browser slants them) where the family has no italic. `key` names the load. */
export function faceSources(font: FontFamily, weight: number, italic: boolean, base = '/fonts'): {key: string; faces: FaceSource[]} {
  if (font.files) {
    const styled = font.files.filter(file => (file.style === 'italic') === italic);
    const files = styled.length ? styled : font.files.filter(file => file.style !== 'italic');
    const style = styled.length && italic ? 'italic' : 'normal';
    const range = (file: (typeof files)[number]) => String(file.weight).split(/\s+/).map(Number);
    const covering = files.filter(file => {
      const [from, to = from] = range(file);
      return weight >= from && weight <= to;
    });
    const chosen = covering.length ? covering : (() => {
      const best = nearestWeight(files.map(file => range(file)[0]), weight);
      return files.filter(file => range(file)[0] === best);
    })();
    const label = chosen.map(file => file.weight).join('+');
    return {
      key: `${font.family}|${label}|${style}`,
      faces: chosen.map(file => ({url: `${base}/${font.dir}/${file.name}`, weight: String(file.weight), style, unicodeRange: file.unicodeRange})),
    };
  }
  if (font.variable) {
    const [min, max] = font.weights;
    return {
      key: `${font.family}|var|normal`,
      faces: SUBSETS.map(([subset, unicodeRange]) => ({url: `${base}/${font.dir}/${font.dir}-${subset}-wght-normal.woff2`, weight: `${min} ${max}`, style: 'normal' as const, unicodeRange})),
    };
  }
  const w = nearestWeight(font.weights, weight);
  return {
    key: `${font.family}|${w}|normal`,
    faces: SUBSETS.map(([subset, unicodeRange]) => ({url: `${base}/${font.dir}/${font.dir}-${subset}-${w}-normal.woff2`, weight: String(w), style: 'normal' as const, unicodeRange})),
  };
}

/** Weight and slant from a local font's style name ("Semibold Italic", "Black", "Regular"). */
export function parseLocalStyle(style: string): {weight: number; italic: boolean} {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  const italic = /italic|oblique|kursiv/.test(s);
  const table: [RegExp, number][] = [
    [/hairline|thin/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/bold/, 700], [/medium/, 500], [/regular|normal|book|roman|plain/, 400],
  ];
  for (const [pattern, weight] of table) if (pattern.test(s)) return {weight, italic};
  return {weight: 400, italic};
}

/** `read`: the face's file, in the desktop app (src/desktop/fonts.ts); without it the face draws through `local()`. */
type LocalFace = {postscriptName: string; weight: number; italic: boolean; read?: () => Promise<ArrayBuffer>};
type LocalFontData = {family: string; fullName: string; postscriptName: string; style: string; morfaBytes?: () => Promise<ArrayBuffer>};

export interface DesignFontRegistry extends FontRegistry {
  readonly measurer: TextMeasurer & {readonly revision: number};
  /** Asks to list the user's installed fonts (must run in a user gesture; Chromium only). Resolves
   *  to false when the browser cannot or the user declines. */
  requestLocalFonts(): Promise<boolean>;
  /** Resolves when every face started so far has loaded or failed. */
  whenIdle(): Promise<void>;
}

export type FontRegistryOptions = {
  /** URL prefix of the fonts root (default /fonts). */
  base?: string;
  fontSet?: FontFaceSet;
};

type Load = {state: 'loading' | 'loaded' | 'failed'; promise: Promise<void>};

export function createFontRegistry(options: FontRegistryOptions = {}): DesignFontRegistry {
  const base = options.base ?? '/fonts';
  const fontSet = options.fontSet ?? (typeof document !== 'undefined' ? document.fonts : (globalThis as {fonts?: FontFaceSet}).fonts);
  const catalogue = new Map(catalogueFamilies().map(font => [font.family, font]));
  const local = new Map<string, LocalFace[]>();
  const loads = new Map<string, Load>();
  const listeners = new Set<(family: string) => void>();
  let revision = 0;
  let ctx: Ctx2D | null = null;
  let ctxFont = '';

  const fallbackOf = (family: string) => catalogue.get(family)?.fallback ?? 'Arial, sans-serif';

  function cssOf(spec: FontSpec): string {
    const weight = Math.round(Math.min(1000, Math.max(1, Number.isFinite(spec.weight) ? spec.weight : 400)));
    const size = spec.size > 0 && Number.isFinite(spec.size) ? spec.size : 1;
    return `${spec.italic ? 'italic ' : ''}${weight} ${size}px ${quote(internalFamily(spec.family))}, ${fallbackOf(spec.family)}`;
  }

  type Sources = {key: string; faces: FaceSource[]; local?: LocalFace} | null;
  function sourcesOf(spec: FontSpec): Sources {
    const font = catalogue.get(spec.family);
    if (font) return faceSources(font, spec.weight, spec.italic, base);
    const faces = local.get(spec.family);
    if (!faces?.length) return null;
    const styled = faces.filter(face => face.italic === spec.italic);
    const pool = styled.length ? styled : faces;
    const weight = nearestWeight(pool.map(face => face.weight), spec.weight);
    const face = pool.find(f => f.weight === weight)!;
    return {key: `${spec.family}|local|${face.postscriptName}`, faces: [], local: face};
  }

  // Text layout measures thousands of times per frame with the same few FontSpec objects: their CSS
  // string and the files they need are worked out once per object (again after local fonts arrive).
  type SpecInfo = {css: string; sources: Sources; generation: number};
  const infos = new WeakMap<FontSpec, SpecInfo>();
  let localGeneration = 0;
  function infoOf(spec: FontSpec): SpecInfo {
    let info = infos.get(spec);
    if (!info || info.generation !== localGeneration) {
      info = {css: cssOf(spec), sources: sourcesOf(spec), generation: localGeneration};
      infos.set(spec, info);
    }
    return info;
  }
  const cssFont = (spec: FontSpec) => infoOf(spec).css;

  function ensure(spec: FontSpec): Promise<void> {
    const sources = infoOf(spec).sources;
    if (!sources || !fontSet || typeof FontFace === 'undefined') return Promise.resolve();
    const existing = loads.get(sources.key);
    if (existing) return existing.promise;
    const family = internalFamily(spec.family);
    const engine = textFonts();
    const descriptors = (face: FaceSource) => ({weight: face.weight, style: face.style, ...(face.unicodeRange ? {unicodeRange: face.unicodeRange} : {})});
    const localFace = sources.local;
    const loading: Promise<unknown>[] = localFace?.read
      ? // The desktop app hands over the face's file: the canvas and the text engine draw the same bytes.
        [localFace.read().then(bytes => {
          if (engine) engine.text_add_face(spec.family, localFace.weight, localFace.weight, localFace.italic, '', new Uint8Array(bytes));
          const loaded = new FontFace(family, bytes, {weight: String(localFace.weight), style: localFace.italic ? 'italic' : 'normal'});
          fontSet.add(loaded);
          return loaded.load();
        })]
      : localFace
      ? [new FontFace(family, `local(${quote(localFace.postscriptName)})`, {weight: String(localFace.weight), style: localFace.italic ? 'italic' : 'normal'})].map(face => {
          fontSet.add(face);
          return face.load();
        })
      : engine
        ? // The text engine shapes with the same bytes: one download feeds the canvas face and the Rust store.
          sources.faces.map(async face => {
            const bytes = await (await fetch(face.url)).arrayBuffer();
            const [min, max = min] = face.weight.split(/\s+/).map(Number);
            engine.text_add_face(spec.family, min, max, face.style === 'italic', face.unicodeRange ?? '', new Uint8Array(bytes));
            const loaded = new FontFace(family, bytes, descriptors(face));
            fontSet.add(loaded);
            return loaded.load();
          })
        : sources.faces.map(face => {
            const loaded = new FontFace(family, `url(${quote(face.url)}) format("woff2")`, descriptors(face));
            fontSet.add(loaded);
            return loaded.load();
          });
    const load: Load = {state: 'loading', promise: Promise.resolve()};
    load.promise = Promise.all(loading).then(
      () => {
        load.state = 'loaded';
      },
      () => {
        load.state = 'failed';
      },
    ).then(() => {
      // Widths measured with the fallback are stale now: a new revision drops every cached layout.
      revision++;
      ctxFont = '';
      for (const listener of [...listeners]) listener(spec.family);
    });
    loads.set(sources.key, load);
    return load.promise;
  }

  function isLoaded(spec: FontSpec): boolean {
    const sources = infoOf(spec).sources;
    if (!sources) return true;
    const state = loads.get(sources.key)?.state;
    return state === 'loaded' || state === 'failed';
  }

  function context(): Ctx2D {
    if (!ctx) {
      ctx = context2d(createCanvas(8, 8));
      if ('textRendering' in ctx) (ctx as CanvasRenderingContext2D).textRendering = 'geometricPrecision';
    }
    return ctx;
  }

  function setFont(spec: FontSpec): Ctx2D {
    const c = context();
    const info = infoOf(spec);
    if (info.css !== ctxFont) {
      c.font = ctxFont = info.css;
      if (!isLoaded(spec)) void ensure(spec);
    }
    return c;
  }

  const measurer = {
    get revision() {
      return revision;
    },
    width(text: string, font: FontSpec): number {
      if (!text) return 0;
      return setFont(font).measureText(text).width;
    },
    metrics(font: FontSpec): {ascent: number; descent: number} {
      const m = setFont(font).measureText('Hg');
      const size = font.size > 0 ? font.size : 0;
      const ascent = m.fontBoundingBoxAscent, descent = m.fontBoundingBoxDescent;
      return {
        ascent: Number.isFinite(ascent) && ascent > 0 ? ascent : size * 0.905,
        descent: Number.isFinite(descent) && descent >= 0 ? descent : size * 0.212,
      };
    },
  };

  const registry: DesignFontRegistry = {
    measurer,
    ensure,
    isLoaded,
    cssFont,
    families(): FontFamilyInfo[] {
      const out: FontFamilyInfo[] = [...catalogue.values()].map(font => ({family: font.family, weights: familyWeights(font), italic: familyHasItalic(font), source: 'catalog', kind: font.kind}));
      for (const [family, faces] of local) {
        if (catalogue.has(family)) continue;
        out.push({family, weights: [...new Set(faces.map(face => face.weight))].sort((a, b) => a - b), italic: faces.some(face => face.italic), source: 'local'});
      }
      return out.sort((a, b) => BY_FAMILY.compare(a.family, b.family));
    },
    onLoad(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async requestLocalFonts() {
      const query = (globalThis as {queryLocalFonts?: () => Promise<LocalFontData[]>}).queryLocalFonts;
      if (typeof query !== 'function') return false;
      try {
        const fonts = await query();
        const added = new Set<string>();
        for (const data of fonts) {
          if (!data.family || !data.postscriptName) continue;
          const {weight, italic} = parseLocalStyle(data.style || data.fullName);
          const faces = local.get(data.family) ?? [];
          if (!faces.some(face => face.postscriptName === data.postscriptName)) {
            faces.push({postscriptName: data.postscriptName, weight, italic, ...(typeof data.morfaBytes === 'function' ? {read: data.morfaBytes} : {})});
            added.add(data.family);
          }
          local.set(data.family, faces);
          localGeneration++;
        }
        if (added.size) {
          // Text set in a font that only now became known was measured with the fallback: lay it out again.
          revision++;
          ctxFont = '';
          for (const family of added) if (!catalogue.has(family)) for (const listener of [...listeners]) listener(family);
        }
        return fonts.length > 0;
      } catch {
        return false;
      }
    },
    async whenIdle() {
      await Promise.all([...loads.values()].map(load => load.promise));
    },
  };
  // The desktop app lists this computer's fonts without asking, like Figma's (src/desktop/host.ts); a browser never calls this.
  whenDesktopFonts(() => void registry.requestLocalFonts());
  return registry;
}
