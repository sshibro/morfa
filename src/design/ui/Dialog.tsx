import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {IconButton} from './Button';
import {IconClose} from './icons';
import {LayerContext, Portal, registerModalLayer} from './layer';
import {useSheetDrag} from './phone/sheet-gesture';
import {usePhone} from './viewport';

export type DialogProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  /** Quiet actions in the header, before "Close" (the share dialog's "Copy link", as Figma's). */
  actions?: ReactNode;
  width?: number;
  /** Focused on open; otherwise the first field or button. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** A click on the dimmed page closes it (off for dialogs that hold typed input). */
  dismissible?: boolean;
  /** False for a choice the user must make: no "Close" button (Escape does nothing either). */
  closable?: boolean;
  className?: string;
};

/**
 * A modal on the native <dialog>: the page behind is inert, focus stays inside, Escape closes,
 * and focus returns where it was. Menus and popovers opened inside render into the dialog itself,
 * the only part of the page a modal leaves interactive. On a phone it is a sheet from the bottom (phone-shell-overlays.css)
 * that a finger drags down by its header to close, as its "Close" button and Escape do.
 */
const FOCUS_ORDER = ['[data-autofocus]', 'input, textarea', '.dz-dialog-footer .is-primary', '.dz-dialog-body button'] as const;

export function Dialog({title, onClose, children, footer, actions, width = 400, initialFocus, dismissible = true, closable = true, className = ''}: DialogProps) {
  const titleId = useId();
  // The element, not a ref: a dialog opened before the area's floating layer exists is portalled again once it does, and React
  // then mounts a new <dialog>, which must be shown modally as well.
  const [element, setElement] = useState<HTMLDialogElement | null>(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Pointer-down and click must both land on the backdrop: a drag out of a field must not close it.
  const downOnBackdrop = useRef(false);
  const phone = usePhone();
  const surface = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(() => surface.current, () => {
    if (closable) onCloseRef.current();
  });

  useLayoutEffect(() => {
    // The state trails the DOM by a commit: an element already replaced by the next one is skipped.
    if (!element?.isConnected) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    // In order of preference, not of the document: a field marked data-autofocus wins over a button that comes before it.
    const focus =
      initialFocus?.current ??
      FOCUS_ORDER.reduce<HTMLElement | null>((found, selector) => found ?? element.querySelector<HTMLElement>(selector), null);
    focus?.focus({preventScroll: true});
    return () => {
      if (element.open) element.close();
      if (previous?.isConnected) previous.focus({preventScroll: true});
    };
  }, [element]); // eslint-disable-line react-hooks/exhaustive-deps
  // While open, the dialog's layer is where toasts go (a modal leaves nothing else clickable).
  useEffect(() => (element?.isConnected && layer ? registerModalLayer(layer) : undefined), [element, layer]);

  return (
    <Portal>
      <dialog ref={setElement} className={`dz-dialog ${className}`.trim()} aria-labelledby={titleId} style={{width}}
        onCancel={event => {
          event.preventDefault();
          if (closable) onCloseRef.current();
        }}
        onPointerDown={event => {downOnBackdrop.current = event.target === event.currentTarget;}}
        onClick={event => {
          if (closable && dismissible && downOnBackdrop.current && event.target === event.currentTarget) onCloseRef.current();
          downOnBackdrop.current = false;
        }}>
        <div ref={surface} className="dz-dialog-surface">
          <header className="dz-dialog-header" {...(phone && closable ? drag : {})}>
            {phone && closable && <span className="dz-sheet-grabber" aria-hidden="true" />}
            <h2 id={titleId} className="dz-dialog-title">{title}</h2>
            {actions && <div className="dz-dialog-actions">{actions}</div>}
            {closable && <IconButton label="Close" tooltip={false} onClick={() => onCloseRef.current()}><IconClose /></IconButton>}
          </header>
          <LayerContext.Provider value={layer}>
            <div className="dz-dialog-body">{children}</div>
            {footer && <footer className="dz-dialog-footer">{footer}</footer>}
          </LayerContext.Provider>
        </div>
        <div ref={setLayer} className="dz-layer is-dialog" />
      </dialog>
    </Portal>
  );
}
