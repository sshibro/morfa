import {useState} from 'react';
import {BrandMorph} from './brand/BrandMorph';

/** A load shorter than this shows nothing: the mark appears only once the wait is long enough to notice. */
const SHOW_AFTER_MS = 320;

/** What the app shows while it finds out who is here, or loads the design area: the mark, folding and unfolding. The
 *  moment it appears is counted from the start of the page, not from this mount, so the two waits that follow each other
 *  (the session, then the design area's code) show one steady mark instead of one that vanishes and starts again. */
export function Splash() {
  const [delay] = useState(() => Math.max(0, SHOW_AFTER_MS - performance.now()));
  return (
    <div className="mf-splash" role="status" style={{animationDelay: `${delay}ms`}}>
      <BrandMorph motion="loop" />
      <span className="mf-visually-hidden">Loading</span>
    </div>
  );
}
