import {formatShortcut} from './shortcuts';

/** A quick, quiet spinner: an arc turning in 0.7 s (a fast spinner reads as a fast load). */
export function Spinner({size = 16, className = '', label}: {size?: number; className?: string; label?: string}) {
  return (
    <svg className={`dz-spinner ${className}`.trim()} width={size} height={size} viewBox="0 0 16 16" fill="none" role={label ? 'img' : undefined}
      aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A shortcut set in key caps, as the platform prints it: ⇧⌘Z or Ctrl+Shift+Z. */
export function Kbd({shortcut, className = ''}: {shortcut: string; className?: string}) {
  return <kbd className={`dz-kbd ${className}`.trim()}>{formatShortcut(shortcut)}</kbd>;
}
