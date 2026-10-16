import {test, expect} from '@playwright/test';
import {EXACT_ARGS, REF_FILE, openHarness, referenceTree, runExact, startExactServer, type ExactServer} from '../../scripts/canvas-exact/run';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// The exact Canvas2D pixel test (scripts/canvas-exact/run.ts): the
// painter and the scene renderer of this tree against the reference commit's, byte for byte, on every golden fixture
// and a text-heavy page, through a script of edits. A change that means to change the picture moves
// scripts/canvas-exact/REF in the same commit.

test.use({launchOptions: {args: EXACT_ARGS, ...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {})}});
test.setTimeout(20 * 60_000);

let server: ExactServer | null = null;
test.afterAll(async () => {
  await server?.close();
});

/** Whether this repository has the reference commit: a copy without the history it was made in (the open-source release) never does. */
const hasCommit = (rev: string) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
};

test('the Canvas2D painter and scene renderer paint exactly what the reference commit paints', async ({page}) => {
  const reference = readFileSync(REF_FILE, 'utf8').trim();
  test.skip(!hasCommit(reference), `scripts/canvas-exact/REF names commit ${reference}, which this repository does not have: the reference picture cannot be built.`);
  const refDir = referenceTree(reference);
  server = await startExactServer(refDir);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHarness(page, server, refDir);
  const report = await runExact(page);
  console.log(`canvas-exact: ${report.compared} pictures compared, ${report.failures.length} differ`);
  expect(errors).toEqual([]);
  expect(report.compared).toBeGreaterThan(300);
  expect(report.failures).toEqual([]);
});
