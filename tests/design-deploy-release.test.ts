import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Lane D: scripts/deploy/release.sh survives a dropped SSH connection (the 2026-10-10 deploy died with exit 255 during the
// cargo build, before the switch). The real release.sh and remote/release-job.sh run against a fake host on this machine: a
// fake ssh that runs the command locally (and answers 255 while a «down» file exists), a fake host.sh and build.sh that record
// each step, and stubs for sudo, install, chown and systemctl. No server is contacted.

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const script = (file: string, text: string) => {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, text);
  chmodSync(file, 0o755);
};

const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-release-'));
  const repo = path.join(dir, 'repo');
  const srv = path.join(dir, 'srv');
  const fake = path.join(dir, 'fake');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(srv, 'releases'), {recursive: true});
  mkdirSync(fake);
  mkdirSync(path.join(repo, 'scripts/deploy/remote'), {recursive: true});
  copyFileSync(path.join(ROOT, 'scripts/deploy/release.sh'), path.join(repo, 'scripts/deploy/release.sh'));
  copyFileSync(path.join(ROOT, 'scripts/deploy/remote/release-job.sh'), path.join(repo, 'scripts/deploy/remote/release-job.sh'));
  // build.sh waits for «build-go», as a long cargo build would.
  script(
    path.join(repo, 'scripts/deploy/build.sh'),
    `#!/usr/bin/env bash
set -e
echo "build $(cat BUILD_COMMIT)\${*:+ $*}" >>"$FAKE_DIR/calls"
for _ in $(seq 1 600); do [ -e "$FAKE_DIR/build-go" ] && break; sleep 0.1; done
mkdir -p bin && printf '#!/bin/sh\\n' >bin/morfa-collab && chmod +x bin/morfa-collab
`,
  );
  script(
    path.join(repo, 'scripts/deploy/remote/host.sh'),
    `#!/usr/bin/env bash
set -e
echo "$1" >>"$FAKE_DIR/calls"
case $1 in
  preflight) [ ! -e "$FAKE_DIR/preflight-fail" ] || { echo "preflight: a placeholder is left in api.env"; exit 1; } ;;
  switch) [ -x "$2/bin/morfa-collab" ]; ln -sfn "$2" "$FAKE_SRV/current" ;;
esac
`,
  );
  // ssh [-o opt]… <host> <command>: the command runs here, unless the network is «down».
  script(
    path.join(bin, 'fake-ssh'),
    `#!/usr/bin/env bash
while [ "$1" = -o ]; do shift 2; done
shift
if [ -e "$FAKE_DIR/down" ]; then echo "Connection to host closed by remote host." >&2; exit 255; fi
exec bash -c "$1"
`,
  );
  script(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do case $1 in -u) shift 2 ;; *) shift ;; esac; done\nexec "$@"\n');
  script(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  script(path.join(bin, 'systemctl'), '#!/bin/sh\necho "systemctl $*" >>"$FAKE_DIR/calls"\n');
  script(
    path.join(bin, 'install'),
    '#!/usr/bin/env bash\nargs=()\nwhile [ $# -gt 0 ]; do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "${args[@]}"\n',
  );
  const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.');
  const commit = (message: string) => {
    writeFileSync(path.join(repo, 'VERSION'), message);
    git('add', 'VERSION');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', message);
    return git('rev-parse', '--short=9', 'HEAD');
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DIR: fake,
    FAKE_SRV: srv,
    MORFA_RELEASE_SRV: srv,
    MORFA_RELEASE_SSH: path.join(bin, 'fake-ssh'),
    MORFA_RELEASE_DETACH: 'setsid',
    MORFA_RELEASE_POLL_SECONDS: '0.2',
  };
  const release = (ref: string, args: string[] = [], extra: Record<string, string> = {}) => {
    const proc = spawn('bash', [path.join(repo, 'scripts/deploy/release.sh'), 'root@fake-host', ref, ...args], {
      cwd: repo,
      env: {...env, ...extra},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', chunk => (output += chunk));
    proc.stderr.on('data', chunk => (output += chunk));
    const done = new Promise<{code: number; output: string}>(resolve => proc.on('close', code => resolve({code: code ?? -1, output})));
    return {done, output: () => output};
  };
  const calls = () => (existsSync(path.join(fake, 'calls')) ? readFileSync(path.join(fake, 'calls'), 'utf8').trim().split('\n') : []);
  const flag = (name: string, on: boolean) => (on ? writeFileSync(path.join(fake, name), '') : rmSync(path.join(fake, name), {force: true}));
  const current = () => (existsSync(path.join(srv, 'current')) ? readlinkSync(path.join(srv, 'current')) : '');
  const until = async (what: string, check: () => boolean, ms = 20_000) => {
    for (const start = Date.now(); !check(); await sleep(50)) if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
  };
  const cleanup = () => {
    // A job left running by a failed assertion.
    for (const hash of existsSync(path.join(srv, 'releases')) ? execFileSync('ls', [path.join(srv, 'releases')], {encoding: 'utf8'}).split('\n') : []) {
      const state = path.join(srv, 'releases', hash, 'state');
      if (hash.endsWith('.run') && existsSync(state)) {
        const [word, pid] = readFileSync(state, 'utf8').split(' ');
        if (word === 'running') try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
    }
    rmSync(dir, {recursive: true, force: true});
  };
  return {srv, commit, release, calls, flag, current, until, cleanup, dirOf: (hash: string) => path.join(srv, 'releases', hash)};
};

const FULL = ['preflight', 'switch', 'migrate', 'restart', 'status'];

test('release: a connection lost during the build — the job finishes the release; a rerun reattaches, then reports', {timeout: 60_000}, async () => {
  const host = setup();
  try {
    const hash = host.commit('one');
    const first = host.release(hash, [], {MORFA_RELEASE_RECONNECT_SECONDS: '1'});
    await host.until('the build to start', () => host.calls().length > 0);
    host.flag('down', true);
    const lost = await first.done;
    assert.equal(lost.code, 255, lost.output);
    assert.match(lost.output, /run the same command again/);
    assert.deepEqual(host.calls(), [`build ${hash}`], 'nothing past the build while the connection was down');
    assert.match(readFileSync(path.join(host.dirOf(hash) + '.run', 'state'), 'utf8'), /^running \d+ build/);

    host.flag('down', false);
    const again = host.release(hash);
    await host.until('the rerun to reattach', () => /reattaching/.test(again.output()));
    host.flag('build-go', true);
    const done = await again.done;
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /released/);
    assert.deepEqual(host.calls(), [`build ${hash}`, ...FULL], 'each step once, the build not repeated');
    assert.equal(host.current(), host.dirOf(hash));

    const third = await host.release(hash).done;
    assert.equal(third.code, 0, third.output);
    assert.match(third.output, /already released/);
    assert.deepEqual(host.calls(), [`build ${hash}`, ...FULL], 'a rerun after success runs nothing');
  } finally {
    host.cleanup();
  }
});

test('release: a short drop is ridden out in the same run; the rollback target is reported', {timeout: 60_000}, async () => {
  const host = setup();
  try {
    const one = host.commit('one');
    host.flag('build-go', true);
    assert.equal((await host.release(one).done).code, 0);
    host.flag('build-go', false);
    const two = host.commit('two');
    const run = host.release(two, [], {MORFA_RELEASE_RECONNECT_SECONDS: '30'});
    await host.until('the build to start', () => host.calls().includes(`build ${two}`));
    host.flag('down', true);
    await host.until('the drop to be noticed', () => /no answer from/.test(run.output()));
    host.flag('down', false);
    host.flag('build-go', true);
    const done = await run.done;
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /connected again/);
    assert.ok(done.output.includes(`previous: ${host.dirOf(one)}`), done.output);
    assert.equal(host.current(), host.dirOf(two));
    assert.deepEqual(host.calls().slice(6), [`build ${two}`, ...FULL]);
  } finally {
    host.cleanup();
  }
});

test('release: a failed preflight never switches; a rerun reports it; --retry resumes at the preflight', {timeout: 60_000}, async () => {
  const host = setup();
  try {
    const hash = host.commit('one');
    host.flag('build-go', true);
    host.flag('preflight-fail', true);
    const failed = await host.release(hash, ['--first']).done;
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /a placeholder is left/);
    assert.match(failed.output, /ended failed at step "preflight"/);
    assert.deepEqual(host.calls(), [`build ${hash}`, 'preflight']);
    assert.equal(host.current(), '');

    const report = await host.release(hash, ['--first']).done;
    assert.equal(report.code, 1, report.output);
    assert.match(report.output, /--retry resumes at "preflight"/);
    assert.deepEqual(host.calls(), [`build ${hash}`, 'preflight'], 'a rerun without --retry runs nothing');

    host.flag('preflight-fail', false);
    const resumed = await host.release(hash, ['--first', '--retry']).done;
    assert.equal(resumed.code, 0, resumed.output);
    const after = host.calls();
    assert.deepEqual(after.slice(0, 5), [`build ${hash}`, 'preflight', 'preflight', 'switch', 'migrate']);
    assert.match(after[5], /^systemctl enable morfa-api@1/);
    assert.match(after[6], /^systemctl start /);
    assert.deepEqual(after.slice(7), ['restart', 'status']);
  } finally {
    host.cleanup();
  }
});

test('release: a job killed mid-build (a reboot) is reported interrupted; --retry builds again and finishes', {timeout: 60_000}, async () => {
  const host = setup();
  try {
    const hash = host.commit('one');
    const run = host.release(hash);
    await host.until('the build to start', () => host.calls().length > 0);
    const state = path.join(host.dirOf(hash) + '.run', 'state');
    const pid = Number(readFileSync(state, 'utf8').split(' ')[1]);
    // The job's whole session (setsid), as a reboot would; where there is no setsid (macOS: nohup), the job alone.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    const done = await run.done;
    assert.equal(done.code, 1, done.output);
    assert.match(done.output, /ended interrupted at step "build"/);
    host.flag('build-go', true);
    const resumed = await host.release(hash, ['--retry']).done;
    assert.equal(resumed.code, 0, resumed.output);
    assert.deepEqual(host.calls(), [`build ${hash}`, `build ${hash}`, ...FULL]);
  } finally {
    host.cleanup();
  }
});

test('release-job poll: a finished job reads as finished; a dead one as interrupted; a launcher that died as interrupted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-release-poll-'));
  try {
    const hash = 'abcdef123';
    const run = path.join(dir, 'releases', `${hash}.run`);
    mkdirSync(run, {recursive: true});
    const poll = () =>
      execFileSync('bash', [path.join(ROOT, 'scripts/deploy/remote/release-job.sh'), 'poll', dir, hash, '0'], {encoding: 'utf8'}).split('\n')[0];
    // A pid that is not a release job (this test's own process): the job is gone.
    writeFileSync(path.join(run, 'state'), `running ${process.pid} status\n`);
    assert.match(poll(), /^interrupted status /);
    writeFileSync(path.join(run, 'state'), 'ok\n');
    assert.match(poll(), /^ok - /);
    writeFileSync(path.join(run, 'state'), 'failed preflight\n');
    assert.match(poll(), /^failed preflight /);
    writeFileSync(path.join(run, 'state'), 'starting\n');
    assert.match(poll(), /^starting - /);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path.join(run, 'state'), old, old);
    assert.match(poll(), /^interrupted start /);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
