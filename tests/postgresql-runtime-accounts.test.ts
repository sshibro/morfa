import test from 'node:test';
import assert from 'node:assert/strict';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';

// Morfa's own accounts (server/auth.ts, server/accounts.ts) through the whole app on the real PostgreSQL schema: the name sign-in,
// the session and the account-generation check, the name, the data export, closing the account and its erasure on the next
// maintenance pass.

type Answer = {status: number; data: any; cookie: string | null; type: string | null};

test('Morfa accounts: name sign-in, sessions, account check, export, closure and erasure', {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const saved = Object.fromEntries(['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN'].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  process.env.ENABLE_DESIGN_TOOL = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const {launchMaintenance} = await import('../server/launch/lifecycle');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  const cookieName = auth.authCookieName('session');
  async function call(url: string, init: RequestInit & {json?: unknown; token?: string; headers?: Record<string, string>} = {}): Promise<Answer> {
    const {json, token, headers, ...rest} = init;
    const response = await fetch(base + url, {
      ...rest,
      headers: {...(token ? {cookie: cookieName + '=' + token} : {}), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...headers},
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const type = response.headers.get('content-type');
    const text = await response.text();
    const cookie = new RegExp(cookieName + '=([^;]*)').exec(response.headers.get('set-cookie') ?? '')?.[1] || null;
    return {status: response.status, data: type?.includes('json') && text ? JSON.parse(text) : text, cookie, type};
  }
  const signIn = async (name: string) => {
    const answer = await call('/api/auth/name', {method: 'POST', json: {name}});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.ok(answer.cookie, 'a session cookie is set');
    return {user: answer.data as {id: string; email: string; name: string}, token: answer.cookie!};
  };

  await t.test('the name sign-in makes an account once, signs it in and says who it is', async () => {
    const config = await call('/api/config');
    assert.equal(config.data.designTool, false, 'nobody is signed in');
    // Cyrillic on purpose: the name folds to an e-mail in any case and spacing, Cyrillic included.
    const first = await signIn('Анна');
    assert.deepEqual([first.user.email, first.user.name], ['анна@name.invalid', 'Анна']);
    const again = await signIn('  анна ');
    assert.equal(again.user.id, first.user.id, 'the same account the second time, in any case and spacing');
    assert.equal(again.user.name, 'Анна', 'the first spelling stays');
    assert.equal((await db.one<{n: number}>("SELECT count(*)::int AS n FROM users WHERE email='анна@name.invalid'"))!.n, 1);
    assert.equal(Number((await db.one<{email_verified: number}>("SELECT email_verified FROM users WHERE email='анна@name.invalid'"))!.email_verified), 1);
    const me = await call('/api/auth/me', {token: again.token});
    assert.deepEqual(me.data, {id: first.user.id, email: 'анна@name.invalid', name: 'Анна'});
    assert.equal((await call('/api/config', {token: again.token})).data.designTool, true);
    assert.equal((await call('/api/auth/me')).data, null, 'nobody without a cookie');
    // Only the SHA-256 of the token is stored.
    assert.ok(await db.one('SELECT 1 FROM sessions WHERE token=$1', [auth.digest(again.token)]));
    assert.equal(await db.one('SELECT 1 FROM sessions WHERE token=$1', [again.token]), undefined);
  });

  await t.test('the name sign-in is open without any switch and from behind a proxy', async () => {
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const answer = await call('/api/auth/name', {method: 'POST', json: {name: 'Behind Proxy'}, headers: {[header]: header === 'forwarded' ? 'for=203.0.113.7' : '203.0.113.7'}});
      assert.equal(answer.status, 200, header);
    }
    assert.equal((await call('/api/auth/dev', {method: 'POST', json: {email: 'a@localhost'}})).status, 404, 'the development route is gone');
  });

  await t.test('the name sign-in refuses names that are empty, too long or hold forbidden characters', async () => {
    for (const name of ['', '   ', '...', 'a'.repeat(51), 'a@b', '<b>x</b>', 'zero\u200Bwidth', 'line\u202Eflip', 12, null]) {
      const answer = await call('/api/auth/name', {method: 'POST', json: {name}});
      assert.deepEqual([answer.status, answer.data.code], [400, 'invalid_name'], JSON.stringify(name));
    }
    assert.equal((await call('/api/auth/name', {method: 'POST', json: {}})).status, 400);
    assert.equal(await db.one("SELECT 1 FROM users WHERE email LIKE '%@b@%' OR email LIKE '%<%'"), undefined, 'no account was made');
  });

  await t.test('the name sign-in keeps the session cookie\'s rules and ends the earlier session of the browser', async () => {
    const first = await signIn('Cookie Person');
    const other = await call('/api/auth/name', {method: 'POST', token: first.token, json: {name: 'Other Cookie Person'}});
    assert.equal(other.status, 200);
    assert.equal((await call('/api/auth/me', {token: first.token})).data, null, 'the previous session ended');
    assert.notEqual(other.data.id, first.user.id);
    // A write from another site is refused before the route.
    assert.equal((await call('/api/auth/name', {method: 'POST', json: {name: 'Cookie Person'}, headers: {origin: 'https://evil.example'}})).status, 403);
  });

  await t.test('a tab that names another account is refused; signing out ends the session', async () => {
    const boris = await signIn('Boris');
    const other = await signIn('Vera');
    const changed = await call('/api/design-files', {token: boris.token, headers: {'x-forma-account': other.user.id}});
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, 'account_changed');
    assert.equal((await call('/api/auth/me', {token: boris.token, headers: {'x-forma-account': other.user.id}})).status, 409);
    assert.equal((await call('/api/design-files', {token: boris.token, headers: {'x-forma-account': boris.user.id}})).status, 200);
    // A write from another site is refused before any route.
    assert.equal((await call('/api/auth/logout', {method: 'POST', token: boris.token, headers: {origin: 'https://evil.example'}})).status, 403);
    assert.equal((await call('/api/auth/logout', {method: 'POST', token: boris.token})).status, 200);
    assert.equal((await call('/api/design-files', {token: boris.token})).status, 401);
    assert.equal((await call('/api/auth/me', {token: boris.token})).data, null);
  });

  await t.test('the name changes; the export holds the profile and the design files', async () => {
    const gleb = await signIn('Glen');
    const renamed = await call('/api/settings', {method: 'PUT', token: gleb.token, json: {name: 'Glen Peters', workspace: 'Studio'}});
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.user.name, 'Glen Peters');
    assert.equal((await call('/api/settings', {method: 'PUT', token: gleb.token, json: {name: ' '}})).status, 400);
    const made = await call('/api/design-files', {method: 'POST', token: gleb.token, json: {}});
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const exported = await call('/api/settings/data-export', {token: gleb.token});
    assert.equal(exported.status, 200);
    assert.match(exported.type ?? '', /application\/json/);
    assert.deepEqual(Object.keys(exported.data), ['profile', 'design', 'support']);
    assert.deepEqual([exported.data.profile.email, exported.data.profile.name], ['glen@name.invalid', 'Glen Peters']);
    assert.deepEqual(exported.data.design.files.map((file: {id: string}) => file.id), [made.data.file.id]);
    assert.equal((await call('/api/settings/data-export')).status, 401);
  });

  await t.test('closing asks for the name, ends every session, and the maintenance pass erases the account', async () => {
    const dina = await signIn('Dina');
    const second = await signIn('Dina');
    const file = (await call('/api/design-files', {method: 'POST', token: dina.token, json: {}})).data.file;
    assert.equal((await call('/api/settings/delete-account', {method: 'POST', token: dina.token, json: {confirmName: 'Someone else'}})).status, 400);
    const closed = await call('/api/settings/delete-account', {method: 'POST', token: dina.token, json: {confirmName: ' DINA '}});
    assert.equal(closed.status, 202, JSON.stringify(closed.data));
    assert.equal((await call('/api/auth/me', {token: second.token})).data, null, 'every session ends');
    assert.equal((await call('/api/auth/name', {method: 'POST', json: {name: 'Dina'}})).status, 403, 'a closed account cannot sign in again');
    await launchMaintenance();
    const row = await db.one<{name: string; email: string; erasure_completed_at: string | null}>('SELECT name,email,erasure_completed_at FROM users WHERE id=$1', [dina.user.id]);
    assert.equal(row!.name, 'Deleted account');
    assert.equal(row!.email, 'erased-' + dina.user.id + '@invalid.local');
    assert.notEqual(row!.erasure_completed_at, null);
    assert.equal(await db.one('SELECT 1 FROM design_files WHERE id=$1', [file.id]), undefined);
    assert.ok(await db.one("SELECT 1 FROM erasure_ledger WHERE id=$1 AND kind='account'", [dina.user.id]));
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM admin_activity WHERE user_id=$1', [dina.user.id]))!.n, 0);
    assert.ok(await db.one("SELECT 1 FROM launch_audit WHERE user_id=$1 AND action='account_erasure_requested'", [dina.user.id]));
    // A second pass finds nothing left to do.
    await launchMaintenance();
    // Once the account is erased its name is free again: the next person to type it gets a new account.
    const reborn = await signIn('Dina');
    assert.notEqual(reborn.user.id, dina.user.id);
  });

  await t.test('the name sign-in is rate limited per client address', async () => {
    let limited = 0;
    for (let attempt = 0; attempt < 70; attempt++)
      if ((await call('/api/auth/name', {method: 'POST', json: {name: ''}})).status === 429) limited++;
    assert.ok(limited > 0, 'a client that keeps trying is stopped');
  });
});
