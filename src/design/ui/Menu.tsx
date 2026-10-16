import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {IconCheck, IconChevronLeft, IconChevronRight} from './icons';
import {Portal} from './layer';
import {firstIndex, isInteractive, lastIndex, moveIndex, typeaheadIndex, type MenuItem} from './menu-model';
import {clamp, placeFloating, rectOf, viewportSize, type Placed, type Placement, type Rect} from './position';
import {useSheetDrag} from './phone/sheet-gesture';
import {formatShortcut} from './shortcuts';
import {usePhone} from './viewport';

export type {MenuItem, MenuAction, MenuSubmenu} from './menu-model';

// Dark menus in both themes, as in desktop design tools: radius 12, a 4 px inset, 24 px rows, a
// check column when any row is checkable, a shortcut column, submenus, keyboard movement and
// type-ahead. One component serves the main menu, context menus, dropdowns and toolbar flyouts. On a phone a menu is a
// sheet from the bottom with rows a thumb can hit (phone-shell-overlays.css), over a dimmed page that closes it; a submenu
// is a sheet over its parent with "Back" on top. `sheet={false}` keeps a menu anchored on a phone too.

export type MenuAnchor = {element: Element} | {rect: Rect} | {point: {x: number; y: number}};
export type MenuCloseReason = 'select' | 'escape' | 'outside' | 'tab' | 'blur';
export type MenuActivate = 'first' | 'last' | 'none' | {id: string};

export type MenuProps = {
  items: MenuItem[];
  anchor: MenuAnchor;
  placement?: Placement;
  offset?: number;
  onClose: (reason: MenuCloseReason) => void;
  /** A keyboard-opened menu starts with a row active; a pointer-opened one does not. */
  activate?: MenuActivate;
  /** Dropdowns: lay this row over the anchor, its label over the anchor's text (inset by `alignInset`). */
  alignItemId?: string;
  alignInset?: number;
  minWidth?: number;
  'aria-label'?: string;
  /** Pointer-downs here are not "outside" (the trigger toggles the menu itself). */
  ignore?: Element | null;
  /** A variant class on the top level (the toolbar's flyouts: `is-tools`). */
  className?: string;
  /** On a phone, a sheet from the bottom (the default) or, false, anchored as on a desktop. */
  sheet?: boolean;
};

const anchorRect = (anchor: MenuAnchor): Rect =>
  'element' in anchor ? rectOf(anchor.element) : 'rect' in anchor ? anchor.rect : {x: anchor.point.x, y: anchor.point.y, width: 0, height: 0};

const SUBMENU_OPEN_MS = 90;
const SUBMENU_CLOSE_MS = 220;

/** A menu anchored to an element, a rectangle or a point. Close it by unmounting it from onClose. */
export function Menu({items, anchor, placement = 'bottom-start', offset = 4, onClose, activate = 'none', alignItemId, alignInset = 8, minWidth, ignore, className, sheet = true, ...aria}: MenuProps) {
  const asSheet = usePhone() && sheet;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [rect] = useState(() => anchorRect(anchor));
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      // The dimmed page behind a sheet closes it on its own click, which it takes: what lies under it is not pressed too.
      if (target?.closest?.('[data-dz-menu], .dz-sheet-backdrop') || (ignore && target && ignore.contains(target))) return;
      onCloseRef.current('outside');
    };
    const scrolled = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('[data-dz-menu]')) onCloseRef.current('outside');
    };
    const blur = () => onCloseRef.current('blur');
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', blur);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', blur);
      window.removeEventListener('blur', blur);
    };
  }, [ignore]);
  return (
    <Portal>
      {asSheet && <SheetBackdrop onClose={() => onCloseRef.current('outside')} />}
      <MenuLevel items={items} anchor={rect} placement={placement} offset={offset} depth={0} activate={activate} alignItemId={asSheet ? undefined : alignItemId} alignInset={alignInset}
        minWidth={minWidth} label={aria['aria-label']} className={className} sheet={asSheet} onCloseAll={reason => onCloseRef.current(reason)} onBack={() => onCloseRef.current('escape')} />
    </Portal>
  );
}

type LevelProps = {
  items: MenuItem[];
  anchor: Rect;
  placement: Placement;
  offset: number;
  depth: number;
  activate: MenuActivate;
  alignItemId?: string;
  alignInset?: number;
  minWidth?: number;
  label?: string;
  className?: string;
  sheet: boolean;
  onCloseAll: (reason: MenuCloseReason) => void;
  /** Escape or ← in a submenu: back to the parent row. */
  onBack: () => void;
  /** The pointer reached this submenu: the parent keeps it open. */
  onPointerArrive?: () => void;
};

function initialIndex(items: MenuItem[], activate: MenuActivate) {
  if (activate === 'first') return firstIndex(items);
  if (activate === 'last') return lastIndex(items);
  if (typeof activate === 'object') {
    const index = items.findIndex(item => 'id' in item && item.id === activate.id);
    return isInteractive(items[index]) ? index : firstIndex(items);
  }
  return -1;
}

function MenuLevel({items, anchor, placement, offset, depth, activate, alignItemId, alignInset = 8, minWidth, label, className, sheet, onCloseAll, onBack, onPointerArrive}: LevelProps) {
  const id = useId();
  const element = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => initialIndex(items, activate));
  const [submenu, setSubmenu] = useState<{index: number; keyboard: boolean; anchor: Rect} | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const timers = useRef<{open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>}>({});
  const typeahead = useRef({text: '', at: 0});
  const hasCheck = items.some(item => (item.type === undefined || item.type === 'item') && item.checked !== undefined);
  const hasIcon = items.some(item => 'icon' in item && !!item.icon);

  useLayoutEffect(() => {
    const menu = element.current;
    if (!menu) return;
    const size = {width: menu.offsetWidth, height: menu.offsetHeight};
    const viewport = viewportSize();
    let next = placeFloating(anchor, size, viewport, placement, offset);
    const row = alignItemId ? menu.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(alignItemId)}"]`) : null;
    if (row) {
      // Dropdowns open over their trigger with the chosen row where the trigger's text was.
      const text = row.querySelector<HTMLElement>('.dz-menu-text') ?? row;
      const y = clamp(anchor.y + anchor.height / 2 - (row.offsetTop + row.offsetHeight / 2), 8, viewport.height - size.height - 8);
      const x = clamp(anchor.x + alignInset - text.offsetLeft, 8, viewport.width - size.width - 8);
      next = {...next, x: Math.round(x), y: Math.round(y), origin: `${text.offsetLeft}px ${row.offsetTop + row.offsetHeight / 2}px`, maxHeight: viewport.height - 16};
    }
    setPlaced(next);
  }, [anchor, placement, offset, alignItemId, alignInset]);

  useEffect(() => {
    const current = timers.current;
    return () => {
      clearTimeout(current.open);
      clearTimeout(current.close);
    };
  }, []);
  // Focus once placed: until then the menu is visibility-hidden, and hidden elements refuse focus.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!placed || focusedOnce.current) return;
    focusedOnce.current = true;
    element.current?.focus({preventScroll: true});
  }, [placed]);

  // Keep the active row in view in long, scrolling menus.
  useEffect(() => {
    if (active < 0) return;
    element.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [active]);

  /** A submenu opens beside this menu with its first row level with the parent row (4 px is the menu's inset). */
  const rowAnchor = (index: number): Rect => {
    const menu = element.current;
    const row = menu?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!menu || !row) return anchor;
    const box = rectOf(menu);
    const rowBox = rectOf(row);
    return {x: box.x, y: rowBox.y - 4, width: box.width, height: rowBox.height + 8};
  };

  const select = (index: number, keyboard: boolean) => {
    const item = items[index];
    if (!isInteractive(item)) return;
    if (item.type === 'submenu') {
      clearTimeout(timers.current.close);
      setActive(index);
      setSubmenu({index, keyboard, anchor: rowAnchor(index)});
      return;
    }
    onCloseAll('select');
    item.onSelect();
  };

  const hover = (index: number) => {
    const item = items[index];
    clearTimeout(timers.current.open);
    if (!isInteractive(item)) {
      if (!submenu) setActive(-1);
      return;
    }
    if (active !== index) setActive(index);
    // A sheet opens a submenu on a tap only: a finger sliding over the rows is not hover.
    if (sheet) return;
    if (item.type === 'submenu') {
      if (submenu?.index === index) {
        clearTimeout(timers.current.close);
        return;
      }
      timers.current.open = setTimeout(() => setSubmenu({index, keyboard: false, anchor: rowAnchor(index)}), SUBMENU_OPEN_MS);
    } else if (submenu) {
      clearTimeout(timers.current.close);
      timers.current.close = setTimeout(() => setSubmenu(null), SUBMENU_CLOSE_MS);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A focused submenu handles its own keys.
    if (event.target !== element.current) return;
    const key = event.key;
    const move = (index: number) => {
      event.preventDefault();
      if (index >= 0) setActive(index);
    };
    if (key === 'ArrowDown') move(moveIndex(items, active, 1));
    else if (key === 'ArrowUp') move(active < 0 ? lastIndex(items) : moveIndex(items, active, -1));
    else if (key === 'Home' || key === 'PageUp') move(firstIndex(items));
    else if (key === 'End' || key === 'PageDown') move(lastIndex(items));
    else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (active >= 0) select(active, true);
    } else if (key === 'ArrowRight') {
      event.preventDefault();
      if (active >= 0 && items[active].type === 'submenu') select(active, true);
    } else if (key === 'ArrowLeft') {
      event.preventDefault();
      if (depth > 0) onBack();
    } else if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    } else if (key === 'Tab') {
      event.preventDefault();
      onCloseAll('tab');
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > 600 ? key : state.text + key;
      state.at = now;
      const index = typeaheadIndex(items, active, state.text);
      if (index >= 0) {
        event.preventDefault();
        setActive(index);
      }
    }
  };

  const openSub = submenu ? items[submenu.index] : null;
  const drag = useSheetDrag(() => element.current, () => onCloseAll('escape'));
  // A sheet can open under a finger that is still down (a long press): the lift's click lands on a row the person never
  // pressed. In a sheet a row acts only on a pointer press that began inside it after it opened (keyboard clicks always do).
  const pressedHere = useRef(false);

  const style = (placed
    ? {left: placed.x, top: placed.y, maxHeight: placed.maxHeight, '--dz-origin': placed.origin, minWidth}
    : {visibility: 'hidden', minWidth}) as CSSProperties;

  return (
    <>
      <div ref={element} role="menu" aria-label={label} tabIndex={-1} data-dz-menu="" className={`dz-menu ${depth === 0 ? 'is-root' : 'is-sub'} ${sheet ? 'is-sheet' : ''} ${className ?? ''}`.replace(/\s+/g, ' ').trim()} style={style}
        aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined} onKeyDown={keyDown}
        onPointerEnter={() => {
          onPointerArrive?.();
          if (document.activeElement !== element.current && !submenu) element.current?.focus({preventScroll: true});
        }}
        onPointerLeave={() => {
          clearTimeout(timers.current.open);
          if (!submenu) setActive(-1);
        }}
        onPointerDownCapture={() => {pressedHere.current = true;}}
        onContextMenu={event => event.preventDefault()}>
        {sheet && <div className="dz-sheet-grabber-row" aria-hidden="true" {...drag}><span className="dz-sheet-grabber" /></div>}
        {sheet && depth > 0 && (
          <button type="button" className="dz-menu-back" tabIndex={-1} onClick={event => {
            event.stopPropagation();
            onBack();
          }}><IconChevronLeft />Back</button>
        )}
        {items.map((item, index) => {
          if (item.type === 'separator') return <div key={'s' + index} role="separator" className="dz-menu-separator" />;
          if (item.type === 'label') return <div key={'l' + index} role="presentation" className="dz-menu-heading">{item.label}</div>;
          const isSub = item.type === 'submenu';
          const checkable = !isSub && item.checked !== undefined;
          return (
            <div key={item.id} id={`${id}-${index}`} data-index={index} data-item-id={item.id}
              role={checkable ? (!isSub && item.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem'}
              aria-checked={checkable ? !!(!isSub && item.checked) : undefined} aria-disabled={item.disabled || undefined}
              aria-haspopup={isSub ? 'menu' : undefined} aria-expanded={isSub ? submenu?.index === index : undefined}
              className={`dz-menu-item ${active === index ? 'is-active' : ''} ${!isSub && item.danger ? 'is-danger' : ''}`.trim()}
              onPointerMove={() => hover(index)}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                if (sheet && event.detail > 0 && !pressedHere.current) return;
                select(index, false);
              }}>
              {hasCheck && <span className="dz-menu-check">{!isSub && item.checked && <IconCheck />}</span>}
              {hasIcon && <span className="dz-menu-icon">{item.icon}</span>}
              <span className="dz-menu-text">
                <span className="dz-menu-label">{item.label}</span>
                {!isSub && item.description && <span className="dz-menu-description">{item.description}</span>}
              </span>
              {!isSub && item.shortcut && <span className="dz-menu-shortcut">{formatShortcut(item.shortcut)}</span>}
              {isSub && <span className="dz-menu-chevron"><IconChevronRight /></span>}
            </div>
          );
        })}
      </div>
      {openSub && openSub.type === 'submenu' && (
        <MenuLevel key={submenu!.index} items={openSub.items} anchor={submenu!.anchor} placement="right-start" offset={-2} depth={depth + 1} sheet={sheet}
          activate={submenu!.keyboard ? 'first' : 'none'} onCloseAll={onCloseAll}
          onPointerArrive={() => clearTimeout(timers.current.close)}
          onBack={() => {
            setSubmenu(null);
            element.current?.focus({preventScroll: true});
          }} />
      )}
    </>
  );
}

/** The dimmed page behind a sheet: a press that begins on it (after the sheet opened: not the lift of the finger that opened it)
 *  closes the sheet, and its click is taken, so what lies under it is not pressed too. */
export function SheetBackdrop({onClose}: {onClose: () => void}) {
  const pressed = useRef(false);
  return <div className="dz-sheet-backdrop" aria-hidden="true" onPointerDown={() => {pressed.current = true;}} onClick={() => pressed.current && onClose()} />;
}

/** A trigger that opens a menu: click, Enter, Space or ↓ (the last three start with the first row active). */
export function useMenuTrigger({items, placement = 'bottom-start', offset, label, minWidth, alignItemId, alignInset, anchor, className, sheet}: {
  items: () => MenuItem[];
  /** Position the menu against another element than the trigger (a toolbar group, not its chevron). */
  anchor?: () => Element | null;
  placement?: Placement;
  offset?: number;
  label?: string;
  minWidth?: number;
  alignItemId?: string;
  alignInset?: number;
  /** A variant class on the menu (Menu's `className`). */
  className?: string;
  /** Menu's `sheet`: false keeps it anchored on a phone. */
  sheet?: boolean;
}) {
  const trigger = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<{activate: MenuActivate; items: MenuItem[]} | null>(null);
  const show = useCallback((activate: MenuActivate) => setOpen({activate, items: items()}), [items]);
  const close = useCallback((reason: MenuCloseReason) => {
    setOpen(null);
    if (reason !== 'outside' && reason !== 'blur') trigger.current?.focus({preventScroll: true});
  }, []);
  const setTrigger = useCallback((element: HTMLElement | null) => {trigger.current = element;}, []);
  const triggerProps = {
    ref: setTrigger,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': !!open,
    onClick: (event: MouseEvent) => {
      if (open) setOpen(null);
      // event.detail is 0 for Enter and Space.
      else show(event.detail === 0 ? (alignItemId ? {id: alignItemId} : 'first') : alignItemId ? {id: alignItemId} : 'none');
    },
    onKeyDown: (event: KeyboardEvent) => {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
        event.preventDefault();
        show(event.key === 'ArrowUp' ? 'last' : alignItemId ? {id: alignItemId} : 'first');
      }
    },
  };
  const element: ReactNode = open && trigger.current
    ? <Menu items={open.items} anchor={{element: anchor?.() ?? trigger.current}} placement={placement} offset={offset} activate={open.activate} onClose={close}
        ignore={trigger.current} aria-label={label} minWidth={minWidth} alignItemId={alignItemId} alignInset={alignInset} className={className} sheet={sheet} />
    : null;
  return {open: !!open, show, close, triggerProps, element};
}

/** Right-click (or the context-menu key) opens a menu at the pointer (or under the focused element). */
export function useContextMenu() {
  const [state, setState] = useState<{items: MenuItem[]; anchor: MenuAnchor; activate: MenuActivate; label?: string} | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  /** `label` names the menu for a screen reader ("File actions for "Layout""). */
  const open = useCallback((event: MouseEvent | {x: number; y: number; keyboard?: boolean; target?: Element}, items: MenuItem[], label?: string) => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if ('preventDefault' in event) {
      event.preventDefault();
      event.stopPropagation();
      const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      const target = event.currentTarget as Element;
      setState({items, label, activate: keyboard ? 'first' : 'none', anchor: keyboard ? {element: target} : {point: {x: event.clientX, y: event.clientY}}});
    } else {
      setState({items, label, activate: event.keyboard ? 'first' : 'none', anchor: event.target ? {element: event.target} : {point: {x: event.x, y: event.y}}});
    }
  }, []);
  const close = useCallback((reason: MenuCloseReason) => {
    setState(null);
    if (reason !== 'outside' && reason !== 'blur') restore.current?.focus({preventScroll: true});
    restore.current = null;
  }, []);
  const element: ReactNode = state
    ? <Menu items={state.items} anchor={state.anchor} placement="bottom-start" offset={'point' in state.anchor ? 2 : 4} activate={state.activate} aria-label={state.label} onClose={close} />
    : null;
  return {open, close, isOpen: !!state, element};
}
