import {db} from '../db';
import {mailEnabled, sendMail, type Mail} from '../mail';
import {appOrigin} from '../app-origin';
import {PRODUCT_NAME} from '../../shared/design/product';
import {supportAccount, type SupportAccount} from './store';

// "New support request": a letter to the operators (SUPPORT_NOTIFY_EMAIL, one address or several, comma separated) when a
// person writes, at most one per conversation per quarter of an hour, whichever api process takes the message (the claim is
// support_threads.notified_at, moved by one UPDATE). Best effort and after the commit: the person's request never waits for it and
// never fails with it; a refused letter is logged by its provider code only (the message may name the address) and not retried, and
// its quarter of an hour stays spent. Off while mail is off (server/mail.ts) or the address is unset.

/** The longest part of the message the letter quotes. */
export const SUPPORT_NOTIFY_QUOTE = 300;
const NOTIFY_EVERY = '15 minutes';

/** The operators' addresses, or null when none is set (anything without an "@" is ignored). */
export function supportNotifyAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const addresses = (env.SUPPORT_NOTIFY_EMAIL ?? '')
    .split(',')
    .map(address => address.trim())
    .filter(address => /^[^\s@]+@[^\s@]+$/.test(address));
  return addresses.length ? addresses.join(', ') : null;
}

/** The letter: who wrote, the start of what they wrote, and the way to the console. Plain text only. */
export function supportNotifyLetter(to: string, account: SupportAccount, body: string, origin = appOrigin()): Mail {
  const quote = body.length > SUPPORT_NOTIFY_QUOTE ? body.slice(0, SUPPORT_NOTIFY_QUOTE).trimEnd() + '…' : body;
  return {
    to,
    subject: 'New support request',
    text:
      `New message to ${PRODUCT_NAME} support.\n\n` +
      `From: ${account.name || 'No name'} <${account.email}>\n` +
      `Account: ${account.id}\n\n` +
      `${quote}\n\n` +
      `Reply: ${origin}/#admin/support\n`,
  };
}

const pending = new Set<Promise<void>>();

/** Starts the letter for a message the person has just written (after its commit); returns at once. */
export function notifySupportOperators(threadId: string, userId: string, body: string): void {
  const to = supportNotifyAddress();
  if (!to || !mailEnabled()) return;
  const letter = (async () => {
    const claimed = await db.one(
      `UPDATE support_threads SET notified_at=clock_timestamp()
       WHERE id=$1 AND (notified_at IS NULL OR notified_at<=clock_timestamp()-interval '${NOTIFY_EVERY}') RETURNING id`,
      [threadId],
    );
    if (!claimed) return;
    const account = await supportAccount(userId);
    if (account) await sendMail(supportNotifyLetter(to, account, body));
  })()
    .catch(error => {
      console.warn(
        'support letter not sent:',
        String((error as {responseCode?: unknown})?.responseCode ?? (error as {code?: unknown})?.code ?? 'error'),
      );
    })
    .finally(() => pending.delete(letter));
  pending.add(letter);
}

/** Letters still on their way (server/app.ts drainAppTasks, the tests). */
export async function drainSupportNotifications(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
