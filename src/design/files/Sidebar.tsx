import {memo, useState, type DragEvent, type ReactNode} from 'react';
import {FILES_DRAG_TYPE} from './drop';
import {Lockup} from '../../brand/marks';
import {AccountMenu} from './AccountMenu';
import {viewKey, type BrowserView, type SidebarSection} from './sidebar';

type SidebarProps = {
  sections: readonly SidebarSection[];
  view: BrowserView;
  onView: (view: BrowserView) => void;
  onBack: () => void;
  /** Buttons in a section's title row (a team's "+ Project" and its menu). */
  sectionActions?: (section: SidebarSection) => ReactNode;
  /** Under the places ("Create team"). */
  footer?: ReactNode;
  /** "Favorites" (Starred.tsx), after the teams. */
  starred?: ReactNode;
  /** The search field under the account (a desktop; on a phone it stays in the main column). */
  search?: ReactNode;
  /** Files dragged from the browser: which places take them, and the drop (files/drop.ts). */
  drop?: {accepts: (view: BrowserView) => boolean; onDrop: (view: BrowserView) => void};
  /** "Claude and ChatGPT" (src/design/assistants), at the bottom: connecting an assistant is a place of its own, not a setting. */
  assistants?: ReactNode;
};

/** The browser's sidebar: the account (its theme, signing out), the places (from data). */
export const Sidebar = memo(function Sidebar({sections, view, onView, onBack, sectionActions, footer, search, drop, starred, assistants}: SidebarProps) {
  const current = viewKey(view);
  const [over, setOver] = useState<string | null>(null);
  return (
    <nav className="dz-files-sidebar" aria-label="Sections">
      <div className="dz-files-product"><Lockup className="dz-files-lockup" /></div>
      <div className="dz-files-sidebar-top">
        <AccountMenu onSignOut={onBack} />
      </div>
      {search && <div className="dz-files-sidebar-search">{search}</div>}
      <div className="dz-files-places">
        {sections.map(section => (
          <div key={section.id} className="dz-files-place-group" role="group" aria-label={section.title}>
            {section.title && (
              <div className="dz-files-place-title">
                <span className="dz-files-place-title-text" title={section.title}>{section.title}</span>
                {sectionActions?.(section)}
              </div>
            )}
            {section.items.map(item => {
              const Icon = item.icon;
              const active = viewKey(item.view) === current;
              return (
                <button key={item.id} type="button" className={`dz-files-place ${active ? 'is-active' : ''} ${over === item.id ? 'is-drop-target' : ''}`.replace(/\s+/g, ' ').trim()}
                  aria-current={active ? 'page' : undefined} onClick={() => onView(item.view)}
                  onDragOver={(event: DragEvent) => {
                    if (!drop || !event.dataTransfer.types.includes(FILES_DRAG_TYPE) || !drop.accepts(item.view)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (over !== item.id) setOver(item.id);
                  }}
                  onDragLeave={() => setOver(value => (value === item.id ? null : value))}
                  onDrop={(event: DragEvent) => {
                    setOver(null);
                    if (!drop || !event.dataTransfer.types.includes(FILES_DRAG_TYPE) || !drop.accepts(item.view)) return;
                    event.preventDefault();
                    drop.onDrop(item.view);
                  }}>
                  <Icon />
                  <span className="dz-files-place-label">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
        {starred}
        {footer}
      </div>
      {assistants && <div className="dz-files-assistants">{assistants}</div>}
    </nav>
  );
});
