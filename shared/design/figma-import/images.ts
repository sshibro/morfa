import type {DesignDocument, ImageAsset, ImageRef, Paint, SceneNode, Style} from '../types';
import {SHAPE_GREY, solid} from '../defaults';

// Pictures. The mapped document keeps Figma's image hashes in its IMAGE paints; once the runner has
// stored each picture in the new file, `withUploadedImages` points the paints at the stored refs and
// fills `images`. A picture that could not be copied leaves a grey placeholder in its place.

function forEachPaintList(doc: DesignDocument, visit: (paints: Paint[]) => Paint[] | void): void {
  for (const [id, node] of Object.entries(doc.nodes)) {
    let next: SceneNode | null = null;
    const fills = visit(node.fills);
    if (fills) (next ??= {...node}).fills = fills;
    const strokes = visit(node.strokes);
    if (strokes) (next ??= {...node}).strokes = strokes;
    if (node.text?.runs.some(run => run.fills)) {
      let changed = false;
      const runs = node.text.runs.map(run => {
        const paints = run.fills ? visit(run.fills) : undefined;
        if (!paints) return run;
        changed = true;
        return {...run, fills: paints};
      });
      if (changed) (next ??= {...node}).text = {...node.text, runs};
    }
    if (next) doc.nodes[id] = next;
  }
  for (const [id, style] of Object.entries(doc.styles)) {
    const paints = style.paints ? visit(style.paints) : undefined;
    if (paints) doc.styles[id] = {...style, paints} as Style;
  }
}

/** Figma image hashes the document uses, once each, in first-use order. */
export function figmaImageRefs(doc: DesignDocument): string[] {
  const refs = new Set<string>();
  forEachPaintList(doc, paints => {
    for (const paint of paints) if (paint.type === 'IMAGE' && paint.imageRef) refs.add(paint.imageRef);
  });
  return [...refs];
}

export type UploadedImage = {ref: ImageRef; asset: ImageAsset};

/** The document with Figma's hashes replaced by stored pictures; missing ones become grey fills.
 *  Returns how many paints lost their picture. */
export function withUploadedImages(source: DesignDocument, uploaded: ReadonlyMap<string, UploadedImage>): {doc: DesignDocument; missing: number} {
  const doc: DesignDocument = {...source, nodes: {...source.nodes}, styles: {...source.styles}, images: {...source.images}};
  let missing = 0;
  forEachPaintList(doc, paints => {
    if (!paints.some(paint => paint.type === 'IMAGE')) return;
    return paints.map(paint => {
      if (paint.type !== 'IMAGE') return paint;
      const stored = uploaded.get(paint.imageRef);
      if (stored) return {...paint, imageRef: stored.ref};
      missing++;
      return {...solid(SHAPE_GREY, paint.opacity), visible: paint.visible, blendMode: paint.blendMode};
    });
  });
  for (const {ref, asset} of uploaded.values()) doc.images[ref] = asset;
  return {doc, missing};
}
