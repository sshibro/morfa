import type {BlendMode, ColorStop, DesignDocument, Effect, GradientPaint, ImagePaint, ImageRef, Matrix, NodeId, Paint, RGB, SceneNode, ShadowEffect, TextCase, TextStyle, VectorPath} from './types';
import {layoutText, type TextMeasurer} from './text-layout';
import {IDENTITY, apply, invert, localMatrix, multiply, scaling, transformRect, translation, unionRects, worldMatrix, type Rect} from './geometry';
import {formatNumber, isClosed, pathsBounds, serializePathData} from './paths';
import {cornerRadiiOf, nodeGeometry, resolveCornerRadii} from './shapes';
import {booleanGeometryExact} from './boolean';
import {outlineStroke} from './outline-stroke';
import {hasVariableWidth, maxWidthFactor, variableWidthOutline} from './stroke-profile';
import {textPathLayout} from './text-path';
import {lazyInputs, withEngine} from './engine-switch';
import {exportSvgPageWasm} from './export-wasm';

// SVG export of a node subtree ("Export" → SVG): geometry as rect/ellipse/path, every paint
// (gradients as SVG gradients with the node's handle frame as gradientTransform; diamond exactly
// as four linear quadrants; angular as a fan of solid wedges, SVG having no conic gradient),
// image fills as patterns with embedded data URLs, strokes by alignment (inside: a doubled stroke
// clipped to the shape; outside: a doubled stroke with the shape masked out), dashes, markers and
// per-side weights as outlined strokes, opacity and blend modes, effects as filters in Figma's
// own construction, masks, clipped frames and text laid out by text-layout.ts.
//
// Output is deterministic (definition ids count up in drawing order) and every value is escaped: layer names are
// written only as `id`s when `layerIds` asks for them (made unique and kept to letters, digits, "_", "-" and "."), and
// text and attributes go through one escaping writer.
//
// `print` is the flavour the server's vector PDF renders (server/design/pdf/, docs/design-tool.md §Export):
// what a PDF can hold stays vector there. Picture fills that do not tile are pictures clipped to the shape
// (a PDF keeps the picture's own pixels, where a pattern is re-rasterized), and drop and inner shadows are
// layers of their own drawn from a reference to the content (`<use>`), so only the shadows rasterize and the
// content, text included, stays vector. A layer blur still filters the whole layer, as in Figma's PDFs.

export type SvgExportOptions = {
  measurer: TextMeasurer;
  /** The data: URL of a stored picture; without it image fills export as a neutral grey. */
  imageData?: (ref: ImageRef) => string | undefined;
  /** An https: URL of a stored picture, when the renderer serves pictures itself (the PDF renderer). Read
   *  only when `imageData` gives nothing; anything but a plain https: URL is ignored. */
  imageHref?: (ref: ImageRef) => string | undefined;
  /** Text as the paths of its glyphs. Only the Rust exporter has glyph outlines (lane L5: crates/export with lane
   *  L3's fonts; the export module must be loaded and the text's fonts registered, shared/design/export-fonts.ts), so
   *  this flavour always runs in Rust, whatever the switch says; without the module it throws. */
  outlineText?: boolean;
  /** Decimals in coordinates (default 3). */
  precision?: number;
  /** Prefix of every definition id, so several exports can share one HTML page. */
  idPrefix?: string;
  /** Each layer's element carries the layer's name as its `id`, unique in the file (Figma's "Include "id" attribute"). */
  layerIds?: boolean;
  /** Vector PDF flavour (see above). */
  print?: boolean;
  /** Page-space rectangle the output shows instead of what the nodes paint (a slice). */
  crop?: Rect;
};

/** An SVG and the page-space rectangle it shows. */
export type SvgPage = {svg: string; bounds: Rect};

// ── A tiny element tree, escaped in one place ──────────────────────────────────────────────────

type Value = string | number | undefined | null;
type El = {tag: string; attrs: Record<string, Value>; children: (El | string)[]};
const el = (tag: string, attrs: Record<string, Value> = {}, children: (El | string)[] = []): El => ({tag, attrs, children});

// Characters XML 1.0 cannot carry at all (controls, lone surrogates, U+FFFE/F) are dropped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const escapeXmlText = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeXmlAttribute = (s: string) => escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

function write(node: El | string, f: (v: number) => string): string {
  if (typeof node === 'string') return escapeXmlText(node);
  let out = '<' + node.tag;
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value === undefined || value === null || value === '') continue;
    out += ` ${name}="${escapeXmlAttribute(typeof value === 'number' ? f(value) : value)}"`;
  }
  if (!node.children.length) return out + '/>';
  return out + '>' + node.children.map(c => write(c, f)).join('') + `</${node.tag}>`;
}

// ── Values ─────────────────────────────────────────────────────────────────────────────────────

const hex = (c: RGB) => '#' + [c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const BLEND_CSS: Partial<Record<BlendMode, string>> = {
  DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color-burn', LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color-dodge', OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light', HARD_LIGHT: 'hard-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
};
const blendStyle = (mode: BlendMode) => (BLEND_CSS[mode] ? `mix-blend-mode:${BLEND_CSS[mode]}` : undefined);
const CAP = {NONE: 'butt', ROUND: 'round', SQUARE: 'square'} as const;
const JOIN = {MITER: 'miter', BEVEL: 'bevel', ROUND: 'round'} as const;
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i;
const SAFE_HREF = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]*$/;
const SAFE_ID_PREFIX = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

function sampleStops(stops: readonly ColorStop[], t: number): {color: RGB; a: number} {
  if (!stops.length) return {color: {r: 0, g: 0, b: 0}, a: 0};
  if (t <= stops[0].position) return {color: stops[0].color, a: stops[0].color.a};
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1], b = stops[k];
    if (t <= b.position) {
      const s = b.position > a.position ? (t - a.position) / (b.position - a.position) : 1;
      const mix = (x: number, y: number) => x + (y - x) * s;
      return {color: {r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b)}, a: mix(a.color.a, b.color.a)};
    }
  }
  const last = stops[stops.length - 1];
  return {color: last.color, a: last.color.a};
}

function applyCase(text: string, textCase: TextCase | undefined): string {
  switch (textCase) {
    case 'UPPER': return text.toLocaleUpperCase('en');
    case 'LOWER': return text.toLocaleLowerCase('en');
    case 'TITLE': return text.replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toLocaleUpperCase('en'));
    default: return text;
  }
}

/** A text hyperlink as the PDF's link: http(s) and mailto only, as the editor opens them (schema.ts `isSafeDesignUrl`). */
function linkHref(url: string): string | undefined {
  if (typeof url !== 'string' || url.length > 2_048) return undefined;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A font-family value: quoted unless every word is a CSS identifier ("Exo 2" must be quoted: an
 *  unquoted word may not start with a digit, and an invalid value would draw the fallback face). */
const familyValue = (family: string) => (/^[A-Za-z_][\w-]*(?: [A-Za-z_][\w-]*)*$/.test(family) ? family : `'${family.replace(/['\\]/g, '')}'`) + ', sans-serif';

// ── The exporter ───────────────────────────────────────────────────────────────────────────────

/** Geometry as drawable elements (one per path), each with a clone for every use. */
type Shape = {elements: El[]; closed: boolean; bounds: Rect | null; paths: VectorPath[]};

class Exporter {
  private readonly defs: El[] = [];
  private readonly counters = new Map<string, number>();
  /** Every id written, definitions' and layers', so none repeats. */
  private readonly taken = new Set<string>();
  readonly f: (v: number) => string;
  private readonly precision: number;

  constructor(private readonly doc: DesignDocument, private readonly options: SvgExportOptions) {
    const precision = this.precision = options.precision ?? 3;
    this.f = v => formatNumber(v, precision);
  }

  private id(prefix: string): string {
    const page = this.options.idPrefix && SAFE_ID_PREFIX.test(this.options.idPrefix) ? this.options.idPrefix : '';
    let id: string;
    do {
      const n = this.counters.get(prefix) ?? 0;
      this.counters.set(prefix, n + 1);
      id = `${page}${prefix}${n}`;
    } while (this.taken.has(id));
    this.taken.add(id);
    return id;
  }

  /** The layer's name as an id (`layerIds`): spaces as "_", only letters, digits, "_", "-" and ".", not starting with a
   *  digit, "-" or ".", at most 64 characters, "_2", "_3"… for repeats. */
  private layerId(node: SceneNode): string | undefined {
    if (!this.options.layerIds) return undefined;
    let base = [...node.name.normalize('NFC').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_.-]/gu, '')].slice(0, 64).join('');
    if (!base) base = 'layer';
    else if (!/^[\p{L}_]/u.test(base)) base = '_' + base;
    let id = base;
    for (let n = 2; this.taken.has(id); n++) id = `${base}_${n}`;
    this.taken.add(id);
    return id;
  }

  private def(element: El): string {
    this.defs.push(element);
    return element.attrs.id as string;
  }

  matrixValue(m: Matrix): string | undefined {
    const [[a, c, e], [b, d, f]] = m;
    if (a === 1 && b === 0 && c === 0 && d === 1) return e || f ? `translate(${this.f(e)} ${this.f(f)})` : undefined;
    // The linear part multiplies coordinates, so it keeps three more decimals than positions do.
    const fine = (v: number) => formatNumber(v, this.precision + 3);
    return `matrix(${[a, b, c, d].map(fine).join(' ')} ${this.f(e)} ${this.f(f)})`;
  }

  // Geometry ──────────────────────────────────────────────────────────────────────────────────

  private shapeOf(node: SceneNode): Shape | null {
    const w = node.width, h = node.height;
    if (FRAME_LIKE.has(node.type) || node.type === 'RECTANGLE') {
      const radii = resolveCornerRadii(w, h, cornerRadiiOf(node)).map(c => c.radius);
      const uniform = radii.every(r => Math.abs(r - radii[0]) < 1e-9);
      if (uniform && (!radii[0] || !node.cornerSmoothing)) {
        const rect = el('rect', {width: w, height: h, rx: radii[0] || undefined});
        return {elements: [rect], closed: true, bounds: {x: 0, y: 0, width: w, height: h}, paths: nodeGeometry(node)};
      }
    }
    if (node.type === 'ELLIPSE') {
      const arc = node.arcData;
      const sweep = arc ? Math.abs(arc.endingAngle - arc.startingAngle) : 2 * Math.PI;
      if (!arc || ((sweep >= 2 * Math.PI - 1e-6 || sweep < 1e-9) && !arc.innerRadius)) {
        const element = Math.abs(w - h) < 1e-9 ? el('circle', {cx: w / 2, cy: h / 2, r: w / 2}) : el('ellipse', {cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2});
        return {elements: [element], closed: true, bounds: {x: 0, y: 0, width: w, height: h}, paths: nodeGeometry(node)};
      }
    }
    const paths = node.type === 'BOOLEAN_OPERATION' ? booleanGeometryExact(this.doc, node.id) : nodeGeometry(node);
    return this.pathShape(paths);
  }

  private pathShape(paths: VectorPath[]): Shape | null {
    const drawn = paths.filter(p => p.commands.length);
    if (!drawn.length) return null;
    return {
      elements: drawn.map(p => el('path', {'fill-rule': p.windingRule === 'EVENODD' ? 'evenodd' : undefined, 'clip-rule': undefined, d: serializePathData(p.commands, this.options.precision ?? 3)})),
      closed: drawn.every(p => isClosed(p.commands)),
      bounds: pathsBounds(drawn),
      paths: drawn,
    };
  }

  private clone(element: El, attrs: Record<string, Value>): El {
    return {tag: element.tag, attrs: {...element.attrs, ...attrs}, children: element.children};
  }

  /** A clipPath of the shape (clip-rule taken from its fill rule). */
  private clipOf(shape: Shape): string {
    const id = this.id('clip');
    return this.def(el('clipPath', {id}, shape.elements.map(e => this.clone(e, {'clip-rule': e.attrs['fill-rule'], 'fill-rule': undefined}))));
  }

  // Paints ────────────────────────────────────────────────────────────────────────────────────

  /** The fill/stroke attribute value for a paint in a node box w×h, or null when it needs more
   *  than one element (angular, diamond) or is not drawable. */
  private paintValue(paint: Paint, w: number, h: number): string | null {
    if (paint.type === 'SOLID') return hex(paint.color);
    if (paint.type === 'IMAGE') return this.imagePattern(paint, w, h) ?? '#d9d9d9';
    if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') return this.gradient(paint, w, h);
    return null;
  }

  /** The gradient's handle frame in node pixels: origin H0, axes H1 − H0 and H2 − H0. */
  private handleFrame(paint: GradientPaint, w: number, h: number, linear: boolean): Matrix | null {
    const [p0, p1, p2] = paint.gradientHandlePositions.map(p => ({x: p.x * w, y: p.y * h}));
    const ax = {x: p1.x - p0.x, y: p1.y - p0.y};
    if (!Number.isFinite(ax.x) || !Number.isFinite(ax.y) || (!ax.x && !ax.y)) return null;
    // Linear gradients keep the width handle half an axis away, so its direction is doubled.
    let bx = {x: (p2.x - p0.x) * (linear ? 2 : 1), y: (p2.y - p0.y) * (linear ? 2 : 1)};
    if (Math.abs(ax.x * bx.y - ax.y * bx.x) < 1e-12) bx = {x: -ax.y, y: ax.x};
    return [[ax.x, bx.x, p0.x], [ax.y, bx.y, p0.y]];
  }

  private stops(paint: GradientPaint): El[] {
    return paint.gradientStops.map(s => el('stop', {offset: Math.max(0, Math.min(1, s.position)), 'stop-color': hex(s.color), 'stop-opacity': s.color.a < 1 ? s.color.a : undefined}));
  }

  private gradient(paint: GradientPaint, w: number, h: number): string | null {
    const linear = paint.type === 'GRADIENT_LINEAR';
    const frame = this.handleFrame(paint, w, h, linear);
    if (!frame || !paint.gradientStops.length) return null;
    const id = this.id(linear ? 'paint_linear' : 'paint_radial');
    const common = {id, gradientUnits: 'userSpaceOnUse', gradientTransform: this.matrixValue(frame)};
    const element = linear ? el('linearGradient', {...common, x1: 0, y1: 0, x2: 1, y2: 0}, this.stops(paint)) : el('radialGradient', {...common, cx: 0, cy: 0, r: 1}, this.stops(paint));
    return `url(#${this.def(element)})`;
  }

  /** The picture's source: an embedded data: URL, or an https: URL the renderer serves. */
  private imageSource(ref: ImageRef | undefined): string | null {
    if (!ref) return null;
    const data = this.options.imageData?.(ref);
    if (data) return SAFE_IMAGE.test(data) ? data : null;
    const href = this.options.imageHref?.(ref);
    return href && SAFE_HREF.test(href) ? href : null;
  }

  private imagePattern(paint: ImagePaint, w: number, h: number): string | null {
    const content = this.imageContent(paint, w, h);
    if (!content) return null;
    const id = this.id('pattern');
    return `url(#${this.def(el('pattern', {id, patternUnits: 'userSpaceOnUse', width: content.tile.width, height: content.tile.height}, [content.image]))})`;
  }

  /** The picture as drawn in the node's box (one tile of it for TILE), and the tile. */
  private imageContent(paint: ImagePaint, w: number, h: number): {image: El; tile: {width: number; height: number}} | null {
    const data = this.imageSource(paint.imageRef);
    if (!data || !(w > 0 && h > 0)) return null;
    const natural = this.doc.images[paint.imageRef];
    const turn = ((paint.rotation ?? 0) % 360 + 360) % 360;
    const sideways = turn === 90 || turn === 270;
    let image: El;
    let tile = {width: w, height: h};
    switch (paint.scaleMode) {
      case 'CROP': {
        const inverse = invert(paint.imageTransform ?? IDENTITY);
        image = el('image', {width: 1, height: 1, preserveAspectRatio: 'none', transform: this.matrixValue(multiply(scaling(w, h), inverse)), 'xlink:href': data});
        break;
      }
      case 'TILE': {
        const factor = paint.scalingFactor ?? 1;
        tile = {width: Math.max(1, (natural?.width ?? w) * factor), height: Math.max(1, (natural?.height ?? h) * factor)};
        image = el('image', {width: tile.width, height: tile.height, preserveAspectRatio: 'none', 'xlink:href': data});
        break;
      }
      default: {
        // FILL covers the box, FIT fits inside it; a quarter turn swaps the box the picture sees.
        const box = sideways ? {width: h, height: w} : {width: w, height: h};
        image = el('image', {x: (w - box.width) / 2, y: (h - box.height) / 2, width: box.width, height: box.height, preserveAspectRatio: paint.scaleMode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice', 'xlink:href': data});
      }
    }
    if (turn && paint.scaleMode !== 'CROP') image = el('g', {transform: `rotate(${turn} ${this.f(tile.width / 2)} ${this.f(tile.height / 2)})`}, [image]);
    return {image, tile};
  }

  /** Elements painting `shape` with one paint (as fill), or for angular/diamond, a clipped group. */
  private paintLayer(shape: Shape, paint: Paint, w: number, h: number): El[] {
    const style = blendStyle(paint.blendMode);
    const opacity = paint.opacity < 1 ? paint.opacity : undefined;
    if (this.options.print && paint.type === 'IMAGE' && paint.scaleMode !== 'TILE') {
      // The picture itself, clipped to the shape: a PDF keeps its pixels (a pattern would be re-rasterized).
      const content = this.imageContent(paint, w, h);
      if (content) return [el('g', {'clip-path': `url(#${this.clipOf(shape)})`, opacity, style}, [content.image])];
    }
    const value = this.paintValue(paint, w, h);
    if (value) return shape.elements.map(e => this.clone(e, {fill: value, 'fill-opacity': opacity, style}));
    if (paint.type !== 'GRADIENT_ANGULAR' && paint.type !== 'GRADIENT_DIAMOND') return [];
    const frame = this.handleFrame(paint, w, h, false);
    if (!frame) return [];
    // Canonical coordinates covering the box, to size the wedges/quadrants.
    const back = invert(frame);
    const reach = Math.max(...[{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}, ...(shape.bounds ? [{x: shape.bounds.x, y: shape.bounds.y}, {x: shape.bounds.x + shape.bounds.width, y: shape.bounds.y + shape.bounds.height}] : [])].map(p => {
      const q = apply(back, p);
      return Math.hypot(q.x, q.y);
    })) * 1.5 + 1;
    const pieces: El[] = [];
    const point = (x: number, y: number) => apply(frame, {x, y});
    const d = (pts: {x: number; y: number}[]) => 'M' + pts.map(p => `${this.f(p.x)} ${this.f(p.y)}`).join('L') + 'Z';
    if (paint.type === 'GRADIENT_DIAMOND') {
      // |gx| + |gy| is linear in each quadrant: four linear gradients are the exact diamond.
      for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const id = this.id('paint_diamond');
        this.def(el('linearGradient', {id, gradientUnits: 'userSpaceOnUse', gradientTransform: this.matrixValue(frame), x1: 0, y1: 0, x2: sx / 2, y2: sy / 2}, this.stops(paint)));
        pieces.push(el('path', {d: d([point(0, 0), point(sx * reach, 0), point(sx * reach, sy * reach), point(0, sy * reach)]), fill: `url(#${id})`}));
      }
    } else {
      // A conic gradient has no SVG form: 120 solid wedges, each overlapping the next a little. For print, opaque
      // stops overlap by half a wedge, so no anti-aliased seam lets the background through in a PDF viewer.
      const count = 120;
      const overlap = this.options.print && paint.gradientStops.every(stop => stop.color.a >= 1) ? 1.5 : 1.05;
      for (let k = 0; k < count; k++) {
        // The last wedge stops at the start: the gradient's hard edge from its last colour back to its first stays put.
        const a0 = (k / count) * 2 * Math.PI, a1 = ((k + (k === count - 1 ? Math.min(overlap, 1.05) : overlap)) / count) * 2 * Math.PI;
        const {color, a} = sampleStops(paint.gradientStops, (k + 0.5) / count);
        pieces.push(el('path', {d: d([point(0, 0), point(Math.cos(a0) * reach, Math.sin(a0) * reach), point(Math.cos(a1) * reach, Math.sin(a1) * reach)]), fill: hex(color), 'fill-opacity': a < 1 ? a : undefined}));
      }
    }
    return [el('g', {'clip-path': `url(#${this.clipOf(shape)})`, opacity, style}, pieces)];
  }

  // Strokes ───────────────────────────────────────────────────────────────────────────────────

  private strokeLayers(node: SceneNode, shape: Shape | null): El[] {
    const paints = node.strokes.filter(p => p.visible);
    if (!paints.length || !shape) return [];
    if (hasVariableWidth(node)) {
      // "Width profile": the same filled pieces the canvas draws (shared/design/stroke-profile.ts).
      const outlined = this.pathShape(variableWidthOutline(node));
      return outlined ? paints.flatMap(p => this.paintLayer(outlined, p, node.width, node.height)) : [];
    }
    const markers = (node.type === 'LINE' || node.type === 'VECTOR') && ((node.strokeStartMarker ?? 'NONE') !== 'NONE' || (node.strokeEndMarker ?? 'NONE') !== 'NONE');
    if (node.individualStrokeWeights || markers) {
      // Per-side weights and markers have no SVG stroke form: the outlined stroke is filled.
      const outlined = this.pathShape(outlineStroke(node, shape.paths));
      return outlined ? paints.flatMap(p => this.paintLayer(outlined, p, node.width, node.height)) : [];
    }
    if (!(node.strokeWeight > 0)) return [];
    const align = shape.closed ? node.strokeAlign : 'CENTER';
    const width = align === 'CENTER' ? node.strokeWeight : node.strokeWeight * 2;
    const common = {
      fill: 'none',
      'stroke-width': width,
      'stroke-linecap': node.strokeCap !== 'NONE' ? CAP[node.strokeCap] : undefined,
      'stroke-linejoin': node.strokeJoin !== 'MITER' ? JOIN[node.strokeJoin] : undefined,
      'stroke-miterlimit': node.strokeJoin === 'MITER' && node.strokeMiterLimit !== 4 ? node.strokeMiterLimit : undefined,
      'stroke-dasharray': node.dashPattern.length ? node.dashPattern.map(this.f).join(' ') : undefined,
    };
    const layers: El[] = [];
    for (const paint of paints) {
      const value = this.paintValue(paint, node.width, node.height);
      if (!value) {
        // Angular and diamond strokes: fill the outlined stroke with the gradient.
        const outlined = this.pathShape(outlineStroke(node, shape.paths));
        if (outlined) layers.push(...this.paintLayer(outlined, paint, node.width, node.height));
        continue;
      }
      for (const e of shape.elements) {
        layers.push(this.clone(e, {...common, 'fill-rule': undefined, stroke: value, 'stroke-opacity': paint.opacity < 1 ? paint.opacity : undefined, style: blendStyle(paint.blendMode)}));
      }
    }
    if (align === 'INSIDE') return [el('g', {'clip-path': `url(#${this.clipOf(shape)})`}, layers)];
    if (align === 'OUTSIDE') {
      const b = shape.bounds ?? {x: 0, y: 0, width: node.width, height: node.height};
      const pad = node.strokeWeight * 2 + 1;
      const region = {x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2};
      const id = this.id('mask');
      this.def(el('mask', {id, maskUnits: 'userSpaceOnUse', ...region}, [
        el('rect', {...region, fill: 'white'}),
        ...shape.elements.map(e => this.clone(e, {fill: 'black'})),
      ]));
      return [el('g', {mask: `url(#${id})`}, layers)];
    }
    return layers;
  }

  // Effects ───────────────────────────────────────────────────────────────────────────────────

  /** Figma's filter construction: drop shadows under the shape, inner shadows over it, then layer blur. */
  private filter(effects: Effect[], region: Rect, transparent: boolean): string | undefined {
    const visible = effects.filter(e => e.visible && e.type !== 'BACKGROUND_BLUR');
    if (!visible.length) return undefined;
    const id = this.id('filter');
    const primitives: El[] = [el('feFlood', {'flood-opacity': 0, result: 'BackgroundImageFix'})];
    const hardAlpha = () => el('feColorMatrix', {in: 'SourceAlpha', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0', result: 'hardAlpha'});
    const tint = (e: ShadowEffect) => el('feColorMatrix', {type: 'matrix', values: `0 0 0 0 ${this.f(e.color.r)} 0 0 0 0 ${this.f(e.color.g)} 0 0 0 0 ${this.f(e.color.b)} 0 0 0 ${this.f(e.color.a)} 0`});
    const mode = (e: ShadowEffect) => BLEND_CSS[e.blendMode] ?? 'normal';
    let below = 'BackgroundImageFix', n = 0;
    for (const e of visible) {
      if (e.type !== 'DROP_SHADOW') continue;
      n++;
      primitives.push(hardAlpha());
      if (e.spread) primitives.push(el('feMorphology', {radius: Math.abs(e.spread), operator: e.spread > 0 ? 'dilate' : 'erode', in: 'SourceAlpha', result: `effect${n}_spread`}));
      primitives.push(el('feOffset', {dx: e.offset.x || undefined, dy: e.offset.y || undefined}));
      if (e.radius > 0) primitives.push(el('feGaussianBlur', {stdDeviation: e.radius / 2}));
      if (!e.showShadowBehindNode && transparent) primitives.push(el('feComposite', {in2: 'hardAlpha', operator: 'out'}));
      primitives.push(tint(e), el('feBlend', {mode: mode(e), in2: below, result: `effect${n}_dropShadow`}));
      below = `effect${n}_dropShadow`;
    }
    primitives.push(el('feBlend', {mode: 'normal', in: 'SourceGraphic', in2: below, result: 'shape'}));
    let current = 'shape';
    for (const e of visible) {
      if (e.type !== 'INNER_SHADOW') continue;
      n++;
      primitives.push(hardAlpha());
      if (e.spread) primitives.push(el('feMorphology', {radius: Math.abs(e.spread), operator: e.spread > 0 ? 'erode' : 'dilate', in: 'SourceAlpha', result: `effect${n}_spread`}));
      primitives.push(el('feOffset', {dx: e.offset.x || undefined, dy: e.offset.y || undefined}));
      if (e.radius > 0) primitives.push(el('feGaussianBlur', {stdDeviation: e.radius / 2}));
      primitives.push(el('feComposite', {in2: 'hardAlpha', operator: 'arithmetic', k2: -1, k3: 1}), tint(e), el('feBlend', {mode: mode(e), in2: current, result: `effect${n}_innerShadow`}));
      current = `effect${n}_innerShadow`;
    }
    for (const e of visible) {
      if (e.type !== 'LAYER_BLUR' || !(e.radius > 0)) continue;
      n++;
      primitives.push(el('feGaussianBlur', {in: current, stdDeviation: e.radius / 2, result: `effect${n}_foregroundBlur`}));
      current = `effect${n}_foregroundBlur`;
    }
    this.def(el('filter', {id, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB', ...region}, primitives));
    return `url(#${id})`;
  }

  /** One drop or inner shadow alone, in the same construction as `filter` (print: drawn as its own layer). */
  private shadowOnly(e: ShadowEffect, region: Rect, transparent: boolean): string {
    const id = this.id('filter');
    const inner = e.type === 'INNER_SHADOW';
    const primitives: El[] = [el('feColorMatrix', {in: 'SourceAlpha', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0', result: 'hardAlpha'})];
    if (e.spread) primitives.push(el('feMorphology', {radius: Math.abs(e.spread), operator: (e.spread > 0) !== inner ? 'dilate' : 'erode', in: 'SourceAlpha'}));
    primitives.push(el('feOffset', {dx: e.offset.x || undefined, dy: e.offset.y || undefined}));
    if (e.radius > 0) primitives.push(el('feGaussianBlur', {stdDeviation: e.radius / 2}));
    if (inner) primitives.push(el('feComposite', {in2: 'hardAlpha', operator: 'arithmetic', k2: -1, k3: 1}));
    else if (!e.showShadowBehindNode && transparent) primitives.push(el('feComposite', {in2: 'hardAlpha', operator: 'out'}));
    primitives.push(el('feColorMatrix', {type: 'matrix', values: `0 0 0 0 ${this.f(e.color.r)} 0 0 0 0 ${this.f(e.color.g)} 0 0 0 0 ${this.f(e.color.b)} 0 0 0 ${this.f(e.color.a)} 0`}));
    this.def(el('filter', {id, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB', ...region}, primitives));
    return `url(#${id})`;
  }

  // Bounds ────────────────────────────────────────────────────────────────────────────────────

  /** What a node paints, in its local space (strokes and effects included). */
  localBounds(node: SceneNode, depth = 0): Rect | null {
    if (!node.visible || node.type === 'SLICE' || depth > 256) return null;
    let box: Rect | null = null;
    const own: Rect = {x: 0, y: 0, width: node.width, height: node.height};
    if (node.type === 'GROUP' || node.type === 'PAGE') box = this.childrenBounds(node, depth);
    else if (FRAME_LIKE.has(node.type)) {
      const children = this.childrenBounds(node, depth);
      box = unionRects([own, ...(children && !node.clipsContent ? [children] : [])]);
    } else if (node.type === 'TEXT') {
      // A text on a path reaches past its box (the path's) wherever its glyphs stand.
      const placed = node.textPath && node.text ? textPathLayout(node, layoutText(node, this.options.measurer)).bounds : null;
      box = placed ? unionRects([own, placed])! : own;
    }
    else {
      const shape = this.shapeOf(node);
      box = shape?.bounds ?? null;
    }
    if (!box) return null;
    if (node.strokes.some(p => p.visible) && node.type !== 'GROUP') {
      const markers = (node.strokeStartMarker ?? 'NONE') !== 'NONE' || (node.strokeEndMarker ?? 'NONE') !== 'NONE';
      const weight = node.individualStrokeWeights ? Math.max(...Object.values(node.individualStrokeWeights)) : node.strokeWeight;
      const open = node.type === 'LINE' || (node.type === 'VECTOR' && !(node.vectorPaths ?? []).every(p => isClosed(p.commands)));
      let pad = open ? weight / 2 : node.strokeAlign === 'CENTER' ? weight / 2 : node.strokeAlign === 'OUTSIDE' ? weight : 0;
      if (node.strokeCap === 'SQUARE' && open) pad = weight * Math.SQRT1_2;
      if (markers) pad = Math.max(pad, weight * 3 + 4);
      if (hasVariableWidth(node)) pad = (node.strokeWeight * maxWidthFactor(node.variableWidthStrokeProperties)) / 2;
      box = {x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2};
    }
    return this.withEffects(box, node.effects);
  }

  private childrenBounds(node: SceneNode, depth: number): Rect | null {
    const boxes: Rect[] = [];
    for (const id of node.children ?? []) {
      const child = this.doc.nodes[id];
      if (!child || child.isMask) continue;
      const b = this.localBounds(child, depth + 1);
      if (b) boxes.push(transformRect(localMatrix(child), b));
    }
    return unionRects(boxes);
  }

  private withEffects(box: Rect, effects: Effect[]): Rect {
    const boxes = [box];
    for (const e of effects) {
      if (!e.visible) continue;
      if (e.type === 'DROP_SHADOW') {
        const grow = e.radius + Math.max(0, e.spread);
        boxes.push({x: box.x + e.offset.x - grow, y: box.y + e.offset.y - grow, width: box.width + grow * 2, height: box.height + grow * 2});
      } else if (e.type === 'LAYER_BLUR') boxes.push({x: box.x - e.radius, y: box.y - e.radius, width: box.width + e.radius * 2, height: box.height + e.radius * 2});
    }
    return unionRects(boxes)!;
  }

  // Nodes ─────────────────────────────────────────────────────────────────────────────────────

  /** A node drawn in its parent's coordinates (`matrix`: local → parent). */
  node(node: SceneNode, matrix: Matrix, depth = 0, asMask = false): El | null {
    if (!node.visible || node.type === 'SLICE' || depth > 256 || (node.isMask && !asMask)) return null;
    // Taken before the children's, so a repeated name numbers in document order (the parent keeps the plain name).
    const layerId = this.layerId(node);
    const content: El[] = [];
    const w = node.width, h = node.height;
    if (node.type === 'GROUP' || node.type === 'PAGE') content.push(...this.children(node, depth));
    else if (node.type === 'TEXT') {
      const text = this.text(node);
      if (text) content.push(text);
    } else {
      const shape = this.shapeOf(node);
      const fills: El[] = [];
      if (shape && node.type !== 'LINE') for (const paint of node.fills) if (paint.visible) fills.push(...this.paintLayer(shape, paint, w, h));
      const children = FRAME_LIKE.has(node.type) ? this.children(node, depth) : [];
      if (children.length && node.clipsContent && node.type !== 'SECTION' && shape) {
        // A clip isolates what it holds: children with a blend mode would blend with nothing below them. The frame's
        // own fills (when they blend normally) go inside the clip, so children blend with the frame as on the canvas.
        const inside = node.fills.every(paint => !paint.visible || paint.blendMode === 'NORMAL' || paint.blendMode === 'PASS_THROUGH');
        if (!inside) content.push(...fills);
        content.push(el('g', {'clip-path': `url(#${this.clipOf(shape)})`}, inside ? [...fills, ...children] : children));
      } else {
        content.push(...fills);
        if (children.length) content.push(el('g', {}, children));
      }
      content.push(...this.strokeLayers(node, shape));
    }
    const flat = content.flatMap(c => (c.tag === 'g' && !Object.values(c.attrs).some(v => v !== undefined && v !== '') ? c.children.filter((x): x is El => typeof x !== 'string') : [c]));
    if (!flat.length) return null;
    const transparent = node.fills.some(p => p.visible && (p.opacity < 1 || p.type !== 'SOLID'));
    const region = node.effects.some(e => e.visible) ? this.localBounds({...node, isMask: false}) : null;
    const shadows = node.effects.filter((e): e is ShadowEffect => e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'));
    if (this.options.print && region && shadows.length && !node.effects.some(e => e.visible && e.type === 'LAYER_BLUR' && e.radius > 0)) {
      // Print: the content once, vector; each shadow a layer drawn from a reference to it (only shadows rasterize).
      const contentId = this.id('content');
      const padded = this.pad(region);
      const layer = (e: ShadowEffect) => el('use', {href: `#${contentId}`, filter: this.shadowOnly(e, padded, transparent), style: blendStyle(e.blendMode)});
      return el('g', {
        transform: this.matrixValue(matrix),
        opacity: node.opacity < 1 ? node.opacity : undefined,
        style: node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL' ? blendStyle(node.blendMode) : undefined,
      }, [
        ...shadows.filter(e => e.type === 'DROP_SHADOW').map(layer),
        el('g', {id: contentId}, flat),
        ...shadows.filter(e => e.type === 'INNER_SHADOW').map(layer),
      ]);
    }
    const filter = region ? this.filter(node.effects, this.pad(region), transparent) : undefined;
    const attrs: Record<string, Value> = {
      id: layerId,
      transform: this.matrixValue(matrix),
      opacity: node.opacity < 1 ? node.opacity : undefined,
      style: node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL' ? blendStyle(node.blendMode) : undefined,
      filter,
    };
    // One element without a transform or opacity of its own takes the attributes directly.
    if (flat.length === 1 && !filter && !flat[0].attrs.transform && !flat[0].attrs.opacity && !flat[0].attrs.style && !flat[0].attrs.filter && !(attrs.id && flat[0].attrs.id)) {
      return this.clone(flat[0], Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)));
    }
    return el('g', attrs, flat);
  }

  private pad(r: Rect): Rect {
    return {x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2};
  }

  /** Children bottom to top; a mask masks the siblings above it up to the next mask. */
  private children(parent: SceneNode, depth: number): El[] {
    const out: El[] = [];
    let target = out;
    for (const id of parent.children ?? []) {
      const child = this.doc.nodes[id];
      if (!child) continue;
      if (child.isMask) {
        if (!child.visible) { target = out; continue; }
        const group = el('g', this.maskAttrs(child, parent, depth));
        out.push(group);
        target = group.children as El[];
        continue;
      }
      const drawn = this.node(child, localMatrix(child), depth + 1);
      if (drawn) target.push(drawn);
    }
    return out.filter(e => e.tag !== 'g' || e.children.length || e.attrs.transform);
  }

  private maskAttrs(mask: SceneNode, parent: SceneNode, depth: number): Record<string, Value> {
    if (mask.maskType === 'VECTOR') {
      const elements: El[] = [];
      const collect = (node: SceneNode, matrix: Matrix, level: number) => {
        if (!node.visible || level > 64) return;
        if (node.type === 'GROUP') {
          for (const id of node.children ?? []) {
            const child = this.doc.nodes[id];
            if (child) collect(child, multiply(matrix, localMatrix(child)), level + 1);
          }
          return;
        }
        const shape = node.type === 'TEXT' ? null : this.shapeOf(node);
        for (const e of shape?.elements ?? []) elements.push(this.clone(e, {transform: this.matrixValue(matrix), 'clip-rule': e.attrs['fill-rule'], 'fill-rule': undefined}));
      };
      collect(mask, localMatrix(mask), 0);
      const id = this.id('clip');
      this.def(el('clipPath', {id}, elements));
      return {'clip-path': `url(#${id})`};
    }
    const content = this.node(mask, localMatrix(mask), depth + 1, true);
    const region = this.childrenBounds(parent, depth) ?? {x: 0, y: 0, width: parent.width, height: parent.height};
    const id = this.id('mask');
    this.def(el('mask', {id, maskUnits: 'userSpaceOnUse', style: mask.maskType === 'LUMINANCE' ? undefined : 'mask-type:alpha', ...this.pad(region)}, content ? [content] : []));
    return {mask: `url(#${id})`};
  }

  // Text ──────────────────────────────────────────────────────────────────────────────────────

  private text(node: SceneNode): El | null {
    const text = node.text;
    if (!text || !text.characters) return null;
    const layout = layoutText(node, this.options.measurer);
    const base = text.style;
    const spacing = (s: TextStyle) => (s.letterSpacing.unit === 'PERCENT' ? (s.letterSpacing.value / 100) * s.fontSize : s.letterSpacing.value);
    const decoration = (s: TextStyle) => (s.textDecoration === 'UNDERLINE' ? 'underline' : s.textDecoration === 'STRIKETHROUGH' ? 'line-through' : undefined);
    const topFill = (fills: Paint[] | undefined) => [...(fills ?? [])].reverse().find(p => p.visible);
    const nodeFill = topFill(node.fills);
    const fillAttrs = (paint: Paint | undefined): Record<string, Value> => {
      if (!paint) return {fill: 'none'};
      const value = this.paintValue(paint, node.width, node.height) ?? (paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND' ? hex(sampleStops(paint.gradientStops, 0.5).color) : null);
      return value ? {fill: value, 'fill-opacity': paint.opacity < 1 ? paint.opacity : undefined} : {fill: 'none'};
    };
    /** The font attributes where a style differs from the base style. */
    const fontAttrs = (s: TextStyle): Record<string, Value> => {
      const attrs: Record<string, Value> = {};
      if (s.fontFamily !== base.fontFamily) attrs['font-family'] = familyValue(s.fontFamily);
      if (s.fontSize !== base.fontSize) attrs['font-size'] = s.fontSize;
      if (s.fontWeight !== base.fontWeight) attrs['font-weight'] = s.fontWeight;
      if (s.italic !== base.italic) attrs['font-style'] = s.italic ? 'italic' : 'normal';
      return attrs;
    };
    // Each piece with the paint it is drawn in (the run's own fill, else the node's).
    /** `link`: print only, a text hyperlink the PDF keeps as a link (http(s) and mailto only). */
    type Span = {attrs: Record<string, Value>; text: string; paint: Paint | undefined; link?: string};
    const spans: Span[] = [];
    // "Text on path": a tspan per grapheme at its place on the path, turned with it (shared/design/text-path.ts),
    // so every viewer draws the glyphs where the canvas does. The layout has already applied the text case.
    const placed = node.textPath ? textPathLayout(node, layout) : null;
    if (placed) for (const glyph of placed.glyphs) {
      const s = glyph.run.style;
      const attrs: Record<string, Value> = {x: glyph.origin.x, y: glyph.origin.y, rotate: Math.abs(glyph.angle) > 1e-9 ? (glyph.angle * 180) / Math.PI : undefined, ...fontAttrs(s)};
      if (s.textDecoration !== base.textDecoration) attrs['text-decoration'] = decoration(s) ?? 'none';
      if (s.textCase === 'SMALL_CAPS' && base.textCase !== 'SMALL_CAPS') attrs['font-variant'] = 'small-caps';
      const link = this.options.print && s.hyperlink?.type === 'URL' ? linkHref(s.hyperlink.url) : undefined;
      spans.push({attrs, text: glyph.text, paint: topFill(glyph.run.fills), link});
    }
    if (!placed) for (const line of layout.lines) {
      if (line.marker) {
        // The marker where the canvas draws it: the layout's position, face and fill.
        const marker = line.marker;
        spans.push({attrs: {x: marker.x, y: line.baseline, ...fontAttrs(marker.style)}, text: marker.text, paint: marker.fills.length ? topFill(marker.fills) : nodeFill});
      }
      for (const run of line.runs) {
        if (!run.text) continue;
        const s = run.style;
        const attrs: Record<string, Value> = {x: run.x, y: line.baseline, ...fontAttrs(s)};
        if (spacing(s) !== spacing(base)) attrs['letter-spacing'] = spacing(s);
        if (s.textDecoration !== base.textDecoration) attrs['text-decoration'] = decoration(s) ?? 'none';
        if (s.textCase === 'SMALL_CAPS' && base.textCase !== 'SMALL_CAPS') attrs['font-variant'] = 'small-caps';
        const link = this.options.print && s.hyperlink?.type === 'URL' ? linkHref(s.hyperlink.url) : undefined;
        spans.push({attrs, text: applyCase(run.text, s.textCase), paint: topFill(run.fills), link});
      }
    }
    if (!spans.length) return null;
    const strokes = node.strokes.filter(p => p.visible);
    const stroke = strokes.length && node.strokeWeight > 0 ? this.paintValue(strokes[strokes.length - 1], node.width, node.height) : null;
    const textAttrs = (fill: Record<string, Value>, withStroke: boolean): Record<string, Value> => ({
      'xml:space': 'preserve',
      ...fill,
      'font-family': familyValue(base.fontFamily),
      'font-size': base.fontSize,
      'font-weight': base.fontWeight !== 400 ? base.fontWeight : undefined,
      'font-style': base.italic ? 'italic' : undefined,
      'letter-spacing': placed ? undefined : spacing(base) || undefined,
      'text-decoration': decoration(base),
      'font-variant': base.textCase === 'SMALL_CAPS' ? 'small-caps' : undefined,
      stroke: withStroke && stroke ? stroke : undefined,
      'stroke-width': withStroke && stroke ? node.strokeWeight : undefined,
    });
    const tspan = (span: Span, fill: Record<string, Value> = {}) => el('tspan', {...span.attrs, ...fill}, [span.text]);
    const linked = (span: Span, fill: Record<string, Value>) => (span.link ? el('a', {href: span.link}, [tspan(span, fill)]) : tspan(span, fill));
    const plain = (paint: Paint | undefined) => !paint || paint.type === 'SOLID';
    if (!this.options.print || spans.every(span => plain(span.paint))) {
      return el('text', textAttrs(fillAttrs(nodeFill), true), spans.map(span => linked(span, span.paint !== nodeFill ? fillAttrs(span.paint) : {})));
    }
    // Print: PDF viewers fill a variable font's glyphs (Type 3) with a gradient or a picture wrongly, so text in such a
    // paint is that paint clipped to its own glyphs (still vector); text in a solid colour stays plain text.
    const out: El[] = [];
    const solid = spans.filter(span => plain(span.paint));
    const own = plain(nodeFill) ? nodeFill : undefined;
    if (solid.length) out.push(el('text', textAttrs(fillAttrs(own), true), solid.map(span => linked(span, span.paint !== own ? fillAttrs(span.paint) : {}))));
    const pad = base.fontSize * 2;
    const reach = placed?.bounds ? [placed.bounds] : layout.lines.map(line => ({x: line.x, y: line.top, width: line.width, height: line.height}));
    const top = Math.min(0, ...reach.map(r => r.y)) - pad, bottom = Math.max(node.height, ...reach.map(r => r.y + r.height)) + pad;
    const left = Math.min(0, ...reach.map(r => r.x)) - pad, right = Math.max(node.width, ...reach.map(r => r.x + r.width)) + pad;
    const area: Shape = {elements: [el('rect', {x: left, y: top, width: right - left, height: bottom - top})], closed: true, bounds: {x: left, y: top, width: right - left, height: bottom - top}, paths: []};
    for (const paint of new Set(spans.map(span => span.paint).filter(paint => !plain(paint)))) {
      const pieces = spans.filter(span => span.paint === paint);
      const id = this.id('clip');
      this.def(el('clipPath', {id}, [el('text', textAttrs({}, false), pieces.map(span => tspan(span)))]));
      out.push(el('g', {'clip-path': `url(#${id})`}, this.paintLayer(area, paint!, node.width, node.height)));
      if (stroke) out.push(el('text', textAttrs({fill: 'none'}, true), pieces.map(span => tspan(span))));
    }
    return out.length === 1 ? out[0] : el('g', {}, out);
  }

  // Document ──────────────────────────────────────────────────────────────────────────────────

  document(ids: readonly NodeId[]): SvgPage {
    const roots = ids.filter(id => this.doc.nodes[id]);
    const placed: {node: SceneNode; world: Matrix; bounds: Rect}[] = [];
    for (const id of roots) {
      const node = this.doc.nodes[id];
      const world = node.type === 'PAGE' ? IDENTITY : worldMatrix(this.doc, id);
      const local = this.localBounds({...node, isMask: false});
      if (local) placed.push({node, world, bounds: transformRect(world, local)});
    }
    const crop = this.options.crop;
    const bounds = crop && crop.width > 0 && crop.height > 0 ? crop : unionRects(placed.map(p => p.bounds));
    const svgAttrs = (b: Rect) => ({width: b.width, height: b.height, viewBox: `0 0 ${this.f(b.width)} ${this.f(b.height)}`, fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink'});
    const empty = {x: 0, y: 0, width: 0, height: 0};
    if (!bounds) return {svg: write(el('svg', svgAttrs(empty)), this.f), bounds: empty};
    const origin = translation(-bounds.x, -bounds.y);
    const body: El[] = [];
    for (const {node, world} of placed) {
      const drawn = this.node({...node, isMask: false}, multiply(origin, world));
      if (drawn) body.push(drawn);
    }
    const children: El[] = [...(this.defs.length ? [el('defs', {}, this.defs)] : []), ...body];
    return {svg: write(el('svg', svgAttrs(bounds), children), this.f), bounds};
  }
}

/** What a diff names as the call's inputs (the measurer and the picture callbacks are functions). */
const svgInputs = (ids: readonly NodeId[], options: SvgExportOptions) => () => ({ids, options: {...options, measurer: undefined, imageData: undefined, imageHref: undefined}});

/** An SVG document of the given nodes (and their subtrees), cropped to what they paint. Through the engine switch's
 *  module `export` (lane L5: crates/export, byte-equal). */
export function exportSvg(doc: DesignDocument, ids: readonly NodeId[], options: SvgExportOptions): string {
  if (options.outlineText) return exportSvgPageWasm(doc, ids, options).svg;
  return withEngine('export', 'exportSvg', () => new Exporter(doc, options).document(ids).svg, () => exportSvgPageWasm(doc, ids, options).svg, {inputs: lazyInputs(svgInputs(ids, options))});
}

/** `exportSvg` with the page-space rectangle the SVG shows (its size is the rectangle's). */
export function exportSvgPage(doc: DesignDocument, ids: readonly NodeId[], options: SvgExportOptions): SvgPage {
  if (options.outlineText) return exportSvgPageWasm(doc, ids, options);
  return withEngine('export', 'exportSvgPage', () => new Exporter(doc, options).document(ids), () => exportSvgPageWasm(doc, ids, options), {inputs: lazyInputs(svgInputs(ids, options))});
}
