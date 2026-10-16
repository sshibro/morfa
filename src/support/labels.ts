import type {MenuItem} from '../design/ui/menu-model';

// The words and counts the support chat's ways in show (SupportButton.tsx, badges.tsx): pure, so the node tests read them.

/** The count a badge shows: "9+" past nine. */
export const unreadBadge = (unread: number) => (unread > 9 ? '9+' : String(unread));

/** "New support reply", "3 new support replies". */
export const supportUnreadNote = (unread: number) => (unread === 1 ? 'New support reply' : `${unread} new support replies`);

/** The file browser's button: its name says the count to a screen reader (the badge itself is decoration). */
export const supportButtonLabel = (unread: number) => (unread ? `Support. ${supportUnreadNote(unread)}` : 'Contact support');

/** The menu with "Contact support" (command `help.support`, wherever it is nested) noting the unread answers. */
export function withSupportNote(items: MenuItem[], unread: number): MenuItem[] {
  if (!unread) return items;
  return items.map(item => {
    if (item.type === 'submenu') return {...item, items: withSupportNote(item.items, unread)};
    if ((item.type === undefined || item.type === 'item') && item.id === 'help.support') return {...item, description: supportUnreadNote(unread)};
    return item;
  });
}
