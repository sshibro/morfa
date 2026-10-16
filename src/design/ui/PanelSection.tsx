import {memo, useId, useState, type ReactNode} from 'react';
import {IconButton} from './Button';
import {IconChevronDown, IconMinus, IconPlus} from './icons';

export type PanelSectionProps = {
  title: string;
  /** Extra header buttons (24 px icon buttons), before "+" / "−". */
  actions?: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  onRemove?: () => void;
  removeLabel?: string;
  /** The header toggles the body. Controlled with `open`, or uncontrolled from `defaultOpen`. */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** An empty section ("Effects" with none yet): the title is quieter and the body hidden. */
  empty?: boolean;
  /** No divider above (the first section of a panel). */
  first?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * A section of the right or left panel: a title row with its actions, then its rows.
 * Memoized: a panel re-rendering for one section leaves the others alone.
 */
export const PanelSection = memo(function PanelSection({title, actions, onAdd, addLabel, onRemove, removeLabel, collapsible = false, open, defaultOpen = true, onOpenChange, empty = false, first = false, className = '', children}: PanelSectionProps) {
  const bodyId = useId();
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const expanded = !collapsible || (open ?? ownOpen);
  const toggle = () => {
    const next = !expanded;
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <section className={`dz-section ${empty ? 'is-empty' : ''} ${first ? 'is-first' : ''} ${className}`.trim()} aria-label={title}>
      <div className="dz-section-header">
        {collapsible ? (
          <button type="button" className="dz-section-title is-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
            <span>{title}</span>
            <span className={`dz-section-chevron ${expanded ? 'is-open' : ''}`} aria-hidden="true"><IconChevronDown size={12} /></span>
          </button>
        ) : (
          <h3 className="dz-section-title">{title}</h3>
        )}
        <div className="dz-section-actions">
          {actions}
          {onRemove && <IconButton label={removeLabel ?? `Remove ${title.toLowerCase()}`} onClick={onRemove}><IconMinus /></IconButton>}
          {onAdd && <IconButton label={addLabel ?? `Add ${title.toLowerCase()}`} onClick={onAdd}><IconPlus /></IconButton>}
        </div>
      </div>
      {expanded && !empty && children !== undefined && <div id={bodyId} className="dz-section-body">{children}</div>}
    </section>
  );
});
