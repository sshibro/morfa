import {useEffect, useRef} from 'react';
import type {DesignStore} from '../../engine/store';
import {followKeyboard} from '../../editor/phone/keyboard';
import {blockPageZoom, installLongPress} from '../../editor/phone/long-press';
import {usePhone} from '../../ui/viewport';

/** The board on a phone: what the design editor's phone frame does besides its layout — a sticky or a
 *  comment being typed stays above the on-screen keyboard, a long press is the right click, Safari never zooms the page.
 *  Renders an empty marker inside the board's frame and does nothing on a wider screen. */
export function PhoneBoard({store}: {store: DesignStore}) {
  const phone = usePhone();
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = marker.current?.closest<HTMLElement>('.dz-board');
    if (!phone || !root) return;
    const stops = [installLongPress(root), blockPageZoom(), followKeyboard(root, store, () => root.getBoundingClientRect().top)];
    return () => stops.forEach(stop => stop());
  }, [phone, store]);
  return <span ref={marker} hidden />;
}
