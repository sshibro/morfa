import test from 'node:test';
import assert from 'node:assert/strict';
import type {Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {smtpSink} from './helpers/smtp-sink';
import {SUPPORT_API, SUPPORT_MESSAGE_MAX, type SupportConversation, type SupportInbox, type SupportThreadView} from '../shared/support';

// The support chat (shared/support.ts, server/support) through the whole app on the real PostgreSQL schema: the person's side
// (/api/support) and the operators' (/api/admin/support) behind the operator check, the read marks and unread counts both ways, the
// inbox's filters, counts, order and search, closing and reopening, the switch, the limits, and the operators' letter. The person is
// told the truth about who answers: the team (never an operator's name), its presence, "typing", the measured reply time, and a
// letter about an answer they have not seen.

type Answer<T = any> = {status: number; data: T; cookie: string | null};
type Session = {id: string; token: string};

/** A letter's text part, decoded (nodemailer writes it quoted-printable or base64, by its content). */
function letterText(data: string): string {
  const split = data.indexOf('\r\n\r\n');
  const headers = data.slice(0, split),
    body = data.slice(split + 4);
  const encoding = /^Content-Transfer-Encoding:\s*([\w-]+)/im.exec(headers)?.[1]?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable')
    return Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
  return body;
}

test('the support chat: the person writes, the operator answers', {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const keys = ['APP_ORIGIN', 'MORFA_OPERATORS', 'SUPPORT_CHAT', 'SUPPORT_NOTIFY_EMAIL', 'MORFA_SMTP_URL', 'MORFA_MAIL_FROM'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const sink = await smtpSink();
  Object.assign(process.env, {
    // An e-mail and an account id, set below.
    MORFA_OPERATORS: ' Olga@localhost , ',
    SUPPORT_NOTIFY_EMAIL: 'support@example.test',
    MORFA_SMTP_URL: `smtp://127.0.0.1:${sink.port}`,
    MORFA_MAIL_FROM: 'Morfa <team@example.test>',
  });
  t.after(async () => {
    await sink.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const {app, drainAppTasks} = await import('../server/app');
  const {drainSupportNotifications} = await import('../server/support/notify');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  const cookieName = auth.authCookieName('session');
  async function call<T = any>(url: string, init: {method?: string; json?: unknown; session?: Session; headers?: Record<string, string>} = {}): Promise<Answer<T>> {
    const response = await fetch(base + '/api' + url, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(init.session ? {cookie: cookieName + '=' + init.session.token} : {}),
        ...(init.json !== undefined ? {'content-type': 'application/json'} : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await response.text();
    const cookie = new RegExp(cookieName + '=([^;]*)').exec(response.headers.get('set-cookie') ?? '')?.[1] || null;
    return {status: response.status, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cookie};
  }
  const signIn = async (email: string, name: string): Promise<Session> => {
    const answer = await call('/auth/name', {json: {name}});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    // The account is a name account; these specs are about letters to a person's address, so it is given one.
    await db.execute('UPDATE users SET email=$1 WHERE id=$2', [email, answer.data.id]);
    return {id: answer.data.id, token: answer.cookie!};
  };
  const send = (session: Session, body: unknown, clientId: string = randomUUID(), context?: unknown) =>
    call<SupportThreadView & {code?: string; error?: string}>(SUPPORT_API.messages, {session, json: {body, clientId, ...(context !== undefined ? {context} : {})}});
  const view = async (session: Session) => {
    const answer = await call<SupportThreadView>(SUPPORT_API.thread, {session});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    return answer.data;
  };
  const unread = async (session: Session) => (await call<{unread: number}>(SUPPORT_API.unread, {session})).data.unread;
  const inbox = async (session: Session, query = '') => {
    const answer = await call<SupportInbox>(SUPPORT_API.inbox + query, {session});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    return answer.data;
  };
  const conversation = async (session: Session, id: string) => {
    const answer = await call<SupportConversation>(SUPPORT_API.conversation(id), {session});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    return answer.data;
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const UNKNOWN = {error: 'Route not found.'};

  const olga = await signIn('olga@localhost', 'Olga');
  // Anna and Vera keep Cyrillic names on purpose: the inbox search below finds them in Cyrillic, in any case.
  const anna = await signIn('anna@localhost', 'Анна Петрова');
  const boris = await signIn('boris@localhost', 'Boris');
  const vera = await signIn('vera@localhost', 'Вера');
  // An operator named by account id.
  const igor = await signIn('igor@localhost', 'Igor');
  process.env.MORFA_OPERATORS += ',' + igor.id;

  await t.test('the chat is on while an operator is named, and off with SUPPORT_CHAT=0', async () => {
    assert.equal((await call('/config')).data.supportChat, true);
    process.env.SUPPORT_CHAT = '0';
    try {
      assert.equal((await call('/config')).data.supportChat, false);
      for (const url of [SUPPORT_API.thread, SUPPORT_API.unread]) assert.deepEqual(await call(url, {session: anna}), {status: 404, data: UNKNOWN, cookie: null});
      assert.deepEqual((await send(anna, 'Hello')).data, UNKNOWN);
      // The operators still reach what was written.
      assert.equal((await call(SUPPORT_API.waiting, {session: olga})).status, 200);
    } finally {
      delete process.env.SUPPORT_CHAT;
    }
    const operators = process.env.MORFA_OPERATORS;
    process.env.MORFA_OPERATORS = ' , ';
    try {
      assert.equal((await call('/config')).data.supportChat, false, 'nobody to answer');
      assert.equal((await call(SUPPORT_API.thread, {session: anna})).status, 404);
    } finally {
      process.env.MORFA_OPERATORS = operators;
    }
    assert.equal((await call(SUPPORT_API.thread)).status, 401, 'the person\'s side needs a session');
  });

  await t.test('before the first message there is no conversation, nothing unread, nothing to mark', async () => {
    const first = await view(anna);
    assert.deepEqual([first.enabled, first.thread, first.operatorTyping], [true, null, false]);
    assert.equal(await unread(anna), 0);
    assert.equal((await call(SUPPORT_API.read, {session: anna, json: {}})).status, 204);
  });

  await t.test('who answers: the team, never an operator\'s name; honest presence', async () => {
    const {resetPresenceThrottle} = await import('../server/support/team');
    try {
      const team = (await view(anna)).team;
      assert.deepEqual(team.operators, [{name: 'Morfa team'}], 'two operators, one team');
      assert.ok(!JSON.stringify(team).includes('Olga') && !JSON.stringify(team).includes('Igor'));
      assert.equal(team.typicalReplyMinutes, null, 'no answers yet: nothing is promised');
      assert.equal(team.emailFollowUp, true, 'mail is configured, and outside production a development address receives it');
      // Presence: an operator used the console's support routes within three minutes; stored, so every process agrees.
      await db.execute('DELETE FROM support_operator_presence');
      resetPresenceThrottle();
      assert.equal((await view(anna)).team.online, false, 'nobody used the console');
      assert.equal((await call(SUPPORT_API.waiting, {session: igor})).status, 200);
      assert.equal((await view(anna)).team.online, true);
      await db.execute("UPDATE support_operator_presence SET seen_at=clock_timestamp()-interval '181 seconds'");
      assert.equal((await view(anna)).team.online, false, 'three minutes is the window');
      await db.execute("UPDATE support_operator_presence SET seen_at=clock_timestamp()-interval '170 seconds'");
      assert.equal((await view(anna)).team.online, true);
      // Anyone else's visit to the console's routes is no presence; an operator no longer named is not present.
      await db.execute('DELETE FROM support_operator_presence');
      resetPresenceThrottle();
      assert.equal((await call(SUPPORT_API.waiting, {session: anna})).status, 404);
      assert.equal((await view(anna)).team.online, false);
      await db.execute('INSERT INTO support_operator_presence(user_id) VALUES($1)', [igor.id]);
      const operators = process.env.MORFA_OPERATORS;
      process.env.MORFA_OPERATORS = 'olga@localhost';
      try {
        const alone = (await view(anna)).team;
        assert.deepEqual([alone.operators, alone.online], [[{name: 'Morfa team'}], false]);
      } finally {
        process.env.MORFA_OPERATORS = operators;
      }
      // Without mail the note promises no letter.
      delete process.env.MORFA_SMTP_URL;
      assert.equal((await view(anna)).team.emailFollowUp, false);
    } finally {
      process.env.MORFA_SMTP_URL = `smtp://127.0.0.1:${sink.port}`;
    }
  });

  await t.test('"we usually reply within": the median wait for an answer over thirty days, hidden below five answers', async () => {
    const {measureTypicalReply, resetSupportStats} = await import('../server/support/team');
    const people: string[] = [];
    /** A conversation of its own whose person waited `waits` minutes for each answer, `daysAgo` days ago. */
    const conversation = async (waits: number[], {daysAgo = 1, again = false}: {daysAgo?: number; again?: boolean} = {}) => {
      const person = 'median:' + randomUUID(),
        thread = randomUUID();
      people.push(person);
      await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Example','')", [person, randomUUID() + '@example.invalid']);
      await db.execute('INSERT INTO support_threads(id,user_id) VALUES($1,$2)', [thread, person]);
      const message = (author: string, minutesAgo: number) =>
        db.execute(
          `INSERT INTO support_messages(id,thread_id,author,operator_id,body,client_id,created_at)
           VALUES($1,$2,$3,$4,'Text',$5,clock_timestamp()-make_interval(mins=>$6::int))`,
          [randomUUID(), thread, author, author === 'operator' ? olga.id : null, randomUUID(), minutesAgo],
        );
      let at = daysAgo * 24 * 60;
      for (const wait of waits) {
        await message('user', at);
        // A second message while waiting: the wait counts from the first.
        await message('user', at - 1);
        await message('operator', at - wait);
        // An answer right after an answer: nobody was waiting, no sample.
        if (again) await message('operator', at - wait - 1);
        at -= wait + 60;
      }
    };
    try {
      await conversation([10, 20], {again: true});
      await conversation([30, 40]);
      assert.equal(await measureTypicalReply(db), null, 'four answers are not enough');
      await conversation([50]);
      assert.equal(await measureTypicalReply(db), 30, 'the median of five');
      await conversation([1000, 2000], {daysAgo: 40});
      assert.equal(await measureTypicalReply(db), 30, 'answers older than thirty days do not count');
      await conversation([100, 200]);
      assert.equal(await measureTypicalReply(db), 40);
      resetSupportStats();
      assert.equal((await view(anna)).team.typicalReplyMinutes, 40, 'the person is told the measured time');
    } finally {
      await db.execute('DELETE FROM support_threads WHERE user_id=ANY($1::text[])', [people]);
      resetSupportStats();
    }
    assert.equal((await view(anna)).team.typicalReplyMinutes, null);
  });

  let annaThread = '';
  await t.test('the person writes: trimmed plain text, where from, once per key', async () => {
    const fileId = randomUUID();
    const first = await send(anna, '  <b>Cannot</b> export PDF\n\n', 'anna-1', {fileId, where: 'editor', extra: 'dropped'});
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const thread = first.data.thread!;
    annaThread = thread.id;
    assert.equal(thread.status, 'open');
    assert.deepEqual(thread.messages.map(message => [message.author, message.body]), [['user', '<b>Cannot</b> export PDF']]);
    assert.match(thread.messages[0]!.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(thread.messages[0]!).sort(), ['author', 'body', 'createdAt', 'id'], 'the person sees no context');
    // A retry of the same key is the same message, whatever it carries.
    const retry = await send(anna, 'Something else', 'anna-1');
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data.thread!.messages.map(message => message.id), [thread.messages[0]!.id]);
    const stored = await db.one<{context: unknown; n: number}>(
      "SELECT context,(SELECT count(*)::int FROM support_messages WHERE thread_id=$1) AS n FROM support_messages WHERE thread_id=$1 AND client_id='anna-1'",
      [annaThread],
    );
    assert.deepEqual(stored, {context: {fileId, where: 'editor'}, n: 1});
    // The operator sees where it was written from.
    const seen = await conversation(olga, annaThread);
    assert.deepEqual(seen.messages[0]!.context, {fileId, where: 'editor'});
    assert.deepEqual(seen.account, {id: anna.id, name: 'Анна Петрова', email: 'anna@localhost'});
  });

  await t.test('a message is refused when empty, too long or malformed', async () => {
    for (const body of ['', '   \n\t ', '\u0000']) {
      const answer = await send(anna, body);
      assert.deepEqual([answer.status, answer.data.code, answer.data.error], [422, 'empty_message', 'Write a message.'], JSON.stringify(body));
    }
    // Cyrillic on purpose: the limit counts characters, not bytes.
    const long = await send(anna, 'я'.repeat(SUPPORT_MESSAGE_MAX + 1));
    assert.deepEqual([long.status, long.data.code], [422, 'message_too_long']);
    assert.match(long.data.error ?? '', /^The message is longer than 4,000 characters/);
    assert.equal((await send(anna, '  ' + 'я'.repeat(SUPPORT_MESSAGE_MAX) + '  ')).status, 200, 'the limit counts the trimmed text');
    for (const json of [{body: 'Hello'}, {body: 'Hello', clientId: 'not a key'}, {body: 42, clientId: 'k'}, {body: 'Hello', clientId: 'x'.repeat(101)}])
      assert.equal((await call(SUPPORT_API.messages, {session: anna, json})).status, 400, JSON.stringify(json));
    assert.equal((await call(SUPPORT_API.messages, {session: anna, json: ['Hello']})).status, 400);
    assert.equal((await view(anna)).thread!.messages.length, 2);
  });

  await t.test('only operators reach the console\'s routes; everyone else gets the unknown-route answer', async () => {
    for (const session of [undefined, anna, boris])
      for (const url of [SUPPORT_API.inbox, SUPPORT_API.conversation(annaThread), SUPPORT_API.waiting, SUPPORT_API.inbox + '?filter=all']) {
        const answer = await call(url, {session});
        assert.deepEqual([answer.status, answer.data], [404, UNKNOWN], `${url} as ${session?.id ?? 'nobody'}`);
      }
    for (const url of [SUPPORT_API.reply(annaThread), SUPPORT_API.status(annaThread), SUPPORT_API.operatorRead(annaThread)])
      assert.deepEqual((await call(url, {session: anna, json: {body: 'Hack', clientId: 'x', status: 'closed'}})).data, UNKNOWN);
    assert.equal((await inbox(igor)).counts.all, 1, 'an operator named by id');
    // An operator's tab acting for another account is refused like any other route's.
    assert.equal((await call(SUPPORT_API.inbox, {session: olga, headers: {'x-forma-account': anna.id}})).status, 409);
    const {isOperator} = await import('../server/admin/operators');
    const row = {id: 'acc-1', email: 'Op@Example.ru', email_verified: 0, deletion_requested_at: null, erasure_completed_at: null};
    assert.equal(isOperator(row, {MORFA_OPERATORS: 'op@example.ru', NODE_ENV: 'production'}), false, 'an unproven address in production');
    assert.equal(isOperator({...row, email_verified: 1}, {MORFA_OPERATORS: 'op@example.ru', NODE_ENV: 'production'}), true);
    assert.equal(isOperator(row, {MORFA_OPERATORS: 'acc-1', NODE_ENV: 'production'}), true, 'an id needs no proof');
    assert.equal(isOperator({...row, deletion_requested_at: '2026-10-10 10:00:00'}, {MORFA_OPERATORS: 'acc-1'}), false, 'a closing account');
    assert.equal(isOperator({...row, erasure_completed_at: '2026-10-10 10:00:00'}, {MORFA_OPERATORS: 'acc-1'}), false);
    assert.equal(isOperator(row, {MORFA_OPERATORS: 'acc-10,cc-1'}), false, 'whole entries only');
  });

  let borisThread = '',
    veraThread = '';
  await t.test('the inbox: waiting longest first, the rest newest first, counts per filter, search by name or e-mail', async () => {
    await tick();
    borisThread = (await send(boris, 'How do I add a member to my team?')).data.thread!.id;
    await tick();
    veraThread = (await send(vera, 'Thanks, everything works!')).data.thread!.id;
    await tick();
    await send(anna, 'One more question: where is the version history?');
    let box = await inbox(olga);
    assert.deepEqual(box.rows.map(row => row.id), [annaThread, borisThread, veraThread], 'waiting the longest first');
    assert.deepEqual(box.counts, {waiting: 3, open: 3, closed: 0, all: 3});
    const annaRow = box.rows[0]!;
    assert.deepEqual(annaRow.account, {id: anna.id, name: 'Анна Петрова', email: 'anna@localhost'});
    assert.deepEqual([annaRow.status, annaRow.unread, annaRow.last.author, annaRow.last.body], ['open', 3, 'user', 'One more question: where is the version history?']);
    assert.ok(annaRow.waitingSince! < annaRow.last.createdAt, 'waiting since the first unanswered message');
    assert.equal(annaRow.updatedAt, annaRow.last.createdAt);
    box = await inbox(olga, '?filter=open');
    assert.deepEqual(box.rows.map(row => row.id), [annaThread, veraThread, borisThread], 'newest first');
    assert.deepEqual((await inbox(olga, '?filter=all')).rows.map(row => row.id), [annaThread, veraThread, borisThread]);
    assert.deepEqual((await inbox(olga, '?filter=closed')).rows, []);
    // Search: the name or the e-mail, case-insensitive in Cyrillic too, its wildcards literal.
    assert.deepEqual((await inbox(olga, '?filter=all&q=' + encodeURIComponent('аННа'))).rows.map(row => row.id), [annaThread]);
    assert.deepEqual((await inbox(olga, '?filter=all&q=BORIS@')).rows.map(row => row.id), [borisThread]);
    const searched = await inbox(olga, '?q=' + encodeURIComponent('  вер '));
    assert.deepEqual([searched.rows.map(row => row.id), searched.counts], [[veraThread], {waiting: 1, open: 1, closed: 0, all: 1}]);
    for (const q of ['%', '_', '\\', 'a%a'])
      assert.deepEqual((await inbox(olga, '?filter=all&q=' + encodeURIComponent(q))).rows, [], `"${q}" is literal`);
    assert.equal((await call(SUPPORT_API.inbox + '?filter=spam', {session: olga})).status, 400);
    assert.deepEqual((await call(SUPPORT_API.waiting, {session: olga})).data, {waiting: 3});
  });

  await t.test('an answer ends the wait, the person sees it unread until they read it; the read marks go both ways', async () => {
    const before = await conversation(olga, annaThread);
    assert.equal(before.userReadAt !== null, true, 'sending reads what the answer shows');
    const replied = await call<SupportConversation>(SUPPORT_API.reply(annaThread), {session: olga, json: {body: ' Hello, Anna! Let me take a look. ', clientId: 'olga-1'}});
    assert.equal(replied.status, 200, JSON.stringify(replied.data));
    assert.deepEqual(replied.data.messages.at(-1)!.body, 'Hello, Anna! Let me take a look.');
    assert.equal(replied.data.messages.at(-1)!.author, 'operator');
    assert.equal((await call<SupportConversation>(SUPPORT_API.reply(annaThread), {session: olga, json: {body: 'Repeat', clientId: 'olga-1'}})).data.messages.length, replied.data.messages.length, 'once per key');
    assert.deepEqual(await db.one("SELECT operator_id FROM support_messages WHERE thread_id=$1 AND client_id='olga-1'", [annaThread]), {operator_id: olga.id});
    // The person: one unread answer, until read.
    assert.equal(await unread(anna), 1);
    let thread = (await view(anna)).thread!;
    assert.deepEqual([thread.unread, thread.messages.at(-1)!.author], [1, 'operator']);
    const lastOfPerson = thread.messages.filter(message => message.author === 'user').at(-1)!;
    assert.ok(thread.operatorReadAt! >= lastOfPerson.createdAt, 'the answer read what came before it: "Read"');
    assert.equal((await call(SUPPORT_API.read, {session: anna, json: {}})).status, 204);
    assert.equal(await unread(anna), 0);
    thread = (await view(anna)).thread!;
    assert.equal(thread.unread, 0);
    assert.ok((await conversation(olga, annaThread)).userReadAt! >= thread.messages.at(-1)!.createdAt, '"read" under the operator\'s answer');
    // The operator's side: no longer waiting, nothing unread.
    let box = await inbox(olga);
    assert.deepEqual(box.rows.map(row => row.id), [borisThread, veraThread]);
    assert.deepEqual(box.counts, {waiting: 2, open: 3, closed: 0, all: 3});
    const annaRow = (await inbox(olga, '?filter=all')).rows.find(row => row.id === annaThread)!;
    assert.deepEqual([annaRow.unread, annaRow.waitingSince, annaRow.last.author], [0, null, 'operator']);
    // The person writes again: waiting since then, one unread for the operator until it reads.
    await tick();
    await send(anna, 'Found it, thanks!');
    box = await inbox(olga);
    assert.deepEqual(box.rows.map(row => [row.id, row.unread]), [[borisThread, 1], [veraThread, 1], [annaThread, 1]]);
    assert.equal((await call(SUPPORT_API.operatorRead(annaThread), {session: igor, json: {}})).status, 204);
    assert.equal((await inbox(olga)).rows.find(row => row.id === annaThread)!.unread, 0);
    assert.equal((await inbox(olga)).rows.find(row => row.id === annaThread)!.waitingSince !== null, true, 'reading is not answering');
  });

  await t.test('closing and opening: an answer or the person\'s next message opens a closed conversation again', async () => {
    const closed = await call<SupportConversation>(SUPPORT_API.status(veraThread), {session: olga, json: {status: 'closed'}});
    assert.deepEqual([closed.status, closed.data.status], [200, 'closed']);
    assert.equal((await view(vera)).thread!.status, 'closed');
    let box = await inbox(olga, '?filter=closed');
    assert.deepEqual([box.rows.map(row => row.id), box.rows[0]!.waitingSince], [[veraThread], null]);
    assert.deepEqual(box.counts, {waiting: 2, open: 2, closed: 1, all: 3});
    assert.equal((await call(SUPPORT_API.status(veraThread), {session: olga, json: {status: 'archived'}})).status, 400);
    // The same status again changes nothing.
    const updated = (await inbox(olga, '?filter=closed')).rows[0]!.updatedAt;
    await call(SUPPORT_API.status(veraThread), {session: olga, json: {status: 'closed'}});
    assert.equal((await inbox(olga, '?filter=closed')).rows[0]!.updatedAt, updated);
    // An answer opens it.
    const answered = await call<SupportConversation>(SUPPORT_API.reply(veraThread), {session: igor, json: {body: 'Glad to help!', clientId: 'igor-1'}});
    assert.equal(answered.data.status, 'open');
    assert.deepEqual(await db.one("SELECT operator_id FROM support_messages WHERE thread_id=$1 AND client_id='igor-1'", [veraThread]), {operator_id: igor.id});
    // Closed again, then the person's message opens it and starts a wait.
    await call(SUPPORT_API.status(veraThread), {session: olga, json: {status: 'closed'}});
    const reopened = await send(vera, 'One more');
    assert.equal(reopened.data.thread!.status, 'open');
    box = await inbox(olga);
    assert.ok(box.rows.some(row => row.id === veraThread));
    assert.deepEqual(box.counts, {waiting: 3, open: 3, closed: 0, all: 3});
  });

  await t.test('"typing": the operator\'s composer says so, the person sees it for six seconds, an answer ends it', async () => {
    assert.equal((await view(anna)).operatorTyping, false);
    assert.equal((await call(SUPPORT_API.typing(annaThread), {session: olga, json: {}})).status, 204);
    let seen = await view(anna);
    assert.equal(seen.operatorTyping, true);
    assert.ok(!JSON.stringify(seen).includes('Olga'), 'never which operator types');
    assert.equal((await view(vera)).operatorTyping, false, 'only in that conversation');
    const left = await db.one<{seconds: number}>(
      'SELECT extract(epoch FROM operator_typing_until-clock_timestamp())::float8 AS seconds FROM support_threads WHERE id=$1',
      [annaThread],
    );
    assert.ok(left!.seconds > 4.5 && left!.seconds <= 6, String(left!.seconds));
    await db.execute("UPDATE support_threads SET operator_typing_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [annaThread]);
    seen = await view(anna);
    assert.equal(seen.operatorTyping, false, 'it ends by itself');
    // Another operator types, then answers: the answer ends it; the person reads the team's answer, the console who wrote it.
    assert.equal((await call(SUPPORT_API.typing(annaThread), {session: igor, json: {}})).status, 204);
    assert.equal((await view(anna)).operatorTyping, true);
    assert.equal((await call(SUPPORT_API.reply(annaThread), {session: igor, json: {body: 'Let me check.', clientId: 'igor-typing'}})).status, 200);
    seen = await view(anna);
    assert.equal(seen.operatorTyping, false);
    assert.deepEqual(
      seen.thread!.messages.filter(message => message.author === 'operator').map(message => [message.body, message.authorName]),
      [['Hello, Anna! Let me take a look.', undefined], ['Let me check.', undefined]],
    );
    assert.ok(!JSON.stringify(seen).includes('Olga') && !JSON.stringify(seen).includes('Igor'), 'no operator\'s name reaches the person');
    assert.equal((await conversation(olga, annaThread)).messages.at(-1)!.authorName, 'Igor', 'the console sees who answered too');
    // Only operators, only a known conversation.
    assert.deepEqual((await call(SUPPORT_API.typing(annaThread), {session: anna, json: {}})).data, UNKNOWN);
    assert.equal((await call(SUPPORT_API.typing(randomUUID()), {session: olga, json: {}})).status, 404);
  });

  await t.test('an unknown conversation is 404', async () => {
    for (const id of [randomUUID(), 'not-a-thread'])
      for (const answer of [
        await call(SUPPORT_API.conversation(id), {session: olga}),
        await call(SUPPORT_API.reply(id), {session: olga, json: {body: 'Hello', clientId: 'x'}}),
        await call(SUPPORT_API.status(id), {session: olga, json: {status: 'closed'}}),
        await call(SUPPORT_API.operatorRead(id), {session: olga, json: {}}),
      ])
        assert.deepEqual([answer.status, answer.data.code], [404, 'not_found'], id);
    assert.equal((await call(SUPPORT_API.reply(annaThread), {session: olga, json: {body: '  ', clientId: 'x'}})).status, 422);
  });

  await t.test('the polls are no one\'s action in the activity journal', async () => {
    const telemetry = await import('../server/admin/telemetry');
    const gleb = await signIn('gleb@localhost', 'Glen');
    await telemetry.drainTelemetry();
    await db.execute('DELETE FROM admin_activity WHERE user_id=$1', [gleb.id]);
    await view(gleb);
    await unread(gleb);
    await call(SUPPORT_API.read, {session: gleb, json: {}});
    await telemetry.drainTelemetry();
    assert.deepEqual(await db.many('SELECT action FROM admin_activity WHERE user_id=$1', [gleb.id]), []);
    await send(gleb, 'Hello');
    await telemetry.drainTelemetry();
    assert.equal((await db.many('SELECT action FROM admin_activity WHERE user_id=$1', [gleb.id])).length, 1, 'writing is');
  });

  await t.test('one letter to the operators per conversation per quarter of an hour, after the commit', async () => {
    await drainSupportNotifications();
    const letters = sink.letters.filter(letter => letter.to.includes('support@example.test')).map(letter => letterText(letter.data));
    // Anna, Boris, Vera and Gleb each got one letter for their first message; their later messages fell in the same quarter hour.
    assert.equal(letters.length, 4, letters.join('\n---\n'));
    const annaLetter = letters.find(text => text.includes('anna@localhost'))!;
    assert.ok(annaLetter, 'names the account');
    assert.match(annaLetter, /From: Анна Петрова <anna@localhost>/);
    assert.ok(annaLetter.includes('<b>Cannot</b> export PDF'), 'the message as written, plain text');
    assert.match(sink.letters[0]!.data, /^Subject: New support request/m);
    const zoya = await signIn('zoya@localhost', 'Zoe');
    // Cyrillic on purpose: the letter cuts at 300 characters, not bytes.
    await send(zoya, 'Ж'.repeat(250) + ' ' + 'Ю'.repeat(200));
    await drainSupportNotifications();
    const zoyaLetter = letterText(sink.letters.at(-1)!.data);
    assert.ok(zoyaLetter.includes('zoya@localhost'));
    assert.ok(zoyaLetter.includes('Ж'.repeat(250) + ' ' + 'Ю'.repeat(49) + '…'), 'the first 300 characters');
    assert.ok(!zoyaLetter.includes('Ю'.repeat(50)));
    assert.ok(zoyaLetter.includes('/#admin/support'));
    // Mail off: no letter, and the message is still taken.
    delete process.env.MORFA_SMTP_URL;
    const count = sink.letters.length;
    const yan = await signIn('yan@localhost', 'Yan');
    assert.equal((await send(yan, 'No mail')).status, 200);
    await drainSupportNotifications();
    assert.equal(sink.letters.length, count);
    process.env.MORFA_SMTP_URL = `smtp://127.0.0.1:${sink.port}`;
  });

  await t.test('an answer the person has not seen for ten minutes is e-mailed to them, once, at most hourly', async () => {
    const {sendSupportFollowUps} = await import('../server/support/follow-up');
    const nina = await signIn('nina@localhost', 'Nina Orlova');
    const threadId = (await send(nina, 'How do I change my password?')).data.thread!.id;
    const answer = async (body: string) =>
      assert.equal((await call(SUPPORT_API.reply(threadId), {session: olga, json: {body, clientId: randomUUID()}})).status, 200);
    /** The whole conversation moves `minutes` into the past (its messages need the owner's role: the runtime never changes one). */
    const age = async (minutes: number) => {
      await f.migration.execute('UPDATE support_messages SET created_at=created_at-make_interval(mins=>$2::int) WHERE thread_id=$1', [threadId, minutes]);
      await db.execute(
        `UPDATE support_threads SET created_at=created_at-make_interval(mins=>$2::int),updated_at=updated_at-make_interval(mins=>$2::int),
           user_read_at=user_read_at-make_interval(mins=>$2::int),operator_read_at=operator_read_at-make_interval(mins=>$2::int),
           user_notified_at=user_notified_at-make_interval(mins=>$2::int),waiting_since=waiting_since-make_interval(mins=>$2::int)
         WHERE id=$1`,
        [threadId, minutes],
      );
    };
    // An hour passes for this conversation.
    const hourLater = () => age(61);
    const letters = () => sink.letters.filter(letter => letter.to.includes('nina@localhost')).map(letter => letterText(letter.data));
    await answer('Hello, Nina! The password is changed in "Settings ▸ Account".');
    assert.equal(await sendSupportFollowUps(), 0, 'not ten minutes yet');
    await age(11);
    assert.equal(await sendSupportFollowUps(), 1);
    const first = sink.letters.filter(letter => letter.to.includes('nina@localhost'));
    assert.equal(first.length, 1);
    assert.match(first[0]!.data, /^Subject: Morfa team replied to you in support/m);
    const text = letters()[0]!;
    assert.ok(text.includes('Hello, Nina!'));
    assert.ok(text.includes('Morfa team replied to you in support:'));
    assert.ok(!text.includes('Olga'), 'the team answered, never an operator by name');
    assert.ok(text.includes('The password is changed in "Settings ▸ Account".'));
    assert.ok(text.includes('/?support=1#designs'));
    assert.equal(await sendSupportFollowUps(), 0, 'an answer is told once');
    // A newer answer within the hour waits; after it, it is told, alone.
    await answer('Also: a strong password is safer.');
    await age(11);
    assert.equal(await sendSupportFollowUps(), 0, 'one letter an hour');
    await hourLater();
    assert.equal(await sendSupportFollowUps(), 1);
    assert.ok(letters()[1]!.includes('a strong password is safer') && !letters()[1]!.includes('Settings ▸ Account'));
    assert.equal(await sendSupportFollowUps(), 0);
    // Seen in time: no letter.
    await answer('Write to us if something does not work.');
    await age(11);
    await hourLater();
    assert.equal((await call(SUPPORT_API.read, {session: nina, json: {}})).status, 204);
    assert.equal(await sendSupportFollowUps(), 0, 'the person saw it');
    // A closing account gets none; nor does anyone while mail is off.
    await answer('The last answer.');
    await age(11);
    await hourLater();
    delete process.env.MORFA_SMTP_URL;
    assert.equal(await sendSupportFollowUps(), 0, 'mail is off');
    process.env.MORFA_SMTP_URL = `smtp://127.0.0.1:${sink.port}`;
    await db.execute("UPDATE users SET deletion_requested_at='2026-10-10 10:00:00' WHERE id=$1", [nina.id]);
    assert.equal(await sendSupportFollowUps(), 0, 'a closing account');
    await db.execute('UPDATE users SET deletion_requested_at=NULL WHERE id=$1', [nina.id]);
    assert.equal(await sendSupportFollowUps(), 1, 'the same answer once the account is live');
    assert.equal(letters().length, 3);
  });

  await t.test('sending is limited per account', async () => {
    const lev = await signIn('lev@localhost', 'Leo');
    for (let index = 0; index < 20; index++) assert.equal((await send(lev, 'Message ' + index)).status, 200, String(index));
    const limited = await send(lev, 'One more');
    assert.deepEqual([limited.status, limited.data.code], [429, 'rate_limited']);
    assert.match(limited.data.error ?? '', /sent many messages/);
    assert.equal((await view(lev)).thread!.messages.length, 20);
    assert.equal((await send(anna, 'And I have my own account')).status, 200, 'another account is not limited');
  });

  await t.test('the conversation goes with the account', async () => {
    const {eraseAccount} = await import('../server/launch/lifecycle');
    const before = (await inbox(olga, '?filter=all')).counts.all;
    await db.execute("UPDATE users SET deletion_requested_at='2026-10-10 10:00:00' WHERE id=$1", [boris.id]);
    assert.equal((await inbox(olga, '?filter=all')).counts.all, before - 1, 'a closing account is out of the inbox');
    assert.equal((await call(SUPPORT_API.conversation(borisThread), {session: olga})).status, 404);
    await eraseAccount(boris.id, new Date().toISOString());
    assert.deepEqual(await db.many('SELECT id FROM support_threads WHERE id=$1', [borisThread]), []);
    assert.deepEqual(await db.many('SELECT id FROM support_messages WHERE thread_id=$1', [borisThread]), []);
  });
});
