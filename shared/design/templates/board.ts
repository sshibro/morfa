import type {NodeId} from '../types';
import type {Font, TemplateBuilder} from './kit';

// A documentation board, the way design teams lay out a components or styles page: a white sheet with a
// title and a lead, then one section per family (name, one line on when to use it, the specimens).

const INK = '#111318';
const MUTED = '#6B7080';
const RULE = '#E4E6EB';

export type BoardOptions = {title: string; lead: string; x?: number; y?: number; width?: number; family?: string};
export type Board = {
  id: NodeId;
  /** A titled section; returns the frame its specimens go in (a wrapping row). */
  section(title: string, note: string, options?: {gap?: number; direction?: 'row' | 'col'}): NodeId;
};

export function docBoard(b: TemplateBuilder, pageId: NodeId, options: BoardOptions): Board {
  const family = options.family ?? 'Inter';
  const title: Font = {family, weight: 700, size: 40, line: 48, tracking: -2};
  const lead: Font = {family, weight: 400, size: 18, line: 28};
  const heading: Font = {family, weight: 600, size: 20, line: 28, tracking: -1};
  const note: Font = {family, weight: 400, size: 14, line: 20};

  const id = b.frame(pageId, {
    name: options.title, x: options.x ?? 0, y: options.y ?? 0, layout: 'col', w: options.width ?? 1280, h: 'hug', pad: [64, 64, 80, 64], gap: 56,
    fill: '#FFFFFF', radius: 24, clip: false,
  });
  const head = b.frame(id, {name: 'Heading', layout: 'col', gap: 12, w: 'fill'});
  b.text(head, options.title, title, {color: INK});
  b.text(head, options.lead, lead, {color: MUTED, w: 640});

  return {
    id,
    section(name, text, {gap = 24, direction = 'row'} = {}) {
      const section = b.frame(id, {name, layout: 'col', gap: 24, w: 'fill', pad: [32, 0, 0, 0], stroke: RULE, strokeWeight: 1, strokeAlign: 'INSIDE'});
      b.update(section, {individualStrokeWeights: {top: 1, right: 0, bottom: 0, left: 0}});
      const label = b.frame(section, {name: 'Description', layout: 'col', gap: 4, w: 'fill'});
      b.text(label, name, heading, {color: INK});
      b.text(label, text, note, {color: MUTED, w: 560});
      return b.frame(section, {name: 'Samples', layout: direction, gap, wrap: direction === 'row', w: direction === 'row' ? 'fill' : 'hug', cross: 'start'});
    },
  };
}
