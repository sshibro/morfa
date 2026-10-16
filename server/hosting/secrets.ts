import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {fail} from './errors';
function key() {
  const value = process.env.HOSTING_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value))
    fail(503, 'encryption_unavailable', 'The platform owner has not set up secure storage for connections yet.');
  return Buffer.from(value, 'hex');
}
export function encrypt(value: unknown, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({
    v: process.env.HOSTING_KEY_VERSION || '1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}
export function decrypt(value: string, context: string) {
  const envelope = JSON.parse(value);
  if (envelope.v !== (process.env.HOSTING_KEY_VERSION || '1'))
    fail(503, 'key_version_mismatch', 'The connection key needs to be restored.');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString());
}
