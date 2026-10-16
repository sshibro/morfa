import {tidySeparators, type MenuItem} from '../ui/menu-model';

// The canvas menu's pure parts (ContextMenu.tsx), tested in node.

/** Only what can run on this selection: disabled rows are left out (a submenu with nothing left
 *  goes too), as Figma's canvas menu offers no "Ungroup" for a circle. */
export function applicable(items: readonly MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const entry of items) {
    if (entry.type === 'separator' || entry.type === 'label') out.push(entry);
    else if (entry.type === 'submenu') {
      const inner = applicable(entry.items);
      if (!entry.disabled && inner.some(item => item.type !== 'separator' && item.type !== 'label')) out.push({...entry, items: inner});
    } else if (!entry.disabled) out.push(entry);
  }
  return tidySeparators(out);
}
