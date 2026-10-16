import {createPrivateKey, createPublicKey, sign, verify, type KeyObject} from 'node:crypto';
import type {DesignTeamRole} from '../../../shared/design/teams';

// Socket tickets (docs/BACKEND.md §2 "Permissions", §11; crates/protocol/src/ticket.rs): api mints one per
// GET /api/design-files/:id/session, Ed25519-signed, valid 60 s, bound to the user, the file, the role, the team and the page
// origin. collab holds only the public key and checks the signature, the expiry, the file and the upgrade's Origin.
//
// Format, byte for byte what the Rust `mint` writes: base64url(claims JSON) "." base64url(signature over the claims bytes),
// no padding. The claims' JSON has the field order of the Rust struct (file, user, name, role, team?, origin?, exp); the
// signature covers the exact bytes sent, so the order only matters for readability.

export const TICKET_TTL_SECONDS = 60;

export type TicketClaims = {
  file: string;
  user: string;
  /** The display name the peers see. */
  name: string;
  role: DesignTeamRole;
  team?: string;
  /** The page origin; the upgrade's Origin must equal it. */
  origin?: string;
  /** Expiry, Unix seconds. */
  exp: number;
};

/** PKCS#8 DER of an Ed25519 private key is this prefix and the 32-byte seed (RFC 8410). */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI DER of an Ed25519 public key is this prefix and the 32-byte key. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SEED_BYTES = 32;

const base64url = (bytes: Buffer) => bytes.toString('base64url');
function fromBase64(text: string): Buffer {
  const clean = text.trim().replace(/=+$/, '');
  return Buffer.from(clean.replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
}

let cached: {text: string; key: KeyObject} | null = null;

/** The signing key from DESIGN_COLLAB_TICKET_KEY (base64url of the seed), or null when it is unset or not a key. */
export function ticketKey(text = process.env.DESIGN_COLLAB_TICKET_KEY ?? ''): KeyObject | null {
  if (!text) return null;
  if (cached?.text === text) return cached.key;
  const seed = fromBase64(text);
  if (seed.length !== SEED_BYTES) return null;
  try {
    const key = createPrivateKey({key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8'});
    cached = {text, key};
    return key;
  } catch {
    return null;
  }
}

/** The public half as collab's MORFA_COLLAB_TICKET_KEY wants it (base64url of the 32 bytes). */
export function ticketPublicKey(key: KeyObject): string {
  const der = createPublicKey(key).export({format: 'der', type: 'spki'});
  return base64url(Buffer.from(der).subarray(SPKI_ED25519.length));
}

/** The claims in the Rust struct's order, without the absent optional fields (serde's skip_serializing_if). */
function claimsJson(claims: TicketClaims): string {
  const ordered: Record<string, unknown> = {file: claims.file, user: claims.user, name: claims.name, role: claims.role};
  if (claims.team) ordered.team = claims.team;
  if (claims.origin) ordered.origin = claims.origin;
  ordered.exp = claims.exp;
  return JSON.stringify(ordered);
}

export function mintTicket(key: KeyObject, claims: TicketClaims): string {
  const payload = Buffer.from(claimsJson(claims));
  return base64url(payload) + '.' + base64url(sign(null, payload, key));
}

/** Checks a ticket as collab does (tests and the bench; collab is the real verifier). Null when it does not hold. */
export function readTicket(publicKey: KeyObject, ticket: string, now = Math.floor(Date.now() / 1000)): TicketClaims | null {
  const [payloadText, signatureText, extra] = ticket.split('.');
  if (!payloadText || !signatureText || extra !== undefined) return null;
  const payload = fromBase64(payloadText);
  if (!verify(null, payload, publicKey, fromBase64(signatureText))) return null;
  const claims = JSON.parse(payload.toString('utf8')) as TicketClaims;
  return claims.exp > now ? claims : null;
}

export const publicKeyFrom = (text: string): KeyObject =>
  createPublicKey({key: Buffer.concat([SPKI_ED25519, fromBase64(text)]), format: 'der', type: 'spki'});
