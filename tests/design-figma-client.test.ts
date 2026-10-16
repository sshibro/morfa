import assert from 'node:assert/strict';
import test from 'node:test';
import {createFigmaClient, FigmaApiError} from '../src/figma-import/figma-client';

// How the Figma client reads Figma's refusals: a token Figma does not know, a token without the right a call needs
// (personal access tokens carry scopes; GET /v1/me needs current_user:read, the files need file_content:read), and a
// file the account may not open.

const answer = (status: number, body: unknown) => (async () =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}})) as typeof fetch;

const refusal = async (status: number, body: unknown) => {
  const client = createFigmaClient({token: 'figd_test', kind: 'token', fetch: answer(status, body)});
  try {
    await client.me();
  } catch (error) {
    assert.ok(error instanceof FigmaApiError);
    return error;
  }
  assert.fail('the call was accepted');
};

test('a 403 that names a missing scope is a scope error, not «no access to the file»', async () => {
  const error = await refusal(403, {status: 403, err: 'Invalid scope(s): file_content:read. This endpoint requires the current_user:read scope'});
  assert.equal(error.kind, 'scope');
  assert.match(error.message, /File content — Read only/);
});

test('a 403 for an invalid or expired token is a token error', async () => {
  assert.equal((await refusal(403, {status: 403, err: 'Invalid token'})).kind, 'token');
  assert.equal((await refusal(403, {status: 403, err: 'Token expired'})).kind, 'token');
});

test('a 401 is a token error', async () => {
  assert.equal((await refusal(401, {status: 401, err: 'Missing credentials'})).kind, 'token');
});

test('any other 403 is no access to the file', async () => {
  assert.equal((await refusal(403, {status: 403, err: 'Forbidden'})).kind, 'access');
});
