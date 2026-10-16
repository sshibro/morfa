import {useCallback, useEffect, useRef, useState} from 'react';
import {IconButton} from '../../ui/Button';
import {IconCheck, IconCopy} from '../../ui/icons';
import {useEditorServices} from '../../editor/services';

// Copying in "Code": a button that shows a tick for a moment, and values that copy on click and say so.

/** Copies, then shows a tick for a moment (the icons cross-fade; better-ui "contextual icons"). */
export function CopyButton({text, label}: {text: string; label: string}) {
  const services = useEditorServices();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      services.toast('The browser did not allow access to the clipboard.', 'error');
    }
  };
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={copy} className="dz-copy-btn" data-copied={copied || undefined}>
      <span className="dz-copy-icons" aria-hidden="true">
        <span className="dz-copy-icon is-copy"><IconCopy /></span>
        <span className="dz-copy-icon is-done"><IconCheck /></span>
      </span>
    </IconButton>
  );
}

/** Copies a value and says what was copied. */
export function useCopy() {
  const services = useEditorServices();
  return useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      services.toast(`Copied: ${text.length > 48 ? text.slice(0, 47) + '…' : text}`);
    } catch {
      services.toast('The browser did not allow access to the clipboard.', 'error');
    }
  }, [services]);
}
