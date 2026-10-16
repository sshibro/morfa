import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantKind, connectionLine, dayLabel} from '../src/design/assistants/model';

// "Connections" (src/design/assistants): which mark a connection gets, and the line under it.

test('should tell Claude and ChatGPT by where they sign in back to, then by name', () => {
  assert.equal(assistantKind({clientHost: 'claude.ai', clientName: 'Claude'}), 'claude');
  assert.equal(assistantKind({clientHost: 'chatgpt.com', clientName: 'ChatGPT'}), 'chatgpt');
  assert.equal(assistantKind({clientHost: '127.0.0.1:33418', clientName: 'Claude Code'}), 'claude');
  assert.equal(assistantKind({clientHost: '127.0.0.1:1455', clientName: 'Codex'}), 'chatgpt');
  assert.equal(assistantKind({clientHost: 'cursor.com', clientName: 'Cursor'}), 'other');
});

test('should say when an assistant was connected and when it last worked', () => {
  const now = new Date(2026, 9, 12, 15, 0);
  assert.equal(dayLabel(new Date(2026, 9, 12, 9, 0).toISOString(), now), 'today');
  assert.equal(dayLabel(new Date(2026, 9, 11, 23, 0).toISOString(), now), 'yesterday');
  assert.equal(dayLabel(new Date(2026, 9, 3, 12, 0).toISOString(), now), 'October 3');
  assert.equal(connectionLine({createdAt: new Date(2026, 9, 3).toISOString(), lastUsedAt: null}, now), 'Connected October 3 · not used yet');
  assert.equal(
    connectionLine({createdAt: new Date(2026, 9, 3).toISOString(), lastUsedAt: new Date(2026, 9, 12, 14).toISOString()}, now),
    'Connected October 3 · last used today',
  );
});
