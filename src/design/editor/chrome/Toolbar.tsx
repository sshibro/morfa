import {memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {IconButton} from '../../ui/Button';
import {IconCode, IconModeDesign, IconModeDraw, IconModePrototype, type IconComponent} from '../../ui/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {MODES, TOOLS, TOOL_GROUPS, type EditorMode, type ToolGroup, type ToolId} from './tools';

export type ToolbarProps = {
  /** Null: the active tool is not one of the toolbar's (a paint or crop mode); no button is lit. */
  tool: ToolId | null;
  onToolChange: (tool: ToolId) => void;
  groups?: readonly ToolGroup[];
  /** After the tools: "Actions" and the AI. */
  end?: ReactNode;
  /** The inset segment at the right end, after a divider: the mode switcher. */
  modes?: ReactNode;
  /** Tools whose module is registered. A tool that is not is left out (never a fake entry), and so is a
   *  group with none; pass a new function when the registry changes. Default: every tool. */
  isAvailable?: (tool: ToolId) => boolean;
};

/**
 * The floating toolbar at the bottom of the canvas, as Figma's UI3 bar: 48 px tall, 32 px buttons
 * with 24 px glyphs, each group's chevron opening its flyout (every tool with its shortcut, a check on
 * the current one), "Actions" and the AI after the tools, the mode switcher in an inset segment at
 * the right end. Each group shows its last used tool. Memoized with narrow props: canvas work
 * re-renders it only when the tool changes. Buttons light and unlight at once (tools switch from the
 * keyboard all day); flyouts opened with a click scale in from their chevron, from the keyboard they
 * are there at once (styles/overlays.css).
 */
export const Toolbar = memo(function Toolbar({tool, onToolChange, groups = TOOL_GROUPS, end, modes, isAvailable}: ToolbarProps) {
  // What the bar shows: registered tools only, groups that keep at least one.
  const shownGroups = useMemo(() => groups
    .map(group => (isAvailable ? {...group, tools: group.tools.filter(id => isAvailable(id))} : group))
    .filter(group => group.tools.length > 0), [groups, isAvailable]);
  // The tool each group shows: its last used one.
  const [lastUsed, setLastUsed] = useState<Record<string, ToolId>>(() => (tool ? Object.fromEntries(shownGroups.filter(group => group.tools.includes(tool)).map(group => [group.id, tool])) : {}));
  useEffect(() => {
    if (!tool) return;
    setLastUsed(current => {
      const owners = shownGroups.filter(group => group.tools.includes(tool) && current[group.id] !== tool);
      return owners.length ? {...current, ...Object.fromEntries(owners.map(group => [group.id, tool]))} : current;
    });
  }, [tool, shownGroups]);
  return (
    <div className="dz-toolbar" role="toolbar" aria-label="Tools">
      <div className="dz-toolbar-tools">
        {shownGroups.map(group => {
          const remembered = lastUsed[group.id];
          const shown = remembered && group.tools.includes(remembered) ? remembered : group.tools[0];
          return <ToolGroupButton key={group.id} group={group} shown={shown} active={tool && group.tools.includes(tool) ? tool : null} onToolChange={onToolChange} />;
        })}
        {end}
      </div>
      {modes && <><span className="dz-toolbar-divider" aria-hidden="true" />{modes}</>}
    </div>
  );
});

const ToolGroupButton = memo(function ToolGroupButton({group, shown, active, onToolChange}: {group: ToolGroup; shown: ToolId; active: ToolId | null; onToolChange: (tool: ToolId) => void}) {
  const spec = TOOLS[shown];
  const Icon = spec.icon;
  const items = useCallback((): MenuItem[] => group.tools.map(id => {
    const entry = TOOLS[id];
    const Glyph = entry.icon;
    // The tool's glyph in a 24 px box, as Figma's flyouts: drawn at 20 px (the icons' 1.5 px stroke) so it sits beside 11 px text.
    return {id, label: entry.label, shortcut: entry.shortcut, icon: <Glyph size={20} strokeWidth={1.2} />, checked: id === (active ?? shown), radio: true, onSelect: () => onToolChange(id)};
  }), [group, active, shown, onToolChange]);
  // As in Figma, the flyout opens above the chevron, its left edge in line with it; rows are 32 px with 24 px icon boxes (styles/editor.css).
  const flyout = useMenuTrigger({items, label: group.label, placement: 'top-start', offset: 12, minWidth: 200, className: 'is-tools'});
  const chevronTip = useTooltip(flyout.open ? null : {label: group.label, placement: 'top'});
  const several = group.tools.length > 1;
  return (
    <div className={`dz-tool-group ${several ? 'has-flyout' : ''} ${active ? 'is-active' : ''}`.trim()}>
      <IconButton size={32} tone="toolbar" label={spec.label} shortcut={spec.shortcut} tooltip={{placement: 'top'}} pressed={active === shown}
        className="dz-tool" onClick={() => onToolChange(shown)}>
        <Icon size={24} strokeWidth={1} />
      </IconButton>
      {several && (
        <>
          <button type="button" className="dz-tool-flyout" aria-label={group.label} {...chevronTip} {...flyout.triggerProps}>
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {flyout.element}
        </>
      )}
    </div>
  );
});

// ── Modes ────────────────────────────────────────────────────────────────────────────────────────

const MODE_ICONS: Record<EditorMode, IconComponent> = {draw: IconModeDraw, design: IconModeDesign, prototype: IconModePrototype, code: IconCode};

export type ModeSwitcherProps = {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  /** The person's modes (a read-only file has no "Draw", a team's viewer no "Code": chrome/tools.ts modesFor). Default: all. */
  modes?: readonly EditorMode[];
};

/**
 * The inset segment at the bar's right end: "Draw", "Design", "Prototype", "Code". A radio group:
 * one tab stop, the arrows move between the modes. Switching is instant (a mode changes from the
 * keyboard too, ⇧D).
 */
export const ModeSwitcher = memo(function ModeSwitcher({mode, onModeChange, modes}: ModeSwitcherProps) {
  const shown = useMemo(() => (modes ? MODES.filter(spec => modes.includes(spec.id)) : MODES), [modes]);
  const refs = useRef<Partial<Record<EditorMode, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = shown.findIndex(spec => spec.id === mode);
    const next = shown[(at + step + shown.length) % shown.length];
    onModeChange(next.id);
    refs.current[next.id]?.focus({preventScroll: true});
  };
  // One tab stop: the current mode, or the first one when the panel shows a tab that is not this person's mode (a viewer's "Code").
  const stop = shown.some(spec => spec.id === mode) ? mode : shown[0]?.id;
  return (
    <div className="dz-toolbar-modes" role="radiogroup" aria-label="Mode" onKeyDown={onKeyDown}>
      {shown.map(spec => {
        const Icon = MODE_ICONS[spec.id];
        return (
          <ModeButton key={spec.id} ref={element => {refs.current[spec.id] = element;}} label={spec.label} tooltip={spec.tooltip ?? spec.label} hint={spec.description} shortcut={spec.shortcut} mode={spec.id}
            checked={mode === spec.id} focusable={stop === spec.id} onSelect={onModeChange}>
            <Icon size={20} strokeWidth={1.2} />
          </ModeButton>
        );
      })}
    </div>
  );
});

function ModeButton({label, tooltip, hint, shortcut, mode, checked, focusable, onSelect, children, ref}: {
  label: string; tooltip: string; hint: string; shortcut?: string; mode: EditorMode; checked: boolean; focusable: boolean; onSelect: (mode: EditorMode) => void; children: ReactNode;
  ref: (element: HTMLButtonElement | null) => void;
}) {
  const tip = useTooltip({label: tooltip, shortcut, placement: 'top'});
  return (
    <button ref={ref} type="button" role="radio" aria-checked={checked} aria-label={label} aria-description={hint} tabIndex={focusable ? 0 : -1}
      className="dz-toolbar-mode" data-mode={mode} onClick={() => onSelect(mode)} {...tip}>
      {children}
    </button>
  );
}
