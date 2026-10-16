import type {ComponentType} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {layoutSections} from './layout-sections';
import {paintSections} from './paint-sections';
import {textSections} from './text-sections';
import {componentSections} from './component-sections';
import {fileSections} from './file-sections';
import {marketplaceSections} from '../../marketplace/sections';

// The "Design" tab is a stack of sections, each owned by one feature and shown when it applies to the
// selection. Order follows Figma's panel: instance/component (10), frame presets and position (20),
// layout with auto layout (25), appearance (50), variable modes (55), text (60), fill (70), stroke (80), selection
// colours (90), effects (100), layout grid (105), export (110). A marketplace card's "Card" (15) sits above the position. With nothing selected: the page (first),
// local variables (115), text styles (119), colour styles (120), effect styles (121), grid styles (122).
// A feature adds its section to its own list; this file only merges.

export type SelectionInfo = {
  doc: DesignDocument;
  ids: readonly NodeId[];
  nodes: readonly SceneNode[];
};

export type SectionProps = {ids: readonly NodeId[]; nodes: readonly SceneNode[]};

export type DesignSection = {
  id: string;
  order: number;
  /** Shown only when true; with nothing selected, sections that describe the page (background, styles) may apply. */
  applies(selection: SelectionInfo): boolean;
  Component: ComponentType<SectionProps>;
};

export const DESIGN_SECTIONS: readonly DesignSection[] = [...componentSections, ...layoutSections, ...textSections, ...paintSections, ...fileSections, ...marketplaceSections]
  .sort((a, b) => a.order - b.order);
