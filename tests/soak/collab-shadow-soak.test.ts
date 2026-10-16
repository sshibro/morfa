import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {collabApp, measurer, type Account} from '../helpers/collab-app';
import {recordShadowRun, shadowFuzz, type FuzzCounts} from '../helpers/collab-shadow-fuzz';
import {mulberry32} from '../helpers/ops-fuzz';
import {formatShadowReport, readShadowReport} from '../../scripts/collab-shadow-report';
import {createDocument, createNode} from '../../shared/design/defaults';
import {beginTransaction} from '../../shared/design/transaction';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// A soak of DESIGN_COLLAB=shadow (docs/BACKEND.md §7 step 2; lane B1 «further wins»): hours of mixed traffic through the api with
// every accepted save forwarded to a real morfa-collab, and 0 differences at the end — in this process's counters and in the
// mismatch log every api process writes to. Not part of test:pg (its own folder): lane B5 runs it on bench-ru with
// `bash scripts/collab-shadow-soak.sh <minutes>`.
//
// Each round (about a minute, until MORFA_SOAK_MINUTES have passed) runs at once:
//   - fuzz: lane L2a's generator through PUT + two PATCHes (stale merges, structure, text, components, variables) on fresh accounts;
//   - a team file edited by two members together: moves made on stale versions with their `before` copies (Node merges them), a
//     PUT restore, a rename and a comment in the middle;
//   - a second api process saving layers of the same team file through its own document cache and save queue
//     (tests/helpers/design-file-changes-process.ts), so two processes forward one file to collab.
// A difference ends the run at once with the report (scripts/collab-shadow-report.ts) and its replayable cases.

const MINUTES = Number(process.env.MORFA_SOAK_MINUTES || 5);
const SEED = Number(process.env.MORFA_SOAK_SEED || 1);
const LAYERS = 30;

function teamDocument(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 2000, height: 2000}), 'page');
  for (let k = 0; k < LAYERS; k++) tx.create(createNode('RECTANGLE', {id: 'r' + k, x: 10 * k, y: 10, width: 40, height: 40}), 'F');
  return tx.commit({measurer}).doc;
}

test(`collab shadow soak: ${MINUTES} minutes of mixed traffic, 0 differences`, {timeout: (MINUTES + 30) * 60_000}, async t => {
  const c = await collabApp(t, {collab: {pg: false}, env: {DESIGN_COLLAB: 'shadow'}});
  const {files, teams, ok} = c;
  const auth = await import('../../server/auth');
  const shadow = await import('../../server/design/collab/shadow');
  const log = process.env.DESIGN_COLLAB_SHADOW_LOG!;
  shadow.resetShadow();
  const deadline = Date.now() + MINUTES * 60_000;
  const totals: FuzzCounts = {cases: 0, ops: 0, stored: 0, empty: 0, refused: 0, skipped: 0, merged: 0};
  const traffic = {teamSaves: 0, teamMerged: 0, conflicts: 0, restores: 0, renames: 0, comments: 0, childSaves: 0};
  const started = performance.now();

  /** Two members of a new team editing one file together, with a restore, a rename and a comment along the way. */
  async function teamRound(round: number, rng: () => number) {
    const owner = await c.account(`soak-owner-${round}`);
    // A free team has two editors: the owner and one member (the second process is the third writer).
    const members = [owner, await c.account(`soak-a-${round}`)];
    const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Soak ' + round}}), 201).team.id as string;
    for (const member of members.slice(1)) {
      const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role: 'editor', days: 1, maxUses: 1}}), 201);
      ok(await teams(member, `/invites/${invite.token}/accept`, {method: 'POST'}));
    }
    const document = teamDocument();
    const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Shared', document, teamId}}), 201).file.id as string;
    // The other process saves the last ten layers of the same file meanwhile.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(import.meta.dirname, '..', 'helpers', 'design-file-changes-process.ts'), id, owner.id, auth.digest(owner.token), Array.from({length: 10}, (_, k) => 'r' + (LAYERS - 10 + k)).join(','), '40'],
      {env: process.env, stdio: ['ignore', 'pipe', 'inherit']},
    );
    const childDone = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    const editor = async (who: Account, index: number) => {
      let opened = ok(await files(who, `/${id}`));
      for (let k = 0; k < 40; k++) {
        // Every few saves the editor reads the file again; in between it saves on the version it read (Node merges).
        if (k % 8 === 7) opened = ok(await files(who, `/${id}`));
        const layer = 'r' + Math.floor(rng() * (LAYERS - 10));
        const base = opened.document.nodes[layer] as SceneNode;
        const node = {...base, x: Math.round(rng() * 1000), y: index * 100 + k};
        const answer = await files(who, `/${id}/document`, {method: 'PATCH', json: {baseVersion: opened.file.version, patch: {nodes: {[layer]: node}}, before: {[layer]: base}}});
        if (answer.status === 200) {
          traffic.teamSaves++;
          if (answer.data.version > opened.file.version + 1) traffic.teamMerged++;
        } else if (answer.status === 409) {
          traffic.conflicts++;
          opened = ok(await files(who, `/${id}`));
        } else assert.fail(`PATCH ${answer.status}: ${JSON.stringify(answer.data)}`);
        if (index === 0 && k === 20) {
          const current = ok(await files(who, `/${id}`)).file.version as number;
          const put = await files(who, `/${id}/document`, {method: 'PUT', json: {baseVersion: current, document}});
          if (put.status === 200) traffic.restores++;
          else if (put.status === 409) traffic.conflicts++;
          else assert.fail(`PUT ${put.status}: ${JSON.stringify(put.data)}`);
          opened = ok(await files(who, `/${id}`));
        }
        if (index === 1 && k === 10) {
          ok(await files(who, `/${id}`, {method: 'PATCH', json: {name: 'Shared ' + k}}));
          traffic.renames++;
        }
        if (index === 1 && k === 25) {
          const pageId = opened.document.pages[0];
          ok(await files(who, `/${id}/comments`, {method: 'POST', json: {anchor: {pageId, x: 1, y: 1, nodeId: null, offset: null}, text: 'Soak', mentions: []}}), 201);
          traffic.comments++;
        }
        await new Promise(resolve => setTimeout(resolve, 200 + rng() * 600));
      }
    };
    await Promise.all(members.map(editor));
    assert.equal(await childDone, 0, 'the second process saved everything');
    traffic.childSaves += 40;
  }

  /** Fuzz cases on four fresh accounts (each within the per-account limits of whole documents and saves). */
  async function fuzzRound(round: number) {
    const people: Account[] = [];
    const owned = new Map<string, string>();
    for (let i = 0; i < 4; i++) {
      const who = await c.account(`soak-fuzz-${round}-${i}`);
      people.push(who);
      owned.set(who.id, ok(await files(who, '', {method: 'POST', json: {name: 'Fuzz ' + i}}), 201).file.id);
    }
    const counts = await shadowFuzz({accounts: people, files: owned, ops: 160, seed: SEED * 10_007 + round, parallel: 4, request: files});
    for (const key of Object.keys(totals) as (keyof FuzzCounts)[]) totals[key] += counts[key];
  }

  let round = 0;
  while (Date.now() < deadline) {
    const rng = mulberry32(SEED * 7919 + round);
    await Promise.all([fuzzRound(round), teamRound(round, rng)]);
    await shadow.shadowIdle();
    const stats = shadow.shadowStats();
    const report = await readShadowReport(log);
    const minutes = ((performance.now() - started) / 60_000).toFixed(1);
    console.error(`soak ${minutes} min, round ${round}: fuzz ${JSON.stringify(totals)} team ${JSON.stringify(traffic)} forwarder ${JSON.stringify(stats)} logged differences ${report.differences.length}`);
    if (stats.mismatches || report.differences.length) {
      console.error(formatShadowReport(report));
      break;
    }
    round++;
  }
  await shadow.shadowIdle();
  const stats = shadow.shadowStats();
  await recordShadowRun(log, `soak ${MINUTES} min`, totals, stats, (performance.now() - started) / 1000);
  const report = await readShadowReport(log);
  // The log, its runs and any replayable case outlive the fixture's data folder.
  if (process.env.MORFA_SHADOW_REPORT_DIR) {
    const {cp, mkdir} = await import('node:fs/promises');
    await mkdir(process.env.MORFA_SHADOW_REPORT_DIR, {recursive: true});
    await cp(path.dirname(log), path.join(process.env.MORFA_SHADOW_REPORT_DIR, 'collab-shadow'), {recursive: true});
  }
  console.log(formatShadowReport(report));
  console.log(`soak: ${round} rounds, fuzz ${JSON.stringify(totals)}, team ${JSON.stringify(traffic)}, forwarder ${JSON.stringify(stats)}`);
  assert.ok(round >= 1, 'at least one round');
  assert.ok(stats.forwarded > 0 && stats.compared > 0, 'saves reached collab and were compared');
  assert.ok(totals.merged > 0 && traffic.teamMerged > 0, 'merges on both kinds of traffic');
  assert.equal(stats.unavailable, 0);
  assert.equal(stats.mismatches, 0, `differences: ${log}`);
  assert.equal(report.differences.length, 0, 'no api process logged a difference');
});
