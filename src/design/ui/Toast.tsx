import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {IconButton} from './Button';
import {useTopModalLayer} from './layer';
import {IconClose} from './icons';

// Short dark notes at the bottom centre, above the toolbar: what just happened, with at most one
// action ("Open", "Try again"). They leave after a few seconds, pause while hovered or while
// the tab is hidden, and are read out politely (errors assertively). A toast that goes fades back the
// way it came (overlays.css `.is-leaving`) and leaves the DOM once that has run.

export type ToastKind = 'info' | 'success' | 'error';
export type ToastOptions = {kind?: ToastKind; action?: {label: string; onClick: () => void}; durationMs?: number};
export type ShowToast = (message: string, options?: ToastOptions) => void;

type Entry = ToastOptions & {id: number; message: string; leaving?: boolean};

const ToastContext = createContext<ShowToast>(() => {});
export const useToast = () => useContext(ToastContext);

const VISIBLE = 3;
/** The exit's length: --dz-fast in tokens.css. */
const EXIT_MS = 120;
let nextId = 1;

export function ToastHost({children}: {children: ReactNode}) {
  const [toasts, setToasts] = useState<Entry[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts(list => list.map(toast => (toast.id === id ? {...toast, leaving: true} : toast)));
    setTimeout(() => setToasts(list => list.filter(toast => toast.id !== id)), EXIT_MS);
  }, []);
  const show = useCallback<ShowToast>((message, options = {}) => {
    setToasts(list => [...list.filter(toast => toast.message !== message), {...options, id: nextId++, message}].slice(-VISIBLE));
  }, []);
  // While a modal dialog is open the stack lives in its layer: outside it a toast would be dimmed by the backdrop and inert.
  const modal = useTopModalLayer();
  const stack = (
    <div className="dz-toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map(toast => <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />)}
    </div>
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      {modal ? createPortal(stack, modal) : stack}
    </ToastContext.Provider>
  );
}

function ToastView({toast, onDismiss}: {toast: Entry; onDismiss: (id: number) => void}) {
  const duration = toast.durationMs ?? (toast.kind === 'error' ? 8000 : toast.action ? 6000 : 4000);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const started = useRef(0);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const changed = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (paused || hidden || toast.leaving) return;
    started.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started.current;
    };
  }, [paused, hidden, toast.leaving, toast.id, onDismiss]);
  const action = toast.action;
  return (
    <div className={`dz-toast is-${toast.kind ?? 'info'}${toast.leaving ? ' is-leaving' : ''}`} role={toast.kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="dz-toast-message">{toast.message}</span>
      {action && (
        <button type="button" className="dz-toast-action" onClick={() => {
          action.onClick();
          onDismiss(toast.id);
        }}>{action.label}</button>
      )}
      <IconButton label="Dismiss notification" tooltip={false} className="dz-toast-close" onClick={() => onDismiss(toast.id)}><IconClose size={14} /></IconButton>
    </div>
  );
}
