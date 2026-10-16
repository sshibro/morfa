import {memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {DesignDocument, NodeId, SceneNode, StrokeMarker} from '../../../../shared/design/types';
import {worldBox, unionRects} from '../../../../shared/design/geometry';
import {childPart, isSticky} from '../../../../shared/design/board/model';
import {cellPosition} from '../../../../shared/design/board/table';
import {BOARD_TEMPLATES} from '../../../../shared/design/board/templates';
import {fillSection} from '../section-commands';
import {SECTION_COLORS, SHAPE_COLORS, STICKY_COLORS, MARKER_COLORS, swatchOf} from '../../../../shared/design/board/palette';
import {BOARD_FLOWCHART_SHAPES, BOARD_SHAPES} from '../../../../shared/design/board/shapes';
import type {BoardShapeKind, ConnectorLine} from '../../../../shared/design/board/types';
import {hexToRgb} from '../../../../shared/design/board/palette';
import {getCommand, isEnabled, runCommand, type CommandContext} from '../../engine/commands';
import {currentViewport, type DesignStore} from '../../engine/store';
import {pageToScreen} from '../../engine/viewport';
import {useDesignStore} from '../../engine/useDesignStore';
import {Popover} from '../../ui/Popover';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {
  alignOf, colorOf, endStyleOf, END_STYLES, isDashed, kindOf, labelBackgroundOf, lineOf, setAlign, setColor, setConnectorLine, setConnectorStyle, setEndStyle, setLabelBackground,
  setLocked, sectionFlags, setSectionFlag, setCellColor, setShapeDashed, isShapeDashed, cellColorOf, tableCells, setShapeKind, setShapeStroke, setStickyColor, setStickyWide, isWideSticky, targetObjects, toggleBold, weightOf, type ConnectorEndSide,
  type BoardSelectionKind, type ConnectorWeight, } from '../edits';
import {
  BdAlignCenter, BdAlignLeft, BdAlignRight, BdAlignObjects, BdEye, BdEyeOff, BdMergeDown, BdMergeRight, BdMindMap, BdUnmerge, BdAuthor, BdBold, BdDashed, BdFit, BdLineCurved, BdLineElbow,
  BdLineStraight, BdMore, BdRowAdd, BdColumnAdd, BdSort, BdTidy, type BdIcon,
} from './icons';
import {ShapeGlyph} from './Toolbar';
import {ContextButton, FaceMenu, LinkButton, ListButton, StrikeButton, textIdsOf} from './TextControls';

// The floating toolbar over the selection (docs/board.md §Context toolbar), FigJam's: what the selected objects are decides what
// it offers — a sticky's paper and author line, a shape's figure, fill and outline, a connector's line and arrowheads, text size and
// face, a section's colour and "fit", a table's rows and columns, lock and more. It follows the selection on the canvas outside
// React (a transform written on animation frames), hides while something is dragged, and changes at once (no motion: it is used
// all day). Edits go through edits.ts, one undo step each.

export type ContextToolbarProps = {store: DesignStore; context: () => CommandContext; readOnly: boolean};

/** The bar at the bottom (64 px, 12 px from the edge) and a margin over it. */
export const BAR_ZONE = 88;
// Clear of the connection dots that sit 18 px outside a hovered sticky or shape (tools/move.ts).
const GAP = 30;

export const ContextToolbar = memo(function ContextToolbar({store, context, readOnly}: ContextToolbarProps) {
  const element = useRef<HTMLDivElement>(null);
  // What is selected (content), read on selection, document and editing changes; the position is written apart.
  const signature = useDesignStore(state => `${state.selection.join(',')}|${state.editing?.id ?? ''}`, Object.is, {store, slice: ['selection', 'editing']});
  // The document between gestures: the toolbar hides while something is dragged, so it reads the objects again when the
  // gesture ends instead of re-rendering on every frame of it.
  const doc = useDesignStore(state => (state.live.size ? null : state.doc), Object.is, {store, slice: ['doc', 'live']});
  const objects = useMemo(() => targetObjects(store), [store, signature, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = useMemo(() => new Set(objects.map(kindOf)), [objects]);
  // Only with "Move" in hand or while typing: a drawing tool keeps the board clear (FigJam).
  const tool = useDesignStore(state => state.tool, Object.is, {store, slice: 'tool'});
  const visible = objects.length > 0 && !readOnly && (tool === 'move' || tool === 'text');

  useEffect(() => {
    const box = element.current;
    if (!box || !visible) return;
    let frame = 0;
    // The objects' box on the page, measured once per document: a pan or a zoom only moves it on screen.
    let measured: {doc: DesignDocument; bounds: ReturnType<typeof unionRects>} | null = null;
    const place = () => {
      frame = 0;
      const state = store.getState();
      if (state.live.size) {
        box.hidden = true;
        return;
      }
      if (measured?.doc !== state.doc) {
        const ids = objects.map(object => object.id).filter(id => state.doc.nodes[id]);
        measured = {doc: state.doc, bounds: ids.length ? unionRects(ids.map(id => worldBox(state.doc, id))) : null};
      }
      const {bounds} = measured;
      if (!bounds) {
        box.hidden = true;
        return;
      }
      const viewport = currentViewport(state);
      const top = pageToScreen(viewport, {x: bounds.x + bounds.width / 2, y: bounds.y});
      const bottom = pageToScreen(viewport, {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height});
      box.hidden = false;
      const host = box.offsetParent as HTMLElement | null;
      const width = box.offsetWidth, height = box.offsetHeight;
      const roomAbove = top.y - GAP - height > 64;
      const above = top.y - GAP - height, below = bottom.y + GAP;
      // Never under the bar at the bottom: below the selection only while it
      // clears the bar's zone; else above it, or as low as the zone allows when the selection fills the view.
      const barTop = (host?.clientHeight ?? innerHeight) - BAR_ZONE;
      let y = roomAbove ? above : below;
      if (y + height > barTop) y = above >= 8 ? above : barTop - height;
      const max = (host?.clientWidth ?? innerWidth) - width - 8;
      const x = Math.max(8, Math.min(max, top.x - width / 2));
      box.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(8, y))}px)`;
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    const off = store.subscribe(request, {slice: ['viewport', 'doc', 'live', 'page']});
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [store, objects, visible]);

  if (!visible) return null;
  return (
    <div ref={element} className="bd-context" role="toolbar" aria-label="Selection properties" hidden>
      <Controls store={store} objects={objects} kinds={kinds} context={context} />
    </div>
  );
});

const only = (kinds: ReadonlySet<BoardSelectionKind>, ...allowed: BoardSelectionKind[]) => kinds.size > 0 && [...kinds].every(kind => allowed.includes(kind));

/** The groups, left to right, divided by thin rules (help.figma.com, the sticky's and the shape's toolbars): what the object is
 *  (its colour, figure, line), then its text (FaceMenu, bold, strikethrough, link, list), then its own switch (a sticky's author),
 *  then "More" with the rest (width, alignment, lock, order, delete). */
function Controls({store, objects, kinds, context}: {store: DesignStore; objects: SceneNode[]; kinds: ReadonlySet<BoardSelectionKind>; context: () => CommandContext}) {
  const get = useCallback((id: NodeId | null | undefined) => (id ? store.getState().doc.nodes[id] : undefined), [store]);
  const first = objects[0];
  const groups: ReactNode[][] = [];
  const color = colorOf(get, first);
  const texts = textIdsOf(get, objects);
  const textGroup = (sized: boolean, bold = true): ReactNode[] => [
    <FaceMenu key="face" store={store} objects={objects} get={get} sized={sized} />,
    ...(bold ? [<ContextButton key="bold" label="Bold" pressed={(get(texts[0])?.text?.style.fontWeight ?? 400) >= 600} onClick={() => toggleBold(store, objects)}><BdBold size={20} /></ContextButton>] : []),
    ...(texts.length ? [
      <StrikeButton key="strike" store={store} ids={texts} get={get} />,
      <LinkButton key="link" store={store} ids={texts} get={get} />,
      <ListButton key="list" store={store} ids={texts} get={get} />,
    ] : []),
  ];

  if (only(kinds, 'sticky')) {
    groups.push([<ColorPicker key="color" label="Sticky color" colors={STICKY_COLORS} value={color} round onPick={hex => setStickyColor(store, objects, swatchOf(STICKY_COLORS, hexToRgb(hex))?.id ?? 'yellow')} />]);
    groups.push(textGroup(false));
    const shown = objects.some(object => childPart(get, object, 'author')?.visible);
    groups.push([<ContextButton key="author" className="is-switch" label="Show author" pressed={shown} onClick={() => runCommand('board.sticky-author', context())}><BdAuthor size={20} /></ContextButton>]);
  } else if (only(kinds, 'shape')) {
    const shape = first.board?.kind === 'shape' ? first.board.shape : 'square';
    groups.push([<ShapePicker key="shape" value={shape} onPick={next => setShapeKind(store, objects, next)} />]);
    const figure = childPart(get, first, 'shape');
    const stroke = figure?.strokes.find(paint => paint.type === 'SOLID');
    groups.push([
      <ColorPicker key="fill" label="Fill" colors={SHAPE_COLORS} value={color} round onPick={hex => setColor(store, objects, hex, 'Fill')} />,
      <ColorPicker key="stroke" label="Stroke" colors={SHAPE_COLORS} value={stroke?.type === 'SOLID' ? swatchHex(stroke.color) : null} outline round
        onPick={hex => setShapeStroke(store, objects, hex)} onNone={() => setShapeStroke(store, objects, null)}
        extra={stroke ? <button type="button" className="bd-palette-switch" aria-pressed={isShapeDashed(get, first)} onClick={() => setShapeDashed(store, objects, !isShapeDashed(get, first))}>Dashed</button> : undefined} />,
    ]);
    groups.push(textGroup(true));
  } else if (only(kinds, 'connector')) {
    groups.push([<LinePicker key="line" value={lineOf(first)} onPick={line => setConnectorLine(store, objects, line)} />]);
    groups.push([
      <EndPicker key="start" side="start" value={endStyleOf(get, first, 'start')} onPick={marker => setEndStyle(store, objects, 'start', marker)} />,
      <EndPicker key="end" side="end" value={endStyleOf(get, first, 'end')} onPick={marker => setEndStyle(store, objects, 'end', marker)} />,
    ]);
    const background = labelBackgroundOf(get, first);
    groups.push([
      <ColorPicker key="color" label="Line color" colors={[...MARKER_COLORS.filter(entry => entry.id !== 'white'), ...SHAPE_COLORS.filter(entry => entry.id === 'grey')]} value={color} round onPick={hex => setColor(store, objects, hex, 'Line color')}
        extra={background === null ? undefined : (
          <button type="button" className="bd-palette-switch" aria-pressed={background} onClick={() => setLabelBackground(store, objects, !background)}>Label background</button>
        )} />,
      <WeightPicker key="weight" value={weightOf(get, first)} dashed={isDashed(get, first)} onPick={style => setConnectorStyle(store, objects, style)} />,
    ]);
    if (texts.length) groups.push(textGroup(true));
  } else if (only(kinds, 'section')) {
    groups.push([<ColorPicker key="color" label="Section color" colors={SECTION_COLORS} value={color} round onPick={hex => setColor(store, objects, hex, 'Section color')} />]);
    if (objects.length === 1) groups.push([
      <ContextButton key="fit" label="Fit to contents" onClick={() => runCommand('board.section-fit', context())}><BdFit size={20} /></ContextButton>,
      <SectionTemplates key="templates" store={store} sectionId={first.id} />,
    ]);
    // FigJam's "Hide section": what it holds goes out of sight (and out of reach) until shown again.
    const hidden = objects.every(object => !!sectionFlags(object).hidden);
    groups.push([<ContextButton key="hide" label={hidden ? 'Show contents' : 'Hide contents'} pressed={hidden} onClick={() => setSectionFlag(store, objects, 'hidden', !hidden)}>{hidden ? <BdEyeOff size={20} /> : <BdEye size={20} />}</ContextButton>]);
  } else if (only(kinds, 'table')) {
    // The cell being typed in, or every cell of the selected table (FigJam colours what is selected).
    const editingCell = (() => {
      const editing = store.getState().editing;
      const at = editing ? cellPosition(get, editing.id) : null;
      return at && at.tableId === first.id ? get(get(first.children?.[at.row])?.children?.[at.column])?.id ?? null : null;
    })();
    const cells = tableCells(get, first, editingCell);
    groups.push([<ColorPicker key="cells" label="Cell color" colors={SHAPE_COLORS.filter(entry => entry.id !== 'black')} value={cellColorOf(cells)} round onPick={hex => setCellColor(store, cells, hex)} />]);
    groups.push([
      <ContextButton key="row" label="Add row" onClick={() => runCommand('board.table-row-add', context())}><BdRowAdd size={20} /></ContextButton>,
      <ContextButton key="column" label="Add column" onClick={() => runCommand('board.table-column-add', context())}><BdColumnAdd size={20} /></ContextButton>,
    ]);
    // FigJam's "Merge cells", for the cell being typed in.
    if (editingCell) {
      const merge: ReactNode[] = [];
      for (const [id, label, Icon] of [['board.table-merge-right', 'Merge with the cell to the right', BdMergeRight], ['board.table-merge-down', 'Merge with the cell below', BdMergeDown], ['board.table-unmerge', 'Unmerge cells', BdUnmerge]] as const) {
        const command = getCommand(id);
        if (command && isEnabled(command, context())) merge.push(<ContextButton key={id} label={label} onClick={() => runCommand(id, context())}><Icon size={20} /></ContextButton>);
      }
      if (merge.length) groups.push(merge);
    }
    groups.push(textGroup(false));
    groups.push([<AlignPicker key="align" value={alignOf(get, first)} onPick={align => setAlign(store, objects, align)} />]);
  } else if (only(kinds, 'stroke')) {
    groups.push([<ColorPicker key="color" label="Color" colors={MARKER_COLORS} value={color} round onPick={hex => setColor(store, objects, hex)} />]);
  } else if (only(kinds, 'text')) {
    groups.push([<ColorPicker key="color" label="Text color" colors={MARKER_COLORS} value={color} round onPick={hex => setColor(store, objects, hex, 'Text color')} />]);
    groups.push(textGroup(true));
    // FigJam's "Start a mind map" on a text (help.figma.com "Create mindmaps in FigJam"): before the alignment as in its picture; its first branch, open for typing.
    if (objects.length === 1) groups.push([<ContextButton key="mind" label="Start mind map" onClick={() => runCommand('board.mind-child', context())}><BdMindMap size={20} /></ContextButton>]);
    groups.push([<AlignPicker key="align" value={alignOf(get, first)} onPick={align => setAlign(store, objects, align)} />]);
  }
  // Several objects: "Arrange" lays them out as a tidy grid; several stickies sort.
  const many: ReactNode[] = [];
  // Several objects: FigJam's six alignments and even spacing (help.figma.com "Select, move, and order objects in FigJam").
  if (objects.length > 1) many.push(<ArrangeMenu key="arrange" context={context} />);
  if (objects.length > 1 && !kinds.has('connector') && !kinds.has('section')) many.push(<ContextButton key="tidy" label="Tidy up" onClick={() => runCommand('arrange.tidy-up', context())}><BdTidy size={20} /></ContextButton>);
  if (kinds.has('sticky') && objects.filter(isSticky).length > 1) {
    many.push(<SortMenu key="sort" context={context} />);
  }
  if (many.length) groups.push(many);
  groups.push([<MoreMenu key="more" store={store} objects={objects} get={get} context={context} kinds={kinds} />]);
  return <>{groups.filter(group => group.length).map((group, i) => <div key={i} className="bd-context-group">{group}</div>)}</>;
}

const swatchHex = (color: {r: number; g: number; b: number}) => '#' + [color.r, color.g, color.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

function ColorPicker({label, colors, value, onPick, onNone, round, outline, extra}: {label: string; colors: readonly {id: string; label: string; hex: string}[]; value: string | null; onPick: (hex: string) => void; onNone?: () => void; round?: boolean; outline?: boolean; extra?: ReactNode}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useTooltip(open ? null : {label, placement: 'top'});
  return (
    <>
      <button ref={button} type="button" className={`bd-context-color ${outline ? 'is-outline' : ''} ${value ? '' : 'is-none'}`.trim()} aria-label={label} aria-haspopup="dialog" aria-expanded={open} {...tip}
        onClick={() => setOpen(current => !current)}>
        <span style={{'--bd-swatch': value ?? 'transparent'} as React.CSSProperties} />
      </button>
      {open && button.current && (
        <Popover anchor={button.current} placement="top" offset={10} aria-label={label} className="bd-palette-popover" onClose={() => setOpen(false)}>
          <div className={`bd-palette ${round ? 'is-round' : ''}`.trim()}>
            {onNone && (
              <button type="button" className={`bd-swatch is-m is-none ${value === null ? 'is-selected' : ''}`.trim()} aria-label="No stroke" aria-pressed={value === null} onClick={() => {onNone(); setOpen(false);}} />
            )}
            {colors.map(color => (
              <button key={color.id} type="button" className={`bd-swatch is-m ${value?.toUpperCase() === color.hex.toUpperCase() ? 'is-selected' : ''}`.trim()} aria-label={color.label}
                aria-pressed={value?.toUpperCase() === color.hex.toUpperCase()} style={{'--bd-swatch': color.hex} as React.CSSProperties}
                onClick={() => {onPick(color.hex); setOpen(false);}} />
            ))}
          </div>
          {extra}
        </Popover>
      )}
    </>
  );
}

function ShapePicker({value, onPick}: {value: BoardShapeKind; onPick: (shape: BoardShapeKind) => void}) {
  const items = useCallback((): MenuItem[] => {
    const item = (shape: {id: BoardShapeKind; label: string}): MenuItem => ({
      id: shape.id, label: shape.label, icon: <ShapeGlyph shape={shape.id} fill="transparent" size={16} />, checked: shape.id === value, radio: true, onSelect: () => onPick(shape.id),
    });
    // FigJam's basic shapes, then its other flowchart figures.
    return [...BOARD_SHAPES.map(item), {type: 'separator'}, ...BOARD_FLOWCHART_SHAPES.map(item)];
  }, [value, onPick]);
  const menu = useMenuTrigger({items, label: 'Shape', placement: 'top-start', minWidth: 220});
  const tip = useTooltip(menu.open ? null : {label: 'Shape', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn is-wide" aria-label="Shape" {...tip} {...menu.triggerProps}><ShapeGlyph shape={value} fill="transparent" size={20} /></button>
      {menu.element}
    </>
  );
}

function Segments<T extends string>({label, options, value, onPick}: {label: string; options: readonly {id: T; label: string; icon?: BdIcon; text?: string}[]; value: T | null; onPick: (value: T) => void}) {
  return (
    <div className="bd-segments" role="group" aria-label={label}>
      {options.map(option => <Segment key={option.id} option={option} pressed={value === option.id} onPick={onPick} />)}
    </div>
  );
}
function Segment<T extends string>({option, pressed, onPick}: {option: {id: T; label: string; icon?: BdIcon; text?: string}; pressed: boolean; onPick: (value: T) => void}) {
  const tip = useTooltip({label: option.label, placement: 'top'});
  const Icon = option.icon;
  return (
    <button type="button" className={`bd-context-btn ${option.text ? 'is-text' : ''}`.trim()} aria-label={option.label} aria-pressed={pressed} {...tip} onClick={() => onPick(option.id)}>
      {Icon ? <Icon size={20} /> : option.text}
    </button>
  );
}

const LINE_OPTIONS = [
  {id: 'straight', label: 'Straight', icon: BdLineStraight},
  {id: 'elbow', label: 'Elbow', icon: BdLineElbow},
  {id: 'curved', label: 'Curved', icon: BdLineCurved},
] as const;
const LinePicker = ({value, onPick}: {value: ConnectorLine | null; onPick: (line: ConnectorLine) => void}) => <Segments label="Line type" options={LINE_OPTIONS} value={value} onPick={onPick} />;

/** A line with the point style at its start (left) or end (right), as the menu and the button show it. */
function EndGlyph({marker, side, size = 20}: {marker: StrokeMarker; side: ConnectorEndSide; size?: number}) {
  const tip = side === 'end' ? 16 : 4, dir = side === 'end' ? 1 : -1;
  const head = (() => {
    switch (marker) {
      case 'LINE_ARROW': return <path d={`M${tip - 5 * dir} 6.5L${tip} 10l${-5 * dir} 3.5`} fill="none" />;
      case 'TRIANGLE_ARROW': return <path d={`M${tip - 6 * dir} 6.5L${tip} 10l${-6 * dir} 3.5z`} fill="currentColor" />;
      case 'REVERSED_TRIANGLE': return <path d={`M${tip} 6.5L${tip - 6 * dir} 10l${6 * dir} 3.5z`} fill="currentColor" />;
      case 'DIAMOND': return <path d={`M${tip} 10l${-3.5 * dir} -3.5l${-3.5 * dir} 3.5l${3.5 * dir} 3.5z`} fill="currentColor" />;
      default: return null;
    }
  })();
  const lineEnd = marker === 'NONE' || marker === 'LINE_ARROW' ? tip : tip - (marker === 'DIAMOND' ? 7 : 6) * dir;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={side === 'end' ? `M3 10H${lineEnd}` : `M${lineEnd} 10H17`} fill="none" />
      {head}
    </svg>
  );
}

function EndPicker({side, value, onPick}: {side: ConnectorEndSide; value: StrokeMarker | null; onPick: (marker: StrokeMarker) => void}) {
  const label = side === 'start' ? 'Start point' : 'End point';
  const items = useCallback((): MenuItem[] => END_STYLES.map(style => ({
    id: style.marker, label: style.label, icon: <EndGlyph marker={style.marker} side={side} size={16} />, checked: value === style.marker, radio: true, onSelect: () => onPick(style.marker),
  })), [side, value, onPick]);
  const menu = useMenuTrigger({items, label, placement: 'top-start', minWidth: 200});
  const tip = useTooltip(menu.open ? null : {label, placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn" aria-label={label} {...tip} {...menu.triggerProps}><EndGlyph marker={value ?? 'NONE'} side={side} /></button>
      {menu.element}
    </>
  );
}

function WeightPicker({value, dashed, onPick}: {value: ConnectorWeight | null; dashed: boolean; onPick: (style: {weight?: ConnectorWeight; dashed?: boolean}) => void}) {
  const items = useCallback((): MenuItem[] => [
    {id: 'thin', label: 'Thin', checked: value === 'thin', radio: true, onSelect: () => onPick({weight: 'thin'})},
    {id: 'medium', label: 'Medium', checked: value === 'medium', radio: true, onSelect: () => onPick({weight: 'medium'})},
    {id: 'thick', label: 'Thick', checked: value === 'thick', radio: true, onSelect: () => onPick({weight: 'thick'})},
    {type: 'separator'},
    {id: 'dashed', label: 'Dashed', checked: dashed, onSelect: () => onPick({dashed: !dashed})},
  ], [value, dashed, onPick]);
  const menu = useMenuTrigger({items, label: 'Weight and dashes', placement: 'top-start', minWidth: 180});
  const tip = useTooltip(menu.open ? null : {label: 'Weight and dashes', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn" aria-label="Weight and dashes" {...tip} {...menu.triggerProps}><BdDashed size={20} /></button>
      {menu.element}
    </>
  );
}


const ALIGN_OPTIONS = [
  {id: 'LEFT', label: 'Align left', icon: BdAlignLeft},
  {id: 'CENTER', label: 'Align center', icon: BdAlignCenter},
  {id: 'RIGHT', label: 'Align right', icon: BdAlignRight},
] as const;
const AlignPicker = ({value, onPick}: {value: string | null; onPick: (align: 'LEFT' | 'CENTER' | 'RIGHT') => void}) => (
  <Segments label="Alignment" options={ALIGN_OPTIONS} value={(value as 'LEFT' | 'CENTER' | 'RIGHT' | null) ?? null} onPick={onPick} />
);

const ARRANGE_ITEMS: readonly ({id: string; label: string} | '-')[] = [
  {id: 'arrange.align-left', label: 'Align left'},
  {id: 'arrange.align-center-h', label: 'Align horizontal centers'},
  {id: 'arrange.align-right', label: 'Align right'},
  '-',
  {id: 'arrange.align-top', label: 'Align top'},
  {id: 'arrange.align-center-v', label: 'Align vertical centers'},
  {id: 'arrange.align-bottom', label: 'Align bottom'},
  '-',
  {id: 'arrange.distribute-h', label: 'Distribute horizontal spacing'},
  {id: 'arrange.distribute-v', label: 'Distribute vertical spacing'},
];

function ArrangeMenu({context}: {context: () => CommandContext}) {
  const items = useCallback((): MenuItem[] => ARRANGE_ITEMS.map(item => (item === '-' ? {type: 'separator'} as MenuItem : {
    id: item.id, label: item.label, disabled: !isEnabled(getCommand(item.id)!, context()), onSelect: () => void runCommand(item.id, context()),
  })), [context]);
  const menu = useMenuTrigger({items, label: 'Align', placement: 'top-start', minWidth: 240});
  const tip = useTooltip(menu.open ? null : {label: 'Align', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn" aria-label="Align" {...tip} {...menu.triggerProps}><BdAlignObjects size={20} /></button>
      {menu.element}
    </>
  );
}

/** FigJam's "Templates" beside a section's title: a template's content placed in the section. */
function SectionTemplates({store, sectionId}: {store: DesignStore; sectionId: NodeId}) {
  const items = useCallback((): MenuItem[] => BOARD_TEMPLATES.map(template => ({
    id: template.id, label: template.name, onSelect: () => void fillSection(store, sectionId, template.id, `Template "${template.name}"`),
  })), [store, sectionId]);
  const menu = useMenuTrigger({items, label: 'Template in section', placement: 'top-start', minWidth: 220});
  const tip = useTooltip(menu.open ? null : {label: 'Template in section', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn is-text" aria-label="Template in section" {...tip} {...menu.triggerProps}>Templates</button>
      {menu.element}
    </>
  );
}

function SortMenu({context}: {context: () => CommandContext}) {
  const items = useCallback((): MenuItem[] => [
    {id: 'color', label: 'By color', onSelect: () => void runCommand('board.sort-color', context())},
    {id: 'author', label: 'By author', onSelect: () => void runCommand('board.sort-author', context())},
  ], [context]);
  const menu = useMenuTrigger({items, label: 'Sort stickies', placement: 'top-start', minWidth: 180});
  const tip = useTooltip(menu.open ? null : {label: 'Sort stickies', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn" aria-label="Sort stickies" {...tip} {...menu.triggerProps}><BdSort size={20} /></button>
      {menu.element}
    </>
  );
}

function MoreMenu({store, objects, get, context, kinds}: {store: DesignStore; objects: SceneNode[]; get: (id: NodeId | null | undefined) => SceneNode | undefined; context: () => CommandContext; kinds: ReadonlySet<BoardSelectionKind>}) {
  const items = useCallback((): MenuItem[] => {
    const run = (id: string) => () => void runCommand(id, context());
    const out: MenuItem[] = [];
    if (only(kinds, 'sticky')) {
      const wide = objects.every(isWideSticky);
      out.push({id: 'wide', label: 'Wide sticky', checked: wide, onSelect: () => setStickyWide(store, objects, !wide)});
    }
    if (only(kinds, 'sticky', 'shape')) {
      const align = alignOf(get, objects[0]);
      out.push({type: 'submenu', id: 'align', label: 'Text alignment', items: ALIGN_OPTIONS.map(option => ({id: 'align-' + option.id, label: option.label, checked: align === option.id, radio: true, onSelect: () => setAlign(store, objects, option.id)}))});
    }
    if (out.length) out.push({type: 'separator'});
    out.push(
      {id: 'duplicate', label: 'Duplicate', shortcut: 'Mod+KeyD', onSelect: run('duplicate')},
      {id: 'front', label: 'Bring to front', shortcut: 'Mod+Alt+BracketRight', onSelect: run('bring-to-front')},
      {id: 'back', label: 'Send to back', shortcut: 'Mod+Alt+BracketLeft', onSelect: run('send-to-back')},
    );
    if (kinds.has('connector')) out.push({id: 'label', label: 'Label', onSelect: run('board.connector-label')});
    // A reshaped connector (its waypoints) goes back to its own route.
    if (objects.some(object => object.board?.kind === 'connector' && !!object.board.points?.length)) {
      out.push({id: 'route', label: 'Reset bends', onSelect: () => store.transact('Reset bends', tx => {
        for (const object of objects) {
          const node = tx.get(object.id);
          if (node?.board?.kind !== 'connector' || !node.board.points) continue;
          const {points: _points, ...rest} = node.board;
          tx.update(node.id, {board: rest});
        }
      })});
    }
    if (kinds.has('table')) out.push({type: 'separator'}, {id: 'row-remove', label: 'Delete row', onSelect: run('board.table-row-remove')}, {id: 'column-remove', label: 'Delete column', onSelect: run('board.table-column-remove')});
    out.push({type: 'separator'}, {id: 'lock', label: 'Lock', onSelect: () => setLocked(store, objects, true)});
    // FigJam's "Lock background only": the section stays put while what it holds can still be moved and edited.
    if (kinds.has('section') && objects.every(object => object.type === 'SECTION')) {
      const locked = objects.every(object => !!sectionFlags(object).backgroundLocked);
      out.push({id: 'lock-background', label: 'Lock background only', checked: locked, onSelect: () => setSectionFlag(store, objects, 'backgroundLocked', !locked)});
    }
    out.push({id: 'delete', label: 'Delete', shortcut: 'Backspace', danger: true, onSelect: run('delete')});
    return out;
  }, [store, objects, get, context, kinds]);
  const menu = useMenuTrigger({items, label: 'More', placement: 'top-end', minWidth: 220});
  const tip = useTooltip(menu.open ? null : {label: 'More', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn" aria-label="More" {...tip} {...menu.triggerProps}><BdMore size={20} /></button>
      {menu.element}
    </>
  );
}
