import {memo, useContext, useRef, type KeyboardEvent} from 'react';
import {IconComment, IconComponent, IconFile, IconVariables, type IconComponent as Glyph} from '../../ui/icons';
import {tabId, tabPanelId} from '../../ui/Tabs';
import {useTooltip} from '../../ui/Tooltip';
import {EditorServicesContext} from '../services';
import type {CommandLookup, MainMenuSection} from './commands';
import {MainMenu} from './MainMenu';

// The navigation bar along the left edge, as Figma Design's current one (help.figma.com "Explore the navigation bar and
// left sidebar"): the main menu on top, then the left panel's views as labelled icons — "File" (pages and layers),
// "Assets", "Comments" — and "Variables", which opens the variables. The views are a vertical tab list bound to the
// left panel's tab panels (`dz-left`), so ↑ ↓ move between them and a screen reader reads them as the panel's tabs.

export type NavTab = 'file' | 'assets' | 'comments';

export type NavRailProps = {
  commands: CommandLookup;
  menu?: readonly MainMenuSection[];
  onBackToFiles: () => void;
  tabs: readonly {id: NavTab; label: string; badge?: number}[];
  value: NavTab;
  onChange: (tab: NavTab) => void;
};

const GLYPHS: Record<NavTab, Glyph> = {file: IconFile, assets: IconComponent, comments: IconComment};
const SHORTCUTS: Partial<Record<NavTab, string>> = {file: 'Alt+Digit1', assets: 'Alt+Digit2'};

export const NavRail = memo(function NavRail({commands, menu, onBackToFiles, tabs, value, onChange}: NavRailProps) {
  const list = useRef<HTMLDivElement>(null);
  const services = useContext(EditorServicesContext);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = tabs.findIndex(tab => tab.id === value);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId('dz-left', next.id))}`)?.focus();
  };
  return (
    <nav className="dz-nav" aria-label="Navigation">
      <MainMenu commands={commands} menu={menu} onBackToFiles={onBackToFiles} />
      <span className="dz-nav-divider" aria-hidden="true" />
      <div ref={list} role="tablist" aria-orientation="vertical" aria-label="Left panel" className="dz-nav-tabs" onKeyDown={onKeyDown}>
        {tabs.map(tab => <NavTabButton key={tab.id} tab={tab} selected={tab.id === value} onSelect={onChange} />)}
      </div>
      {services && (
        <>
          <span className="dz-nav-divider" aria-hidden="true" />
          <NavButton label="Variables" Icon={IconVariables} onClick={() => services.openDialog('variables')} />
        </>
      )}
    </nav>
  );
});

function NavTabButton({tab, selected, onSelect}: {tab: NavRailProps['tabs'][number]; selected: boolean; onSelect: (tab: NavTab) => void}) {
  const Icon = GLYPHS[tab.id];
  const tip = useTooltip({label: tab.label, shortcut: SHORTCUTS[tab.id], placement: 'right'});
  return (
    <button type="button" role="tab" id={tabId('dz-left', tab.id)} aria-controls={tabPanelId('dz-left', tab.id)} aria-selected={selected} tabIndex={selected ? 0 : -1}
      className="dz-nav-item" onClick={() => onSelect(tab.id)} {...tip}>
      <span className="dz-nav-icon"><Icon size={20} strokeWidth={1.2} /></span>
      <span className="dz-nav-label">{tab.label}</span>
      {tab.badge ? <span className="dz-tab-badge dz-nav-badge" aria-label={`, ${tab.badge} new`}>{tab.badge > 99 ? '99+' : tab.badge}</span> : null}
    </button>
  );
}

function NavButton({label, Icon, onClick}: {label: string; Icon: Glyph; onClick: () => void}) {
  const tip = useTooltip({label, placement: 'right'});
  return (
    <button type="button" className="dz-nav-item" aria-label={label} onClick={onClick} {...tip}>
      <span className="dz-nav-icon"><Icon size={20} strokeWidth={1.2} /></span>
      <span className="dz-nav-label" aria-hidden="true">{label}</span>
    </button>
  );
}
