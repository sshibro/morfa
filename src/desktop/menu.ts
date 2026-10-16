import type {MainMenuEntry} from '../design/editor/chrome/commands';
import type {EditorMenuSource} from './host';
import type {WebMenu, WebMenuItem} from './ipc';

// The editor's main menu (EDITOR_MENU through the live command lookup) as the native menu bar's data
// (desktop/src-tauri/src/menu.rs), and running what the native menu chose.

function items(entries: readonly MainMenuEntry[], source: EditorMenuSource): WebMenuItem[] {
  const out: WebMenuItem[] = [];
  for (const entry of entries) {
    if (entry === '-') {
      if (out.length && out[out.length - 1].type !== 'separator') out.push({type: 'separator'});
      continue;
    }
    if (typeof entry === 'object') {
      const children = items(entry.items, source);
      if (children.some(child => child.type !== 'separator')) out.push({type: 'submenu', label: entry.label, items: children});
      continue;
    }
    const command = source.lookup(entry);
    if (!command) continue;
    let enabled = true;
    let checked: boolean | undefined;
    try {
      enabled = command.enabled ? command.enabled() : true;
      checked = command.checked?.();
    } catch {
      enabled = false;
    }
    const clipboard = source.clipboard?.(entry);
    out.push({
      type: 'command',
      id: entry,
      label: command.label,
      ...(command.shortcut ? {shortcut: command.shortcut} : {}),
      enabled,
      ...(checked === undefined ? {} : {checked}),
      ...(clipboard ? {clipboard} : {}),
    });
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

/** The menu bar's sections; none without an open editor (the shell keeps its own items). */
export function webMenu(source: EditorMenuSource | null): WebMenu {
  if (!source) return {sections: []};
  return {sections: source.sections.map(section => ({label: section.label, items: items(section.items, source)})).filter(section => section.items.length > 0)};
}

const EDITING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** A text field has the keyboard: undo, redo and select-all belong to it, not to the canvas. */
export function editingText(doc: Document = document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  return !!active && (EDITING.has(active.tagName) || active.isContentEditable);
}

const FIELD_COMMANDS: Record<string, string> = {'edit.undo': 'undo', 'edit.redo': 'redo', 'edit.select-all': 'selectAll'};

/** Runs a command the native menu chose. Answers whether something ran. */
export function runMenuCommand(id: string, source: EditorMenuSource | null, doc: Document = document): boolean {
  const field = FIELD_COMMANDS[id];
  if (field && editingText(doc)) {
    (doc as Document & {execCommand: (command: string) => boolean}).execCommand(field);
    return true;
  }
  const command = source?.lookup(id);
  if (!command) return false;
  try {
    if (command.enabled && !command.enabled()) return false;
  } catch {
    return false;
  }
  command.run();
  return true;
}
