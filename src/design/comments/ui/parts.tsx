import {memo, useEffect, useState, useSyncExternalStore} from 'react';
import {commentSegments, type DesignCommentMention, type DesignCommentPerson} from '../../../../shared/design/comments';
import type {CommentsController, CommentsState} from '../controller';
import {avatarColor, initials, relativeTime} from '../model';

/** The controller's state in React (the layer and the panel; the editor reads only the count). */
export function useCommentsState(controller: CommentsController): CommentsState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** Now, refreshed every minute (relative times). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A person's round avatar: initials on a steady colour (no photos are stored). */
export const Avatar = memo(function Avatar({person, size = 24}: {person: DesignCommentPerson | {id: string | null; name: string}; size?: 20 | 24}) {
  return (
    <span className={`dz-avatar is-${size}`} style={{background: avatarColor(person.id)}} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
});

/** A comment's words as text nodes: mentions highlighted, nothing ever parsed as markup; line breaks kept by CSS. */
export const CommentText = memo(function CommentText({text, mentions, you}: {text: string; mentions: readonly DesignCommentMention[]; you: string | null}) {
  return (
    <p className="dz-comment-text">
      {commentSegments(text, mentions).map((segment, index) =>
        segment.userId ? (
          <span key={index} className={`dz-mention ${segment.userId === you ? 'is-you' : ''}`.trim()}>{segment.text}</span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
});

const FULL_DATE = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'});

export function TimeAgo({iso, now}: {iso: string; now: number}) {
  return <time dateTime={iso} title={FULL_DATE.format(new Date(iso))}>{relativeTime(iso, now)}</time>;
}
