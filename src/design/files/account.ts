import type {Account} from '../../auth/session';

// What the file browser's account button shows (AccountMenu.tsx).

/** "Anna Smith" → "A"; an address → its first letter; nothing → a dot. */
export const accountInitial = (account: Account | null): string => [...(account?.name || account?.email || '').trim()][0]?.toLocaleUpperCase('en') ?? '·';

/** The name the sidebar shows: the account's name, else its address before the "@", else "Account". */
export const accountLabel = (account: Account | null): string => account?.name?.trim() || account?.email?.split('@')[0] || 'Account';
