import {useRef, useState, type KeyboardEvent} from 'react';
import {CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, MARKETPLACES, marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import {Button} from '../../ui/Button';
import {IconBack} from '../../ui/icons';
import '../marketplace.css';
import type {NewCardChoice} from './new-card';

// "New file ▾ → Marketplace card" (docs/marketplaces.md §Frames and the new card): which marketplace, and one main
// photo or the six slides a listing needs. The file is built by the starter template (shared/design/templates/marketplace.ts) and
// opens on the card. Light on purpose: the file browser loads it with its gallery, not the editor.

export {newCardFileName, type NewCardChoice} from './new-card';

const SETS: readonly {value: NewCardChoice['set']; label: string; description: string}[] = [
  {value: 'single', label: 'One card', description: 'Main photo with room for the product and a headline'},
  {value: 'kit', label: 'Set of six slides', description: CARD_SLIDE_KINDS.map(kind => CARD_SLIDE_LABELS[kind].toLowerCase()).join(', ').replace(/^./, c => c.toUpperCase())},
];

/** Arrow keys move a radio group's choice, as native radios do. */
function useRadioKeys<T extends string>(values: readonly T[], value: T, onChange: (value: T) => void) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = values[(values.indexOf(value) + step + values.length) % values.length];
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return {ref: group, onKeyDown};
}

export function NewCardChooser({busy, disabled, onBack, onCreate}: {busy: boolean; disabled: boolean; onBack: () => void; onCreate: (choice: NewCardChoice) => void}) {
  const [marketplace, setMarketplace] = useState<Marketplace>('wb');
  const [set, setSet] = useState<NewCardChoice['set']>('single');
  const marketplaceKeys = useRadioKeys(MARKETPLACES, marketplace, setMarketplace);
  const setKeys = useRadioKeys(SETS.map(entry => entry.value), set, setSet);
  return (
    <div className="dz-templates dz-mp-new">
      <header className="dz-mp-new-header">
        <button type="button" className="dz-icon-btn is-24 is-panel" aria-label="Back to templates" onClick={onBack}><IconBack /></button>
        <div className="dz-templates-header">
          <h2 className="dz-templates-title">Marketplace card</h2>
          <p className="dz-templates-lead">A frame of the right size, badge zones on the canvas and a check against the marketplace rules as you work.</p>
        </div>
      </header>
      <h3 className="dz-mp-new-caption" id="dz-mp-new-marketplace">Marketplace</h3>
      <div className="dz-mp-choices is-three" role="radiogroup" aria-labelledby="dz-mp-new-marketplace" {...marketplaceKeys}>
        {MARKETPLACES.map(id => {
          const spec = marketplaceSpec(id);
          return (
            <button key={id} type="button" role="radio" aria-checked={id === marketplace} tabIndex={id === marketplace ? 0 : -1} data-value={id}
              className="dz-mp-choice" onClick={() => setMarketplace(id)}>
              <span className="dz-mp-choice-name">{spec.name}</span>
              <span className="dz-mp-choice-note">{spec.frame.width} × {spec.frame.height}</span>
            </button>
          );
        })}
      </div>
      <h3 className="dz-mp-new-caption" id="dz-mp-new-set">What to create</h3>
      <div className="dz-mp-choices" role="radiogroup" aria-labelledby="dz-mp-new-set" {...setKeys}>
        {SETS.map(entry => (
          <button key={entry.value} type="button" role="radio" aria-checked={entry.value === set} tabIndex={entry.value === set ? 0 : -1} data-value={entry.value}
            className="dz-mp-choice" onClick={() => setSet(entry.value)}>
            <span className="dz-mp-choice-name">{entry.label}</span>
            <span className="dz-mp-choice-note">{entry.description}</span>
          </button>
        ))}
      </div>
      <footer className="dz-mp-new-footer">
        <Button size={32} variant="primary" busy={busy} disabled={disabled} onClick={() => onCreate({marketplace, set})}>Create file</Button>
      </footer>
    </div>
  );
}
