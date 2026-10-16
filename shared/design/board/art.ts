// "Board": the drawings of stamps and stickers (docs/board.md §Stamps, §Stickers), as SVG path data. Stamps are 24-unit icons on a
// round badge; stickers are small flat illustrations with a dark outline in a 96-unit box, FigJam's playful style. Pure data: the
// layers are made from it by create.ts, so a sticker on the canvas is ordinary vectors (they export and print like anything else).

import type {StampId} from './types';

export type StampSpec = {
  id: StampId;
  label: string;
  /** The badge's colour. */
  color: string;
  /** A 24-unit icon (filled white unless `stroke`), or a glyph drawn as text. */
  icon?: string;
  stroke?: boolean;
  glyph?: string;
};

/** The stamp wheel's order (E), FigJam's set and a few more; 'avatar' is the author's own initials. */
export const STAMPS: readonly StampSpec[] = [
  {id: 'heart', label: 'Heart', color: '#FF4D4D', icon: 'M12 20.5s-7.6-4.6-9.4-9.2C1.2 7.9 3.4 4.6 6.8 4.6c2.1 0 3.7 1.1 5.2 3 1.5-1.9 3.1-3 5.2-3 3.4 0 5.6 3.3 4.2 6.7-1.8 4.6-9.4 9.2-9.4 9.2z'},
  {id: 'like', label: 'Like', color: '#14AE5C', icon: 'M3 10.5h3.6V21H3zM8.6 21h8.1c1 0 1.8-.7 2-1.6l1.6-6.6c.3-1.3-.7-2.6-2-2.6h-4.6l.8-3.8c.2-1-.5-2-1.5-2.2-.6-.1-1.1.2-1.4.7L8.6 10.5z'},
  {id: 'dislike', label: 'Dislike', color: '#FF8A1F', icon: 'M3 3h3.6v10.5H3zM8.6 3h8.1c1 0 1.8.7 2 1.6l1.6 6.6c.3 1.3-.7 2.6-2 2.6h-4.6l.8 3.8c.2 1-.5 2-1.5 2.2-.6.1-1.1-.2-1.4-.7L8.6 13.5z'},
  {id: 'star', label: 'Star', color: '#FFB800', icon: 'M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.3l-5.7 3 1.1-6.3-4.6-4.5 6.4-.9z'},
  {id: 'question', label: 'Question', color: '#9747FF', glyph: '?'},
  {id: 'plus-one', label: '+1', color: '#0D99FF', glyph: '+1'},
  {id: 'check', label: 'Done', color: '#1BAE9F', icon: 'M5 12.6l4.4 4.4L19 7.4', stroke: true},
  {id: 'fire', label: 'Fire', color: '#FF5A1F', icon: 'M12.2 2.5c.8 3.4 5.3 5.5 5.3 10.6a5.5 5.5 0 0 1-11 0c0-2.4 1.2-4 2.6-5.1.2 1.7.9 2.9 2.2 3.5-.4-3.3-.1-6.5.9-9z'},
  {id: 'avatar', label: 'My stamp', color: '#7B61FF'},
];

export const stampSpec = (id: StampId): StampSpec => STAMPS.find(stamp => stamp.id === id) ?? STAMPS[0];

/** Initials of a display name for the avatar stamp: "Anna Smith" → "AS", "kirill" → "K". */
export function initialsOf(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length > 1 ? [words[0], words[words.length - 1]].map(word => [...word][0]) : [[...words[0]][0]];
  return letters.join('').toUpperCase();
}

/** A colour for someone's avatar stamp, the same for the same name. */
export function avatarColor(name: string | undefined): string {
  const palette = ['#7B61FF', '#0D99FF', '#14AE5C', '#FF8A1F', '#FF4D4D', '#E040A0', '#1BAE9F', '#B37A00'];
  let hash = 0;
  for (const char of name ?? '') hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return palette[hash % palette.length];
}

// ── Stickers ─────────────────────────────────────────────────────────────────────────────────────

/** One layer of a sticker: a path (or an ellipse: cx, cy, rx, ry) with a fill and an outline. */
export type StickerLayer =
  | {d: string; fill?: string; stroke?: string; width?: number; cap?: 'round'}
  | {ellipse: [number, number, number, number]; fill?: string; stroke?: string; width?: number};

export type StickerSpec = {id: string; label: string; keywords: string; layers: StickerLayer[]};

const INK = '#1E1E1E';
const W = 3;

export const STICKERS: readonly StickerSpec[] = [
  {
    id: 'light-bulb', label: 'Light bulb', keywords: 'idea lamp light thought',
    layers: [
      {d: 'M48 6v8M18 18l6 6M78 18l-6 6M8 46h8M80 46h8', stroke: INK, width: W, cap: 'round'},
      {d: 'M48 18c-15.5 0-27 11.6-27 26.4 0 9.4 4.8 15.6 9.6 20.4 3 3 4.4 6 4.4 9.4V78h26v-3.8c0-3.4 1.4-6.4 4.4-9.4 4.8-4.8 9.6-11 9.6-20.4C75 29.6 63.5 18 48 18z', fill: '#FFD94D', stroke: INK, width: W},
      {d: 'M40 70v-12c0-4 8-4 8 2 0-6 8-6 8-2v12', stroke: '#FF9F1A', width: W, cap: 'round'},
      {d: 'M33 30c-4 4-5.6 8.6-5.4 13', stroke: '#FFFFFF', width: 4, cap: 'round'},
      {d: 'M35 78h26v6c0 3.3-2.7 6-6 6H41c-3.3 0-6-2.7-6-6z', fill: '#B3B3B3', stroke: INK, width: W},
      {d: 'M36 84h24', stroke: INK, width: W, cap: 'round'},
    ],
  },
  {
    id: 'rocket', label: 'Rocket', keywords: 'launch start growth',
    layers: [
      {d: 'M40 66c-6 4-9 12-8 22 10 1 18-2 22-8z', fill: '#FF8A1F', stroke: INK, width: W},
      {d: 'M42 68c-3 3-4.5 7-4 12 5 .5 9-1 11-4z', fill: '#FFD94D'},
      {d: 'M30 50L16 56l8 12 12-4zM46 66l-6 14 12 8 4-14z', fill: '#FF4D4D', stroke: INK, width: W},
      {d: 'M80 10C62 10 44 22 32 46l18 18c24-12 36-30 36-48 0-3.3-2.7-6-6-6z', fill: '#F5F5F5', stroke: INK, width: W},
      {ellipse: [62, 34, 8, 8], fill: '#5CC2FF', stroke: INK, width: W},
      {d: 'M74 12c2 4 6 8 10 10', stroke: INK, width: W, cap: 'round'},
    ],
  },
  {
    id: 'star', label: 'Star', keywords: 'best favorite great',
    layers: [
      {d: 'M48 8l11.4 23.2 25.6 3.7-18.5 18 4.4 25.5L48 66.4 25.1 78.4l4.4-25.5L11 34.9l25.6-3.7z', fill: '#FFD94D', stroke: INK, width: W},
      {d: 'M48 22l6.6 13.4', stroke: '#FFFFFF', width: 4, cap: 'round'},
      {d: 'M80 70l2.2 5.4 5.8.6-4.4 3.8 1.3 5.7L80 82.5l-4.9 3 1.3-5.7-4.4-3.8 5.8-.6z', fill: '#FF9F1A', stroke: INK, width: 2},
      {d: 'M16 70v8M12 74h8', stroke: INK, width: W, cap: 'round'},
    ],
  },
  {
    id: 'heart', label: 'Heart', keywords: 'love like heart',
    layers: [
      {d: 'M48 84S12 62 10 38C8.6 22 20 12 32 12c7.6 0 12.6 4 16 9.4C51.4 16 56.4 12 64 12c12 0 23.4 10 22 26-2 24-38 46-38 46z', fill: '#FF4D6A', stroke: INK, width: W},
      {d: 'M24 28c-3 2-4.4 6-4 10', stroke: '#FFFFFF', width: 4, cap: 'round'},
    ],
  },
  {
    id: 'fire', label: 'Fire', keywords: 'hot urgent cool',
    layers: [
      {d: 'M50 6c4 16 26 26 26 50 0 16-12.5 30-28 30S20 72 20 56c0-11 5.6-18.6 12-23.6 1 7.8 4.2 13.4 10.4 16.2C40.6 33 41.4 18 50 6z', fill: '#FF6A2B', stroke: INK, width: W},
      {d: 'M48 50c2 8 14 12 14 22 0 7.6-6.3 13-14 13s-14-5.4-14-13c0-5 2.6-8.6 5.6-11 .6 3.6 2 6.2 5 7.6C44 62 44.6 56 48 50z', fill: '#FFD94D'},
    ],
  },
  {
    id: 'thumbs-up', label: 'Thumbs up', keywords: 'yes agree approve',
    layers: [
      {d: 'M12 42h16v44H12z', fill: '#0D99FF', stroke: INK, width: W},
      {d: 'M28 86h34c4.6 0 8.4-3.2 9.4-7.6l6-26c1.4-6-3.2-11.4-9.4-11.4H50l3-14.6c1-5-2.4-9.6-7.4-10.4-3-.4-5.8 1-7.2 3.6L28 42z', fill: '#FFCF8C', stroke: INK, width: W},
      {d: 'M60 52h12M58 64h12M56 76h10', stroke: INK, width: 2.5, cap: 'round'},
    ],
  },
  {
    id: 'check', label: 'Done', keywords: 'done yes accepted',
    layers: [
      {ellipse: [48, 48, 38, 38], fill: '#2BC46C', stroke: INK, width: W},
      {d: 'M30 49l12 12 25-26', stroke: '#FFFFFF', width: 8, cap: 'round'},
    ],
  },
  {
    id: 'party', label: 'Party popper', keywords: 'party hooray win',
    layers: [
      {d: 'M10 86l14-46 32 32z', fill: '#9747FF', stroke: INK, width: W},
      {d: 'M17 63l8 8M21 50l18 18', stroke: '#FFD94D', width: 4, cap: 'round'},
      {d: 'M40 30c4-8 2-14-4-18M58 24c8-6 16-6 22 0M64 44c8 0 14 4 16 10', stroke: INK, width: W, cap: 'round'},
      {ellipse: [52, 10, 4, 4], fill: '#FF4D6A'},
      {ellipse: [84, 32, 4, 4], fill: '#0D99FF'},
      {ellipse: [74, 66, 4, 4], fill: '#FFB800'},
      {ellipse: [30, 22, 3.5, 3.5], fill: '#2BC46C'},
    ],
  },
  {
    id: 'coffee', label: 'Coffee', keywords: 'break pause tea',
    layers: [
      {d: 'M36 8c-4 6 4 8 0 14M48 6c-4 6 4 8 0 14M60 8c-4 6 4 8 0 14', stroke: '#B3B3B3', width: W, cap: 'round'},
      {d: 'M70 44h6c6.6 0 12 5.4 12 12s-5.4 12-12 12h-6', stroke: INK, width: W},
      {d: 'M16 32h56v28c0 15.5-12.5 28-28 28S16 75.5 16 60z', fill: '#FFFFFF', stroke: INK, width: W},
      {d: 'M16 32h56v10H16z', fill: '#8B5A3C', stroke: INK, width: W},
    ],
  },
  {
    id: 'trophy', label: 'Trophy', keywords: 'win first place award',
    layers: [
      {d: 'M24 18H12v8c0 10 6 16 16 18M72 18h12v8c0 10-6 16-16 18', stroke: INK, width: W},
      {d: 'M24 10h48v24c0 13.3-10.7 24-24 24S24 47.3 24 34z', fill: '#FFC21A', stroke: INK, width: W},
      {d: 'M42 58h12v12H42z', fill: '#E0A500', stroke: INK, width: W},
      {d: 'M30 70h36v14H30z', fill: '#8B5A3C', stroke: INK, width: W},
      {d: 'M34 18v14', stroke: '#FFFFFF', width: 4, cap: 'round'},
    ],
  },
  {
    id: 'question', label: 'Question', keywords: 'unclear ask why',
    layers: [
      {d: 'M18 12h60c5.5 0 10 4.5 10 10v38c0 5.5-4.5 10-10 10H44L26 86l2-16H18c-5.5 0-10-4.5-10-10V22c0-5.5 4.5-10 10-10z', fill: '#B48CFF', stroke: INK, width: W},
      {d: 'M38 32c0-6 4.6-10 10-10s10 4 10 9.6c0 7.4-10 7.4-10 15.4', stroke: '#FFFFFF', width: 6, cap: 'round'},
      {ellipse: [48, 58, 4, 4], fill: '#FFFFFF'},
    ],
  },
  {
    id: 'target', label: 'Target', keywords: 'goal task focus',
    layers: [
      {ellipse: [44, 52, 36, 36], fill: '#FF4D4D', stroke: INK, width: W},
      {ellipse: [44, 52, 24, 24], fill: '#FFFFFF', stroke: INK, width: W},
      {ellipse: [44, 52, 12, 12], fill: '#FF4D4D', stroke: INK, width: W},
      {d: 'M44 52L82 14', stroke: INK, width: W, cap: 'round'},
      {d: 'M74 10l8 4 4 8-8-2z', fill: '#FFD94D', stroke: INK, width: 2.5},
    ],
  },
  {
    id: 'smile', label: 'Smile', keywords: 'joy good happy',
    layers: [
      {ellipse: [48, 48, 38, 38], fill: '#FFD94D', stroke: INK, width: W},
      {ellipse: [35, 40, 4.5, 6], fill: INK},
      {ellipse: [61, 40, 4.5, 6], fill: INK},
      {d: 'M30 58c4 9 11 13 18 13s14-4 18-13', stroke: INK, width: W, cap: 'round'},
      {ellipse: [26, 56, 5, 3.5], fill: '#FF9F8C'},
      {ellipse: [70, 56, 5, 3.5], fill: '#FF9F8C'},
    ],
  },
  {
    id: 'sparkles', label: 'Sparkles', keywords: 'magic new wonder',
    layers: [
      {d: 'M40 14c3 16 10 23 26 26-16 3-23 10-26 26-3-16-10-23-26-26 16-3 23-10 26-26z', fill: '#FFD94D', stroke: INK, width: W},
      {d: 'M72 50c1.6 8.4 5.6 12.4 14 14-8.4 1.6-12.4 5.6-14 14-1.6-8.4-5.6-12.4-14-14 8.4-1.6 12.4-5.6 14-14z', fill: '#B48CFF', stroke: INK, width: W},
      {d: 'M24 66c1 5 3.4 7.4 8.4 8.4-5 1-7.4 3.4-8.4 8.4-1-5-3.4-7.4-8.4-8.4 5-1 7.4-3.4 8.4-8.4z', fill: '#5CC2FF', stroke: INK, width: 2.5},
    ],
  },
  {
    id: 'flag', label: 'Flag', keywords: 'milestone goal finish',
    layers: [
      {d: 'M22 10v80', stroke: INK, width: 4, cap: 'round'},
      {d: 'M22 14c14-8 26 6 40 0s20-4 24-2v36c-4-2-10-4-24 2s-26-8-40 0z', fill: '#2BC46C', stroke: INK, width: W},
    ],
  },
  {
    id: 'clock', label: 'Clock', keywords: 'time due deadline',
    layers: [
      {ellipse: [48, 50, 38, 38], fill: '#FFFFFF', stroke: INK, width: W},
      {d: 'M48 28v22l14 10', stroke: INK, width: 4, cap: 'round'},
      {d: 'M22 10l-12 10M74 10l12 10', stroke: INK, width: 4, cap: 'round'},
      {ellipse: [48, 50, 3.5, 3.5], fill: '#FF4D4D'},
    ],
  },
];

export const stickerSpec = (id: string): StickerSpec | undefined => STICKERS.find(sticker => sticker.id === id);
