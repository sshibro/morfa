import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startCollab} from './collab-binary';

// The legacy PostgreSQL suites in the other two DESIGN_COLLAB modes. A wrapper file
// (`tests/postgresql-runtime-design-<suite>.<mode>.test.ts`) starts the collab binary, points the api at it with the
// switch set for the whole process, then loads the suite itself: every one of its tests runs unchanged.
//
//   shadow  every PATCH the suite makes that Node accepts (and every whole-document write) is forwarded to collab's
//           /internal/shadow-op; after the suite one more test requires 0 differences and that forwards happened.
//   rust    no test of these suites opens a socket, so no node ever holds a lease: the suites prove that in rust mode the legacy
//           path still serves every file a node does not hold (PATCH, SSE, the store's reads and catch-ups, compaction of Node's own
//           rows), with the lease checks in every write path. The rust paths themselves are the collab-session, -cutover suites.

export async function collabModeSuite(mode: 'shadow' | 'rust', suite: string, load: () => Promise<unknown>) {
  const collab = await startCollab();
  // Differences are kept where the run's other output goes (gitignored), not in the suite's temporary data folder.
  const log = path.resolve('output', 'B6', 'suites', `${suite}-${mode}-${process.pid}`, 'mismatches.jsonl');
  Object.assign(process.env, collab.apiEnv, {DESIGN_COLLAB: mode, DESIGN_COLLAB_SHADOW_LOG: log});
  after(() => collab.stop());
  await load();
  if (mode === 'shadow')
    test('shadow: every forward of the suite matched collab’s copy', async () => {
      const shadow = await import('../../server/design/collab/shadow');
      await shadow.shadowIdle();
      const stats = shadow.shadowStats();
      console.log(`shadow forwards of the suite: ${JSON.stringify(stats)}`);
      assert.ok(stats.forwarded > 0, 'the suite’s saves reached collab');
      assert.equal(stats.unavailable, 0);
      assert.equal(stats.mismatches, 0, `differences: npx tsx scripts/collab-shadow-report.ts ${log}`);
    });
  else
    test('rust: the suite ran with the switch at rust and no file went to the node', async () => {
      const {fileCollabMode} = await import('../../server/design/collab/switch');
      assert.equal(fileCollabMode({user_id: 'anyone', team_id: null}), 'rust');
      const health = (await (await fetch(collab.url + '/healthz')).json()) as {docs: number; conns: number};
      assert.deepEqual({docs: health.docs, conns: health.conns}, {docs: 0, conns: 0});
    });
}
