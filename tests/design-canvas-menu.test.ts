import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicable} from '../src/design/editor/context-menu-model';
import type {MenuItem} from '../src/design/ui/menu-model';

// src/design/editor/ContextMenu.tsx: the canvas's right-click menu offers only what can run on the
// selection, like Figma's (no "Ungroup" on a circle, no instance commands on a plain shape).

const labels = (items: readonly MenuItem[]): string[] => items.flatMap(item => (item.type === 'separator' ? ['—'] : item.type === 'submenu' ? [`${item.label} ▸ ${labels(item.items).join(', ')}`] : 'label' in item ? [item.label] : []));

test('rows the selection cannot use are left out of the canvas menu, separators tidied', () => {
  const run = () => {};
  const shared: MenuItem[] = [
    {id: 'edit.copy', label: 'Copy', onSelect: run},
    {type: 'separator'},
    {id: 'object.ungroup', label: 'Ungroup', disabled: true, onSelect: run},
    {type: 'separator'},
    {id: 'object.detach-instance', label: 'Detach instance', disabled: true, onSelect: run},
    {id: 'object.reset-instance', label: 'Reset all changes', disabled: true, onSelect: run},
    {type: 'separator'},
    {type: 'submenu', id: 'menu:boolean', label: 'Boolean operations', items: [{id: 'object.boolean-union', label: 'Union', disabled: true, onSelect: run}]},
    {type: 'submenu', id: 'menu:order', label: 'Arrange', items: [{id: 'a', label: 'Bring forward', onSelect: run}, {id: 'b', label: 'Send backward', disabled: true, onSelect: run}]},
    {type: 'separator'},
    {id: 'layers.toggle-visible', label: 'Hide', onSelect: run},
  ];
  assert.deepEqual(labels(applicable(shared)), ['Copy', '—', 'Arrange ▸ Bring forward', '—', 'Hide']);
});
