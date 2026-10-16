import type {DesignSection} from './sections';
import {TextSection} from './text/TextSection';
import {TextPathSection} from './text/TextPathSection';

// The "Design" panel sections owned by the text feature (see sections.ts for the order numbers).
export const textSections: DesignSection[] = [
  {id: 'text', order: 60, applies: selection => selection.nodes.some(node => node.type === 'TEXT'), Component: TextSection},
  // "Text on path": where the text starts on its path, its side, and leaving the path.
  {id: 'text-path', order: 61, applies: selection => selection.nodes.some(node => !!node.textPath), Component: TextPathSection},
];
