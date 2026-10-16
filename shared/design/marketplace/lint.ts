// Spec Lint: the marketplaces' own photo rules checked live on a card (docs/marketplaces.md §Spec Lint). Pure: the editor
// gathers the card's facts (shared/design/marketplace/facts.ts reads the document; the picture's encoded size, the contrast
// behind each text and how much of the product is covered come from rendering it) and this module turns them into checks.

import type {NodeId} from '../types';
import type {LayerRole} from './meta';
import {MARKETPLACE_RULES_VERSION, marketplaceSpec, type ImageFormat, type Marketplace, type MarketplaceSpec} from './specs';

export type LintStatus = 'pass' | 'warn' | 'fail' | 'pending';

export type LintCheckId =
  | 'format' | 'resolution' | 'aspect' | 'file-size' | 'compression' | 'images-count'
  | 'words' | 'contrast' | 'proofing' | 'logo' | 'product' | 'product-fill' | 'safe-zones';

export const LINT_CHECK_LABELS: Readonly<Record<LintCheckId, string>> = {
  format: 'File format',
  resolution: 'Resolution',
  aspect: 'Aspect ratio',
  'file-size': 'File size',
  compression: 'Compression',
  'images-count': 'Photos in the card',
  words: 'Banned words',
  contrast: 'Text contrast',
  proofing: 'Spelling',
  logo: 'Logo and watermark',
  product: 'Product visible',
  'product-fill': 'Product fills the frame',
  'safe-zones': 'Badge zones',
};

export type LintFinding = {status: Exclude<LintStatus, 'pass'>; message: string; nodeIds: NodeId[]};
export type LintCheck = {id: LintCheckId; label: string; status: LintStatus; findings: LintFinding[]};
export type LintReport = {marketplace: Marketplace; rulesVersion: string; status: LintStatus; checks: LintCheck[]};

export type Box = {x: number; y: number; width: number; height: number};

/** What Spec Lint needs to know about one card. Boxes are in the card frame's own coordinates. */
export type CardFacts = {
  marketplace: Marketplace;
  frame: {id: NodeId; width: number; height: number};
  export: {format: ImageFormat; scale: number; /** 1..100, JPEG and WebP. */ quality: number};
  texts: readonly {id: NodeId; name: string; characters: string; /** Largest font size in the layer, card px. */ fontSize: number; fontWeight: number; box: Box}[];
  /** Layers with a role, and layers filled with a picture (`image`). */
  layers: readonly {id: NodeId; name: string; role: LayerRole | null; box: Box; image?: boolean}[];
  /** Images the seller's card will have: this frame and the other frames of its set for the same marketplace. */
  imagesInSet: number;
  /** Rendering results; a missing one leaves its check pending. */
  measured?: {
    /** The encoded picture's size at the export settings. */
    bytes?: number;
    /** Text layer → the lowest contrast ratio between its colour and what is behind its glyphs. */
    contrast?: Readonly<Record<NodeId, number>>;
    /** Product layer → share (0..1) of its visible pixels covered by layers above it. */
    covered?: Readonly<Record<NodeId, number>>;
  };
  /** Text layer → spelling issues found by proofing (shared/design/marketplace/api.ts `ProofIssue`). */
  proofing?: Readonly<Record<NodeId, readonly {word: string; message: string}[]>>;
};

const RANK: Record<LintStatus, number> = {pass: 0, pending: 1, warn: 2, fail: 3};
export const worstStatus = (statuses: Iterable<LintStatus>): LintStatus => {
  let worst: LintStatus = 'pass';
  for (const status of statuses) if (RANK[status] > RANK[worst]) worst = status;
  return worst;
};

const area = (box: Box) => Math.max(0, box.width) * Math.max(0, box.height);
export function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const ratio = (value: number) => `${value.toFixed(1)}:1`;

/** WCAG "large text": 24 px, or 18.66 px from semi-bold up, at a 900 px wide card; scaled with the card's width. */
export function isLargeText(fontSize: number, fontWeight: number, frameWidth: number): boolean {
  const scale = frameWidth > 0 ? 900 / frameWidth : 1;
  const size = fontSize * scale;
  return size >= 24 || (fontWeight >= 600 && size >= 18.66);
}

/** Roles that stand on the card as content (and so must keep out of the marketplace's badges). */
const CONTENT_ROLES: ReadonlySet<LayerRole> = new Set(['product', 'logo', 'store-logo', 'watermark', 'headline', 'badge', 'benefit']);

export function lintCard(facts: CardFacts): LintReport {
  const spec = marketplaceSpec(facts.marketplace);
  const checks: LintCheck[] = [];
  const add = (id: LintCheckId, findings: LintFinding[], pending = false) =>
    checks.push({id, label: LINT_CHECK_LABELS[id], status: findings.length ? worstStatus(findings.map(f => f.status)) : pending ? 'pending' : 'pass', findings});
  const frameIds = [facts.frame.id];

  // Format, size in pixels, proportions.
  add('format', spec.formats.includes(facts.export.format) ? [] : [{status: 'fail', message: `${spec.name} does not accept ${facts.export.format.toUpperCase()}: use ${spec.formats.map(f => f.toUpperCase()).join(', ')}`, nodeIds: frameIds}]);

  const pixelWidth = Math.round(facts.frame.width * facts.export.scale);
  const pixelHeight = Math.round(facts.frame.height * facts.export.scale);
  const resolution: LintFinding[] = [];
  if (pixelWidth < spec.minSize.width || pixelHeight < spec.minSize.height)
    resolution.push({status: 'fail', message: `${pixelWidth} × ${pixelHeight} px is below the minimum of ${spec.name}: ${spec.minSize.width} × ${spec.minSize.height}`, nodeIds: frameIds});
  if (spec.maxSize && (pixelWidth > spec.maxSize.width || pixelHeight > spec.maxSize.height))
    resolution.push({status: 'fail', message: `${pixelWidth} × ${pixelHeight} px is above the maximum of ${spec.name}: ${spec.maxSize.width} × ${spec.maxSize.height}`, nodeIds: frameIds});
  add('resolution', resolution);

  const wanted = spec.aspect.width / spec.aspect.height;
  const actual = facts.frame.height > 0 ? facts.frame.width / facts.frame.height : 0;
  const square = facts.marketplace === 'ozon' && Math.abs(actual - 1) < 0.01; // Ozon fresh
  add('aspect', Math.abs(actual - wanted) <= 0.01 || square ? [] : [{
    status: spec.aspect.strict ? 'fail' : 'warn',
    message: `Aspect ratio ${facts.frame.width}:${facts.frame.height}, ${spec.name} expects ${spec.aspect.width}:${spec.aspect.height}${spec.aspect.strict ? '' : ' — the picture will be cropped or padded'}`,
    nodeIds: frameIds,
  }]);

  // The encoded file.
  const bytes = facts.measured?.bytes;
  add('file-size', bytes === undefined ? [] : bytes > spec.maxFileBytes ? [{status: 'fail', message: `File ${formatBytes(bytes)}, ${spec.name} accepts up to ${formatBytes(spec.maxFileBytes)}`, nodeIds: frameIds}] : [], bytes === undefined);
  const lossy = facts.export.format === 'jpg' || facts.export.format === 'webp';
  add('compression', spec.minJpegQuality !== null && lossy && facts.export.quality < spec.minJpegQuality
    ? [{status: 'fail', message: `Quality ${facts.export.quality}%: ${spec.name} requires at least ${spec.minJpegQuality}%`, nodeIds: frameIds}]
    : []);

  // How many pictures the card has.
  const count: LintFinding[] = [];
  if (facts.imagesInSet > spec.maxImages) count.push({status: 'fail', message: `${facts.imagesInSet} photos: ${spec.name} accepts up to ${spec.maxImages}`, nodeIds: frameIds});
  if (spec.minImagesForSearch !== null && facts.imagesInSet < spec.minImagesForSearch)
    count.push({status: 'warn', message: `${spec.name} does not show a card with one photo in search: add ${spec.minImagesForSearch - facts.imagesInSet} more`, nodeIds: frameIds});
  add('images-count', count);

  // Text.
  add('words', bannedWordFindings(spec, facts.texts));
  if (spec.textContrast) {
    const measured = facts.measured?.contrast;
    const findings: LintFinding[] = [];
    let pending = false;
    for (const text of facts.texts) {
      if (!text.characters.trim()) continue;
      const value = measured?.[text.id];
      if (value === undefined) {
        pending = true;
        continue;
      }
      const large = isLargeText(text.fontSize, text.fontWeight, facts.frame.width);
      const needed = large ? spec.textContrast.large : spec.textContrast.normal;
      if (value + 1e-6 < needed)
        findings.push({status: 'fail', message: `"${clip(text.characters)}": contrast ${ratio(value)}, needs ${ratio(needed)}${large ? ' for large text' : ''}`, nodeIds: [text.id]});
    }
    add('contrast', findings, pending);
  }
  if (spec.proofText) {
    const findings: LintFinding[] = [];
    for (const text of facts.texts) {
      const issues = facts.proofing?.[text.id];
      if (!issues?.length) continue;
      findings.push({status: 'warn', message: `"${clip(text.characters)}": ${issues.map(issue => `"${issue.word}" — ${issue.message}`).join('; ')}`, nodeIds: [text.id]});
    }
    add('proofing', findings, !facts.proofing && facts.texts.some(text => text.characters.trim()));
  }

  // Logos.
  add('logo', logoFindings(spec, facts));

  // The product.
  const products = facts.layers.filter(layer => layer.role === 'product');
  const productFindings: LintFinding[] = [];
  let productPending = false;
  if (!products.length) {
    // The largest picture is most likely the product: the finding selects it, so the role is one click away.
    const photo = facts.layers.filter(layer => layer.image).sort((a, b) => area(b.box) - area(a.box))[0];
    if (spec.realProductOnly) productFindings.push({status: 'warn', message: `${spec.name} rejects photos without the real product: mark the product layer with the Product role`, nodeIds: photo ? [photo.id] : frameIds});
  } else {
    for (const product of products) {
      const covered = facts.measured?.covered?.[product.id];
      if (covered === undefined) productPending = true;
      else if (covered > 0.5) productFindings.push({status: 'fail', message: `Product covered by ${Math.round(covered * 100)}%: packaging or badges hide it`, nodeIds: [product.id]});
      else if (covered > 0.25) productFindings.push({status: 'warn', message: `Product covered by ${Math.round(covered * 100)}%`, nodeIds: [product.id]});
    }
  }
  add('product', productFindings, productPending);
  if (spec.productMinFill !== null) {
    const fill = spec.productMinFill;
    const best = products.reduce((most, product) => Math.max(most, product.box.height / facts.frame.height, product.box.width / facts.frame.width), 0);
    add('product-fill', !products.length ? [] : best + 1e-6 < fill
      ? [{status: 'fail', message: `The product fills ${Math.round(best * 100)}% of the frame, ${spec.name} requires at least ${Math.round(fill * 100)}%`, nodeIds: products.map(p => p.id)}]
      : [], !products.length);
  }

  // The marketplace's own badges.
  add('safe-zones', safeZoneFindings(spec, facts));

  return {marketplace: facts.marketplace, rulesVersion: MARKETPLACE_RULES_VERSION, status: worstStatus(checks.map(check => check.status)), checks};
}

const clip = (text: string, max = 28) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function bannedWordFindings(spec: MarketplaceSpec, texts: CardFacts['texts']): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const text of texts) {
    const seen = new Set<string>();
    for (const rule of spec.bannedWords) {
      if (seen.has(rule.reason)) continue;
      const match = rule.pattern.exec(text.characters);
      if (!match) continue;
      seen.add(rule.reason);
      findings.push({status: 'fail', message: `"${clip(match[0].trim(), 24)}": ${rule.reason}`, nodeIds: [text.id]});
    }
  }
  return findings;
}

function logoFindings(spec: MarketplaceSpec, facts: CardFacts): LintFinding[] {
  const findings: LintFinding[] = [];
  const frameArea = area({x: 0, y: 0, width: facts.frame.width, height: facts.frame.height});
  for (const layer of facts.layers) {
    if (layer.role !== 'logo' && layer.role !== 'store-logo' && layer.role !== 'watermark') continue;
    if (spec.logo === 'forbidden') {
      findings.push({status: 'fail', message: `${spec.name} does not allow logos and watermarks on photos: hide "${clip(layer.name)}" for ${spec.short}`, nodeIds: [layer.id]});
      continue;
    }
    if (layer.role === 'store-logo') {
      findings.push({status: 'fail', message: `${spec.name} does not allow the store logo: keep only the brand logo`, nodeIds: [layer.id]});
      continue;
    }
    if (spec.logo === 'watermark') {
      const share = frameArea > 0 ? area(layer.box) / frameArea : 0;
      if (share >= 0.5) findings.push({status: 'fail', message: `The watermark fills ${Math.round(share * 100)}% of the frame: ${spec.name} allows less than half`, nodeIds: [layer.id]});
      const cx = (layer.box.x + layer.box.width / 2) / facts.frame.width;
      const cy = (layer.box.y + layer.box.height / 2) / facts.frame.height;
      if (Math.abs(cx - 0.5) < 0.15 && Math.abs(cy - 0.5) < 0.15)
        findings.push({status: 'fail', message: `Watermark in the centre: ${spec.name} allows it only at the side`, nodeIds: [layer.id]});
    }
  }
  return findings;
}

function safeZoneFindings(spec: MarketplaceSpec, facts: CardFacts): LintFinding[] {
  const findings: LintFinding[] = [];
  const {width, height} = facts.frame;
  const content: {id: NodeId; name: string; box: Box}[] = [
    ...facts.texts.filter(text => text.characters.trim()).map(text => ({id: text.id, name: text.characters, box: text.box})),
    ...facts.layers.filter(layer => layer.role && CONTENT_ROLES.has(layer.role) && !facts.texts.some(text => text.id === layer.id)),
  ];
  for (const zone of spec.safeZones) {
    const box = {x: zone.x * width, y: zone.y * height, width: zone.width * width, height: zone.height * height};
    const hit = content.filter(item => {
      const overlap = overlapArea(item.box, box);
      // A layer that only grazes the zone, or one that fills the card (a background) is fine.
      return overlap > 0.15 * Math.min(area(item.box), area(box)) && area(item.box) < 0.8 * width * height;
    });
    if (hit.length) findings.push({status: 'warn', message: `${zone.label} will cover "${clip(hit[0].name, 20)}"${hit.length > 1 ? ` and ${hit.length - 1} more` : ''}`, nodeIds: hit.map(item => item.id)});
  }
  return findings;
}
