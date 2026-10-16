import {useMemo, useState} from 'react';
import type {Command} from '../engine/commands';
import {IconSearch} from '../ui/icons';
import {Dialog} from '../ui/Dialog';
import {Kbd} from '../ui/Spinner';
import {TextInput} from '../ui/TextInput';
import {listedCommands, searchPalette, shortcutString} from './command-bridge';
import type {EditorDialogProps} from './services';

// "Keyboard shortcuts" (⌃⇧? / Help ▸): every registered command with a key, grouped as the menus
// group them, searchable. It reads the registry when it opens, so a feature's keys appear here the
// day its command file is imported.

export const SHORTCUT_GROUPS: Record<string, string> = {
  tools: 'Tools',
  file: 'File',
  edit: 'Edit',
  clipboard: 'Edit',
  select: 'Selection',
  view: 'View',
  arrange: 'Arrange',
  order: 'Layer order',
  layer: 'Layer',
  object: 'Object',
  text: 'Text',
  components: 'Components',
  component: 'Components',
  boolean: 'Boolean operations',
  mask: 'Object',
  vector: 'Object',
  layout: 'Auto layout',
  insert: 'Tools',
  export: 'Export',
  prototype: 'Prototype',
  help: 'General',
  app: 'General',
  preferences: 'General',
  meeting: 'Meeting',
};
const GROUP_ORDER = ['General', 'Tools', 'File', 'Edit', 'Selection', 'View', 'Object', 'Arrange', 'Layer order', 'Layer', 'Text', 'Components', 'Boolean operations', 'Export', 'Prototype', 'Meeting'];

export type ShortcutRow = {id: string; label: string; shortcut: string; group: string};

/** Rows of the dialog: commands with a key (hidden ones left out), plus the keys that are not commands. */
export function shortcutRows(commands: readonly Command[] = listedCommands()): ShortcutRow[] {
  const rows: ShortcutRow[] = commands
    .filter(command => command.shortcut)
    .map(command => ({
      id: command.id,
      label: command.label,
      shortcut: shortcutString(command.shortcut!),
      group: SHORTCUT_GROUPS[command.group ?? command.id.split('.')[0]] ?? 'Other',
    }));
  rows.push(
    {id: 'hold-space', label: 'Hand while holding', shortcut: 'Space', group: 'Tools'},
    {id: 'nudge', label: 'Nudge', shortcut: 'ArrowRight', group: 'Arrange'},
    {id: 'nudge-large', label: 'Big nudge', shortcut: 'Shift+ArrowRight', group: 'Arrange'},
    {id: 'resize', label: 'Resize by one step', shortcut: 'Mod+ArrowRight', group: 'Arrange'},
    {id: 'resize-large', label: 'Resize by a large step', shortcut: 'Shift+Mod+ArrowRight', group: 'Arrange'},
    // The number keys (commands/opacity.ts): one row for 1…9, one for 0; two quick digits set it exactly.
    {id: 'opacity', label: 'Opacity 10–90% (1–9; two digits in a row for an exact value)', shortcut: 'Digit1', group: 'Layer'},
    {id: 'opacity-full', label: 'Opacity 100%', shortcut: 'Digit0', group: 'Layer'},
  );
  return rows;
}

export function groupRows(rows: readonly ShortcutRow[]): {group: string; rows: ShortcutRow[]}[] {
  const groups = new Map<string, ShortcutRow[]>();
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const rank = (group: string) => {
    const at = GROUP_ORDER.indexOf(group);
    return at < 0 ? GROUP_ORDER.length : at;
  };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([group, list]) => ({group, rows: list}));
}

/** `rows`: what the dialog lists (a board passes its own keys, docs/board.md §Tools and keys); every command by default. */
export function ShortcutsDialog({onClose, rows: build = shortcutRows}: EditorDialogProps & {rows?: () => ShortcutRow[]}) {
  const [query, setQuery] = useState('');
  const [rows] = useState(() => build());
  const shown = useMemo(() => {
    if (!query.trim()) return rows;
    const entries = rows.map(row => ({id: row.id, label: row.label, shortcut: row.shortcut, keywords: `${row.group} ${row.id.replace(/[.-]+/g, ' ')}`}));
    const order = new Map(searchPalette(entries, query).map((entry, index) => [entry.id, index]));
    return rows.filter(row => order.has(row.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }, [rows, query]);
  const groups = useMemo(() => groupRows(shown), [shown]);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={680} className="dz-shortcuts">
      <TextInput value={query} onChange={setQuery} icon={<IconSearch />} placeholder="Search commands" aria-label="Search commands" size={32} autoFocus data-autofocus />
      {groups.length ? (
        <div className="dz-shortcuts-scroll">
          <div className="dz-shortcuts-groups">
            {groups.map(({group, rows: list}) => (
              <section key={group} className="dz-shortcuts-group" aria-label={group}>
                <h3 className="dz-shortcuts-title">{group}</h3>
                <dl>
                  {list.map(row => (
                    <div key={row.id} className="dz-shortcuts-row">
                      <dt>{row.label}</dt>
                      <dd><Kbd shortcut={row.shortcut} /></dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      ) : <p className="dz-panel-note dz-shortcuts-empty">Nothing found</p>}
    </Dialog>
  );
}
