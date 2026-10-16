import {memo, useState} from 'react';
import type {StyleId} from '../../../../../shared/design/types';
import {besidePanel} from '../../../ui/ColorPicker';
import {PanelSection} from '../../../ui/PanelSection';
import type {Rect} from '../../../ui/position';
import {StyleEditor, StyleList, type StyleType} from './StyleList';

// With nothing selected, Figma's panel lists the file's local styles; these two sections show the
// colour and effect styles (a click opens the style editor; the menu renames and deletes).

export const LocalStylesSection = memo(function LocalStylesSection({type}: {type: StyleType}) {
  const [editing, setEditing] = useState<{styleId: StyleId; anchor: Rect; row: Element} | null>(null);
  const open = (styleId: StyleId, row: HTMLElement) => setEditing(current => (current?.styleId === styleId ? null : {styleId, anchor: besidePanel(row), row}));
  return (
    <PanelSection title={type === 'FILL' ? 'Color styles' : 'Effect styles'}>
      <StyleList type={type} currentStyleId={editing?.styleId ?? null} localOnly
        onApply={open}
        onEdit={open} />
      {editing && <StyleEditor anchor={editing.anchor} trigger={editing.row} styleId={editing.styleId} onClose={() => setEditing(null)} />}
    </PanelSection>
  );
});

export const ColorStylesSection = memo(function ColorStylesSection() {
  return <LocalStylesSection type="FILL" />;
});

export const EffectStylesSection = memo(function EffectStylesSection() {
  return <LocalStylesSection type="EFFECT" />;
});
