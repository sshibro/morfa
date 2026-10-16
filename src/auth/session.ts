import {post} from '../api';
import {readApi} from '../api-read';

// Morfa's own accounts (server/auth.ts): the session the cookie carries, the app's public config and the way in. People sign in by
// typing a name (server/accounts.ts, docs/authentication.md); that and signing out are the only API calls that change the session.

/** The signed-in account, as GET /api/auth/me answers it. */
export type Account = {id: string; email?: string | null; name?: string | null};

/** GET /api/config: what the app may offer. Unknown fields are kept for the modules that read them (support, PDF…).
 *  `admin`: the session's account is an operator (src/auth/operator.ts); absent for everyone else. */
export type AppConfig = {
  admin?: boolean;
  [key: string]: unknown;
};

export const SESSION_PATH = '/auth/me';
export const NAME_SIGN_IN_PATH = '/auth/name';
export const SIGN_OUT_PATH = '/auth/logout';

/** The account of this browser's session, or null when signed out. */
export const readSession = (signal?: AbortSignal) => readApi<Account | null>(SESSION_PATH, {signal});

/** The app's config; a server without one reads as "nothing offered". */
export async function readConfig(signal?: AbortSignal): Promise<AppConfig> {
  try {
    return (await readApi<AppConfig | null>('/config', {signal})) ?? {};
  } catch (error) {
    if (signal?.aborted) throw error;
    return {};
  }
}

/** Signs in with a display name: the account of the name, made on first use (shared/sign-in.ts). */
export const nameSignIn = (name: string) => post<Account>(NAME_SIGN_IN_PATH, {name});

export const signOut = () => post<unknown>(SIGN_OUT_PATH);
