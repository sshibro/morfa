import './support-button.css';
import {IconButton} from '../design/ui/Button';
import {supportButtonLabel, unreadBadge} from './labels';
import {closeSupport, openSupport} from './open';
import {useSupportState} from './state';
import {supportChatOn} from './support-config';

// The file browser's way into the support chat (its top bar): a speech bubble with the count of the operator's answers the person
// has not read. Pressed while the panel is open; a second press closes it. Nothing while the chat is off.

export function SupportButton() {
  const {open, unread} = useSupportState();
  if (!supportChatOn()) return null;
  return (
    <IconButton size={32} label={supportButtonLabel(unread)} className="mf-support-button" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => (open ? closeSupport() : openSupport({source: 'button'}))}>
      <SupportGlyph />
      {unread > 0 && <span className="mf-support-badge" aria-hidden="true">{unreadBadge(unread)}</span>}
    </IconButton>
  );
}

/** A speech bubble with a question mark, on the tool's 16-unit grid. */
export function SupportGlyph({size = 16}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 13.25a5.25 5.25 0 1 0-4.6-2.72L2.75 13.25l2.82-.62A5.2 5.2 0 0 0 8 13.25Z" />
      <path d="M6.6 6.55a1.45 1.45 0 0 1 2.82.45c0 .97-1.42 1.2-1.42 2" />
      <circle cx="8" cy="10.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
