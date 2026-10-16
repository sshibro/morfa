import {useRef, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import {useVariableBinding} from '../../variables/VariableBindButton';
import {PanelNumber, type PanelNumberProps} from './fields';

// A number field that a variable can drive (BINDABLE_FIELDS: sizes, gaps, paddings, radii, opacity):
// the hexagon "Apply variable" sits inside the field's right edge on hover, as in Figma, and
// while the selection is bound the field gives way to the variable's chip (src/design/panels/
// variables/VariableBindButton.tsx, the variables feature's). As Figma's fields, "=" typed in the field, a right click on it
// or ⇧ with a click into it open the list (help.figma.com "Apply variables to designs"). `VariableSlot` gives any other
// field (the text section's) the same.

export type BindableNumberProps = PanelNumberProps & {
  /** The bindable field, e.g. 'width', 'itemSpacing', 'paddingLeft', 'cornerRadius', 'opacity'. */
  field: string;
  /** The layers the binding applies to (the section's selection). */
  ids: readonly NodeId[];
};

/** The ways into the variable list a field offers: "=", a right click, ⇧-click. */
function openers(opener: {current: (() => void) | null}, disabled?: boolean) {
  const open = (event: {preventDefault(): void; stopPropagation(): void}) => {
    if (disabled || !opener.current) return false;
    event.preventDefault();
    event.stopPropagation();
    opener.current();
    return true;
  };
  return {
    onKeyDownCapture: (event: KeyboardEvent) => {
      if (event.key === '=' && event.target instanceof HTMLInputElement) open(event);
    },
    onContextMenu: (event: MouseEvent) => void open(event),
    onMouseDownCapture: (event: MouseEvent) => {
      if (event.shiftKey && event.button === 0 && event.target instanceof HTMLInputElement) open(event);
    },
  };
}

export function BindableNumber({field, ids, ...props}: BindableNumberProps) {
  const opener = useRef<(() => void) | null>(null);
  const binding = useVariableBinding(field, {ids, opener});
  if (binding.chip) return <div className="dz-pl-bound">{binding.chip}</div>;
  return (
    <span className="dz-pl-bindable" {...openers(opener, props.disabled)}>
      <PanelNumber {...props} adornment={props.disabled ? undefined : binding.button} />
    </span>
  );
}

/** Any field a variable can drive (the text section's size, line height, spacing): the same ways into the list as
 *  `BindableNumber`, the hexagon out of sight beside it (the list hangs off it), and the variable's chip once bound. */
export function VariableSlot({field, ids, children}: {field: string; ids: readonly NodeId[]; children: ReactNode}) {
  const opener = useRef<(() => void) | null>(null);
  const binding = useVariableBinding(field, {ids, opener});
  if (binding.chip) return <div className="dz-pl-bound">{binding.chip}</div>;
  return (
    <span className="dz-pl-varslot" {...openers(opener)}>
      {children}
      <span className="dz-pl-varslot-anchor">{binding.button}</span>
    </span>
  );
}
