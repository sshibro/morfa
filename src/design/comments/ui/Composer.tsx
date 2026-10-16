import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {commentTextIssue, DESIGN_COMMENT_LIMITS, shiftMentions, type DesignCommentDraft, type DesignCommentMention} from '../../../../shared/design/comments';
import {Button, IconButton} from '../../ui/Button';
import {IconArrowUp, IconMention} from '../../ui/icons';
import type {TeamMember} from '../controller';
import {insertMention, matchMembers, mentionQueryAt, tidyDraft} from '../model';
import {Avatar} from './parts';

export type ComposerProps = {
  placeholder: string;
  'aria-label': string;
  /** The words being edited (an edit), else empty. */
  initial?: DesignCommentDraft;
  /** Resolves when sent; a rejection keeps the words (the caller says why). */
  onSubmit(draft: DesignCommentDraft): Promise<void>;
  /** Escape in the field (with no member list open). */
  onCancel?(): void;
  /** Members to mention (team files); absent: no "@". */
  members?: () => Promise<TeamMember[]>;
  /** The viewer: left out of the member list. */
  you?: string | null;
  autoFocus?: boolean;
  /** "Save" instead of the arrow (editing a comment). */
  saveLabel?: string;
  className?: string;
};

const MAX_HEIGHT = 168;

/**
 * The comment field: a plain-text area that grows with its words, "@" to mention a member of the team (a list under the caret's line:
 * ↑↓ to choose, Enter or Tab to insert, Escape to close), Enter to send and Shift+Enter for a new line. Mentions are ranges of the text
 * that move as it is edited; typing inside one drops it.
 */
export function Composer({placeholder, initial, onSubmit, onCancel, members, you = null, autoFocus, saveLabel, className = '', ...aria}: ComposerProps) {
  const [text, setText] = useState(initial?.text ?? '');
  const [mentionList, setMentions] = useState<DesignCommentMention[]>(initial?.mentions ?? []);
  const [caret, setCaret] = useState(initial?.text.length ?? 0);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<TeamMember[] | null>(null);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const query = members ? mentionQueryAt(text, caret, mentionList) : null;
  const pickerOpen = !!query && closedAt !== query.start;
  useEffect(() => {
    if (!pickerOpen || people || !members) return;
    let live = true;
    members().then(list => live && setPeople(list), () => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [pickerOpen, people, members]);
  const matches = useMemo(
    () => (pickerOpen && people ? matchMembers(people.filter(member => member.userId !== you), query!.query, 6) : []),
    [pickerOpen, people, query?.query, you], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => setActive(0), [query?.query, query?.start]);

  // The field grows with its lines up to a limit, then scrolls.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(MAX_HEIGHT, element.scrollHeight) + 'px';
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);
  useEffect(() => {
    if (!autoFocus) return;
    const focus = () => {
      const element = field.current;
      if (!element || document.activeElement === element) return;
      element.focus({preventScroll: true});
      element.setSelectionRange(element.value.length, element.value.length);
    };
    focus();
    // A field opened by a press on the canvas mounts before that press's default action moves the focus to the page: take it back once
    // the press is through.
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const change = (next: string, nextCaret: number) => {
    // The edit is what differs between the old and the new text: mentions after it move, one it touches goes.
    let start = 0;
    while (start < text.length && start < next.length && text[start] === next[start]) start++;
    let tail = 0;
    while (tail < text.length - start && tail < next.length - start && text[text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    setMentions(list => shiftMentions(list, start, text.length - tail, next.length - start - tail));
    setText(next);
    setCaret(nextCaret);
  };

  const choose = (member: TeamMember) => {
    if (!query) return;
    const result = insertMention(text, mentionList, query.start, caret, member);
    if (result.text.length > DESIGN_COMMENT_LIMITS.textLength) return;
    setText(result.text);
    setMentions(result.mentions);
    setCaret(result.caret);
    pendingCaret.current = result.caret;
    field.current?.focus({preventScroll: true});
  };

  const draft = tidyDraft(text, mentionList);
  const sendable = !busy && !commentTextIssue(draft.text);
  const submit = async () => {
    if (!sendable) return;
    setBusy(true);
    try {
      await onSubmit(draft);
      setText('');
      setMentions([]);
      setCaret(0);
    } catch {
      // The caller has said why; the words stay for another try.
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (pickerOpen && matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(matches[Math.min(active, matches.length - 1)]);
        return;
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (pickerOpen) setClosedAt(query!.start);
      else onCancel?.();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const insertAt = () => {
    const element = field.current;
    const at = element ? element.selectionStart : text.length;
    const before = text.slice(0, at);
    const prefix = before && !/\s$/.test(before) ? ' @' : '@';
    const next = before + prefix + text.slice(at);
    if (next.length > DESIGN_COMMENT_LIMITS.textLength) return;
    change(next, at + prefix.length);
    setClosedAt(null);
    pendingCaret.current = at + prefix.length;
    element?.focus({preventScroll: true});
  };

  return (
    <div className={`dz-composer ${saveLabel ? 'is-editing' : ''} ${busy ? 'is-busy' : ''} ${className}`.trim()}>
      <textarea
        ref={field}
        className="dz-composer-field"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={aria['aria-label']}
        maxLength={DESIGN_COMMENT_LIMITS.textLength}
        spellCheck
        role={members ? 'combobox' : undefined}
        aria-expanded={members ? pickerOpen && matches.length > 0 : undefined}
        aria-controls={members && pickerOpen ? listId : undefined}
        aria-autocomplete={members ? 'list' : undefined}
        aria-activedescendant={pickerOpen && matches.length ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined}
        onChange={event => change(event.currentTarget.value, event.currentTarget.selectionStart)}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <div className="dz-composer-actions">
        {members && <IconButton label="Mention" tooltip={{placement: 'top'}} onClick={insertAt} disabled={busy}><IconMention /></IconButton>}
        {saveLabel ? (
          <>
            <span className="dz-composer-spacer" />
            {onCancel && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
            <Button variant="primary" disabled={!sendable} onClick={() => void submit()}>{saveLabel}</Button>
          </>
        ) : (
          <button type="button" className="dz-composer-send" aria-label="Send" disabled={!sendable} onClick={() => void submit()}>
            <IconArrowUp size={14} />
          </button>
        )}
      </div>
      {pickerOpen && (people === null || matches.length > 0) && (
        <ul className="dz-mention-list" id={listId} role="listbox" aria-label="Team members">
          {people === null ? (
            <li className="dz-mention-empty" role="presentation">Loading members…</li>
          ) : (
            matches.map((member, index) => (
              <li key={member.userId} id={`${listId}-${index}`} role="option" aria-selected={index === active}
                className={`dz-mention-option ${index === active ? 'is-active' : ''}`.trim()}
                onPointerDown={event => {
                  event.preventDefault();
                  choose(member);
                }}
                onPointerEnter={() => setActive(index)}>
                <Avatar person={{id: member.userId, name: member.name}} size={20} />
                <span>{member.name}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
