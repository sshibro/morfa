import type {AccountSegment} from '../../shared/admin-analytics';

// Chart colours by the job they do (the dataviz method): the values are CSS custom properties on `.mfa` (admin.css), light and dark,
// so a chart names a role and never a hex.
//
// Categorical, fixed order, never cycled: indigo (Morfa's #4338ff), orange, aqua, amber, pink, green, sky, red. Validated with the
// dataviz validator on white and on the dark workspace (#1c1c1f): every adjacent pair clears CVD ΔE 8 (worst 9.1 light, 8.4 dark)
// and the normal-vision floor 15 (19.6 / 19.3); the first three clear all pairs. Aqua, amber and pink sit under 3:1 on white, so
// every chart that uses them carries a legend with values and a table for screen readers.
export const SERIES = Array.from({length: 8}, (_, index) => `var(--mfa-viz-${index + 1})`);
export const seriesColor = (index: number) => SERIES[Math.min(index, SERIES.length - 1)];

/** Segments wear categorical hues: the live accounts the brand, the accounts being closed their own. */
export const SEGMENT_COLOR: Record<AccountSegment, string> = {
  active: 'var(--mfa-seg-active)',
  closing: 'var(--mfa-seg-closing)',
};

export const SEGMENT_LABEL: Record<AccountSegment | 'all', string> = {
  all: 'All',
  active: 'Active',
  closing: 'Being deleted',
};

/** One account's segment, as a pill says it. */
export const SEGMENT_ONE: Record<AccountSegment, string> = {
  active: 'active',
  closing: 'being deleted',
};

/** Sequential (magnitude: heatmap, cohorts): one indigo hue, 7 steps, near-zero recedes into the surface; dark flips the anchor. */
export const SEQUENTIAL = Array.from({length: 7}, (_, index) => `var(--mfa-seq-${index})`);
/** The bin of a 0..1 share on the sequential ramp; exactly 0 is the empty step. */
export const sequentialStep = (share: number) => (share <= 0 ? 0 : Math.min(6, 1 + Math.floor(share * 5.999)));
/** Steps dark enough for white text. */
export const sequentialInk = (step: number) => (step >= 4 ? 'var(--mfa-seq-ink-strong)' : 'var(--mfa-seq-ink)');

/** Ordinal (funnel stages): five indigo steps, darkest first, the lightest still 2:1 on the surface. */
export const ORDINAL = Array.from({length: 5}, (_, index) => `var(--mfa-ord-${index})`);
