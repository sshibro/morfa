// A closing run's rows as Prometheus gauges for node_exporter's textfile collector (lane B5), so Grafana's TARGETS dashboard
// (scripts/deploy/dashboards.ts) draws every close.sh run beside production's live values, under the same row ids:
//   morfa_target_actual{row,metric,profile,hash}   the measured value, in the row's unit
//   morfa_target_pass{row,profile,hash}            rule rows: 1 passes, 0 fails
//   morfa_target_state{row,profile,hash,state}     1 for the row's colour (green, yellow, red, n.a.)
//
//   npx tsx scripts/deploy/targets-prom.ts --results output/bench/targets-bench-ru-…/results.json --profile cores4 --hash <hash> \
//     --out /var/lib/morfa/textfile/morfa_targets_cores4.prom
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTargets, rowState, type RowResult, type TargetsFile} from '../bench/lib/targets';

const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function targetsExposition(targets: TargetsFile, results: Record<string, RowResult>, profile: string, hash: string): string {
  const labels = (extra: Record<string, string>) =>
    '{' + Object.entries({...extra, profile, hash}).map(([key, value]) => `${key}="${escape(value)}"`).join(',') + '}';
  const actual: string[] = [], pass: string[] = [], state: string[] = [];
  for (const row of targets.rows) {
    const result = results[row.id];
    if (!result) continue;
    state.push(`morfa_target_state${labels({row: row.id, state: rowState(row, result)})} 1`);
    if (result.na) continue;
    if (row.metrics.every(metric => metric.better === 'rule')) {
      if (result.pass !== undefined) pass.push(`morfa_target_pass${labels({row: row.id})} ${result.pass ? 1 : 0}`);
      continue;
    }
    for (const metric of row.metrics) {
      const value = result.values?.[metric.key];
      if (typeof value === 'number' && Number.isFinite(value)) actual.push(`morfa_target_actual${labels({row: row.id, metric: metric.key})} ${value}`);
    }
  }
  return [
    '# HELP morfa_target_actual A TARGETS row measured by scripts/bench/close.sh, in the row\'s unit.',
    '# TYPE morfa_target_actual gauge',
    ...actual,
    '# HELP morfa_target_pass A TARGETS rule row: 1 passes, 0 fails.',
    '# TYPE morfa_target_pass gauge',
    ...pass,
    '# HELP morfa_target_state The colour of a TARGETS row in the closing run.',
    '# TYPE morfa_target_state gauge',
    ...state,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const resultsFile = option('results'), profile = option('profile'), hash = option('hash'), out = option('out');
  if (!resultsFile || !profile || !hash || !out) {
    console.error('usage: targets-prom.ts --results <results.json> --profile <cores4|cores8> --hash <hash> --out <file.prom>');
    process.exit(2);
  }
  const text = targetsExposition(loadTargets(), JSON.parse(readFileSync(resultsFile, 'utf8')), profile, hash);
  // The collector must never read half a file.
  writeFileSync(out + '.tmp', text);
  renameSync(out + '.tmp', out);
  console.log(`wrote ${out}`);
}
