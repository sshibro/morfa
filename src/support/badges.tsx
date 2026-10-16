import './support-button.css';
import {useSupportState} from './state';

// The support chat's unread answers where the way in is a menu (the editor's main menu, the board's help pill): a dot on the button
// that opens it (the button gets SUPPORT_ANCHOR) and a line under "Contact support" inside it (labels.ts withSupportNote).

export {supportUnreadNote, withSupportNote} from './labels';

/** The class a button carrying a SupportDot needs (it positions the dot). */
export const SUPPORT_ANCHOR = 'mf-support-anchor';

export function SupportDot() {
  const {unread} = useSupportState();
  return unread > 0 ? <span className="mf-support-dot" aria-hidden="true" /> : null;
}
