// The targets of docs/TARGETS.md as data (scripts/bench/targets.json) and how a measured row is judged and printed.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {round} from './stats';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const TARGETS_JSON = path.join(ROOT, 'scripts/bench/targets.json');

export type Better = 'lower' | 'higher' | 'rule';
export type MetricSpec = {key: string; label: string; unit: string; better: Better; target: number | null; ceiling: number | null; rule?: string};
export type BenchName = 'canvas' | 'edit-ops' | 'collab-load' | 'codec' | 'durability' | 'open-save' | 'export' | 'api' | 'cost';
export type Machine = 'laptop' | 'dev-4' | 'bench-ru';
export type TargetRow = {id: string; section: string; bench: BenchName; lane: string; star: boolean; cells: [string, string, string, string, string, string]; metrics: MetricSpec[]};
export type TargetSection = {id: string; title: string; bench: BenchName; machines: Machine[]};
export type TargetsFile = {version: 1; doc: string; tableHeader: string; tableRule: string; sections: TargetSection[]; rows: TargetRow[]};

export function loadTargets(file = TARGETS_JSON): TargetsFile {
  return JSON.parse(readFileSync(file, 'utf8')) as TargetsFile;
}

export type State = 'green' | 'yellow' | 'red' | 'n.a.';

/**
 * What a bench reports for one row. `values` by metric key (the units of targets.json); `pass` for a rule row; `na` (the reason)
 * when the row cannot be measured on this code or machine. `provisional` says why the number does not count yet (load on the Mac,
 * a stand-in scenario). `notes` are printed under the table.
 */
export type RowResult = {
  id: string;
  values?: Record<string, number>;
  pass?: boolean;
  /** Free text in place of the numbers (a rule row's observed behaviour). */
  text?: string;
  na?: string;
  provisional?: string;
  notes?: string[];
  /** Raw numbers worth keeping in the history (not judged). */
  extra?: Record<string, unknown>;
  /** What the row measured (lane B5): `collab` (DESIGN_COLLAB=rust, the socket), `legacy` (SSE + PATCH), `api`, … */
  path?: string;
};

/** The state of one metric: green at or better than the target, yellow up to the ceiling, red past it. */
export function metricState(spec: MetricSpec, value: number | undefined): State {
  if (value === undefined || Number.isNaN(value) || spec.target === null || spec.ceiling === null) return 'n.a.';
  if (spec.better === 'higher') return value >= spec.target ? 'green' : value >= spec.ceiling ? 'yellow' : 'red';
  return value <= spec.target ? 'green' : value <= spec.ceiling ? 'yellow' : 'red';
}

const ORDER: State[] = ['green', 'yellow', 'red'];
/** A row is as bad as its worst measured metric; n.a. when nothing was measured. */
export function rowState(row: TargetRow, result: RowResult | undefined): State {
  if (!result || result.na) return 'n.a.';
  if (row.metrics.every(spec => spec.better === 'rule')) return result.pass === undefined ? 'n.a.' : result.pass ? 'green' : 'red';
  const states = row.metrics.filter(spec => spec.better !== 'rule').map(spec => metricState(spec, result.values?.[spec.key])).filter(state => state !== 'n.a.');
  if (!states.length) return 'n.a.';
  return ORDER[Math.max(...states.map(state => ORDER.indexOf(state)))];
}

/** "58.2 fps / 18.1 ms", metrics in the row's order; a missing one is "–". */
export function formatActual(row: TargetRow, result: RowResult | undefined): string {
  if (!result) return 'not measured';
  if (result.na) return 'n.a.: ' + result.na;
  if (result.text && !result.values) return result.text;
  const parts = row.metrics
    .filter(spec => spec.better !== 'rule')
    .map(spec => {
      const value = result.values?.[spec.key];
      return value === undefined || Number.isNaN(value) ? '–' : `${round(value)} ${spec.unit}`.trim();
    });
  const text = parts.join(' / ');
  return result.text ? `${text} (${result.text})` : text;
}

export function parseOnly(only: string | undefined, rows: readonly TargetRow[]): TargetRow[] {
  if (!only) return [...rows];
  const wanted = only.split(',').map(token => token.trim()).filter(Boolean);
  return rows.filter(row => wanted.some(token => row.id === token || (/^[A-Z]$/.test(token) && row.id[0] === token)));
}
