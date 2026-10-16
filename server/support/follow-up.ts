import {db} from '../db';
import {mailEnabled, sendMail, type Mail} from '../mail';
import {appOrigin} from '../app-origin';
import {PRODUCT_NAME} from '../../shared/design/product';
import {SUPPORT_FOLLOW_UP_AFTER_MS, SUPPORT_FOLLOW_UP_EVERY_MS, SUPPORT_TEAM_NAME} from '../../shared/support';
import {SUPPORT_NOTIFY_QUOTE} from './notify';
import {supportMailReaches} from './team';

// "The Morfa team replied to you in support": an operator's answer the person has not seen SUPPORT_FOLLOW_UP_AFTER_MS after it came is
// e-mailed to them, at most one letter per conversation per SUPPORT_FOLLOW_UP_EVERY_MS and only for answers newer than the last
// letter (an answer is told once). The worker's minute pass (server/worker.ts) sends them. Only while mail is configured
// (server/mail.ts), only to an address that can receive it (server/support/team.ts supportMailReaches), never for a closing account,
// never for answers older than two days (a letter about a stale answer helps nobody). The claim is the UPDATE of
// support_threads.user_notified_at, so a letter goes once whichever process runs the pass; a refused letter is logged by its
// provider's code only and not retried.

/** Answers older than this are not e-mailed. */
const FRESH_FOR = '2 days';
/** The conversations whose person has an unseen answer that is due, and may get a letter now. `t` and `u` are the thread and the
 *  person; $1 and $2 the waits in milliseconds. */
const DUE = `u.deletion_requested_at IS NULL AND u.erasure_completed_at IS NULL
  AND (t.user_notified_at IS NULL OR t.user_notified_at<=clock_timestamp()-make_interval(secs=>$2::int/1000.0))
  AND EXISTS (SELECT 1 FROM support_messages m WHERE m.thread_id=t.id AND m.author='operator'
    AND m.created_at<=clock_timestamp()-make_interval(secs=>$1::int/1000.0)
    AND m.created_at>clock_timestamp()-interval '${FRESH_FOR}'
    AND (t.user_read_at IS NULL OR m.created_at>t.user_read_at)
    AND (t.user_notified_at IS NULL OR m.created_at>t.user_notified_at))`;

/** The first name of an account's name ("Ivan" of "Ivan Petrov"). */
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** The letter: the team answered (never an operator's name, shared/support.ts SupportTeam), the start of what it wrote, and the way
 *  back to the conversation. Plain text only. */
export function supportFollowUpLetter(to: string, person: {name: string}, body: string, origin = appOrigin()): Mail {
  const quote = body.length > SUPPORT_NOTIFY_QUOTE ? body.slice(0, SUPPORT_NOTIFY_QUOTE).trimEnd() + '…' : body;
  const greeting = firstName(person.name) ? `Hello, ${firstName(person.name)},` : 'Hello,';
  return {
    to,
    subject: `${SUPPORT_TEAM_NAME} replied to you in support`,
    text:
      `${greeting}\n\n` +
      `${SUPPORT_TEAM_NAME} replied to you in support:\n\n` +
      `${quote}\n\n` +
      `Open the conversation: ${origin}/?support=1#designs\n\n` +
      `You received this email because you wrote to ${PRODUCT_NAME} support and have not seen the reply yet.\n`,
  };
}

type Due = {id: string; name: string; email: string; email_verified: number};
type Unseen = {body: string};

/** The worker's pass: one letter for each conversation that is due. Answers how many letters went. */
export async function sendSupportFollowUps(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!mailEnabled(env)) return 0;
  const waits = [SUPPORT_FOLLOW_UP_AFTER_MS, SUPPORT_FOLLOW_UP_EVERY_MS];
  const due = await db.many<Due>(
    `SELECT t.id,u.name,u.email,u.email_verified FROM support_threads t JOIN users u ON u.id=t.user_id
     WHERE t.updated_at>clock_timestamp()-interval '${FRESH_FOR}' AND ${DUE} ORDER BY t.updated_at LIMIT 200`,
    waits,
  );
  let sent = 0;
  for (const thread of due) {
    if (!supportMailReaches(thread, env)) continue;
    // What the person has not seen and was not told, oldest first; read before the claim moves the mark.
    const unseen = await db.many<Unseen>(
      `SELECT m.body FROM support_messages m JOIN support_threads t ON t.id=m.thread_id
       WHERE m.thread_id=$1 AND m.author='operator' AND (t.user_read_at IS NULL OR m.created_at>t.user_read_at)
         AND (t.user_notified_at IS NULL OR m.created_at>t.user_notified_at)
       ORDER BY m.created_at,m.id LIMIT 20`,
      [thread.id],
    );
    if (!unseen.length) continue;
    const claimed = await db.one(
      `UPDATE support_threads t SET user_notified_at=clock_timestamp() FROM users u
       WHERE t.id=$3 AND u.id=t.user_id AND ${DUE} RETURNING t.id`,
      [...waits, thread.id],
    );
    if (!claimed) continue;
    try {
      const letter = supportFollowUpLetter(thread.email, thread, unseen.map(message => message.body).join('\n\n'));
      if (await sendMail(letter, env)) sent++;
    } catch (error) {
      console.warn(
        'support follow-up not sent:',
        String((error as {responseCode?: unknown})?.responseCode ?? (error as {code?: unknown})?.code ?? 'error'),
      );
    }
  }
  return sent;
}
