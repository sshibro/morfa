// S-rows of docs/TARGETS.md §5 against a bench server. Legacy stores a document as JSON text in PostgreSQL (≤ 20 MB, ≤ 50 000
// layers) plus its changes after the text; there are no checkpoints. What can be measured is measured on f20k and named so.
//
//   tsx scripts/bench/open-save.ts --machine dev-4 [--only S1,S5,S6]
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench} from './lib/context';
import {accounts, api, cookieOf, createFile, fixtureText} from './lib/fixtures';
import {LoadWatch} from './lib/machine';
import {startServer} from './lib/server';
import {median} from './lib/stats';
import type {RowResult} from './lib/targets';

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  const load = new LoadWatch();
  try {
    const [owner] = await accounts(server, 1, 'opensave');
    let f100kRefusal = '';
    if (wants(ctx, 'S1', 'S5')) {
      const body = '{"name":"f100k","document":' + fixtureText('f100k') + '}';
      const answer = await api(server, owner, 'POST', '/api/design-files', body);
      f100kRefusal = `${answer.status} ${(JSON.parse(answer.text || '{}') as {code?: string}).code ?? ''}`.trim();
    }
    const file = await createFile(server, owner, 'f20k');
    if (wants(ctx, 'S1')) {
      // The f20k analog: a cold read after a restart (no parsed document in the process).
      await server.kill();
      await server.restart();
      const cold = await api(server, owner, 'GET', `/api/design-files/${file.id}`);
      const warm: number[] = [];
      for (let i = 0; i < 3; i++) warm.push((await api(server, owner, 'GET', `/api/design-files/${file.id}`)).ms);
      results.push({id: 'S1', na: `legacy refuses a 100 MB file (POST of f100k: ${f100kRefusal}; caps 20 MB / 50 000 layers) and has no checkpoint + journal tail; f20k (15.9 MB) cold open after a restart ${cold.ms.toFixed(0)} ms, warm ${median(warm).toFixed(0)} ms (GET, loopback)`});
    }
    if (wants(ctx, 'S2')) results.push({id: 'S2', na: 'legacy has no checkpoint stream (B2: zstd checkpoint from S3 by a signed URL)'});
    if (wants(ctx, 'S3')) results.push({id: 'S3', na: 'legacy has no checkpoints; its catch-up write of the whole text every 120 changes runs on the event loop (B2)'});
    if (wants(ctx, 'S4')) results.push({id: 'S4', na: 'no checkpoints in legacy: the text is rewritten every 120 changes or 4 MB of them, 20 s after the last save, on an automatic version and at shutdown (document-store.ts)'});
    if (wants(ctx, 'S5')) {
      const puts: number[] = [];
      let version = file.version;
      for (let i = 0; i < 3; i++) {
        const answer = await api(server, owner, 'PUT', `/api/design-files/${file.id}/document`, '{"baseVersion":' + version + ',"document":' + fixtureText('f20k') + '}');
        if (answer.status !== 200) throw Error(`PUT: ${answer.status} ${answer.text.slice(0, 200)}`);
        version = (JSON.parse(answer.text) as {version: number}).version;
        puts.push(answer.ms);
      }
      results.push({id: 'S5', na: `legacy caps a document at 20 MB (100 MB: ${f100kRefusal || '413'}); PUT of f20k (15.9 MB) acked in ${median(puts).toFixed(0)} ms (median of 3, loopback)`});
    }
    if (wants(ctx, 'S6')) {
      const named = await api(server, owner, 'POST', `/api/design-files/${file.id}/versions`, {label: 'Measurement'});
      if (named.status !== 201) throw Error(`version: ${named.status} ${named.text.slice(0, 200)}`);
      const listed = await api(server, owner, 'GET', `/api/design-files/${file.id}/versions`);
      const versions = (JSON.parse(listed.text) as {versions: {id: string}[]}).versions;
      const times: number[] = [];
      for (let i = 0; i < 5; i++) times.push((await api(server, owner, 'GET', `/api/design-files/${file.id}/versions/${versions[0].id}`)).ms);
      const prov = load.result().provisional ? `load average up to ${load.result().max.toFixed(1)}` : undefined;
      results.push({id: 'S6', values: {wall: median(times)}, provisional: prov, notes: [`S6: a named version of f20k (legacy keeps whole copies, no replay) read with GET /:id/versions/:id, median of 5 on loopback, ${server.shape}; the 100 MB case is refused by the legacy caps`]});
    }
  } finally {
    load.stop();
    await server.stop();
  }
  // The same rows with the big-files switch on (docs/decisions/big-files.md §8 step 2), through the api on this
  // machine: a 100 MB file is accepted, opened cold after a restart (S1), its first byte timed (S2), and replaced whole (S5).
  // BENCH_BIG_FILES=0 skips it; the collab checkpoint path (S1/S3 in Rust) is `storagesim open-save`.
  if (process.env.BENCH_BIG_FILES !== '0' && wants(ctx, 'S1', 'S2', 'S5')) results.push(...(await bigFiles(ctx)));
  writeFileSync(path.join(ctx.outDir, 'open-save.json'), JSON.stringify(results, null, 1));
  return fillNa(ctx, results, 'not run');
};

/** S1, S2 and S5 on f100k (BENCH_BIG_FILE names another bench file: f100k5, f500k25) with DESIGN_BIG_FILES=1 (the api's legacy
 *  store: JSON text in PostgreSQL, no checkpoints). */
async function bigFiles(ctx: Parameters<Bench>[0]): Promise<RowResult[]> {
  const results: RowResult[] = [];
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log, env: {DESIGN_BIG_FILES: '1'}});
  const load = new LoadWatch();
  const fixture = process.env.BENCH_BIG_FILE || 'f100k';
  try {
    const [owner] = await accounts(server, 1, 'bigfiles');
    const text = fixtureText(fixture);
    const mb = (text.length / 1e6).toFixed(1);
    const created = await api(server, owner, 'POST', '/api/design-files', '{"name":' + JSON.stringify(fixture) + ',"document":' + text + '}');
    if (created.status !== 201 && created.status !== 200) throw Error(`big files: POST ${fixture} ${created.status} ${created.text.slice(0, 200)}`);
    const file = (JSON.parse(created.text) as {file: {id: string; version: number}}).file;
    const prov = () => (load.result().provisional ? `load average up to ${load.result().max.toFixed(1)}` : undefined);
    const route = `/api/design-files/${file.id}`;
    if (wants(ctx, 'S1', 'S2')) {
      await server.kill();
      await server.restart();
      // First byte (S2): the time until the response's headers and first chunk arrive; the whole body (S1) after it.
      const started = performance.now();
      const response = await fetch(server.base + route, {headers: {cookie: cookieOf(owner)}});
      const reader = response.body!.getReader();
      const first = await reader.read();
      const firstByte = performance.now() - started;
      let bytes = first.value?.length ?? 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
      }
      const cold = performance.now() - started;
      const warm: number[] = [];
      for (let i = 0; i < 3; i++) warm.push((await api(server, owner, 'GET', route)).ms);
      if (wants(ctx, 'S1')) results.push({id: 'S1', values: {wall: cold}, provisional: prov() ?? 'the api path (JSON text + changes, no checkpoint) on this machine; the collab checkpoint path is storagesim open-save', notes: [`S1 (big files): ${fixture} (${mb} MB, ${response.status}) cold open after a restart ${cold.toFixed(0)} ms (${(bytes / 1e6).toFixed(1)} MB read), warm ${median(warm).toFixed(0)} ms (GET, loopback), ${server.shape}`]});
      if (wants(ctx, 'S2')) {
        // The editor's own open (docs/decisions/big-files.md §3): the skeleton, then the first page — each timed to its first byte
        // and to its end, after the whole-document read above warmed the server's parsed copy.
        const timed = async (suffix: string) => {
          const at = performance.now();
          const answer = await fetch(server.base + route + suffix, {headers: {cookie: cookieOf(owner)}});
          const body = answer.body!.getReader();
          const head = await body.read();
          const first = performance.now() - at;
          let size = head.value?.length ?? 0;
          for (;;) {
            const chunk = await body.read();
            if (chunk.done) break;
            size += chunk.value.length;
          }
          return {status: answer.status, first, total: performance.now() - at, size};
        };
        // Cold: the first parse of the text after the restart (what S1 is on this path); warm: the parsed copy is kept.
        const skeletonCold = await timed('?pages=skeleton');
        const skeleton = await timed('?pages=skeleton');
        const pageId = (JSON.parse((await api(server, owner, 'GET', route + '?pages=skeleton')).text) as {document: {pages: string[]}}).document.pages[0];
        const firstPage = await timed('/pages/' + encodeURIComponent(pageId));
        results.push({id: 'S2', values: {wall: skeleton.first}, provisional: prov() ?? 'the api path on this machine', extra: {wholeFirstByte: firstByte, skeletonCold, skeleton, firstPage}, notes: [`S2 (big files): the skeleton of ${fixture} (${(skeleton.size / 1e3).toFixed(1)} KB, ${skeleton.status}) first byte ${skeleton.first.toFixed(0)} ms warm (${skeletonCold.first.toFixed(0)} ms cold: the one parse of the text after a restart, S1 on this path); its first page (${(firstPage.size / 1e6).toFixed(1)} MB) first byte ${firstPage.first.toFixed(0)} ms, whole ${firstPage.total.toFixed(0)} ms; the whole document's first byte on a cold GET ${firstByte.toFixed(0)} ms, body (${(bytes / 1e6).toFixed(1)} MB) ${(cold - firstByte).toFixed(0)} ms more`]});
      }
    }
    if (wants(ctx, 'S5')) {
      const puts: number[] = [];
      let version = (JSON.parse((await api(server, owner, 'GET', route)).text) as {file: {version: number}}).file.version;
      for (let i = 0; i < 3; i++) {
        const answer = await api(server, owner, 'PUT', route + '/document', '{"baseVersion":' + version + ',"document":' + text + '}');
        if (answer.status !== 200) throw Error(`PUT f100k: ${answer.status} ${answer.text.slice(0, 200)}`);
        version = (JSON.parse(answer.text) as {version: number}).version;
        puts.push(answer.ms);
      }
      results.push({id: 'S5', values: {ack: median(puts)}, provisional: prov() ?? 'the api path on this machine', notes: [`S5 (big files): PUT of ${fixture} (${mb} MB) acked in ${median(puts).toFixed(0)} ms (median of 3: ${puts.map(ms => ms.toFixed(0)).join(', ')}), loopback, ${server.shape}`]});
    }
  } finally {
    load.stop();
    await server.stop();
  }
  return results;
}

export default run;
await runStandalone('open-save', run, import.meta.url);
