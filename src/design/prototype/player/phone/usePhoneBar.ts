import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import {usePhone} from '../../../ui/viewport';

// The player's bar on a phone (Figma's app hides its prototype menu): the
// prototype is full-bleed and the bar is away. A tap where there is no hotspot shows it for a few seconds, and so does a
// two-finger press-and-hold; touching the bar keeps it. It always has "Close", so the way out is never a secret.

/** ms the bar stays after it was shown or last touched. */
export const BAR_SHOWN_MS = 4000;
/** ms two fingers are held still before the bar shows. */
const HOLD_MS = 500;

export function usePhoneBar(stage: RefObject<HTMLElement | null>, bar: RefObject<HTMLElement | null>) {
  const phone = usePhone();
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    setShown(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), BAR_SHOWN_MS);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Two fingers held on the stage.
  useEffect(() => {
    const element = stage.current;
    if (!phone || !element) return;
    const fingers = new Set<number>();
    let hold: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (hold) clearTimeout(hold);
      hold = null;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      fingers.add(event.pointerId);
      stop();
      if (fingers.size === 2) hold = setTimeout(show, HOLD_MS);
    };
    const up = (event: PointerEvent) => {
      fingers.delete(event.pointerId);
      stop();
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', up, true);
    return () => {
      stop();
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', up, true);
    };
  }, [phone, stage, show]);

  // A touch on the bar keeps it.
  useEffect(() => {
    const element = bar.current;
    if (!phone || !element) return;
    element.addEventListener('pointerdown', show, true);
    return () => element.removeEventListener('pointerdown', show, true);
  }, [phone, bar, show]);

  return {hidden: phone && !shown, show: phone ? show : () => undefined};
}
