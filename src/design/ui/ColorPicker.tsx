import '../styles/color-picker.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import {isTypingTarget} from './shortcuts';
import {isPickingColor} from '../engine/eyedropper';
import {rotateCrop} from '../engine/tools/image-crop';
import type {BlendMode, GradientPaint, ImagePaint, ImageScaleMode, Paint, RGB} from '../../../shared/design/types';
import {
  COLOR_FORMATS, clamp01, formatCss, hslFields, hsvFields, hsvToRgb, hslToRgb, parseCssColor, parseHex, percent, rgbToHsl, rgbToHsv, sameRgb, toHex,
  type ColorFormat, type HSV,
} from '../panels/design/paint/color';
import {
  GRADIENT_TYPES, PAINT_KIND_LABELS, addStop, convertPaint, flipGradient, gradientCss, isGradient, removeStop, rgbaCss, rotateGradient, stopOrder, updateStop, type PaintKind,
} from '../panels/design/paint/paints';
import type {ColorUse} from '../panels/design/paint/selection-colors';
import {CONTRAST_TARGETS, contrastRatio, formatRatio, nearestCompliant, type ContrastCategory} from '../panels/design/paint/contrast';
import {Button, IconButton} from './Button';
import {
  IconBlend, IconClose, IconCrop, IconEyedropper, IconImage, IconMinus, IconPaintGradient, IconPaintSolid, IconPlus, IconRotate, IconSwap,
} from './icons';
import {Portal} from './layer';
import {NumberField} from './NumberField';
import {placeFloating, rectOf, viewportSize, type Placed, type Placement, type Rect} from './position';
import {useMenuTrigger} from './Menu';
import type {MenuItem} from './menu-model';
import {Select, type SelectEntry} from './Select';
import {Slider} from './Slider';
import {TextInput} from './TextInput';
import {useTooltip} from './Tooltip';

// The colour picker of "Fill", "Stroke", shadows and the page background, after Figma UI3: tabs
// "Custom" / "Libraries", the paint kind (solid, gradient, picture), a saturation–brightness area with
// hue and alpha sliders, an eyedropper, the colour as HEX/RGB/CSS/HSL/HSB, and the file's own colours.
// Gradients get a stops bar and a stops list; pictures get the scale mode and adjustments.
//
// The picker holds no document state: it shows `paint` and reports a whole new paint through
// `onChange`. A drag (area, sliders, stops, scrubbing) is wrapped in onGestureStart/onGestureEnd, so
// the owner commits it as one undo step and coalesces frames; the area keeps its own HSB so hue
// survives black and grey.

// ── Floating panel ───────────────────────────────────────────────────────────────────────────────

/** Panels open now, outermost first: a press inside a later (nested) one is not "outside" an earlier one. */
const openPanels: HTMLElement[] = [];

export type FloatingPanelProps = {
  anchor: Element | Rect;
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  'aria-label': string;
  className?: string;
  /** Re-place when this changes (content that grows). */
  layoutKey?: unknown;
  /** Presses on these are not outside (the canvas under a gradient being edited). */
  ignoreOutside?: (target: Element) => boolean;
  /** The element that opened the panel and toggles it (an anchor element is one already). */
  trigger?: Element | null;
  children: ReactNode;
};

/** A floating panel like ui/Popover, which nests (a picker opened from an effect's settings) and
 *  lets its owner keep it open for presses on the canvas. */
export function FloatingPanel({anchor, onClose, placement = 'left-start', offset = 8, className = '', layoutKey, ignoreOutside, trigger: triggerElement, children, ...aria}: FloatingPanelProps) {
  const element = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ignoreRef = useRef(ignoreOutside);
  ignoreRef.current = ignoreOutside;

  useLayoutEffect(() => {
    const panel = element.current;
    if (!panel) return;
    const rect = anchor instanceof Element ? rectOf(anchor) : anchor;
    const next = placeFloating(rect, {width: panel.offsetWidth, height: panel.offsetHeight}, viewportSize(), placement, offset);
    setPlaced(previous => (previous && previous.x === next.x && previous.y === next.y && previous.origin === next.origin ? previous : next));
  }, [anchor, placement, offset, layoutKey]);

  // The control that opened the panel (the swatch pressed in the trigger row): Escape gives focus back
  // to it, so the keyboard carries on from there. Space stays the canvas's (CanvasView pans while it is
  // held and keeps it from pressing a focused button), so a designer's Space-drag never reopens it.
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null) opener.current = openerOf(triggerElement ?? (anchor instanceof Element ? anchor : null));
  const byKey = useRef(false);
  const close = (key: boolean) => {
    byKey.current = key;
    onCloseRef.current();
  };
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!placed || focusedOnce.current) return;
    focusedOnce.current = true;
    element.current?.focus({preventScroll: true});
  }, [placed]);
  useEffect(() => () => {
    const back = opener.current;
    const focused = document.activeElement;
    // Only after Escape, and only when focus was left with nowhere to be (it was in the panel).
    if (byKey.current && back?.isConnected && (!focused || focused === document.body || element.current?.contains(focused))) back.focus({preventScroll: true});
  }, []);

  useEffect(() => {
    const panel = element.current;
    if (!panel) return;
    openPanels.push(panel);
    const trigger = triggerElement ?? (anchor instanceof Element ? anchor : null);
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      if (!target || panel.contains(target) || trigger?.contains(target) || target.closest?.('[data-dz-menu]')) return;
      const depth = openPanels.indexOf(panel);
      if (openPanels.slice(depth + 1).some(inner => inner.contains(target))) return;
      if (ignoreRef.current?.(target)) return;
      close(false);
    };
    // Escape with the focus outside every field (after a click on the canvas, a field blurred by its
    // own Escape) closes the top panel only, before the canvas sees the key.
    const escape = (event: globalThis.KeyboardEvent) => {
      // A pipette in progress takes Escape first (it cancels the pick, the picker stays).
      if (event.key !== 'Escape' || event.defaultPrevented || isPickingColor() || openPanels[openPanels.length - 1] !== panel) return;
      if (panel.contains(event.target as Node) || isTypingTarget(event.target) || (event.target as Element | null)?.closest?.('[data-dz-menu]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside, true);
      const index = openPanels.indexOf(panel);
      if (index >= 0) openPanels.splice(index, 1);
    };
  }, [anchor, triggerElement]);

  return (
    <Portal>
      <div ref={element} role="dialog" aria-label={aria['aria-label']} tabIndex={-1} className={`dz-popover dz-float ${className}`.trim()}
        style={(placed ? {left: placed.x, top: placed.y, '--dz-origin': placed.origin, maxHeight: placed.maxHeight} : {visibility: 'hidden'}) as CSSProperties}
        onKeyDown={event => {
          // During a pipette pick Escape goes on to the canvas tool, which cancels the pick.
          if (event.key === 'Escape' && !isPickingColor()) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
            // Keys pressed in a picker never reach the canvas (they would delete or enter the layer).
            event.stopPropagation();
          }
        }}>
        <div className="dz-popover-body">{children}</div>
      </div>
    </Portal>
  );
}

/** The control a panel was opened from: the focused element inside the trigger (a pressed swatch keeps
 *  focus in Chromium), else the trigger's own button, else the trigger when it takes focus itself. */
function openerOf(trigger: Element | null): HTMLElement | null {
  if (!(trigger instanceof HTMLElement)) return null;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body && trigger.contains(focused)) return focused;
  if (trigger.matches('button, [tabindex]:not([tabindex="-1"])')) return trigger;
  return trigger.querySelector<HTMLElement>('button[aria-expanded], button:not(:disabled)');
}

/** The rectangle a picker opens beside: the left edge of the panel (or of the floating panel) the row
 *  is in, at the row's height, as Figma opens pickers next to the properties panel, not over it. */
export function besidePanel(element: Element): Rect {
  const row = element.getBoundingClientRect();
  const panel = element.closest('.dz-float, .dz-side-panel')?.getBoundingClientRect();
  if (!panel) return {x: row.left, y: row.top, width: row.width, height: row.height};
  return {x: panel.left, y: row.top, width: 0, height: row.height};
}

// ── The picker ───────────────────────────────────────────────────────────────────────────────────

export type ImageServices = {
  /** A URL the browser can show (the asset's same-origin /uploads URL). */
  url(ref: string): string | null;
  /** Uploads a picture and resolves to its ref (null when the upload failed; the owner says why). */
  upload(file: File): Promise<string | null>;
};

export type ColorPickerProps = {
  anchor: Element | Rect;
  onClose: () => void;
  'aria-label': string;
  paint: Paint;
  onChange: (paint: Paint) => void;
  /** A drag begins: the owner opens one undo step for everything until onGestureEnd. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  /** 'solid': shadows, the page background, gradient stops edited on their own. */
  kinds?: 'all' | 'solid';
  /** Off for colours without alpha (the page background). */
  alpha?: boolean;
  /** Gradients: the selected stop, shared with the canvas handles. */
  stop?: number;
  onStopChange?: (index: number) => void;
  images?: ImageServices;
  /** Swatches under the colour: the file's colours, most used first. */
  documentColors?: () => ColorUse[];
  /** "Libraries": styles and variables, rendered by the owner. Absent: no tabs. */
  libraries?: ReactNode;
  /** A variable the colour is bound to: shown instead of the hex, with "Detach". */
  boundVariable?: {name: string; onDetach: () => void} | null;
  /** Picks a colour from the screen (pipette); absent hides the button. */
  onEyedropper?: () => Promise<RGB | null>;
  /** "Crop": the owner starts cropping on the canvas. */
  onCrop?: () => void;
  /** The colour behind the layer and what it is judged as: a "Contrast" toggle shows the WCAG ratio and AA/AAA. */
  contrast?: {behind: RGB; category: ContrastCategory} | null;
  /** "+" in the header (Figma's "Create style"): saves the paint as a colour style. Absent: no button. */
  onCreateStyle?: () => void;
  /** A title over the content (a style being edited). */
  title?: string;
  placement?: Placement;
  ignoreOutside?: (target: Element) => boolean;
  trigger?: Element | null;
  initialTab?: 'custom' | 'libraries';
  /** The node's size: ↻ turns a gradient in its pixels, so a wide box keeps the shape. */
  box?: {width: number; height: number};
};

const FORMAT_KEY = 'dz-color-format';
function storedFormat(): ColorFormat {
  try {
    const value = localStorage.getItem(FORMAT_KEY);
    return COLOR_FORMATS.some(format => format.value === value) ? (value as ColorFormat) : 'HEX';
  } catch {
    return 'HEX';
  }
}
function storeFormat(format: ColorFormat) {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Private windows: the format is only remembered for this session.
  }
}

/** The colour the area edits: the solid's colour (alpha = paint opacity) or the selected stop's. */
function editedColor(paint: Paint, stop: number): {color: RGB; alpha: number} | null {
  if (paint.type === 'SOLID') return {color: paint.color, alpha: paint.opacity};
  if (isGradient(paint)) {
    const s = paint.gradientStops[stop] ?? paint.gradientStops[0];
    return s ? {color: {r: s.color.r, g: s.color.g, b: s.color.b}, alpha: s.color.a} : null;
  }
  return null;
}

/** The paint with the edited colour replaced. */
function withColor(paint: Paint, stop: number, color: RGB, alpha: number): Paint {
  if (paint.type === 'SOLID') {
    const next = {...paint, color: {r: color.r, g: color.g, b: color.b}, opacity: clamp01(alpha)};
    delete next.boundVariables;
    return next;
  }
  if (isGradient(paint)) {
    const index = paint.gradientStops[stop] ? stop : 0;
    return updateStop(paint, index, {color: {r: color.r, g: color.g, b: color.b, a: clamp01(alpha)}});
  }
  return paint;
}

const KIND_TABS: {kind: 'SOLID' | 'GRADIENT' | 'IMAGE'; label: string; icon: ReactNode}[] = [
  {kind: 'SOLID', label: 'Solid', icon: <IconPaintSolid />},
  {kind: 'GRADIENT', label: 'Gradient', icon: <IconPaintGradient />},
  {kind: 'IMAGE', label: 'Image', icon: <IconImage />},
];

const GRADIENT_OPTIONS: SelectEntry<GradientPaint['type']>[] = GRADIENT_TYPES.map(type => ({value: type, label: PAINT_KIND_LABELS[type]}));

export const BLEND_MODES: SelectEntry<BlendMode>[] = [
  {value: 'NORMAL', label: 'Normal'}, {separator: true},
  {value: 'DARKEN', label: 'Darken'}, {value: 'MULTIPLY', label: 'Multiply'}, {value: 'COLOR_BURN', label: 'Color burn'}, {separator: true},
  {value: 'LIGHTEN', label: 'Lighten'}, {value: 'SCREEN', label: 'Screen'}, {value: 'COLOR_DODGE', label: 'Color dodge'}, {separator: true},
  {value: 'OVERLAY', label: 'Overlay'}, {value: 'SOFT_LIGHT', label: 'Soft light'}, {value: 'HARD_LIGHT', label: 'Hard light'}, {separator: true},
  {value: 'DIFFERENCE', label: 'Difference'}, {value: 'EXCLUSION', label: 'Exclusion'}, {separator: true},
  {value: 'HUE', label: 'Hue'}, {value: 'SATURATION', label: 'Saturation'}, {value: 'COLOR', label: 'Color'}, {value: 'LUMINOSITY', label: 'Luminosity'},
];

export function ColorPicker(props: ColorPickerProps) {
  const {paint, onChange, onGestureStart, onGestureEnd, kinds = 'all', alpha = true, images, libraries, title} = props;
  const [tab, setTab] = useState<'custom' | 'libraries'>(props.initialTab ?? 'custom');
  const [checking, setChecking] = useState(false);
  const [ownStop, setOwnStop] = useState(0);
  const stop = props.stop ?? ownStop;
  const selectStop = useCallback((index: number) => {
    setOwnStop(index);
    props.onStopChange?.(index);
  }, [props.onStopChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const kindTab = paint.type === 'SOLID' ? 'SOLID' : paint.type === 'IMAGE' ? 'IMAGE' : 'GRADIENT';
  const switchKind = (kind: PaintKind) => {
    if (kind === paint.type) return;
    onChange(convertPaint(paint, kind));
    if (kind !== 'SOLID' && kind !== 'IMAGE') selectStop(0);
  };

  const layoutKey = `${tab}:${kindTab}:${isGradient(paint) ? paint.gradientStops.length : 0}:${paint.type === 'IMAGE' ? paint.scaleMode : ''}`;
  return (
    <FloatingPanel anchor={props.anchor} onClose={props.onClose} aria-label={props['aria-label']} className="dz-cp" layoutKey={layoutKey}
      placement={props.placement ?? 'left-start'} ignoreOutside={props.ignoreOutside} trigger={props.trigger}>
      <div className="dz-cp-header">
        {libraries ? (
          <div className="dz-cp-tabs" role="tablist" aria-label="Color source">
            <button type="button" role="tab" aria-selected={tab === 'custom'} className="dz-tab" onClick={() => setTab('custom')}>Custom</button>
            <button type="button" role="tab" aria-selected={tab === 'libraries'} className="dz-tab" onClick={() => setTab('libraries')}>Libraries</button>
          </div>
        ) : <h2 className="dz-cp-title">{title ?? props['aria-label']}</h2>}
        {props.onCreateStyle && <IconButton label="Create color style" onClick={props.onCreateStyle}><IconPlus /></IconButton>}
        <IconButton label="Close" onClick={props.onClose} tooltip={false}><IconClose /></IconButton>
      </div>
      {libraries && title && <div className="dz-cp-subtitle">{title}</div>}
      {tab === 'libraries' && libraries ? (
        <div className="dz-cp-libraries">{libraries}</div>
      ) : (
        <>
          {kinds === 'all' && (
            <div className="dz-cp-kinds">
              <div className="dz-cp-kind-tabs" role="radiogroup" aria-label="Fill type">
                {KIND_TABS.map(item => (
                  <KindButton key={item.kind} label={item.label} checked={kindTab === item.kind}
                    onSelect={() => switchKind(item.kind === 'GRADIENT' ? (isGradient(paint) ? paint.type : 'GRADIENT_LINEAR') : item.kind)}>
                    {item.icon}
                  </KindButton>
                ))}
              </div>
              <div className="dz-cp-kind-actions">
                <BlendButton value={paint.blendMode === 'PASS_THROUGH' ? 'NORMAL' : paint.blendMode} onChange={blendMode => onChange({...paint, blendMode})} />
                {props.contrast && paint.type === 'SOLID' && (
                  <IconButton label="Check contrast" pressed={checking} onClick={() => setChecking(value => !value)}><IconContrast /></IconButton>
                )}
              </div>
            </div>
          )}
          {isGradient(paint) && (
            <GradientControls paint={paint} stop={stop} box={props.box} onSelectStop={selectStop} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
          )}
          {paint.type === 'IMAGE' ? (
            <ImageControls paint={paint} box={props.box} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} images={images} onCrop={props.onCrop} />
          ) : (
            <ColorControls paint={paint} stop={stop} alpha={alpha} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd}
              documentColors={props.documentColors} boundVariable={props.boundVariable} onEyedropper={props.onEyedropper}
              contrast={checking && paint.type === 'SOLID' ? props.contrast ?? null : null} />
          )}
          {isGradient(paint) && (
            <StopsList paint={paint} stop={stop} onSelectStop={selectStop} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
          )}
        </>
      )}
    </FloatingPanel>
  );
}

/** The droplet at the end of the kinds row, as Figma's picker: the paint's blend modes in a menu, the current one in the
 *  tooltip. */
function BlendButton({value, onChange}: {value: BlendMode; onChange: (mode: BlendMode) => void}) {
  const items = useCallback((): MenuItem[] => BLEND_MODES.map((entry): MenuItem => ('value' in entry
    ? {id: entry.value, label: entry.label, checked: entry.value === value, radio: true, onSelect: () => onChange(entry.value)}
    : {type: 'separator'})), [value, onChange]);
  const menu = useMenuTrigger({items, label: 'Blend mode', minWidth: 200, placement: 'bottom-end'});
  const current = BLEND_MODES.find((entry): entry is {value: BlendMode; label: string} => 'value' in entry && entry.value === value)?.label ?? '';
  const tip = useTooltip(menu.open ? null : {label: `Blend mode: ${current}`});
  return (
    <>
      <button type="button" className="dz-icon-btn is-24 is-panel dz-cp-blend" aria-label="Blend mode" aria-description={current} {...tip} {...menu.triggerProps}>
        <IconBlend />
      </button>
      {menu.element}
    </>
  );
}

function KindButton({label, checked, onSelect, children}: {label: string; checked: boolean; onSelect: () => void; children: ReactNode}) {
  const tip = useTooltip({label});
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={label} className="dz-cp-kind" onClick={onSelect} {...tip}>{children}</button>
  );
}

// ── Colour: area, sliders, fields, swatches ─────────────────────────────────────────────────────

type GestureProps = {onGestureStart?: () => void; onGestureEnd?: () => void};

function ColorControls({paint, stop, alpha, onChange, onGestureStart, onGestureEnd, documentColors, boundVariable, onEyedropper, contrast}: GestureProps & {
  contrast?: {behind: RGB; category: ContrastCategory} | null;
  paint: Paint;
  stop: number;
  alpha: boolean;
  onChange: (paint: Paint) => void;
  documentColors?: () => ColorUse[];
  boundVariable?: {name: string; onDetach: () => void} | null;
  onEyedropper?: () => Promise<RGB | null>;
}) {
  const current = editedColor(paint, stop) ?? {color: {r: 0, g: 0, b: 0}, alpha: 1};
  // The area's own HSB: converting back from RGB would lose the hue at grey and the saturation at black.
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(current.color));
  const shown = useRef(hsv);
  shown.current = hsv;
  useEffect(() => {
    if (!sameRgb(hsvToRgb(shown.current), current.color)) setHsv(previous => rgbToHsv(current.color, previous.h));
  }, [current.color.r, current.color.g, current.color.b]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new stop or paint shows its own colour.
  useEffect(() => {
    setHsv(previous => (sameRgb(hsvToRgb(previous), current.color) ? previous : rgbToHsv(current.color, previous.h)));
  }, [stop, paint.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useRef({paint, stop, alpha: current.alpha});
  latest.current = {paint, stop, alpha: current.alpha};
  const setColor = useCallback((next: HSV, nextAlpha = latest.current.alpha) => {
    setHsv(next);
    onChange(withColor(latest.current.paint, latest.current.stop, hsvToRgb(next), nextAlpha));
  }, [onChange]);
  const setRgb = (color: RGB, nextAlpha = current.alpha) => {
    const next = rgbToHsv(color, hsv.h);
    setHsv(next);
    onChange(withColor(paint, stop, color, nextAlpha));
  };

  // The model's own channels while they match what the area shows, so an alpha change never
  // nudges the colour through an HSB round trip.
  const fromArea = hsvToRgb(hsv);
  const rgb = sameRgb(fromArea, current.color) ? current.color : fromArea;
  const swatches = useMemo(() => documentColors?.() ?? [], [documentColors]);
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    if (!onEyedropper || picking) return;
    setPicking(true);
    try {
      const color = await onEyedropper();
      if (color) setRgb(color);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="dz-cp-color">
      <ColorArea hsv={hsv} onChange={setColor} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
      <div className="dz-cp-sliders">
        {onEyedropper && (
          <IconButton label="Eyedropper" shortcut="KeyI" pressed={picking} onClick={pick} className="dz-cp-eyedropper"><IconEyedropper /></IconButton>
        )}
        <div className="dz-cp-slider-stack">
          <Slider aria-label="Hue" value={Math.round(hsv.h)} min={0} max={360} trackBackground="linear-gradient(90deg, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%)"
            onChangeStart={onGestureStart} onChangeEnd={onGestureEnd} onChange={h => setColor({...shown.current, h})} valueText={`${Math.round(hsv.h)}°`} className="dz-cp-hue" />
          {alpha && (
            <Slider aria-label="Opacity" value={percent(current.alpha)} min={0} max={100} checker
              trackBackground={`linear-gradient(90deg, ${rgbaCss(rgb, 0)}, ${rgbaCss(rgb, 1)})`}
              onChangeStart={onGestureStart} onChangeEnd={onGestureEnd} onChange={value => setColor(shown.current, value / 100)} valueText={`${percent(current.alpha)}%`} className="dz-cp-alpha" />
          )}
        </div>
      </div>
      {boundVariable ? (
        <div className="dz-cp-variable">
          <span className="dz-cp-variable-chip" style={{'--dz-chip': rgbaCss(rgb, 1)} as CSSProperties}>{boundVariable.name}</span>
          <Button size={24} variant="ghost" onClick={boundVariable.onDetach}>Detach</Button>
        </div>
      ) : (
        <FormatFields rgb={rgb} hsv={hsv} alpha={alpha ? current.alpha : null}
          onRgb={(color, nextAlpha) => setRgb(color, nextAlpha ?? current.alpha)} onHsv={(next, nextAlpha) => setColor(next, nextAlpha ?? current.alpha)}
          onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
      )}
      {contrast && <ContrastRow color={rgb} behind={contrast.behind} category={contrast.category} onFix={color => setRgb(color)} />}
      {swatches.length > 0 && (
        <div className="dz-cp-swatches">
          <div className="dz-cp-caption">Colors in this file</div>
          <div className="dz-cp-swatch-grid">
            {swatches.map(use => (
              <SwatchButton key={use.key} color={use.color} opacity={use.opacity} onPick={() => setRgb(use.color, alpha ? use.opacity : current.alpha)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_LABELS: Record<ContrastCategory, string> = {'normal-text': 'Normal text', 'large-text': 'Large text', graphics: 'Graphics'};

/** Figma's contrast view under the fields: the colour behind, the ratio, and AA / AAA for the layer's kind of content; a
 *  level the colour misses is a button that moves the colour's brightness to the nearest one that meets it. */
function ContrastRow({color, behind, category, onFix}: {color: RGB; behind: RGB; category: ContrastCategory; onFix: (color: RGB) => void}) {
  const ratio = contrastRatio(color, behind);
  const targets = CONTRAST_TARGETS[category];
  const level = (name: 'AA' | 'AAA', target: number) => {
    const passes = ratio >= target;
    const fix = passes ? null : nearestCompliant(color, behind, target);
    return (
      <button type="button" className={`dz-cp-level ${passes ? 'is-pass' : 'is-fail'}`} disabled={passes || !fix}
        aria-label={passes ? `${name}: passes` : `${name}: fails, fix`} onClick={() => fix && onFix(fix)}>
        {name} {passes ? '✓' : '✕'}
      </button>
    );
  };
  return (
    <div className="dz-cp-contrast" role="group" aria-label="Contrast">
      <span className="dz-cp-contrast-behind" style={{'--dz-swatch': rgbaCss(behind, 1)} as CSSProperties} title={`Background ${toHex(behind)}`} />
      <span className="dz-cp-contrast-ratio">{formatRatio(ratio)}</span>
      <span className="dz-cp-contrast-category">{CATEGORY_LABELS[category]}</span>
      {level('AA', targets.aa)}
      {level('AAA', targets.aaa)}
    </div>
  );
}

/** Half a circle filled: contrast. */
function IconContrast() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 2.75a5.25 5.25 0 0 1 0 10.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SwatchButton({color, opacity, onPick}: {color: RGB; opacity: number; onPick: () => void}) {
  const label = `${toHex(color)}${opacity < 1 ? ` · ${percent(opacity)}%` : ''}`;
  const tip = useTooltip({label});
  return <button type="button" className="dz-cp-doc-swatch" aria-label={label} style={{'--dz-swatch': rgbaCss(color, opacity)} as CSSProperties} onClick={onPick} {...tip} />;
}

/** The saturation (→) and brightness (↑) area; arrows move by 1 %, Shift by 10 %. */
function ColorArea({hsv, onChange, onGestureStart, onGestureEnd}: GestureProps & {hsv: HSV; onChange: (hsv: HSV) => void}) {
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const fromPointer = (event: PointerEvent) => {
    const box = area.current!.getBoundingClientRect();
    return {h: hsvRef.current.h, s: clamp01((event.clientX - box.left) / Math.max(1, box.width)), v: clamp01(1 - (event.clientY - box.top) / Math.max(1, box.height))};
  };
  const keyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]};
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onChange({h: hsv.h, s: clamp01(hsv.s + move[0]), v: clamp01(hsv.v + move[1])});
  };
  const hue = hsvToRgb({h: hsv.h, s: 1, v: 1});
  return (
    <div ref={area} className="dz-cp-area" style={{'--dz-hue': rgbaCss(hue, 1), '--dz-x': hsv.s, '--dz-y': 1 - hsv.v, '--dz-thumb': rgbaCss(hsvToRgb(hsv), 1)} as CSSProperties}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = event.pointerId;
        (event.currentTarget.querySelector('[role="slider"]') as HTMLElement | null)?.focus({preventScroll: true});
        onGestureStart?.();
        onChange(fromPointer(event));
      }}
      onPointerMove={event => {
        if (dragging.current !== event.pointerId) return;
        onChange(fromPointer(event));
      }}
      onPointerUp={event => {
        if (dragging.current !== event.pointerId) return;
        dragging.current = null;
        onGestureEnd?.();
      }}
      onLostPointerCapture={() => {
        if (dragging.current === null) return;
        dragging.current = null;
        onGestureEnd?.();
      }}>
      <span role="slider" tabIndex={0} aria-label="Saturation and brightness" aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        aria-valuenow={Math.round(hsv.s * 100)} aria-valuemin={0} aria-valuemax={100} className="dz-cp-area-thumb" onKeyDown={keyDown} />
    </div>
  );
}

const FORMAT_OPTIONS: SelectEntry<ColorFormat>[] = COLOR_FORMATS.map(format => ({value: format.value, label: format.label}));

/** The colour as text in the chosen format, then the opacity. */
function FormatFields({rgb, hsv, alpha, onRgb, onHsv, onGestureStart, onGestureEnd}: GestureProps & {
  rgb: RGB;
  hsv: HSV;
  alpha: number | null;
  onRgb: (color: RGB, alpha?: number) => void;
  onHsv: (hsv: HSV, alpha?: number) => void;
}) {
  const [format, setFormat] = useState<ColorFormat>(storedFormat);
  const scrub = {onScrubStart: onGestureStart, onScrubEnd: () => onGestureEnd?.()};
  const channel = (key: 'r' | 'g' | 'b', label: string) => (
    <NumberField key={key} aria-label={label} value={Math.round(clamp01(rgb[key]) * 255)} min={0} max={255} precision={0} {...scrub}
      onChange={value => onRgb({...rgb, [key]: value / 255})} className="dz-cp-num" />
  );
  const hsl = rgbToHsl(rgb, hsv.h);
  const hslShown = hslFields(hsl), hsvShown = hsvFields(hsv);
  let fields: ReactNode;
  switch (format) {
    case 'HEX': fields = <HexInput rgb={rgb} onCommit={(color, a) => onRgb(color, alpha === null ? undefined : a ?? undefined)} />; break;
    case 'CSS': fields = <CssInput rgb={rgb} alpha={alpha ?? 1} onCommit={(color, a) => onRgb(color, alpha === null ? undefined : a ?? undefined)} />; break;
    case 'RGB': fields = <>{channel('r', 'Red')}{channel('g', 'Green')}{channel('b', 'Blue')}</>; break;
    case 'HSL':
      fields = (
        <>
          <NumberField aria-label="Hue" value={hslShown.h} min={0} max={360} precision={0} {...scrub} onChange={h => onRgb(hslToRgb({...hsl, h}))} className="dz-cp-num" />
          <NumberField aria-label="Saturation" value={hslShown.s} min={0} max={100} precision={0} {...scrub} onChange={s => onRgb(hslToRgb({...hsl, s: s / 100}))} className="dz-cp-num" />
          <NumberField aria-label="Lightness" value={hslShown.l} min={0} max={100} precision={0} {...scrub} onChange={l => onRgb(hslToRgb({...hsl, l: l / 100}))} className="dz-cp-num" />
        </>
      );
      break;
    case 'HSB':
      fields = (
        <>
          <NumberField aria-label="Hue" value={hsvShown.h} min={0} max={360} precision={0} {...scrub} onChange={h => onHsv({...hsv, h})} className="dz-cp-num" />
          <NumberField aria-label="Saturation" value={hsvShown.s} min={0} max={100} precision={0} {...scrub} onChange={s => onHsv({...hsv, s: s / 100})} className="dz-cp-num" />
          <NumberField aria-label="Brightness" value={hsvShown.v} min={0} max={100} precision={0} {...scrub} onChange={v => onHsv({...hsv, v: v / 100})} className="dz-cp-num" />
        </>
      );
      break;
  }
  return (
    <div className={`dz-cp-format is-${format.toLowerCase()} ${alpha === null ? 'no-alpha' : ''}`.trim()}>
      <Select<ColorFormat> value={format} options={FORMAT_OPTIONS} appearance="quiet" aria-label="Color format" className="dz-cp-format-select"
        onChange={next => {
          setFormat(next);
          storeFormat(next);
        }} />
      <div className="dz-cp-fields">
        {fields}
        {alpha !== null && format !== 'CSS' && (
          <NumberField aria-label="Opacity" value={percent(alpha)} min={0} max={100} precision={0} suffix="%" {...scrub}
            onChange={value => onRgb(rgb, value / 100)} className="dz-cp-num dz-cp-alpha-field" />
        )}
      </div>
    </div>
  );
}

function HexInput({rgb, onCommit}: {rgb: RGB; onCommit: (color: RGB, alpha: number | null) => void}) {
  const hex = toHex(rgb);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput aria-label="Color in HEX" value={draft ?? hex} className="dz-cp-hex" selectOnFocus maxLength={9}
      onFocus={() => setDraft(hex)} onBlur={() => setDraft(null)} onChange={setDraft}
      onCommit={text => {
        const parsed = parseHex(text);
        if (parsed) onCommit(parsed.color, parsed.alpha);
        setDraft(parsed ? toHex(parsed.color) : hex);
      }} />
  );
}

function CssInput({rgb, alpha, onCommit}: {rgb: RGB; alpha: number; onCommit: (color: RGB, alpha: number | null) => void}) {
  const css = formatCss(rgb, alpha);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput aria-label="Color in CSS" value={draft ?? css} className="dz-cp-css" selectOnFocus
      onFocus={() => setDraft(css)} onBlur={() => setDraft(null)} onChange={setDraft}
      onCommit={text => {
        const parsed = parseCssColor(text);
        if (parsed) onCommit(parsed.color, parsed.alpha);
        setDraft(parsed ? formatCss(parsed.color, parsed.alpha ?? alpha) : css);
      }} />
  );
}

// ── Gradients ─────────────────────────────────────────────────────────────────────────────────────

function GradientControls({paint, stop, box, onSelectStop, onChange, onGestureStart, onGestureEnd}: GestureProps & {
  paint: GradientPaint;
  stop: number;
  box?: {width: number; height: number};
  onSelectStop: (index: number) => void;
  onChange: (paint: Paint) => void;
}) {
  return (
    <div className="dz-cp-gradient">
      <div className="dz-cp-gradient-row">
        <Select<GradientPaint['type']> value={paint.type} options={GRADIENT_OPTIONS} aria-label="Gradient type" className="dz-cp-gradient-type"
          onChange={type => onChange(convertPaint(paint, type))} />
        <IconButton label="Flip gradient" onClick={() => onChange(flipGradient(paint))}><IconSwap /></IconButton>
        <IconButton label="Rotate 90°" onClick={() => onChange(rotateGradient(paint, box?.width ?? 1, box?.height ?? 1))}><IconRotate /></IconButton>
      </div>
      <StopsBar paint={paint} stop={stop} onSelectStop={onSelectStop} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
    </div>
  );
}

/** The gradient as a strip with its stops: click the strip to add one, drag a stop to move it,
 *  Backspace removes the focused one, arrows nudge it by 1 % (Shift 10 %). */
function StopsBar({paint, stop, onSelectStop, onChange, onGestureStart, onGestureEnd}: GestureProps & {
  paint: GradientPaint;
  stop: number;
  onSelectStop: (index: number) => void;
  onChange: (paint: Paint) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{pointer: number; index: number; base: GradientPaint; moved: boolean} | null>(null);
  const positionAt = (clientX: number) => {
    const box = bar.current!.getBoundingClientRect();
    return clamp01((clientX - box.left - 8) / Math.max(1, box.width - 16));
  };
  const begin = (event: PointerEvent, index: number, base: GradientPaint) => {
    event.preventDefault();
    bar.current?.setPointerCapture(event.pointerId);
    drag.current = {pointer: event.pointerId, index, base, moved: false};
    onSelectStop(index);
  };
  const finish = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.moved) onGestureEnd?.();
  };
  return (
    <div ref={bar} className="dz-cp-stops-bar"
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('.dz-cp-stop')) return;
        // A press on the strip adds a stop with the colour the gradient has there.
        const added = addStop(paint, positionAt(event.clientX));
        onGestureStart?.();
        onChange(added.paint);
        begin(event, added.index, added.paint);
        drag.current!.moved = true;
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (!current.moved) {
          current.moved = true;
          onGestureStart?.();
        }
        onChange(updateStop(current.base, current.index, {position: positionAt(event.clientX)}));
      }}
      onPointerUp={finish}
      onLostPointerCapture={finish}>
      <div className="dz-cp-stops-track" style={{'--dz-gradient': gradientCss(paint)} as CSSProperties} />
      {paint.gradientStops.map((each, index) => (
        <button key={index} type="button" className={`dz-cp-stop ${index === stop ? 'is-selected' : ''}`}
          aria-label={`Stop ${Math.round(each.position * 100)}%`} aria-pressed={index === stop}
          style={{'--dz-at': clamp01(each.position), '--dz-swatch': rgbaCss(each.color)} as CSSProperties}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.stopPropagation();
            begin(event, index, paint);
          }}
          onFocus={() => onSelectStop(index)}
          onKeyDown={event => {
            if ((event.key === 'Backspace' || event.key === 'Delete') && paint.gradientStops.length > 2) {
              event.preventDefault();
              onChange(removeStop(paint, index));
              onSelectStop(Math.max(0, index - 1));
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const step = (event.shiftKey ? 0.1 : 0.01) * (event.key === 'ArrowLeft' ? -1 : 1);
              onChange(updateStop(paint, index, {position: each.position + step}));
            }
          }} />
      ))}
    </div>
  );
}

function StopsList({paint, stop, onSelectStop, onChange, onGestureStart, onGestureEnd}: GestureProps & {
  paint: GradientPaint;
  stop: number;
  onSelectStop: (index: number) => void;
  onChange: (paint: Paint) => void;
}) {
  const scrub = {onScrubStart: onGestureStart, onScrubEnd: () => onGestureEnd?.()};
  return (
    <div className="dz-cp-stops">
      <div className="dz-cp-stops-header">
        <span className="dz-cp-caption">Stops</span>
        <IconButton label="Add stop" onClick={() => {
          const order = stopOrder(paint);
          const a = paint.gradientStops[order[order.length - 2] ?? 0], b = paint.gradientStops[order[order.length - 1] ?? 0];
          const added = addStop(paint, a && b ? (a.position + b.position) / 2 : 0.5);
          onChange(added.paint);
          onSelectStop(added.index);
        }}><IconPlus /></IconButton>
      </div>
      {stopOrder(paint).map(index => {
        const each = paint.gradientStops[index];
        return (
          <div key={index} className={`dz-cp-stop-row ${index === stop ? 'is-selected' : ''}`} onPointerDown={() => onSelectStop(index)}>
            <NumberField aria-label="Stop position" value={Math.round(each.position * 100)} min={0} max={100} precision={0} suffix="%" {...scrub}
              onChange={value => onChange(updateStop(paint, index, {position: value / 100}))} className="dz-cp-num" />
            <div className="dz-cp-stop-color">
              <span className="dz-swatch" style={{'--dz-swatch': rgbaCss(each.color), '--dz-swatch-solid': rgbaCss(each.color, 1), width: 14, height: 14} as CSSProperties} aria-hidden="true" />
              <StopHex color={each.color} onCommit={color => onChange(updateStop(paint, index, {color: {...color, a: each.color.a}}))} />
            </div>
            <NumberField aria-label="Stop opacity" value={percent(each.color.a)} min={0} max={100} precision={0} suffix="%" {...scrub}
              onChange={value => onChange(updateStop(paint, index, {color: {...each.color, a: value / 100}}))} className="dz-cp-num" />
            <IconButton label="Remove stop" disabled={paint.gradientStops.length <= 2} onClick={() => {
              onChange(removeStop(paint, index));
              onSelectStop(Math.max(0, Math.min(stop, paint.gradientStops.length - 2)));
            }}><IconMinus /></IconButton>
          </div>
        );
      })}
    </div>
  );
}

function StopHex({color, onCommit}: {color: RGB; onCommit: (color: RGB) => void}) {
  const hex = toHex(color);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input aria-label="Stop color" className="dz-cp-inline-hex" value={draft ?? hex} spellCheck={false} maxLength={7}
      onFocus={event => {
        setDraft(hex);
        event.currentTarget.select();
      }}
      onChange={event => setDraft(event.currentTarget.value)}
      onBlur={event => {
        const parsed = parseHex(event.currentTarget.value);
        if (parsed && toHex(parsed.color) !== hex) onCommit(parsed.color);
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(null);
          event.currentTarget.blur();
        }
      }} />
  );
}

// ── Pictures ──────────────────────────────────────────────────────────────────────────────────────

const SCALE_MODES: SelectEntry<ImageScaleMode>[] = [
  {value: 'FILL', label: 'Fill'}, {value: 'FIT', label: 'Fit'}, {value: 'CROP', label: 'Crop'}, {value: 'TILE', label: 'Tile'},
];

const FILTERS: {key: keyof NonNullable<ImagePaint['filters']>; label: string}[] = [
  {key: 'exposure', label: 'Exposure'}, {key: 'contrast', label: 'Contrast'}, {key: 'saturation', label: 'Saturation'},
  {key: 'temperature', label: 'Temperature'}, {key: 'tint', label: 'Tint'}, {key: 'highlights', label: 'Highlights'}, {key: 'shadows', label: 'Shadows'},
];

function ImageControls({paint, box, onChange, onGestureStart, onGestureEnd, images, onCrop}: GestureProps & {
  paint: ImagePaint;
  box?: {width: number; height: number};
  onChange: (paint: Paint) => void;
  images?: ImageServices;
  onCrop?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const url = paint.imageRef ? images?.url(paint.imageRef) ?? null : null;
  const latest = useRef(paint);
  latest.current = paint;
  const choose = async (file: File | undefined) => {
    if (!file || !images) return;
    setUploading(true);
    try {
      const ref = await images.upload(file);
      if (ref) onChange({...latest.current, imageRef: ref});
    } finally {
      setUploading(false);
    }
  };
  const filters = paint.filters ?? {};
  const scrub = {onScrubStart: onGestureStart, onScrubEnd: () => onGestureEnd?.()};
  return (
    <div className="dz-cp-image">
      <div className="dz-cp-image-row">
        <Select<ImageScaleMode> value={paint.scaleMode} options={SCALE_MODES} aria-label="Scale mode" className="dz-cp-scale"
          onChange={scaleMode => {
            onChange({...paint, scaleMode});
            if (scaleMode === 'CROP') onCrop?.();
          }} />
        {paint.scaleMode === 'TILE' && (
          <NumberField aria-label="Tile scale" value={Math.round((paint.scalingFactor ?? 1) * 100)} min={1} max={1000} precision={0} suffix="%" {...scrub}
            onChange={value => onChange({...paint, scalingFactor: value / 100})} className="dz-cp-tile" />
        )}
        {paint.scaleMode === 'CROP' && onCrop && <IconButton label="Crop on canvas" onClick={onCrop}><IconCrop /></IconButton>}
        <IconButton label="Rotate 90°" onClick={() => onChange(paint.scaleMode === 'CROP' && paint.imageTransform && box
          // A crop turns where it is; the other modes turn about the box's centre.
          ? {...paint, imageTransform: rotateCrop(paint.imageTransform, box.width, box.height)}
          : {...paint, rotation: ((paint.rotation ?? 0) + 90) % 360})}><IconRotate /></IconButton>
      </div>
      <div className={`dz-cp-image-preview ${url ? 'has-image' : ''}`} style={url ? {'--dz-image': `url("${url.replace(/["\\\n]/g, '')}")`} as CSSProperties : undefined}>
        <Button size={24} variant={url ? 'secondary' : 'primary'} busy={uploading} disabled={!images} className="dz-cp-choose" onClick={() => input.current?.click()}>
          {url ? 'Replace image' : 'Choose image'}
        </Button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void choose(file);
          }} />
      </div>
      <div className="dz-cp-adjust">
        {FILTERS.map(filter => {
          const value = Math.round((filters[filter.key] ?? 0) * 100);
          return (
            <div key={filter.key} className="dz-cp-adjust-row">
              <span className="dz-cp-adjust-label">{filter.label}</span>
              <Slider aria-label={filter.label} value={value} min={-100} max={100} onChangeStart={onGestureStart} onChangeEnd={onGestureEnd} valueText={String(value)}
                onChange={next => onChange({...latest.current, filters: {...(latest.current.filters ?? {}), [filter.key]: next / 100}})} className="dz-cp-adjust-slider" />
              <span className="dz-cp-adjust-value">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export {withColor as paintWithColor, editedColor as paintColor};
