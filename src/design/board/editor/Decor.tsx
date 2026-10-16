import {memo, useEffect, useRef} from 'react';
import type {SpatialIndex} from '../../../../shared/design/tree';
import {currentViewport, type DesignStore} from '../../engine/store';
import {drawBoardDecor} from '../tools/decor';

// The board's hints over the canvas (docs/board.md §Stickies): a canvas of its own the size of the canvas host, redrawn on an
// animation frame when the view, the document, the page or the text being edited changes, whatever tool is in hand. It takes no
// pointer events and is never exported (the renderer does not know it).

export const BoardDecor = memo(function BoardDecor({store, index}: {store: DesignStore; index: () => SpatialIndex | null}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const host = element?.parentElement;
    const ctx2d = element?.getContext('2d');
    if (!element || !host || !ctx2d) return;
    let frame = 0;
    const coarse = window.matchMedia('(pointer: coarse)');
    let size = {width: 0, height: 0};
    const draw = () => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(size.width * dpr), height = Math.round(size.height * dpr);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      const state = store.getState();
      drawBoardDecor(ctx2d, state, currentViewport(state), size, index(), coarse.matches);
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const resize = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) size = {width: box.width, height: box.height};
      request();
    });
    resize.observe(host);
    const rect = host.getBoundingClientRect();
    size = {width: rect.width, height: rect.height};
    request();
    const off = store.subscribe(request, {slice: ['viewport', 'doc', 'page', 'editing', 'hover', 'selection']});
    return () => {
      off();
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [store, index]);
  return <canvas ref={canvas} className="bd-decor" aria-hidden="true" />;
});
