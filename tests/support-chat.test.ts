import test from 'node:test';
import assert from 'node:assert/strict';
import {primeSupportConfig, readSupportConfig, resetSupportConfig, supportChatOn} from '../src/support/support-config';
import {setSupportPlace, supportPlace} from '../src/support/open';
import {
  chatDays, counterText, dayLabel, emptyText, newOperatorMessages, presenceText,
  readMessageId, receivedNote, receivedNoteRun, replyTimeText, TEAM_TYPING, teamHeadline, typicalReplyText, unconfirmed, type PendingMessage,
} from '../src/support/chat-model';
import {supportButtonLabel, unreadBadge, withSupportNote} from '../src/support/labels';
import {supportChannel} from '../src/design/engine/commands/help';
import {SUPPORT_MESSAGE_MAX, SUPPORT_TEAM_NAME, type SupportMessage, type SupportTeam} from '../shared/support';
import type {MenuItem} from '../src/design/ui/menu-model';

// The person's support chat (src/support): what /api/config switches on, where a message is written from, and what the panel draws
// (days, runs, pending messages, "Read", the counter) and the badges say.

const at = (iso: string) => new Date(iso);
const message = (id: string, author: SupportMessage['author'], createdAt: string, body = id): SupportMessage => ({id, author, body, createdAt});

test('the chat is on only when /api/config says so', () => {
  assert.deepEqual(readSupportConfig({supportChat: true, supportEmail: ' help@morfa.test '}), {supportChat: true, supportEmail: 'help@morfa.test'});
  for (const value of [{}, {supportChat: 'true'}, {supportChat: 1}, null, 'x', {supportChat: false}])
    assert.equal(readSupportConfig(value).supportChat, false, JSON.stringify(value));
  resetSupportConfig();
  assert.equal(supportChatOn(), false);
  primeSupportConfig({supportChat: true});
  assert.equal(supportChatOn(), true);
  assert.deepEqual(supportChannel(), {kind: 'chat'}, '"Contact support" opens the chat');
  primeSupportConfig({supportChat: false, supportEmail: 'help@morfa.test'});
  assert.deepEqual(supportChannel(), {kind: 'email', address: 'help@morfa.test'});
  resetSupportConfig();
});

test('a message names where it was written: the open file and its kind, the player, the file browser', () => {
  assert.deepEqual(supportPlace('#designs'), {where: 'files'});
  assert.deepEqual(supportPlace(''), {where: 'files'});
  assert.deepEqual(supportPlace('#design/f-1'), {fileId: 'f-1', where: 'editor'});
  assert.deepEqual(supportPlace('#design/f-1?present=frame'), {fileId: 'f-1', where: 'other'});
  const leave = setSupportPlace({fileId: 'b-1', where: 'board'});
  assert.deepEqual(supportPlace('#design/b-1'), {fileId: 'b-1', where: 'board'});
  // A later screen's registration is not undone by an earlier one leaving.
  const next = setSupportPlace({fileId: 'f-2', where: 'editor'});
  leave();
  assert.deepEqual(supportPlace('#designs'), {fileId: 'f-2', where: 'editor'});
  next();
  assert.deepEqual(supportPlace('#designs'), {where: 'files'});
});

test('days read "Today", "Yesterday", then the date, with the year only when it is another one', () => {
  const now = at('2026-10-10T15:00:00');
  assert.equal(dayLabel(at('2026-10-10T00:05:00'), now), 'Today');
  assert.equal(dayLabel(at('2026-10-09T23:59:00'), now), 'Yesterday');
  assert.equal(dayLabel(at('2026-10-08T12:00:00'), now), 'October 8');
  assert.equal(dayLabel(at('2025-12-31T12:00:00'), now), 'December 31, 2025');
});

test('the conversation splits into days and into runs of one side close in time; pending messages come last', () => {
  const now = at('2026-10-10T15:00:00');
  const messages = [
    message('a', 'user', at('2026-10-08T10:00:00').toISOString()),
    message('b', 'operator', at('2026-10-09T09:00:00').toISOString()),
    message('c', 'operator', at('2026-10-09T09:03:00').toISOString()),
    message('d', 'operator', at('2026-10-09T09:30:00').toISOString()),
    message('e', 'user', at('2026-10-10T14:00:00').toISOString()),
  ];
  const pending: PendingMessage[] = [{clientId: 'p', body: 'More', createdAt: at('2026-10-10T14:01:00').toISOString(), status: 'sending'}];
  const days = chatDays(messages, pending, now);
  assert.deepEqual(days.map(day => day.label), ['October 8', 'Yesterday', 'Today']);
  assert.deepEqual(days[1]!.runs.map(run => run.bubbles.map(bubble => bubble.key)), [['b', 'c'], ['d']], 'a gap of more than five minutes starts a run');
  assert.deepEqual(days[2]!.runs.map(run => [run.author, run.bubbles.map(bubble => bubble.key)]), [['user', ['e', 'pending:p']]]);
  assert.equal(days[2]!.runs[0]!.bubbles[1]!.pending?.status, 'sending');
});

test('a pending message is taken by the server\'s copy of it, once', () => {
  const sentAt = '2026-10-10T12:00:00.000Z';
  const pending: PendingMessage[] = [
    {clientId: 'one', body: 'Hello', createdAt: sentAt, status: 'failed'},
    {clientId: 'two', body: 'Hello', createdAt: sentAt, status: 'sending'},
    {clientId: 'three', body: 'Other', createdAt: sentAt, status: 'sending'},
  ];
  const server = [message('m1', 'user', '2026-10-10T12:00:01.000Z', 'Hello'), message('m0', 'operator', '2026-10-10T12:00:02.000Z', 'Other')];
  assert.deepEqual(unconfirmed(server, pending).map(item => item.clientId), ['two', 'three'], 'one copy takes one; an operator\'s text takes none');
  const old = [message('m2', 'user', '2026-10-10T11:00:00.000Z', 'Hello')];
  assert.equal(unconfirmed(old, pending).length, 3, 'an old message with the same words is not this one');
});

test('the same words sent again are a new message, not the copy of the one already shown', () => {
  // "Thanks" twice within minutes: the second was taken as the first's copy at once, so it vanished and a failed send was lost.
  const shown = [message('m1', 'user', '2026-10-10T12:00:00.000Z', 'Thanks')];
  const again: PendingMessage = {clientId: 'p2', body: 'Thanks', createdAt: '2026-10-10T12:03:00.000Z', status: 'sending', seen: ['m1']};
  assert.deepEqual(unconfirmed(shown, [again]).map(item => item.clientId), ['p2'], 'still on its way');
  assert.deepEqual(unconfirmed(shown, [{...again, status: 'failed'}]).map(item => item.status), ['failed'], 'a failed one stays to send again');
  const arrived = [...shown, message('m2', 'user', '2026-10-10T12:03:01.000Z', 'Thanks')];
  assert.deepEqual(unconfirmed(arrived, [again]), [], 'its own copy takes it');
});

test('"Read" stands under the person\'s message when it is the last and the operator read past it', () => {
  const messages = [message('a', 'operator', '2026-10-10T10:00:00.000Z'), message('b', 'user', '2026-10-10T10:05:00.000Z')];
  assert.equal(readMessageId(messages, null), null);
  assert.equal(readMessageId(messages, '2026-10-10T10:04:00.000Z'), null);
  assert.equal(readMessageId(messages, '2026-10-10T10:05:00.000Z'), 'b');
  assert.equal(readMessageId([...messages, message('c', 'operator', '2026-10-10T10:06:00.000Z')], '2026-10-10T10:07:00.000Z'), null, 'an answer says it');
  assert.equal(readMessageId([], '2026-10-10T10:07:00.000Z'), null);
});

test('the counter shows near the limit, counts the trimmed text, and says when it is over', () => {
  assert.equal(counterText('Hello'), null);
  assert.equal(counterText(' '.repeat(3600) + 'a'), null);
  assert.deepEqual(counterText('x'.repeat(3600)), {text: '3,600 / 4,000', over: false});
  assert.deepEqual(counterText('x'.repeat(SUPPORT_MESSAGE_MAX + 1)), {text: '4,001 / 4,000', over: true});
});

test('only the operator\'s new messages are read out', () => {
  const messages = [message('a', 'operator', '2026-10-10T10:00:00.000Z'), message('b', 'user', '2026-10-10T10:01:00.000Z'), message('c', 'operator', '2026-10-10T10:02:00.000Z')];
  assert.deepEqual(newOperatorMessages(messages, new Set(['a'])).map(item => item.id), ['c']);
});

test('the badges: the count, the button\'s name, the menu line under "Contact support"', () => {
  assert.deepEqual([unreadBadge(1), unreadBadge(9), unreadBadge(10)], ['1', '9', '9+']);
  assert.equal(supportButtonLabel(0), 'Contact support');
  assert.equal(supportButtonLabel(1), 'Support. New support reply');
  assert.equal(supportButtonLabel(3), 'Support. 3 new support replies');
  const select = () => undefined;
  const menu: MenuItem[] = [
    {id: 'app.back-to-files', label: 'Back to files', onSelect: select},
    {type: 'submenu', id: 'menu:help', label: 'Help', items: [{id: 'help.guide', label: 'Guide', onSelect: select}, {id: 'help.support', label: 'Contact support', onSelect: select}]},
  ];
  assert.equal(withSupportNote(menu, 0), menu);
  const noted = withSupportNote(menu, 2);
  const help = noted[1] as Extract<MenuItem, {type: 'submenu'}>;
  assert.equal((help.items[1] as {description?: string}).description, '2 new support replies');
  assert.equal((help.items[0] as {description?: string}).description, undefined);
});

const team = (fields: Partial<SupportTeam> = {}): SupportTeam => ({
  operators: [{name: 'Morfa team'}],
  online: true,
  typicalReplyMinutes: null,
  emailFollowUp: false,
  ...fields,
});
const plain = (text: string) => text.replaceAll(' ', ' ');

test('who answers is the team, never one person by name', () => {
  const headline = teamHeadline(team())!;
  assert.deepEqual([headline.title, plain(headline.subtitle)], [SUPPORT_TEAM_NAME, 'Our team will answer you — real people, not a bot']);
  assert.ok(!headline.subtitle.includes(' —') && headline.subtitle.includes('not\u00a0a\u00a0bot'), 'a dash never starts a line');
  // A tab of an earlier release could still pass an operator's name: it is never said.
  assert.deepEqual(teamHeadline(team({operators: [{name: 'John Smith'}, {name: 'Maria'}]})), headline);
  assert.equal(teamHeadline(team({operators: []})), null);
  assert.equal(plain(emptyText(team())), 'Describe your question in your own words — our team will read it. The reply will appear here, and the support button will show a badge.');
  assert.equal(emptyText(team({operators: []})), 'Tell us what happened or what you want to know. The reply will appear here.');
  assert.equal(TEAM_TYPING, `${SUPPORT_TEAM_NAME} is typing…`);
});

test('presence and the reply time say only what was measured', () => {
  assert.equal(presenceText(team()), 'Online');
  assert.equal(plain(presenceText(team({online: false}))), 'We are offline right now — we will reply here as soon as we are back');
  assert.equal(typicalReplyText(team()), null, 'no measure, no promise');
  assert.deepEqual([1, 3, 9, 12, 38, 54, 55, 90, 179, 24 * 60, 36 * 60, 3 * 24 * 60].map(replyTimeText),
    ['~1 min', '~3 min', '~9 min', '~10 min', '~40 min', '~55 min', '~1 h', '~2 h', '~3 h', '~24 h', '~2 d', '~3 d']);
  assert.deepEqual([null, 0, -5, Number.NaN].map(value => replyTimeText(value as number | null)), [null, null, null, null]);
  assert.equal(typicalReplyText(team({typicalReplyMinutes: 42})), 'We usually reply within ~40 min');
});

test('the note after the first message: a person reads it; the letter is promised only when one will go', () => {
  assert.equal(plain(receivedNote(team())), 'Message received. A person from our team will read it. The reply will appear here.');
  assert.equal(plain(receivedNote(team({emailFollowUp: true}))), 'Message received. A person from our team will read it. The reply will appear here; if you leave, we will email you.');
  const mine = message('a', 'user', '2026-10-10T10:00:00.000Z');
  const pending: PendingMessage = {clientId: 'p', body: 'More', createdAt: '2026-10-10T10:01:00.000Z', status: 'sending'};
  assert.equal(receivedNoteRun(chatDays([], [pending])), null, 'not before the server has it');
  assert.equal(receivedNoteRun(chatDays([mine], [pending])), 'a');
  assert.equal(receivedNoteRun(chatDays([mine, message('b', 'operator', '2026-10-10T10:30:00.000Z')])), null, 'gone once answered');
});

test('the team\'s answers close in time are one run, whoever of the operators wrote them', () => {
  const at = (minute: number) => `2026-10-10T10:0${minute}:00.000Z`;
  const days = chatDays([
    {...message('a', 'operator', at(0)), authorName: 'Ivan'},
    {...message('b', 'operator', at(1)), authorName: 'Ivan'},
    {...message('c', 'operator', at(2)), authorName: 'Maria'},
  ], [], new Date('2026-10-10T12:00:00.000Z'));
  assert.deepEqual(days[0]!.runs.map(run => [run.author, run.bubbles.length]), [['operator', 3]]);
});
