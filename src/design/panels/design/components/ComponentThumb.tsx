import {memo, useEffect, useRef} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import {defaultPageBackground, pageBackground} from '../../../../../shared/design/defaults';
import {worldBox} from '../../../../../shared/design/geometry';
import {pageIdOf} from '../../../../../shared/design/tree';
import {defaultVariant} from '../../../../../shared/design/components';
import {cssColor} from '../../../ui/ColorSwatch';
import {paintNodeTree} from '../../../engine/render/painter';
import type {EditorServices} from '../../../editor/services';
import {useResolvedTheme} from '../../../ui/theme';

// A component's picture in the swap menu: painted with the canvas's own painter (paintNodeTree) on its
// page's background, fitted into the tile, once the tile scrolls into view. Pictures and fonts that
// arrive later repaint it.

type Props = {services: EditorServices; id: NodeId; width: number; height: number; root?: Element | null};

export const ComponentThumb = memo(function ComponentThumb({services, id, width, height, root}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useResolvedTheme();
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let visible = false, frame = 0;
    const paint = () => {
      frame = 0;
      if (!visible) return;
      const doc = services.store.getState().doc;
      const ctx = element.getContext('2d');
      if (!ctx || !doc.nodes[id]) return;
      const dpr = window.devicePixelRatio || 1;
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      // On the background of the page the component stands on, as the designer sees it there (a dark
      // icon stays visible in the dark theme).
      const pageId = pageIdOf(doc, id);
      ctx.fillStyle = cssColor(pageBackground(pageId ? doc.nodes[pageId] : undefined, defaultPageBackground(theme)));
      ctx.fillRect(0, 0, element.width, element.height);
      // A set shows its default variant, as instances of it do.
      const root = doc.nodes[id].type === 'COMPONENT_SET' ? defaultVariant(doc, id) ?? id : id;
      const box = worldBox(doc, root);
      const pad = 3;
      const scale = Math.min((width - pad * 2) / Math.max(box.width, 1e-6), (height - pad * 2) / Math.max(box.height, 1e-6), 2);
      const x = (width - box.width * scale) / 2 - box.x * scale, y = (height - box.height * scale) / 2 - box.y * scale;
      try {
        paintNodeTree({ctx, transform: [[scale * dpr, 0, x * dpr], [0, scale * dpr, y * dpr]], scale: scale * dpr}, doc, [root], {images: services.images, fonts: services.fonts, minSize: 0.5});
      } catch {
        // A picture that cannot paint leaves the tile empty; the menu still works.
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) schedule();
    }, {root: root ?? null, rootMargin: '64px'});
    observer.observe(element);
    const offImages = services.images.onChange(schedule);
    const offFonts = services.fonts.onLoad(schedule);
    return () => {
      observer.disconnect();
      offImages();
      offFonts();
      cancelAnimationFrame(frame);
    };
  }, [services, id, width, height, root, theme]);
  return <canvas ref={canvas} className="dz-cmp-thumb-canvas" style={{width, height}} aria-hidden="true" />;
});
