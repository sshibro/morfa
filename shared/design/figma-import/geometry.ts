import type {Matrix} from '../types';
import {IDENTITY, apply, invert, multiply, normalizeDegrees, rotationMatrix, toRadians, transformRect, translation} from '../geometry';
import type {Entry} from './plan';
import {finite, matrixOf, size as sizeOf} from './values';

// Figma geometry → ours. Figma gives each node `relativeTransform` (local → its *containing* parent:
// groups and boolean operations are not containers, so their children are placed in the space of
// the nearest frame, section, component or page above them) and `size`. We keep every node's
// matrix in page space, then express it in the space of its parent in the new file, groups
// included, and split it into x, y, rotation, flip and size (shared/design/geometry.ts localMatrix:
// translate(x, y) · rotate(−rotation°) · flip about the centre).

const GROUP_LIKE = new Set(['GROUP', 'BOOLEAN_OPERATION']);
const ROUND = 1e4;
const tidy = (value: number) => {
  const rounded = Math.round(value * ROUND) / ROUND;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export type Placed = {x: number; y: number; width: number; height: number; rotation: number; flipX?: boolean; skewed: boolean; scaleX: number; scaleY: number};

/** Figma's size of a node (falls back to the bounding box for answers read without geometry). */
export function figmaSize(entry: Entry): {width: number; height: number} {
  const size = entry.node.size;
  if (size && typeof size === 'object') return {width: sizeOf(size.x), height: sizeOf(size.y)};
  const box = entry.node.absoluteBoundingBox;
  return {width: sizeOf(box?.width), height: sizeOf(box?.height)};
}

/** Page-space matrices of Figma nodes, with optional extra placement for lifted subtrees. */
export class PageSpace {
  private readonly cache = new Map<Entry, Matrix>();
  /** Lifted roots: an extra translation applied after their own page-space matrix. */
  readonly shift = new Map<Entry, Matrix>();

  /** The node's local box → its page, as Figma placed it (without lifting). */
  original(entry: Entry): Matrix {
    const cached = this.cache.get(entry);
    if (cached) return cached;
    let m: Matrix;
    const own = matrixOf(entry.node.relativeTransform);
    if (!entry.parent || entry.node.type === 'CANVAS') {
      m = entry.node.type === 'CANVAS' ? IDENTITY : own && !entry.parent && entry.node.absoluteBoundingBox ? this.fromBox(entry, own) : own ?? this.boxTranslation(entry);
    } else if (!own) m = this.boxTranslation(entry);
    else if (GROUP_LIKE.has(entry.parent.node.type)) m = this.inGroup(entry, own);
    else m = multiply(this.original(entry.parent), own);
    this.cache.set(entry, m);
    return m;
  }

  /** A node read without its parents: keep its rotation, put its bounds where Figma reports them. */
  private fromBox(entry: Entry, own: Matrix): Matrix {
    const box = entry.node.absoluteBoundingBox!;
    const {width, height} = figmaSize(entry);
    const linear: Matrix = [[own[0][0], own[0][1], 0], [own[1][0], own[1][1], 0]];
    const bounds = transformRect(linear, {x: 0, y: 0, width, height});
    return multiply(translation(finite(box.x) - bounds.x, finite(box.y) - bounds.y), linear);
  }

  private boxTranslation(entry: Entry): Matrix {
    const box = entry.node.absoluteBoundingBox;
    return box ? translation(finite(box.x), finite(box.y)) : IDENTITY;
  }

  /** A child of a group: by Figma's rule in the containing parent's space; if the bounding box Figma
   *  reports says the transform was relative to the group itself, that reading wins. */
  private inGroup(entry: Entry, own: Matrix): Matrix {
    let containing = entry.parent!;
    while (containing.parent && GROUP_LIKE.has(containing.node.type)) containing = containing.parent;
    const byRule = multiply(this.original(containing), own);
    const box = entry.node.absoluteBoundingBox;
    if (!box) return byRule;
    const byGroup = multiply(this.original(entry.parent!), own);
    const {width, height} = figmaSize(entry);
    const miss = (m: Matrix) => {
      const r = transformRect(m, {x: 0, y: 0, width, height});
      return Math.abs(r.x - finite(box.x)) + Math.abs(r.y - finite(box.y));
    };
    return miss(byGroup) + 0.01 < miss(byRule) ? byGroup : byRule;
  }

  /** Page-space matrix in the new file: lifted roots and their subtrees move by their shift. */
  placed(entry: Entry): Matrix {
    for (let at: Entry | null = entry; at; at = at.parent) {
      const shift = this.shift.get(at);
      if (shift) return multiply(shift, this.original(entry));
    }
    return this.original(entry);
  }
}

/** Splits a node's matrix in its new parent's space into our fields. */
export function place(local: Matrix, width: number, height: number): Placed {
  const [[a, c, e], [b, d, f]] = local;
  const scaleX = Math.hypot(a, b) || 1, scaleY = Math.hypot(c, d) || 1;
  const ax = a / scaleX, bx = b / scaleX, cy = c / scaleY, dy = d / scaleY;
  const flip = ax * dy - bx * cy < 0;
  const skewed = Math.abs(ax * cy + bx * dy) > 1e-3;
  const rotation = normalizeDegrees((-Math.atan2(flip ? -bx : bx, flip ? -ax : ax) * 180) / Math.PI);
  const w = width * scaleX, h = height * scaleY;
  // With a flip, the box's local origin lands on the far side; ours flips about the centre.
  const offset = flip ? apply(rotationMatrix(-toRadians(rotation)), {x: w, y: 0}) : {x: 0, y: 0};
  const out: Placed = {x: tidy(e - offset.x), y: tidy(f - offset.y), width: tidy(w), height: tidy(h), rotation, skewed, scaleX, scaleY};
  if (flip) out.flipX = true;
  return out;
}

/** The child's matrix in its parent's space. */
export const relativeTo = (parent: Matrix, child: Matrix): Matrix => multiply(invert(parent), child);
