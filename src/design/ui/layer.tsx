import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

// Floating things (menus, popovers, tooltips, dialogs) render into a layer inside the `.dz` root,
// so they inherit the design tokens and font and stay out of the panels' overflow. A modal dialog
// provides its own layer: anything opened from it renders inside the dialog, which is the only
// part of the page a modal leaves interactive.

export const LayerContext = createContext<HTMLElement | null>(null);

export const useLayer = () => useContext(LayerContext);

// The layers of the modal dialogs open now, oldest first. A modal makes everything outside it inert, so what must stay readable and
// clickable while one is open (the toasts) renders into the topmost dialog's layer instead of the area's.
const modalLayers: HTMLElement[] = [];
const modalListeners = new Set<() => void>();
const notifyModals = () => modalListeners.forEach(listener => listener());
/** A modal dialog's layer while it is open; returns the removal. */
export function registerModalLayer(layer: HTMLElement): () => void {
  modalLayers.push(layer);
  notifyModals();
  return () => {
    const index = modalLayers.lastIndexOf(layer);
    if (index >= 0) modalLayers.splice(index, 1);
    notifyModals();
  };
}
const subscribeModals = (listener: () => void) => {
  modalListeners.add(listener);
  return () => void modalListeners.delete(listener);
};
const topModalLayer = () => modalLayers[modalLayers.length - 1] ?? null;
/** The topmost open modal dialog's layer, or null when no modal is open. */
export const useTopModalLayer = (): HTMLElement | null => useSyncExternalStore(subscribeModals, topModalLayer, () => null);

/** Renders children into the nearest layer (document.body outside any `.dz` scope). */
export function Portal({children}: {children: ReactNode}) {
  const layer = useLayer();
  return createPortal(children, layer ?? document.body);
}

/** A `.dz` scope with its own floating layer. DesignRoot uses it for the whole area; harnesses may too. */
export function DzScope({className = '', theme, children}: {className?: string; theme: 'light' | 'dark'; children: ReactNode}) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const scope = useRef<HTMLDivElement>(null);
  const shownTheme = useRef(theme);
  // A theme flip would fire every colour transition at once and smear: they stay off for one frame.
  useLayoutEffect(() => {
    const element = scope.current;
    if (!element || shownTheme.current === theme) return;
    shownTheme.current = theme;
    element.classList.add('dz-theme-swap');
    void element.offsetWidth;
    const frame = requestAnimationFrame(() => element.classList.remove('dz-theme-swap'));
    return () => cancelAnimationFrame(frame);
  }, [theme]);
  // Which input came last. A menu opened with Enter, a dialog from a shortcut, a panel from the keyboard
  // appear at once (emil-design-eng: never animate keyboard-initiated actions); overlays.css reads it.
  useEffect(() => {
    const element = scope.current;
    if (!element) return;
    const mark = (input: 'keyboard' | 'pointer') => () => {
      if (element.dataset.input !== input) element.dataset.input = input;
    };
    const keyboard = mark('keyboard');
    const pointer = mark('pointer');
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => {
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  return (
    <div ref={scope} className={`dz ${className}`.trim()} data-theme={theme}>
      <LayerContext.Provider value={layer}>
        {children}
        <div ref={setLayer} className="dz-layer" />
      </LayerContext.Provider>
    </div>
  );
}
