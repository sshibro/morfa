// Outgoing e-mail. Off until the owner chooses a provider: with MORFA_SMTP_URL unset nothing is sent. Accounts have no mailbox (they are
// made by typing a name, docs/authentication.md), so a letter to an account's own address is never sent. Any provider with
// SMTP works (Yandex 360, Mail.ru for business, Unisender Go, Postmark…): MORFA_SMTP_URL is `smtps://user:password@host:465` (or
// `smtp://…:587`, upgraded with STARTTLS), MORFA_MAIL_FROM the sender, e.g. `Morfa <team@example.ru>`. A letter is sent after the
// change it is about has committed; a failure is reported to the caller, never retried here, and never fails that change.
import nodemailer, {type Transporter} from 'nodemailer';
import {isNameAddress} from '../shared/sign-in';

export type Mail = {to: string; subject: string; text: string; html?: string};

type Config = {url: string; from: string};
let cached: {key: string; transport: Transporter} | null = null;

/** The provider's settings, or null while mail is off (either variable unset or malformed). */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const url = env.MORFA_SMTP_URL?.trim(),
    from = env.MORFA_MAIL_FROM?.trim();
  if (!url || !from) return null;
  try {
    if (!['smtp:', 'smtps:'].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return {url, from};
}
export const mailEnabled = (env: NodeJS.ProcessEnv = process.env) => mailConfig(env) !== null;

/** Sends one letter; resolves false while mail is off or when the address is an account's name address (no mailbox), rejects when the
 *  provider refuses it. */
export async function sendMail(mail: Mail, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const config = mailConfig(env);
  if (!config || isNameAddress(mail.to)) return false;
  const key = config.url + '\n' + config.from;
  if (cached?.key !== key) {
    cached?.transport.close();
    // Short timeouts: a letter is sent while its request waits (an invite answers once its letters went or failed).
    cached = {
      key,
      transport: nodemailer.createTransport({
        url: config.url,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      }),
    };
  }
  await cached.transport.sendMail({
    from: config.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  return true;
}
