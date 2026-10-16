// Writes the target tables of docs/TARGETS.md from scripts/bench/targets.json, so the numbers have one source.
//   tsx scripts/bench/targets-md.ts            rewrite the tables in docs/TARGETS.md
//   tsx scripts/bench/targets-md.ts --check    exit 1 when the file differs from what the JSON gives (byte for byte)
// Each section `## <id>. …` of the JSON keeps its prose; only its table (the header row, the rule and the row lines) is written.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ROOT, loadTargets, type TargetsFile} from './lib/targets';

export function renderTargetsMarkdown(source: string, targets: TargetsFile): string {
  const lines = source.split('\n');
  for (const section of targets.sections) {
    const heading = lines.findIndex(line => line.startsWith(`## ${section.id}. `));
    if (heading < 0) throw Error(`docs/TARGETS.md has no section "## ${section.id}."`);
    const start = lines.findIndex((line, index) => index > heading && line === targets.tableHeader);
    if (start < 0) throw Error(`section ${section.id} has no table header`);
    let end = start;
    while (end < lines.length && lines[end].startsWith('|')) end++;
    const rows = targets.rows.filter(row => row.section === section.id).map(row => '| ' + row.cells.join(' | ') + ' |');
    lines.splice(start, end - start, targets.tableHeader, targets.tableRule, ...rows);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts/bench/targets-md.ts');
if (isMain) {
  const file = path.join(ROOT, 'docs/TARGETS.md');
  const current = readFileSync(file, 'utf8');
  const next = renderTargetsMarkdown(current, loadTargets());
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('docs/TARGETS.md differs from scripts/bench/targets.json: run npm run targets:md');
      process.exit(1);
    }
    console.log('docs/TARGETS.md tables match scripts/bench/targets.json (byte-identical).');
  } else if (next !== current) {
    writeFileSync(file, next);
    console.log('docs/TARGETS.md tables rewritten from scripts/bench/targets.json.');
  } else console.log('docs/TARGETS.md already matches scripts/bench/targets.json.');
}
