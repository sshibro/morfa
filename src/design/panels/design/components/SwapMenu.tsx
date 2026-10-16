import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import type {EditorServices} from '../../../editor/services';
import {Popover} from '../../../ui/Popover';
import {TextInput} from '../../../ui/TextInput';
import {IconCheck, IconSearch} from '../../../ui/icons';
import {ComponentThumb} from './ComponentThumb';
import {filterSwapEntries, swapEntries, type SwapEntry} from './model';

// "Swap instance": the local components of the file, searchable, grouped by page and by the "/"
// folders of their names, each with its picture; a property's preferred components come first. Arrows
// move, Enter picks, Escape closes.

export type SwapMenuProps = {
  services: EditorServices;
  anchor: Element;
  /** The component (or set) shown now: marked in the list. */
  current: NodeId | null;
  preferred?: readonly NodeId[];
  /** Left out (a component cannot hold an instance of itself). */
  exclude?: (entry: SwapEntry) => boolean;
  onPick: (id: NodeId) => void;
  onClose: () => void;
  label?: string;
};

const THUMB = {width: 40, height: 32};

export function SwapMenu({services, anchor, current, preferred = [], exclude, onPick, onClose, label = 'Swap instance'}: SwapMenuProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<NodeId | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // Read once per opening: the list does not chase edits made while it is open.
  const entries = useMemo(() => {
    const all = swapEntries(services.store.getState().doc);
    return exclude ? all.filter(entry => !exclude(entry)) : all;
  }, [services, exclude]);
  const {preferred: first, groups} = useMemo(() => filterSwapEntries(entries, query, preferred), [entries, query, preferred]);
  const flat = useMemo(() => [...first, ...groups.flatMap(group => group.entries)], [first, groups]);
  const activeId = active && flat.some(entry => entry.id === active) ? active : null;
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-swap-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({block: 'nearest'});
  }, [activeId]);

  const move = (step: 1 | -1) => {
    if (!flat.length) return;
    const at = activeId ? flat.findIndex(entry => entry.id === activeId) : step > 0 ? -1 : flat.length;
    setActive(flat[(at + step + flat.length) % flat.length].id);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      const pick = activeId ?? (flat.length === 1 ? flat[0].id : null);
      if (!pick) return;
      event.preventDefault();
      onPick(pick);
      onClose();
    }
  };

  const row = (entry: SwapEntry) => {
    const chosen = entry.id === current;
    return (
      <button key={entry.id} type="button" role="option" aria-selected={chosen} data-swap-id={entry.id}
        className={`dz-swap-item ${entry.id === activeId ? 'is-active' : ''} ${chosen ? 'is-current' : ''}`.trim()}
        onPointerMove={() => {if (activeId !== entry.id) setActive(entry.id);}}
        onClick={() => {
          onPick(entry.id);
          onClose();
        }}>
        <span className="dz-swap-thumb"><ComponentThumb services={services} id={entry.id} width={THUMB.width} height={THUMB.height} root={scroller} /></span>
        <span className="dz-swap-name" title={entry.name}>{entry.label}</span>
        {chosen && <span className="dz-swap-check"><IconCheck /></span>}
      </button>
    );
  };

  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" aria-label={label} className="dz-swap-popover">
      {/* data-dz-menu: a popover this menu opened from (a property's editor) stays open while it is used. */}
      <div className="dz-swap" onKeyDown={keyDown} data-dz-menu="">
        <div className="dz-swap-search">
          <TextInput value={query} onChange={value => {setQuery(value); setActive(null);}} icon={<IconSearch />} placeholder="Search components"
            aria-label="Search components" autoFocus />
        </div>
        <div className="dz-swap-list" role="listbox" aria-label={label} ref={element => {listRef.current = element; setScroller(element);}}>
          {first.length > 0 && (
            <div className="dz-swap-group">
              <div className="dz-swap-heading">Preferred</div>
              {first.map(row)}
            </div>
          )}
          {groups.map(group => (
            <div className="dz-swap-group" key={group.group}>
              <div className="dz-swap-heading" title={group.group}>{group.group}</div>
              {group.entries.map(row)}
            </div>
          ))}
          {!flat.length && <p className="dz-swap-empty">{entries.length ? 'Nothing found' : 'No other components in the file'}</p>}
        </div>
      </div>
    </Popover>
  );
}
