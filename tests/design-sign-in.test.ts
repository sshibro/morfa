import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {NAME_ADDRESS_DOMAIN, NAME_MAX_LENGTH, checkName, isNameAddress, nameAddress} from '../shared/sign-in';
import {DESIGN_INVITE_PARAM, DESIGN_INVITE_STORAGE_KEY} from '../shared/design/teams';
import {SignIn} from '../src/auth/SignIn';
import {rememberInvite} from '../src/auth/invite';

// The way into the design tool (src/auth): the name screen, and the rules a name must meet (shared/sign-in.ts), which the server
// applies again (server/accounts.ts).

const memory = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: key => void values.delete(key),
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
};
const screen = () => cheerio.load(renderToString(createElement(SignIn, {onSignedIn: () => undefined})));

test('should ask for a name and nothing else', () => {
  const $ = screen();

  assert.equal($('h1').text(), 'Welcome to Morfa');
  assert.equal($('form input').length, 1);
  assert.equal($('form input').attr('type'), 'text');
  assert.equal($('label').text(), 'Your name');
  assert.equal($('form button[type=submit]').text(), 'Continue');
  assert.equal($('input[type=password], input[type=email]').length, 0);
});

test('should offer no provider, no operator entrance and no legal link', () => {
  const $ = screen();

  assert.equal($('a').length, 0);
  assert.equal($('svg.mf-auth-provider-mark-google, img.mf-auth-provider-mark').length, 0);
});

test('should show no alert before anything was tried', () => {
  assert.equal(screen()('[role=alert]').length, 0);
});

test('should trim a name, collapse its spaces and compose it', () => {
  assert.deepEqual(checkName('a' + String.fromCharCode(0xFEFF, 0x2028) + 'b'), {ok: true, name: 'a b'}, 'separators are spaces');
  assert.deepEqual(checkName('  Anna   Petrova '), {ok: true, name: 'Anna Petrova'});
  assert.deepEqual(checkName('Cafe' + String.fromCharCode(0x301)), {ok: true, name: 'Caf' + String.fromCharCode(0xE9)}, 'composed');
  assert.deepEqual(checkName('Anna\tPetrova'), {ok: true, name: 'Anna Petrova'});
  assert.deepEqual(checkName('李雷'), {ok: true, name: '李雷'});
  assert.deepEqual(checkName('R2-D2'), {ok: true, name: 'R2-D2'});
});

test('should refuse a name that is empty, has no letter or digit, or is not text', () => {
  for (const value of ['', '   ', '...', '--', 12, null, undefined, {}]) assert.deepEqual(checkName(value), {ok: false, problem: 'empty'}, String(value));
});

test('should refuse a name longer than the limit, counted in characters', () => {
  assert.equal(checkName('a'.repeat(NAME_MAX_LENGTH)).ok, true);
  assert.deepEqual(checkName('a'.repeat(NAME_MAX_LENGTH + 1)), {ok: false, problem: 'long'});
  assert.equal(checkName('😀'.repeat(NAME_MAX_LENGTH - 1) + 'a').ok, true, 'an emoji is one character');
});

test('should refuse controls, invisible and direction-changing marks, and the characters that make an address or markup', () => {
  for (const value of ['a@b', 'a<b', 'a>b', 'a\u0000b', 'a' + String.fromCharCode(0x200B) + 'b', 'a' + String.fromCharCode(0x202E) + 'b', 'a' + String.fromCharCode(0x2066) + 'b', 'a＠b'])
    assert.deepEqual(checkName(value), {ok: false, problem: 'characters'}, JSON.stringify(value));
  assert.equal(checkName('a' + String.fromCharCode(0x200D) + 'b').ok, true, 'a joiner stays');
});

test('should make the same address for the same name in any case, spacing or width', () => {
  const same = ['Anna Petrova', 'anna petrova', 'ANNA PETROVA', 'Ａｎｎａ Ｐｅｔｒｏｖａ'].map(name => nameAddress((checkName(name) as {name: string}).name));
  assert.deepEqual(new Set(same), new Set([`anna petrova@${NAME_ADDRESS_DOMAIN}`]));
  assert.notEqual(nameAddress('Anna'), nameAddress('Anna P'));
  assert.notEqual(nameAddress('a b'), nameAddress('a-b'), 'a space is not a hyphen');
});

test('should recognise an address made from a name, and only that', () => {
  assert.equal(isNameAddress(nameAddress('Anna')), true);
  assert.equal(isNameAddress('ANNA@NAME.INVALID'), true);
  assert.equal(isNameAddress('anna@morfa.example'), false);
  assert.equal(isNameAddress(null), false);
});

// An invite link opened signed out (src/auth/invite.ts): the tab keeps the token.

const INVITE_TOKEN = 'a'.repeat(43);
const inviteQuery = (token: string) => `?${DESIGN_INVITE_PARAM}=${token}`;

test('should keep the invite in the tab when the address carries one', () => {
  const storage = memory();

  const invited = rememberInvite(inviteQuery(INVITE_TOKEN), storage);

  assert.equal(invited, true);
  assert.equal(storage.getItem(DESIGN_INVITE_STORAGE_KEY), INVITE_TOKEN);
});

test('should keep nothing when the address carries no invite', () => {
  const storage = memory();

  const invited = rememberInvite('?utm=1', storage);

  assert.equal(invited, false);
  assert.equal(storage.length, 0);
});

test('should refuse an invite that is not a token', () => {
  const storage = memory();

  const invited = rememberInvite(inviteQuery('<script>'), storage);

  assert.equal(invited, false);
  assert.equal(storage.length, 0);
});

test('should still count the invite when the tab has no storage', () => {
  assert.equal(rememberInvite(inviteQuery(INVITE_TOKEN), null), true);
});

test('should show no invite note on an ordinary visit', () => {
  assert.equal(screen()('.mf-auth-invite').length, 0);
});
