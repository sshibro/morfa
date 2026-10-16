import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {ArrowDownRight, ArrowUpRight, Check, CircleHelp, Copy, Inbox, RefreshCw, Search, X} from 'lucide-react';
import type {AccountSegment} from '../../shared/admin-analytics';
import {failureOf} from './data';
import {initials, type Delta} from './format';
import {SEGMENT_COLOR, SEGMENT_ONE} from './palette';
import {Sparkline} from './charts/Sparkline';

// The console's primitives, after the house rules (docs/admin-design.md) in Morfa's brand: numbers lead, caveats sit behind "?",
// warnings on the block they concern, one indigo accent.

/** A caveat behind "?": opens on hover, focus or a tap. */
export function InfoTip({text, label = 'How it is calculated'}: {text: ReactNode; label?: string}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="mfa-info" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(value => !value)}>
        <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && <span className="mfa-info-pop" role="tooltip" id={id}>{text}</span>}
    </span>
  );
}

export function DeltaPill({delta, compare}: {delta: Delta | null; compare?: string}) {
  if (!delta) return null;
  const Arrow = delta.direction === 'up' ? ArrowUpRight : delta.direction === 'down' ? ArrowDownRight : null;
  return (
    <span className={`mfa-delta is-${delta.tone}`} title={compare}>
      {Arrow && <Arrow size={13} strokeWidth={2.4} aria-hidden="true" />}
      {delta.text}
      {compare && <span className="mfa-sr"> {compare}</span>}
    </span>
  );
}

type KpiProps = {
  label: string;
  value: string;
  delta?: Delta | null;
  /** "vs the previous 30 days": said to screen readers and in the delta's title. */
  compare?: string;
  spark?: number[];
  sparkColor?: string;
  /** Another small picture in the sparkline's place. */
  visual?: ReactNode;
  hint?: ReactNode;
  /** One short fact under the value. */
  foot?: ReactNode;
  href?: string;
  hero?: boolean;
  tone?: 'danger' | 'warn';
};

/** A number that leads: the label, the value large, the change against the previous window, and the trend under it. */
export function Kpi({label, value, delta, compare, spark, sparkColor, visual, hint, foot, href, hero = false, tone}: KpiProps) {
  const body = (
    <>
      <div className="mfa-kpi-label">
        <span>{label}</span>
        {hint && <InfoTip text={hint} label={`${label}: how it is calculated`} />}
      </div>
      <div className="mfa-kpi-value">{value}</div>
      <div className="mfa-kpi-meta">
        <DeltaPill delta={delta ?? null} compare={compare} />
        {foot && <span className="mfa-kpi-foot">{foot}</span>}
      </div>
      {spark && spark.length > 1 && spark.some(value => value !== 0) && <Sparkline values={spark} height={hero ? 40 : 28} color={sparkColor} area dot className="mfa-kpi-spark" />}
      {visual && <div className="mfa-kpi-visual">{visual}</div>}
    </>
  );
  const className = `mfa-kpi${hero ? ' is-hero' : ''}${tone ? ` is-${tone}` : ''}`;
  return href ? <a className={className} href={href}>{body}</a> : <div className={className}>{body}</div>;
}

export function KpiSkeleton({hero = false}: {hero?: boolean}) {
  return (
    <div className={`mfa-kpi${hero ? ' is-hero' : ''}`} aria-hidden="true">
      <div className="mfa-skel" style={{width: '42%', height: 12}} />
      <div className="mfa-skel" style={{width: '64%', height: hero ? 34 : 24, marginTop: 12}} />
      <div className="mfa-skel" style={{width: '30%', height: 12, marginTop: 12}} />
      {hero && <div className="mfa-skel" style={{width: '100%', height: 40, marginTop: 14}} />}
    </div>
  );
}

type SectionProps = {
  title: string;
  hint?: ReactNode;
  /** Right of the title: a legend, a toggle, a link. */
  aside?: ReactNode;
  /** A count after the title. */
  count?: number | string;
  /** Columns of the 12-column grid. */
  span?: 3 | 4 | 5 | 6 | 7 | 8 | 12;
  alert?: {tone: 'danger' | 'warn' | 'info'; text: string};
  id?: string;
  children: ReactNode;
  className?: string;
};

/** A flat block under a hairline: the title (and its caveat), then what it shows. */
export function Section({title, hint, aside, count, span = 12, alert, id, children, className}: SectionProps) {
  const headingId = useId();
  return (
    <section className={`mfa-sec mfa-span-${span}${className ? ' ' + className : ''}`} aria-labelledby={headingId} id={id}>
      <header className="mfa-sec-head">
        <h2 id={headingId}>
          {title}
          {count !== undefined && <span className="mfa-sec-count">{count}</span>}
        </h2>
        {hint && <InfoTip text={hint} label={`${title}: how it is calculated`} />}
        {alert && <span className={`mfa-sec-alert is-${alert.tone}`}><i aria-hidden="true" />{alert.text}</span>}
        {aside && <div className="mfa-sec-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

const AVATAR_TINTS = 6;
const hashOf = (text: string) => {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return Math.abs(hash);
};

/** Initials on a soft tint chosen by the id (decoration: the name beside it says who it is). */
export function Avatar({id, name, email, size = 'md'}: {id: string; name: string; email?: string; size?: 'sm' | 'md' | 'lg'}) {
  return <span className={`mfa-avatar is-${size} is-tint-${hashOf(id) % AVATAR_TINTS}`} aria-hidden="true">{initials(name, email)}</span>;
}

export function SegmentPill({segment}: {segment: AccountSegment}) {
  return (
    <span className="mfa-pill">
      <i style={{background: SEGMENT_COLOR[segment]}} aria-hidden="true" />
      {SEGMENT_ONE[segment]}
    </span>
  );
}

export function Chip({children, tone}: {children: ReactNode; tone?: 'brand' | 'mono'}) {
  return <span className={`mfa-chip${tone ? ` is-${tone}` : ''}`}>{children}</span>;
}

/** A search field that writes after a short pause (the caller puts it in the address); it follows the address back and forward. */
export function SearchBox({value, onChange, placeholder, label, full = false}: {value: string; onChange: (value: string) => void; placeholder: string; label: string; full?: boolean}) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text.trim() === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text.trim();
      onChange(text.trim());
    }, 280);
    return () => clearTimeout(timer);
  }, [text, onChange]);
  return (
    <label className={`mfa-search${full ? ' is-full' : ''}`}>
      <Search size={16} strokeWidth={2} aria-hidden="true" />
      <input type="search" value={text} onChange={event => setText(event.target.value)} placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" />
      {text && (
        <button type="button" aria-label="Clear" onClick={() => setText('')}>
          <X size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </label>
  );
}

/** An id in monospace with a copy button. */
export function CopyId({id}: {id: string}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    }, () => undefined);
  };
  return (
    <button type="button" className="mfa-copy" onClick={copy} aria-label={copied ? 'Copied' : `Copy id ${id}`}>
      <span className="mfa-mono">{id}</span>
      {copied ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : <Copy size={13} strokeWidth={2} aria-hidden="true" />}
    </button>
  );
}

export function Empty({text, action}: {text: string; action?: ReactNode}) {
  return (
    <div className="mfa-empty">
      <span className="mfa-empty-mark" aria-hidden="true"><Inbox size={20} strokeWidth={1.8} /></span>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** The server's message, a retry, and the HTTP status and request id the log can find. */
export function Failure({error, onRetry, compact = false}: {error: Error; onRetry: () => void; compact?: boolean}) {
  const {message, status, requestId} = failureOf(error);
  return (
    <div className={`mfa-failure${compact ? ' is-compact' : ''}`} role="alert">
      <span className="mfa-failure-mark" aria-hidden="true" />
      <div className="mfa-failure-body">
        <p>{message}</p>
        {(status !== null || requestId) && (
          <small className="mfa-mono">
            {status !== null && `HTTP ${status}`}
            {status !== null && requestId && ' · '}
            {requestId && `request ${requestId}`}
          </small>
        )}
      </div>
      <button type="button" className="mfa-btn" onClick={onRetry}>
        <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}

/** A page's head: the only title on the screen and one line of numbers. */
export function PageHead({title, fact, leading, actions}: {title: ReactNode; fact?: ReactNode; leading?: ReactNode; actions?: ReactNode}) {
  return (
    <header className="mfa-head">
      {leading}
      <div className="mfa-head-text">
        <h1>{title}</h1>
        {fact && <p>{fact}</p>}
      </div>
      {actions && <div className="mfa-head-actions">{actions}</div>}
    </header>
  );
}
