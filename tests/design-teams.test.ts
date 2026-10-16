import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignableRoles,
  canEditTeamFiles,
  canInspectCode,
  canManageMember,
  canManageTeam,
  DESIGN_INVITE_TOKEN,
  DESIGN_TEAM_ROLES,
  designInviteUrl,
} from '../shared/design/teams';
import {maskDesignInvite, sanitize} from '../server/admin/sanitize';

// "Morfa Design" teams (docs/design-tool.md §Teams): the role rules both sides read and the invite token's masking.

const TEAM = '0d2c3b4a-1111-4222-8333-944455556666';

test('should give each role exactly its rights: editors edit, managers manage, viewers do not inspect code', () => {
  const table = Object.fromEntries(DESIGN_TEAM_ROLES.map(role => [role, [canEditTeamFiles(role), canManageTeam(role), canInspectCode(role)]]));
  assert.deepEqual(table, {
    owner: [true, true, true],
    admin: [true, true, true],
    editor: [true, false, true],
    developer: [false, false, true],
    viewer: [false, false, false],
  });
});

test('should let the owner hand out every role but its own and an admin only those below it', () => {
  assert.deepEqual(assignableRoles('owner'), ['admin', 'editor', 'developer', 'viewer']);
  assert.deepEqual(assignableRoles('admin'), ['editor', 'developer', 'viewer']);
  for (const role of ['editor', 'developer', 'viewer'] as const) assert.deepEqual(assignableRoles(role), []);
  assert.equal(canManageMember('owner', 'admin'), true);
  assert.equal(canManageMember('owner', 'owner'), false, 'the owner hands over, never demotes itself');
  assert.equal(canManageMember('admin', 'admin'), false);
  assert.equal(canManageMember('admin', 'owner'), false);
  assert.equal(canManageMember('admin', 'viewer'), true);
  assert.equal(canManageMember('editor', 'viewer'), false);
});

test('should carry an invite in the design area\'s query and accept only a 43-character base64url token', () => {
  const token = 'a'.repeat(21) + '-_' + 'Z9'.repeat(10);
  assert.equal(token.length, 43);
  assert.match(token, DESIGN_INVITE_TOKEN);
  assert.equal(designInviteUrl('https://app.example.test/', token), `https://app.example.test/?designInvite=${token}#designs`);
  for (const bad of ['', 'short', token + 'x', token.slice(1) + '/', token.slice(1) + '='] as const) assert.doesNotMatch(bad, DESIGN_INVITE_TOKEN, bad);
});

test('should keep the token out of the request journal and any collected text', () => {
  const token = 'Qw3'.repeat(14) + 'x';
  assert.equal(maskDesignInvite(`POST /api/design-teams/invites/${token}/accept`), 'POST /api/design-teams/invites/:token/accept');
  assert.equal(maskDesignInvite(`https://app.example.test/?designInvite=${token}#designs`), 'https://app.example.test/?designInvite=[token]#designs');
  const text = sanitize(`GET /api/design-teams/invites/${token} and ?designInvite=${token}`);
  assert.doesNotMatch(text, new RegExp(token));
});
