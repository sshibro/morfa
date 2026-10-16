import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {rm} from 'node:fs/promises';
import path from 'node:path';
import {collabApp, smallDocument, type Account} from './helpers/collab-app';
import {recordShadowRun, shadowFuzz} from './helpers/collab-shadow-fuzz';
import {formatShadowReport, readShadowReport} from '../scripts/collab-shadow-report';
import type {SceneNode} from '../shared/design/types';

// DESIGN_COLLAB=shadow (docs/BACKEND.md §7 step 2): Node stays authoritative and every accepted PATCH (and every
// PUT, which re-seeds) also goes to lane B1's POST /internal/shadow-op; collab answers its copy's hash and the api compares it with
// its own document's. The pass condition is 10 000 fuzz ops with 0 differences (MORFA_SHADOW_FUZZ_OPS=10000; the gate runs 400).
// A difference is logged with a replayable case and scripts/collab-shadow-report.ts prints it with the first differing path.

const OPS = Number(process.env.MORFA_SHADOW_FUZZ_OPS || 400);

test('collab shadow: legacy PATCH forwarded to collab, hashes compared', {timeout: 3_600_000}, async t => {
  const c = await collabApp(t, {collab: {pg: false}, env: {DESIGN_COLLAB: 'shadow'}});
  const {files, ok} = c;
  const shadow = await import('../server/design/collab/shadow');
  const shadowLog = await import('../server/design/collab/shadow-log');
  const log = process.env.DESIGN_COLLAB_SHADOW_LOG!;
  shadow.resetShadow();

  const people: Account[] = [];
  const owned = new Map<string, string>();
  for (let i = 0; i < Math.ceil(OPS / 2 / 50) + 1; i++) {
    const who = await c.account('fuzz' + i);
    people.push(who);
    owned.set(who.id, ok(await files(who, '', {method: 'POST', json: {name: 'Fuzz ' + i}}), 201).file.id);
  }

  await t.test(`${OPS} fuzz ops through PATCH: every forward compared, 0 mismatches`, async () => {
    const started = performance.now();
    const counts = await shadowFuzz({accounts: people, files: owned, ops: OPS, seed: Number(process.env.MORFA_SHADOW_FUZZ_SEED || 1), request: files,
      progress: done => done % 2000 === 0 && console.error(`shadow fuzz: ${done}/${OPS} ops`)});
    await shadow.shadowIdle();
    const stats = shadow.shadowStats();
    await recordShadowRun(log, `fuzz ${OPS}`, counts, stats, (performance.now() - started) / 1000);
    console.log(`shadow fuzz: ${JSON.stringify(counts)} forwarder ${JSON.stringify(stats)}`);
    assert.ok(counts.ops >= OPS - 1, `ran ${counts.ops} ops`);
    assert.ok(counts.merged > 0, 'some second edits merged onto the first');
    // Every accepted PATCH and every PUT went to collab; each answer's hash was compared.
    assert.equal(stats.forwarded, counts.stored + counts.empty + counts.cases, JSON.stringify({counts, stats}));
    assert.equal(stats.compared, stats.forwarded);
    assert.equal(stats.unavailable, 0);
    assert.equal(stats.mismatches, 0, `differences: see ${log}`);
    assert.equal(stats.equal, stats.compared);
  });

  await t.test('the report prints the runs and no difference', async () => {
    const report = await readShadowReport(log);
    console.log(formatShadowReport(report));
    // MORFA_SHADOW_REPORT_DIR: keep this run's log.
    if (process.env.MORFA_SHADOW_REPORT_DIR) {
      const {cp, mkdir} = await import('node:fs/promises');
      await mkdir(process.env.MORFA_SHADOW_REPORT_DIR, {recursive: true});
      await cp(path.dirname(log), path.join(process.env.MORFA_SHADOW_REPORT_DIR, `seed-${process.env.MORFA_SHADOW_FUZZ_SEED || 1}-${Date.now()}`), {recursive: true});
    }
    assert.equal(report.differences.length, 0);
    assert.ok(report.runs.some(run => run.ops >= OPS - 1 && run.mismatches === 0));
  });

  await t.test('a difference is logged with the file, versions and a replayable case; the report lists it', async () => {
    // A node that answers one wrong hash: everything else is the real collab's answer.
    let corrupt = false;
    const fake: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const answer = await fetch(c.collab!.url + req.url, {method: req.method, headers: {authorization: String(req.headers.authorization), 'content-type': 'application/json'}, ...(req.method === 'GET' ? {} : {body: Buffer.concat(chunks)})});
      const body = (await answer.json()) as {hash?: string};
      if (corrupt && body.hash) body.hash = '0'.repeat(64);
      res.writeHead(answer.status, {'content-type': 'application/json'}).end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => fake.close(() => resolve())));
    const nodes = process.env.DESIGN_COLLAB_NODES;
    process.env.DESIGN_COLLAB_NODES = `${c.collab!.node}=http://127.0.0.1:${(fake.address() as {port: number}).port}`;
    try {
      const who = people[0], id = owned.get(who.id)!;
      const doc = smallDocument();
      const current = ok(await files(who, `/${id}`)).file.version as number;
      const put = ok(await files(who, `/${id}/document`, {method: 'PUT', json: {baseVersion: current, document: doc}}));
      await shadow.shadowIdle();
      corrupt = true;
      const a = doc.nodes.a as SceneNode;
      ok(await files(who, `/${id}/document`, {method: 'PATCH', json: {baseVersion: put.version, patch: {nodes: {a: {...a, x: 321}}}, before: {a}}}));
      await shadow.shadowIdle();
      corrupt = false;
      const report = await readShadowReport(log);
      const found = report.differences.find(entry => entry.file === id);
      assert.ok(found, 'logged');
      assert.equal(found.kind, 'hash');
      assert.equal(found.version, put.version + 1);
      assert.equal(found.appliedOn, put.version);
      assert.equal(found.collabHash, '0'.repeat(64));
      assert.ok(found.case, 'with a case');
      assert.match(found.path, /replay agrees/, 'the engines agree on this op: the difference was in the answer');
      assert.match(formatShadowReport(report), new RegExp(id));
    } finally {
      process.env.DESIGN_COLLAB_NODES = nodes;
      // The gate's report of this file stays clean of the injected difference.
      await rm(path.dirname(log), {recursive: true, force: true});
    }
  });

  await t.test('the first differing path of two documents', () => {
    assert.equal(shadowLog.firstDifference({nodes: {a: {x: 1, y: 2}}}, {nodes: {a: {x: 1, y: 3}}}), 'nodes.a.y');
    assert.equal(shadowLog.firstDifference({pages: ['p', 'q']}, {pages: ['p']}), 'pages[1]');
    assert.equal(shadowLog.firstDifference({a: 1, b: undefined}, {a: 1}), null);
  });

  await t.test('legacy forwards nothing', async () => {
    process.env.DESIGN_COLLAB = 'legacy';
    const before = shadow.shadowStats().forwarded;
    const who = people[1], id = owned.get(who.id)!;
    const opened = ok(await files(who, `/${id}`));
    const [first] = Object.values(opened.document.nodes as Record<string, SceneNode>).filter(n => n.type !== 'PAGE');
    ok(await files(who, `/${id}/document`, {method: 'PATCH', json: {baseVersion: opened.file.version, patch: {nodes: {[first.id]: {...first, name: 'legacy'}}}, before: {[first.id]: first}}}));
    await shadow.shadowIdle();
    assert.equal(shadow.shadowStats().forwarded, before);
  });
});
