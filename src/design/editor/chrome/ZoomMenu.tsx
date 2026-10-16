import {memo, useCallback} from 'react';
import {IconChevronDown} from '../../ui/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {useExternalValue, type ExternalValue} from './external';
import {getPreferences, setPreferences} from '../preferences';

export type ZoomAction = {type: 'in'} | {type: 'out'} | {type: 'fit'} | {type: 'selection'} | {type: 'set'; zoom: number};

export type ZoomMenuProps = {
  /** Subscribed here only: pinching re-renders this label, not the panel around it. */
  zoom: ExternalValue<number>;
  /** Without it the zoom is shown, not offered. */
  onZoom?: (action: ZoomAction) => void;
};

/** "100%" in the right panel's tab row; its menu zooms in, out, to fit, to the selection or to a preset, and turns the
 *  panel's property captions on and off ("Property labels"), as Figma's zoom/view menu does. */
export const ZoomMenu = memo(function ZoomMenu({zoom, onZoom}: ZoomMenuProps) {
  const value = useExternalValue(zoom);
  const percent = Math.round(value * 100);
  const items = useCallback((): MenuItem[] => {
    const run = (action: ZoomAction) => () => onZoom?.(action);
    return [
      {id: 'zoom-in', label: 'Zoom in', shortcut: 'Mod+Equal', onSelect: run({type: 'in'})},
      {id: 'zoom-out', label: 'Zoom out', shortcut: 'Mod+Minus', onSelect: run({type: 'out'})},
      {type: 'separator'},
      {id: 'zoom-fit', label: 'Zoom to fit', shortcut: 'Shift+Digit1', onSelect: run({type: 'fit'})},
      {id: 'zoom-selection', label: 'Zoom to selection', shortcut: 'Shift+Digit2', onSelect: run({type: 'selection'})},
      {type: 'separator'},
      ...([0.5, 1, 2] as const).map((preset): MenuItem => ({
        id: 'zoom-' + preset * 100, label: `${preset * 100}%`, shortcut: preset === 1 ? 'Shift+Digit0' : undefined,
        checked: Math.abs(zoom.get() - preset) < 0.0005, radio: true, onSelect: run({type: 'set', zoom: preset}),
      })),
      {type: 'separator'},
      // Figma's "Property labels": captions over the panel's fields, off by default.
      {id: 'property-labels', label: 'Property labels', checked: getPreferences().propertyLabels,
        onSelect: () => setPreferences({propertyLabels: !getPreferences().propertyLabels})},
    ];
  }, [zoom, onZoom]);
  const trigger = useMenuTrigger({items, label: 'Zoom', placement: 'bottom-end', minWidth: 200});
  const tip = useTooltip(trigger.open ? null : {label: 'Zoom'});
  return (
    <>
      <button type="button" className="dz-zoom" aria-label={`Zoom ${percent}%`} disabled={!onZoom} {...tip} {...trigger.triggerProps}>
        <span className="dz-zoom-value">{percent}%</span>
        <IconChevronDown size={12} />
      </button>
      {trigger.element}
    </>
  );
});
