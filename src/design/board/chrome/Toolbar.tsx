import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {HIGHLIGHTER_COLORS, MARKER_COLORS, SHAPE_COLORS, STICKY_COLORS, WASHI_COLORS, stickyColor} from '../../../../shared/design/board/palette';
import {BOARD_FLOWCHART_SHAPES, BOARD_SHAPES, boardShapeGeometry} from '../../../../shared/design/board/shapes';
import type {BoardShapeKind, ConnectorLine} from '../../../../shared/design/board/types';
import {useTooltip} from '../../ui/Tooltip';
import {boardChoices, setBoardChoices, subscribeBoardChoices, type BoardChoices, type MarkerKind} from '../state';
import {BOARD_TOOL_LABELS, type BoardToolId} from '../tools';
import {BOARD_TOOL_SHORTCUTS} from '../keys';
import {MarkerArt, ShapesArt, StickiesArt} from './Illustrations';
import {
  BdPalette, BdSparkle, BdClose, BdComment, BdEraser, BdHand, BdLineCurved, BdLineElbow, BdLineStraight, BdMindMap, BdMore, BdMove, BdPicture, BdPlus, BdSection, BdStamp, BdTable, BdText, BdThick, BdThin,
  type BdIcon,
} from './icons';

// The board's toolbar (docs/board.md §Toolbar), FigJam's: Move and Hand | the drawn Marker, Stickies and Shapes | Text, Section,
// Table, Stamp, Comment, Actions and "+". A tray rises above it for the tool in hand (the marker's kinds, thickness and colours;
// sticky colours; shapes and connector lines; stamps). Buttons light at once (tools switch from the keyboard all day); a tray
// rises from the toolbar in 160 ms with ease-out, and appears at once when the tool came from a key (the root's data-input).

export const useBoardChoices = (): BoardChoices => useSyncExternalStore(subscribeBoardChoices, boardChoices, boardChoices);

export type BoardToolbarProps = {
  tool: string;
  onTool: (tool: BoardToolId, choices?: Partial<BoardChoices>) => void;
  readOnly: boolean;
  plusOpen: boolean;
  onPlus: () => void;
  onActions: () => void;
  /** Over the toolbar when no tray is: "Back to board" (Recenter.tsx). */
  above?: ReactNode;
  /** "Board colors" in the marker tray: the colours already drawn with on the board (colors.ts). */
  boardColors?: (kind: Exclude<MarkerKind, 'eraser'>) => string[];
  /** "Tape from picture" in the marker tray: asks for a picture and prints new washi tape with it (BoardLayout's). */
  onWashiPicture?: () => void;
  /** "Mind map" in the shapes tray: places one in the view (mind-map.ts). */
  onMindMap?: () => void;
};

// The stamp has no tray: its button opens the stamp wheel above it (FigJam), BoardLayout's.
const TOOL_TRAY: Partial<Record<string, 'marker' | 'sticky' | 'shape'>> = {
  'board-marker': 'marker',
  'board-sticky': 'sticky',
  'board-shape': 'shape',
  'board-connector': 'shape',
  'board-line': 'shape',
};

export const BoardToolbar = memo(function BoardToolbar({tool, onTool, readOnly, plusOpen, onPlus, onActions, above, boardColors, onMindMap, onWashiPicture}: BoardToolbarProps) {
  const choices = useBoardChoices();
  const tray = plusOpen ? null : TOOL_TRAY[tool] ?? null;
  // The tray is as wide as the bar and 6 px more on each side (the owner's picture): the dock knows the bar's width.
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = dock.current, bar = element?.querySelector<HTMLElement>('.bd-toolbar');
    if (!element || !bar) return;
    const sync = () => element.style.setProperty('--bd-bar-width', `${bar.offsetWidth}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={dock} className="bd-dock" onKeyDown={arrowFocus}>
      {!tray && !plusOpen && above}
      {tray === 'marker' && <MarkerTray choices={choices} boardColors={boardColors} onWashiPicture={onWashiPicture} />}
      {tray === 'sticky' && <StickyTray choices={choices} />}
      {tray === 'shape' && <ShapeTray choices={choices} tool={tool} onTool={onTool} onMindMap={onMindMap} />}
      <div className="bd-toolbar" role="toolbar" aria-label="Board tools">
        <div className="bd-cluster">
          <ToolButton tool="move" icon={BdMove} active={tool === 'move'} onTool={onTool} />
          <ToolButton tool="hand" icon={BdHand} active={tool === 'hand'} onTool={onTool} />
        </div>
        {!readOnly && (
          <>
            <span className="bd-divider" aria-hidden="true" />
            <div className="bd-cluster is-art">
              <ArtButton tool="board-marker" label="Marker" kind="marker" active={tool === 'board-marker'} onTool={onTool}>
                <MarkerArt ink={choices.marker === 'highlighter' ? choices.colors.highlighter : choices.marker === 'washi' ? choices.colors.washi : choices.colors.marker} />
              </ArtButton>
              <ArtButton tool="board-sticky" label="Sticky" kind="stickies" active={tool === 'board-sticky'} onTool={onTool}>
                <StickiesArt paper={stickyColor(choices.stickyColor).hex} />
              </ArtButton>
              <ArtButton tool="board-shape" label="Shapes and connectors" kind="shapes" active={tool === 'board-shape' || tool === 'board-connector' || tool === 'board-line'} onTool={onTool}>
                <ShapesArt />
              </ArtButton>
            </div>
          </>
        )}
        <span className="bd-divider" aria-hidden="true" />
        <div className="bd-cluster is-icons">
          {!readOnly && (
            <>
              <ToolButton tool="text" icon={BdText} active={tool === 'text'} onTool={onTool} />
              <ToolButton tool="section" icon={BdSection} active={tool === 'section'} onTool={onTool} />
              <ToolButton tool="board-table" icon={BdTable} active={tool === 'board-table'} onTool={onTool} />
              <ToolButton tool="board-stamp" icon={BdStamp} active={tool === 'board-stamp'} onTool={onTool} />
            </>
          )}
          {/* Comments live in the top-right pill and on C (the owner's picture has no comment button in the bar); a read-only board
              keeps it here, as its only tool besides Move and Hand. */}
          {readOnly && <ToolButton tool="comment" icon={BdComment} active={tool === 'comment'} onTool={onTool} />}
          <PlainButton label="Actions" shortcut="Mod+KeyK" onClick={onActions}><BdSparkle /></PlainButton>
          {!readOnly && (
            <button type="button" className={`bd-plus ${plusOpen ? 'is-open' : ''}`.trim()} aria-label={plusOpen ? 'Close' : 'More: stickers, templates, stamps'} aria-expanded={plusOpen} onClick={onPlus}>
              <span className="bd-plus-icon is-plus"><BdPlus size={20} /></span>
              <span className="bd-plus-icon is-close"><BdClose size={20} /></span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/** ←/→ (and ↑/↓) move focus along the bar or a tray, as in a toolbar (WAI-ARIA); Home and End go to the ends. */
function arrowFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  const edge = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null;
  if (!step && !edge) return;
  const group = (event.target as HTMLElement).closest<HTMLElement>('[role="toolbar"], [role="group"]');
  if (!group) return;
  const items = [...group.querySelectorAll<HTMLElement>('button, input')].filter(item => !(item as HTMLButtonElement).disabled);
  const at = items.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = edge === 'first' ? 0 : edge === 'last' ? items.length - 1 : (at + step + items.length) % items.length;
  items[next].focus();
}

/** A tool button pressed with the mouse leaves focus where it was (the canvas): FigJam's tools never wear a focus ring after a
 *  click, and the next key goes to the board. Tab still reaches every button. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

function ToolButton({tool, icon: Icon, active, onTool}: {tool: BoardToolId; icon: BdIcon; active: boolean; onTool: BoardToolbarProps['onTool']}) {
  const tip = useTooltip({label: BOARD_TOOL_LABELS[tool], shortcut: BOARD_TOOL_SHORTCUTS[tool], placement: 'top'});
  return (
    <button type="button" className="bd-tool" aria-label={BOARD_TOOL_LABELS[tool]} aria-pressed={active} {...tip} onMouseDown={keepFocus} onClick={() => onTool(tool)}>
      <Icon />
    </button>
  );
}

function PlainButton({label, shortcut, onClick, children}: {label: string; shortcut?: string; onClick: () => void; children: ReactNode}) {
  const tip = useTooltip({label, shortcut, placement: 'top'});
  return <button type="button" className="bd-tool" aria-label={label} {...tip} onMouseDown={keepFocus} onClick={onClick}>{children}</button>;
}

function ArtButton({tool, label, kind, active, onTool, children}: {tool: BoardToolId; label: string; kind: 'marker' | 'stickies' | 'shapes'; active: boolean; onTool: BoardToolbarProps['onTool']; children: ReactNode}) {
  const tip = useTooltip({label, shortcut: BOARD_TOOL_SHORTCUTS[tool], placement: 'top'});
  return (
    <button type="button" className={`bd-art-tool is-${kind}`} aria-label={label} aria-pressed={active} {...tip} onMouseDown={keepFocus} onClick={() => onTool(tool)}>
      {children}
    </button>
  );
}

// ── "Board colors" ──

/** The palette button after the rainbow (the owner's picture): the colours already drawn with on the board, one click each. */
function BoardColorsButton({colors, current, onPick}: {colors: () => string[]; current: string; onPick: (hex: string) => void}) {
  const [open, setOpen] = useState<string[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const tip = useTooltip(open ? null : {label: 'Board colors', placement: 'top'});
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div ref={root} className="bd-board-colors">
      <button type="button" className="bd-icon-choice" aria-label="Board colors" aria-expanded={!!open} {...tip} onClick={() => setOpen(value => (value ? null : colors()))}>
        <BdPalette />
      </button>
      {open && (
        <div className="bd-board-colors-pop" role="group" aria-label="Board colors">
          {open.length
            ? open.map(hex => <Swatch key={hex} hex={hex} label={hex} selected={current.toUpperCase() === hex} onPick={() => {onPick(hex); setOpen(null);}} />)
            : <p className="bd-tray-note">Colors already used on this board that are not in the palette will appear here.</p>}
        </div>
      )}
    </div>
  );
}

// ── Trays ────────────────────────────────────────────────────────────────────────────────────────

function Tray({label, children, className = ''}: {label: string; children: ReactNode; className?: string}) {
  return <div className={`bd-tray ${className}`.trim()} role="group" aria-label={label}>{children}</div>;
}

function Swatch({hex, label, selected, onPick, size = 'm'}: {hex: string; label: string; selected: boolean; onPick: () => void; size?: 'm' | 'l'}) {
  const tip = useTooltip({label, placement: 'top'});
  // A 24 px disc (32 px for sticky colours) in a 40 px target; chosen, a ring with a white gap around it.
  return (
    <button type="button" className={`bd-swatch-hit is-${size}`} aria-label={label} aria-pressed={selected} {...tip} onClick={onPick}>
      <span className={`bd-swatch is-${size} ${selected ? 'is-selected' : ''}`.trim()} style={{'--bd-swatch': hex} as React.CSSProperties} />
    </button>
  );
}

const MARKER_KINDS: {id: MarkerKind; label: string; shortcut: string}[] = [
  {id: 'marker', label: 'Marker', shortcut: 'M'},
  {id: 'highlighter', label: 'Highlighter', shortcut: '⇧M'},
  {id: 'washi', label: 'Washi tape', shortcut: 'W'},
  {id: 'eraser', label: 'Eraser', shortcut: '⇧⌫'},
];

function MarkerKindButton({kind, choices}: {kind: (typeof MARKER_KINDS)[number]; choices: BoardChoices}) {
  const tip = useTooltip({label: `${kind.label} · ${kind.shortcut}`, placement: 'top'});
  const active = choices.marker === kind.id;
  return (
    <button type="button" className="bd-marker-kind" aria-label={kind.label} aria-pressed={active} {...tip} onClick={() => setBoardChoices({marker: kind.id})}>
      <MarkerKindArt kind={kind.id} choices={choices} />
    </button>
  );
}

/** The marker tray's drawings of each kind, filling a 36 px tile (28 px, the owner's picture), in the colour each will draw
 *  with: a marker with its tip, a highlighter, a patterned square of washi tape, a pink eraser block. */
function MarkerKindArt({kind, choices}: {kind: MarkerKind; choices: BoardChoices}) {
  if (kind === 'eraser') {
    return (
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <rect x="4" y="2" width="16" height="21" rx="3" fill="#FFB8D2" stroke="rgba(0,0,0,0.18)" />
        <rect x="4" y="15" width="16" height="8" rx="2" fill="#F5F5F5" stroke="rgba(0,0,0,0.14)" />
      </svg>
    );
  }
  if (kind === 'washi') {
    return (
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="2" fill={choices.colors.washi} stroke="rgba(0,0,0,0.16)" />
        <path d="M2 9l7-7M2 16l14-14M6 22l16-16M13 22l9-9" stroke="#FFFFFF" strokeOpacity="0.6" strokeWidth="2.2" />
      </svg>
    );
  }
  const ink = kind === 'highlighter' ? choices.colors.highlighter : choices.colors.marker;
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      {kind === 'highlighter'
        ? <path d="M7 8 L17 3.5 L17 8.5 L7 8.5 Z" fill={ink} stroke="rgba(0,0,0,0.25)" strokeWidth="0.75" />
        : <path d="M9.5 8 L12 0.5 L14.5 8 Z" fill={ink} stroke="rgba(0,0,0,0.25)" strokeWidth="0.75" />}
      <rect x="7" y="8" width="10" height="17" rx="3" fill="#FAFAFA" stroke="rgba(0,0,0,0.2)" />
      <rect x="7" y="12" width="10" height="3.5" fill={ink} />
    </svg>
  );
}

const MarkerTray = memo(function MarkerTray({choices, boardColors, onWashiPicture}: {choices: BoardChoices; boardColors?: BoardToolbarProps['boardColors']; onWashiPicture?: () => void}) {
  const kind = choices.marker;
  const drawing = kind !== 'eraser';
  const colors = kind === 'highlighter' ? HIGHLIGHTER_COLORS : kind === 'washi' ? WASHI_COLORS : MARKER_COLORS;
  const current = kind === 'highlighter' ? choices.colors.highlighter : kind === 'washi' ? choices.colors.washi : choices.colors.marker;
  const printed = kind === 'washi' && !!choices.washiImage;
  const pick = (hex: string) => {
    if (kind === 'eraser') return;
    setBoardChoices({colors: {...choices.colors, [kind]: hex}, ...(kind === 'washi' ? {washiImage: null} : {})});
  };
  return (
    <Tray label="Marker" className="is-marker">
      <div className="bd-tray-row is-kinds">{MARKER_KINDS.map(entry => <MarkerKindButton key={entry.id} kind={entry} choices={choices} />)}</div>
      {drawing && (
        <>
          <span className="bd-tray-divider" aria-hidden="true" />
          <div className="bd-tray-row">
            <IconChoice label="Thin line" selected={!choices.thick} onPick={() => setBoardChoices({thick: false})}><BdThin /></IconChoice>
            <IconChoice label="Thick line" selected={choices.thick} onPick={() => setBoardChoices({thick: true})}><BdThick /></IconChoice>
          </div>
          <span className="bd-tray-divider" aria-hidden="true" />
          <div className="bd-tray-row is-colors">
            {colors.map(color => <Swatch key={color.id} hex={color.hex} label={color.label} selected={!printed && current.toUpperCase() === color.hex.toUpperCase()} onPick={() => pick(color.hex)} />)}
            <label className="bd-swatch-hit is-m" aria-label="Custom color">
              <span className="bd-swatch is-m is-custom" />
              <input type="color" value={current} onChange={event => pick(event.currentTarget.value.toUpperCase())} />
            </label>
            {boardColors && <BoardColorsButton colors={() => boardColors(kind as Exclude<MarkerKind, 'eraser'>)} current={current} onPick={pick} />}
            {kind === 'washi' && onWashiPicture && <IconChoice label="Tape from picture" selected={printed} onPick={onWashiPicture}><BdPicture /></IconChoice>}
          </div>
        </>
      )}
      {!drawing && <p className="bd-tray-note">Drag over marker, highlighter or tape lines to erase them. The eraser does not touch stickies and shapes.</p>}
    </Tray>
  );
});

function IconChoice({label, selected, onPick, children}: {label: string; selected: boolean; onPick: () => void; children: ReactNode}) {
  const tip = useTooltip({label, placement: 'top'});
  return <button type="button" className="bd-icon-choice" aria-label={label} aria-pressed={selected} {...tip} onClick={onPick}>{children}</button>;
}

const StickyTray = memo(function StickyTray({choices}: {choices: BoardChoices}) {
  return (
    <Tray label="Sticky color" className="is-sticky">
      <div className="bd-tray-row is-colors">
        {STICKY_COLORS.map(color => <Swatch key={color.id} size="l" hex={color.hex} label={color.label} selected={choices.stickyColor === color.id} onPick={() => setBoardChoices({stickyColor: color.id})} />)}
      </div>
      <p className="bd-tray-hint">Click the board to place a sticky</p>
    </Tray>
  );
});

const LINES: {id: ConnectorLine; label: string; icon: BdIcon}[] = [
  {id: 'elbow', label: 'Elbow connector · X', icon: BdLineElbow},
  {id: 'curved', label: 'Curved connector', icon: BdLineCurved},
  {id: 'straight', label: 'Straight connector · L', icon: BdLineStraight},
];

const ShapeTray = memo(function ShapeTray({choices, tool, onTool, onMindMap}: {choices: BoardChoices; tool: string; onTool: BoardToolbarProps['onTool']; onMindMap?: () => void}) {
  const pickShape = useCallback((shape: BoardShapeKind) => onTool('board-shape', {shape}), [onTool]);
  const flowchart = BOARD_FLOWCHART_SHAPES.some(shape => shape.id === choices.shape);
  // Open when one of them is in hand, so the chosen figure shows.
  const [more, setMore] = useState(flowchart);
  return (
    <Tray label="Shapes and connectors" className="is-shapes">
      <div className="bd-shape-grid">
        {BOARD_SHAPES.map(shape => (
          <ShapeChoice key={shape.id} shape={shape.id} label={shape.label} fill={choices.shapeFill} selected={tool === 'board-shape' && choices.shape === shape.id} onPick={pickShape} />
        ))}
        <MoreShapes open={more} selected={flowchart} onToggle={() => setMore(value => !value)} />
        {more && BOARD_FLOWCHART_SHAPES.map(shape => (
          <ShapeChoice key={shape.id} shape={shape.id} label={shape.label} fill={choices.shapeFill} selected={tool === 'board-shape' && choices.shape === shape.id} onPick={pickShape} />
        ))}
      </div>
      <span className="bd-tray-divider" aria-hidden="true" />
      <div className="bd-tray-column">
        {LINES.map(line => (
          <IconChoice key={line.id} label={line.label} selected={tool === 'board-connector' && choices.line === line.id} onPick={() => onTool('board-connector', {line: line.id})}>
            <line.icon />
          </IconChoice>
        ))}
        {onMindMap && <IconChoice label="Mind map" selected={false} onPick={onMindMap}><BdMindMap /></IconChoice>}
      </div>
      <span className="bd-tray-divider" aria-hidden="true" />
      <div className="bd-tray-row is-colors is-two-rows">
        {SHAPE_COLORS.filter(color => color.id !== 'black').slice(0, 12).map(color => (
          <Swatch key={color.id} hex={color.hex} label={color.label} selected={choices.shapeFill.toUpperCase() === color.hex.toUpperCase()} onPick={() => setBoardChoices({shapeFill: color.hex})} />
        ))}
      </div>
    </Tray>
  );
});

/** FigJam's "More shapes": a tile at the end of the grid that unfolds its other flowchart figures below it, in the tray. */
function MoreShapes({open, selected, onToggle}: {open: boolean; selected: boolean; onToggle: () => void}) {
  const tip = useTooltip({label: open ? 'Fewer shapes' : 'More shapes', placement: 'top'});
  return (
    <button type="button" className="bd-shape-choice" aria-label="More shapes" aria-expanded={open} aria-pressed={selected && !open} {...tip} onClick={onToggle}>
      <BdMore />
    </button>
  );
}

function ShapeChoice({shape, label, fill, selected, onPick}: {shape: BoardShapeKind; label: string; fill: string; selected: boolean; onPick: (shape: BoardShapeKind) => void}) {
  const tip = useTooltip({label, placement: 'top'});
  return (
    <button type="button" className="bd-shape-choice" aria-label={label} aria-pressed={selected} {...tip} onClick={() => onPick(shape)}>
      <ShapeGlyph shape={shape} fill={fill} />
    </button>
  );
}

/** A figure drawn small (the tray, the context toolbar), from the same geometry the canvas draws. */
export function ShapeGlyph({shape, fill, size = 22}: {shape: BoardShapeKind; fill: string; size?: number}) {
  const geometry = boardShapeGeometry(shape, 20, shape === 'arrow-right' || shape === 'arrow-left' ? 12 : 20);
  const top = shape === 'arrow-right' || shape === 'arrow-left' ? 6 : 2;
  const common = {fill, stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' as const};
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {geometry.type === 'ELLIPSE' && <ellipse cx="12" cy="12" rx="10" ry="10" {...common} />}
      {geometry.type === 'RECTANGLE' && <rect x="2" y="2" width="20" height="20" rx={shape === 'rounded' ? 5 : 1} {...common} />}
      {geometry.type === 'VECTOR' && (
        <g transform={`translate(2 ${top})`}>
          {(geometry.fields.vectorPaths ?? []).map((path, i) => (
            <path key={i} d={path.commands.map(c => (c.type === 'Z' ? 'Z' : c.type === 'C' ? `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}` : c.type === 'Q' ? `Q${c.x1} ${c.y1} ${c.x} ${c.y}` : `${c.type}${c.x} ${c.y}`)).join('')}
              {...common} fill={i === 0 ? fill : 'none'} />
          ))}
        </g>
      )}
    </svg>
  );
}

export function StampFace({color, glyph, icon, stroke, size = 32, initials}: {color: string; glyph?: string; icon?: string; stroke?: boolean; size?: number; initials?: string}) {
  const text = initials ?? glyph;
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <circle cx="24" cy="24" r="22.5" fill={color} stroke="#FFFFFF" strokeWidth="3" />
      {text ? (
        <text x="24" y="24" textAnchor="middle" dominantBaseline="central" fill="#FFFFFF" fontSize={text.length > 1 ? 17 : 22} fontWeight="700" fontFamily="Inter Variable, Inter, sans-serif">{text}</text>
      ) : icon ? (
        <g transform="translate(12 12)"><path d={icon} fill={stroke ? 'none' : '#FFFFFF'} stroke={stroke ? '#FFFFFF' : 'none'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></g>
      ) : null}
    </svg>
  );
}
