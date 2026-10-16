import {memo} from 'react';
import {PanelSection} from '../../../ui/PanelSection';
import {Select, type SelectEntry} from '../../../ui/Select';
import type {SectionProps} from '../sections';
import {sameSectionProps} from '../shared/edit';
import {useComponentHost, useDocValue} from './hooks';
import {MIXED} from './model';
import {AUTO, modeRows, setFramesMode} from './variable-modes';
import '../../../styles/panel-components.css';

// "Variables": which mode of each variable collection a frame (and everything inside it) uses —
// "Auto" follows the frame's parent, as in Figma; a picked mode re-applies every bound value inside.
// Shown for frames when the file has a collection with more than one mode.

export const VariableModesSection = memo(function VariableModesSection({ids}: SectionProps) {
  const services = useComponentHost();
  const rows = useDocValue(services, doc => modeRows(doc, ids));
  if (!rows.length) return null;
  return (
    <PanelSection title="Variables" className="dz-cmp-section">
      <div className="dz-cmp-rows">
        {rows.map(row => {
          const options: SelectEntry<string>[] = [
            {value: AUTO, label: `Auto (${row.inherited})`},
            {separator: true},
            ...row.modes.map(mode => ({value: mode.modeId, label: mode.name})),
          ];
          return (
            <div className="dz-cmp-row" key={row.collectionId}>
              <span className="dz-cmp-label" title={row.name}>{row.name}</span>
              <div className="dz-cmp-control">
                <Select value={row.value === MIXED ? null : row.value} mixed={row.value === MIXED} options={options} aria-label={`Mode: ${row.name}`}
                  onChange={value => setFramesMode(services.store, ids, row.collectionId, value === AUTO ? null : value)} />
              </div>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}, sameSectionProps);
