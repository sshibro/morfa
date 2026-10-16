// Name-only sign-in (docs/authentication.md): the part the server (server/accounts.ts) and the sign-in screen (src/auth) must
// agree on. A person types a display name; the same name is always the same account. There are no passwords, e-mail addresses or
// outside providers, so the name is also what keeps accounts apart: an account's `users.email` holds an address made from the
// name (`anna@name.invalid`, never a mailbox), which is the only place the server tells two names apart.

/** The longest display name, in characters (code points). */
export const NAME_MAX_LENGTH = 50;
/** The domain of the address a name is stored under. `.invalid` is reserved (RFC 2606): no mail can ever be delivered to it. */
export const NAME_ADDRESS_DOMAIN = 'name.invalid';
/** The longest address an account may have (users.email check). */
const ADDRESS_MAX_LENGTH = 320;

/** Controls and the invisible or direction-changing marks that make two names look the same (zero-width space, bidi overrides and
 *  isolates). Line and paragraph separators and the byte order mark are white space: they collapse to a space before this check. The joiners U+200C and U+200D stay: scripts and emoji need them. */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069<>@]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export type NameProblem = 'empty' | 'long' | 'characters';
export type NameResult = {ok: true; name: string} | {ok: false; problem: NameProblem};

/** What each problem says, to the person typing the name (the sign-in screen and the server's refusal alike). */
export const NAME_PROBLEM_TEXT: Record<NameProblem, string> = {
  empty: 'Enter your name.',
  long: `The name can have at most ${NAME_MAX_LENGTH} characters.`,
  characters: 'The name has characters that cannot be used (such as @, < or >).',
};

/** The display name as it will be kept: Unicode-composed, with runs of spaces collapsed and the ends trimmed. Or what is wrong with it:
 *  `empty` (nothing, or no letter or digit in it), `long` (over NAME_MAX_LENGTH characters), `characters` (a control, an invisible
 *  mark, `<`, `>` or `@`). */
export function checkName(value: unknown): NameResult {
  if (typeof value !== 'string') return {ok: false, problem: 'empty'};
  const name = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!LETTER_OR_DIGIT.test(name)) return {ok: false, problem: 'empty'};
  if ([...name].length > NAME_MAX_LENGTH) return {ok: false, problem: 'long'};
  if (FORBIDDEN_CHARACTERS.test(name) || FORBIDDEN_CHARACTERS.test(name.normalize('NFKC'))) return {ok: false, problem: 'characters'};
  return {ok: true, name};
}

/** The address an account is kept under for a checked display name: compatibility-folded and lower-cased, so "Anna" and "anna"
 *  (and "Ａｎｎａ") are one person. Null for a name too long to fit once folded. */
export function nameAddress(name: string): string | null {
  const address = `${name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()}@${NAME_ADDRESS_DOMAIN}`;
  return address.length <= ADDRESS_MAX_LENGTH ? address : null;
}

/** Whether an address is one made from a name (and so can never receive mail). */
export const isNameAddress = (address: string | null | undefined): boolean =>
  typeof address === 'string' && address.toLowerCase().endsWith('@' + NAME_ADDRESS_DOMAIN);
