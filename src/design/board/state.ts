import type {BoardShapeKind, ConnectorLine, StampId} from '../../../shared/design/board/types';
import type {StrokeMarker} from '../../../shared/design/types';
import {HIGHLIGHTER_COLORS, MARKER_COLORS, WASHI_COLORS} from '../../../shared/design/board/palette';
import {SHAPE_DEFAULT_FILL} from '../../../shared/design/board/create';

// "Board": what the person last chose in the trays (docs/board.md §Tools): the marker's kind, thickness and colours, the sticky's
// colour, the shape, the connector's line, the stamp. Not the document: kept per browser (localStorage, best effort) and read by
// the tools when they place something. A tiny external store for useSyncExternalStore.

export type MarkerKind = 'marker' | 'highlighter' | 'washi' | 'eraser';
export type BoardTray = 'marker' | 'sticky' | 'shape' | 'stamp' | 'plus' | null;

export type BoardChoices = {
  marker: MarkerKind;
  thick: boolean;
  /** Hex per drawing kind. */
  colors: {marker: string; highlighter: string; washi: string};
  stickyColor: string;
  shape: BoardShapeKind;
  /** The shapes' fill (a SHAPE_COLORS hex). */
  shapeFill: string;
  line: ConnectorLine;
  stamp: StampId;
  /** Text: the handwriting face or the plain one. */
  handwriting: boolean;
  /** The last connector style set from the toolbar: the next connector starts with it (FigJam remembers it in a file). */
  connector?: ConnectorLook;
  /** FigJam's custom washi tape: a picture uploaded into the open board (its ImageRef) that new tape is printed with; null for a
   *  colour. Only used while the board holds that picture. */
  washiImage?: string | null;
  /** FigJam's "Show templates for new files": the "+" sheet opens on a new, empty board unless this is false. */
  templatesOnNew?: boolean;
};

export type ConnectorLook = {color?: string; weight?: number; dashed?: boolean; startMarker?: StrokeMarker; endMarker?: StrokeMarker};

/** The style a new connector starts with. */
export const connectorLook = (): ConnectorLook => boardChoices().connector ?? {};

/** Remembers part of the connector style for the next connector. */
export const rememberConnectorLook = (look: ConnectorLook) => setBoardChoices({connector: {...boardChoices().connector, ...look}});

export const DEFAULT_CHOICES: BoardChoices = {
  marker: 'marker',
  thick: false,
  colors: {marker: MARKER_COLORS[0].hex, highlighter: HIGHLIGHTER_COLORS[0].hex, washi: WASHI_COLORS[0].hex},
  stickyColor: 'yellow',
  shape: 'square',
  shapeFill: SHAPE_DEFAULT_FILL,
  line: 'elbow',
  stamp: 'like',
  handwriting: false,
};

/** Stroke widths in page px: thin and thick, per kind (washi tape: its width). */
export const STROKE_WEIGHTS: Record<Exclude<MarkerKind, 'eraser'>, [number, number]> = {marker: [4, 10], highlighter: [18, 36], washi: [24, 40]};

const KEY = 'morfa.board.choices.v1';

function load(): BoardChoices {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_CHOICES;
    const value = JSON.parse(raw) as Partial<BoardChoices>;
    return {...DEFAULT_CHOICES, ...value, colors: {...DEFAULT_CHOICES.colors, ...(value.colors ?? {})}};
  } catch {
    return DEFAULT_CHOICES;
  }
}

let choices: BoardChoices | null = null;
const listeners = new Set<() => void>();

export function boardChoices(): BoardChoices {
  return (choices ??= load());
}

export function setBoardChoices(partial: Partial<BoardChoices>): void {
  choices = {...boardChoices(), ...partial};
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Private mode or a full store: the choice lasts for this visit.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeBoardChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
