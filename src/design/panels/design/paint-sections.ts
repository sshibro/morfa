import type {DesignDocument, StyleType} from '../../../../shared/design/types';
import type {DesignSection} from './sections';
import {registerPaintFeature} from './paint';
import {EffectsSection} from './paint/EffectsSection';
import {ColorStylesSection, EffectStylesSection} from './paint/LocalStylesSection';
import {FillSection, StrokeSection} from './paint/PaintSection';
import {takesEffects, takesFills, takesStrokes} from './paint/paints';
import {SelectionColorsSection} from './paint/SelectionColorsSection';

// The "Design" panel sections owned by the paint feature (see sections.ts for the order numbers):
// fill, stroke, selection colours and effects; with nothing selected, the file's colour and effect
// styles. The page background (PageBackgroundSection) is exported from ./paint for the page panel.

registerPaintFeature();

const hasStyles = (doc: DesignDocument, type: StyleType) => {
  // Local styles only: a shared library's copies are read-only and listed under their library in "Assets".
  for (const id in doc.styles) if (doc.styles[id].type === type && !doc.styles[id].remote) return true;
  return false;
};

export const paintSections: DesignSection[] = [
  {id: 'fill', order: 70, applies: ({nodes}) => nodes.some(node => takesFills(node.type)), Component: FillSection},
  {id: 'stroke', order: 80, applies: ({nodes}) => nodes.some(node => takesStrokes(node.type)), Component: StrokeSection},
  {id: 'selection-colors', order: 90, applies: ({nodes}) => nodes.length > 1 || nodes.some(node => (node.children?.length ?? 0) > 0), Component: SelectionColorsSection},
  {id: 'effects', order: 100, applies: ({nodes}) => nodes.some(node => takesEffects(node.type)), Component: EffectsSection},
  {id: 'color-styles', order: 120, applies: ({ids, doc}) => !ids.length && hasStyles(doc, 'FILL'), Component: ColorStylesSection},
  {id: 'effect-styles', order: 121, applies: ({ids, doc}) => !ids.length && hasStyles(doc, 'EFFECT'), Component: EffectStylesSection},
];
