import '../styles/font-picker.css';
import {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent} from 'react';
import {internalFamily, nearestWeight, type DesignFontRegistry} from '../engine/fonts';
import {Button} from './Button';
import {fontRows, readRecentFonts, rememberRecentFont, type FontRow, type LocalFontsState} from './font-rows';
import {IconCheck, IconMonitor, IconSearch} from './icons';
import {Popover} from './Popover';
import type {Placement} from './position';
import {TextInput} from './TextInput';

// The font list ("Font"): a search field over every family the editor can draw — the catalogue
// (all with Cyrillic) grouped by kind, recently used first, and the computer's own fonts when the
// browser lets us list them. Each row shows its family in that family; faces load only for rows
// that come into view (the list is virtualized, ~100 families and any number of local ones), so
// opening the list costs a few small files, not the catalogue. ↑/↓ move, Enter picks, Esc closes.

const ROW = 28;
const OVERSCAN = 6;
/** Faces for the rows in view load once scrolling pauses this long. */
const LOAD_DELAY_MS = 90;

export type FontPickerProps = {
  anchor: Element;
  /** The family in use (null when the selection mixes several). */
  value: string | null;
  fonts: DesignFontRegistry;
  onPick: (family: string) => void;
  onClose: () => void;
  placement?: Placement;
  /** Distance from the anchor (the design panel passes the one that opens it beside the panel, not over its edge). */
  offset?: number;
  'aria-label'?: string;
};

const supportsLocalFonts = () => typeof window !== 'undefined' && typeof (window as {queryLocalFonts?: unknown}).queryLocalFonts === 'function';

export function FontPicker({anchor, value, fonts, onPick, onClose, placement = 'left-start', offset = 8, ...aria}: FontPickerProps) {
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<LocalFontsState>(() => (!supportsLocalFonts() ? 'unsupported' : fonts.families().some(info => info.source === 'local') ? 'loaded' : 'idle'));
  const [generation, setGeneration] = useState(0);
  const [recent] = useState(readRecentFonts);
  const families = useMemo(() => fonts.families(), [fonts, generation]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => fontRows(families, query, query ? [] : recent, local), [families, query, recent, local]);
  const fontIndexes = useMemo(() => rows.flatMap((row, i) => (row.type === 'font' ? [i] : [])), [rows]);
  const [active, setActive] = useState(() => {
    const index = rows.findIndex(row => row.type === 'font' && row.family === value && row.group !== 'recent');
    return index >= 0 ? index : fontIndexes[0] ?? -1;
  });
  const list = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({top: 0, height: 360});
  const listId = useId();

  // Open on the current family, centred.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const height = element.clientHeight || 360;
    if (active >= 0) element.scrollTop = Math.max(0, active * ROW - height / 2 + ROW / 2);
    setScroll({top: element.scrollTop, height});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A new search starts at its first match.
  useEffect(() => {
    if (!query) return;
    setActive(fontIndexes[0] ?? -1);
    if (list.current) list.current.scrollTop = 0;
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(scroll.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW) + OVERSCAN);

  // Load the faces of the rows in view (after scrolling settles), so each previews in itself.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (let i = first; i < last; i++) {
        const row = rows[i];
        if (row?.type !== 'font') continue;
        const weights = row.info.weights;
        const spec = {family: row.family, weight: weights.length ? nearestWeight(weights, 400) : 400, italic: false, size: 13};
        if (!fonts.isLoaded(spec)) void fonts.ensure(spec);
      }
    }, LOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [first, last, rows, fonts]);

  const reveal = useCallback((index: number) => {
    const element = list.current;
    if (!element || index < 0) return;
    const top = index * ROW;
    if (top < element.scrollTop + ROW) element.scrollTop = Math.max(0, top - ROW);
    else if (top + ROW > element.scrollTop + element.clientHeight) element.scrollTop = top + 2 * ROW - element.clientHeight;
  }, []);

  const pick = (family: string) => {
    rememberRecentFont(family);
    onPick(family);
  };

  const step = (direction: 1 | -1, count = 1) => {
    if (!fontIndexes.length) return;
    let position = fontIndexes.indexOf(active);
    if (position < 0) position = direction > 0 ? -1 : fontIndexes.length;
    const next = fontIndexes[Math.max(0, Math.min(fontIndexes.length - 1, position + direction * count))];
    setActive(next);
    reveal(next);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      step(event.key === 'PageDown' ? 1 : -1, 10);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row?.type === 'font') pick(row.family);
    }
  };

  const requestLocal = async () => {
    setLocal('loading');
    const granted = await fonts.requestLocalFonts();
    setGeneration(value => value + 1);
    setLocal(granted ? 'loaded' : 'denied');
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const visible: {row: FontRow; index: number}[] = [];
  for (let i = first; i < last; i++) visible.push({row: rows[i], index: i});

  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} offset={offset} aria-label={aria['aria-label'] ?? 'Fonts'} className="dz-font-popover">
      <div className="dz-font-picker">
        <div className="dz-font-search">
          <TextInput value={query} onChange={setQuery} icon={<IconSearch />} placeholder="Search fonts" aria-label="Search fonts" onKeyDown={keyDown}
            role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={active >= 0 ? optionId(active) : undefined} autoFocus />
        </div>
        <div ref={list} id={listId} className="dz-font-list" role="listbox" aria-label="Fonts" tabIndex={-1}
          onScroll={event => setScroll({top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight})}>
          <div className="dz-font-list-inner" style={{height: rows.length * ROW}}>
            {visible.map(({row, index}) => {
              const style = {transform: `translateY(${index * ROW}px)`};
              if (row.type === 'heading') return <div key={`h${index}`} className="dz-font-heading" style={style} role="presentation">{row.label}</div>;
              if (row.type === 'empty') return <div key="empty" className="dz-font-note" style={style}>Nothing found</div>;
              if (row.type === 'local') return <LocalRow key="local" state={row.state} style={style} onRequest={requestLocal} />;
              const selected = row.family === value;
              return (
                <div key={`${row.group}:${row.family}`} id={optionId(index)} role="option" aria-selected={selected}
                  className={`dz-font-row ${index === active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`.trim()} style={style}
                  onPointerMove={() => index !== active && setActive(index)}
                  onClick={() => pick(row.family)}>
                  <span className="dz-font-check" aria-hidden="true">{selected && <IconCheck size={12} />}</span>
                  <span className="dz-font-name" style={{fontFamily: `"${internalFamily(row.family)}", var(--dz-font)`}}>{row.family}</span>
                  {row.info.source === 'local' && <span className="dz-font-source" title="Font on this computer"><IconMonitor size={12} /></span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Popover>
  );
}

function LocalRow({state, style, onRequest}: {state: LocalFontsState; style: CSSProperties; onRequest: () => void}) {
  if (state === 'unsupported') return <div className="dz-font-note is-wrap" style={style}>This browser cannot list the fonts on your computer: Chrome and Edge can.</div>;
  if (state === 'denied') return <div className="dz-font-note is-wrap" style={style}>Access to the fonts on your computer was not granted.</div>;
  if (state === 'loaded') return <div className="dz-font-note" style={style}>No other fonts were found on your computer.</div>;
  return (
    <div className="dz-font-local" style={style}>
      <Button size={24} variant="ghost" icon={<IconMonitor />} busy={state === 'loading'} onClick={onRequest}>Show fonts on this computer</Button>
    </div>
  );
}
