import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {DesignDocument, NodeId, VectorPath} from '../../../shared/design/types';
import {booleanGeometry} from '../../../shared/design/boolean';
import {defaultPageBackground} from '../../../shared/design/defaults';
import type {Viewport} from '../engine/contracts';
import type {DesignFontRegistry} from '../engine/fonts';
import type {DesignImageCache} from '../engine/images';
import {createSceneRenderer, type DesignSceneRenderer} from '../engine/render';
import {fitPage, wheelToViewport, zoomAround, zoomStep} from '../engine/viewport';
import {Button} from '../ui/Button';
import {IconClock} from '../ui/icons';
import {Select} from '../ui/Select';
import {Spinner} from '../ui/Spinner';
import {useResolvedTheme} from '../ui/theme';

// A version shown read-only over the canvas, painted by its own tiled renderer (the same paintNodeTree
// path as the canvas, exports and thumbnails). Wheel and drag move around it; ⇧1 fits the page again.
// The banner says which version this is and offers the two ways out: restore it or go back.

const NO_LABELS: ReadonlySet<NodeId> = new Set();
/** The banner's band at the top, kept clear when the page is fitted. */
const BANNER_SPACE = 56;

const safeBoolean = (doc: DesignDocument, id: NodeId): readonly VectorPath[] | null => {
  try {
    return booleanGeometry(doc, id);
  } catch {
    return null;
  }
};

export type VersionPreviewProps = {
  /** The version's document; null while it loads. */
  doc: DesignDocument | null;
  error: string | null;
  onRetry: () => void;
  fonts: DesignFontRegistry;
  images: DesignImageCache;
  /** "You are viewing the version saved today at 14:05", with the name of a named version. */
  title: string;
  onBack: () => void;
  onRestore: () => void;
  restoring: boolean;
  /** Restoring needs the editor's autosave; without it the button says why it is off. */
  restoreUnavailable?: string;
  /** The page the editor shows, opened first when the version has it. */
  pageId?: NodeId;
  /** The page picked in the banner, when the host keeps it (the version's "Layers" follow it). */
  page?: NodeId | null;
  onPageChange?: (page: NodeId) => void;
};

/** The page of `doc` a preview shows: the one picked, else the editor's page when the version has it, else its first. */
export function versionPage(doc: DesignDocument, picked: NodeId | null | undefined, editorPage: NodeId | undefined): NodeId {
  if (picked && doc.nodes[picked]?.type === 'PAGE') return picked;
  if (editorPage && doc.nodes[editorPage]?.type === 'PAGE') return editorPage;
  return doc.pages[0];
}

export function VersionPreview({doc, error, onRetry, fonts, images, title, onBack, onRestore, restoring, restoreUnavailable, pageId, ...props}: VersionPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<DesignSceneRenderer | null>(null);
  const view = useRef<{viewport: Viewport | null; size: {width: number; height: number}; dpr: number}>({viewport: null, size: {width: 0, height: 0}, dpr: 1});
  const [ownPage, setOwnPage] = useState<NodeId | null>(null);
  const page = props.onPageChange ? props.page ?? null : ownPage;
  const setPage = props.onPageChange ?? setOwnPage;

  const shownPage = doc ? versionPage(doc, page, pageId) : null;
  const pages = useMemo(() => (doc ? doc.pages.map(id => ({value: id, label: doc.nodes[id]?.name || 'Page'})) : []), [doc]);

  // A page without its own colour shows the theme's canvas, as the editor does.
  const theme = useResolvedTheme();
  const background = useMemo(() => defaultPageBackground(theme), [theme]);
  const draw = useRef(() => {});
  draw.current = () => {
    const target = canvas.current, scene = renderer.current, state = view.current;
    if (!target || !scene || !doc || !shownPage || !state.viewport || !state.size.width) return;
    scene.render({doc, pageId: shownPage, viewport: state.viewport, size: state.size, dpr: state.dpr, labels: {selected: NO_LABELS}, background});
  };
  useEffect(() => draw.current(), [background]);

  // The renderer lives as long as the preview; a new version reuses it (it compares documents by identity).
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    try {
      renderer.current = createSceneRenderer(element, {fonts, images, booleanGeometry: safeBoolean});
    } catch {
      renderer.current = null;
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [fonts, images]);

  // Size: the canvas backs every CSS pixel with devicePixelRatio pixels.
  useLayoutEffect(() => {
    const element = host.current, target = canvas.current;
    if (!element || !target) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
      const state = view.current;
      if (width === state.size.width && height === state.size.height && dpr === state.dpr) return;
      state.size = {width, height};
      state.dpr = dpr;
      target.width = Math.round(width * dpr);
      target.height = Math.round(height * dpr);
      draw.current();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new document or page opens fitted (never magnified past 100 %), below the banner.
  const fit = (maxZoom?: number) => {
    const size = view.current.size.width ? view.current.size : {width: 800, height: 600};
    const fitted = fitPage(doc!, shownPage!, {width: size.width, height: Math.max(1, size.height - BANNER_SPACE)}, maxZoom);
    return {...fitted, y: fitted.y - BANNER_SPACE / fitted.zoom};
  };
  useLayoutEffect(() => {
    if (!doc || !shownPage) return;
    view.current.viewport = fit(1);
    draw.current();
  }, [doc, shownPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel: pan, ⌘/Ctrl or pinch zooms around the pointer. Not passive, so the page itself never scrolls.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const state = view.current;
      if (!state.viewport) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      state.viewport = wheelToViewport(state.viewport, event, {x: event.clientX - rect.left, y: event.clientY - rect.top});
      draw.current();
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  // Keys: ⇧1 fits, ⌘+ / ⌘− zoom; Escape goes back to the current version.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], .dz-dialog, .dz-menu')) return;
      const state = view.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        onBackRef.current();
        return;
      }
      if (!doc || !shownPage || !state.viewport) return;
      const mod = event.metaKey || event.ctrlKey;
      const centre = {x: state.size.width / 2, y: state.size.height / 2};
      if (event.code === 'Digit1' && event.shiftKey && !mod) state.viewport = fit();
      else if (mod && (event.code === 'Equal' || event.code === 'NumpadAdd')) state.viewport = zoomAround(state.viewport, centre, zoomStep(state.viewport.zoom, 1));
      else if (mod && (event.code === 'Minus' || event.code === 'NumpadSubtract')) state.viewport = zoomAround(state.viewport, centre, zoomStep(state.viewport.zoom, -1));
      else if (mod && event.code === 'Digit0') state.viewport = zoomAround(state.viewport, centre, 1);
      else return;
      event.preventDefault();
      event.stopPropagation();
      draw.current();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [doc, shownPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // Drag to pan, with any button (the preview has nothing to select).
  const drag = useRef<{id: number; x: number; y: number} | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  return (
    <div className="dz-version-preview" role="region" aria-label="Version preview">
      <div ref={host} className={`dz-version-canvas ${grabbing ? 'is-grabbing' : ''}`.trim()}
        onPointerDown={event => {
          if (drag.current) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY};
          setGrabbing(true);
        }}
        onPointerMove={event => {
          const start = drag.current, state = view.current;
          if (!start || start.id !== event.pointerId || !state.viewport) return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          start.x = event.clientX;
          start.y = event.clientY;
          state.viewport = {...state.viewport, x: state.viewport.x - dx / state.viewport.zoom, y: state.viewport.y - dy / state.viewport.zoom};
          draw.current();
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          drag.current = null;
          setGrabbing(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setGrabbing(false);
        }}
        onContextMenu={event => event.preventDefault()}>
        <canvas ref={canvas} className="dz-version-scene" aria-hidden="true" />
      </div>

      {!doc && !error && <Spinner size={20} className="dz-version-loading" label="Loading the version" />}
      {error && (
        <div className="dz-version-failed" role="alert">
          <p>{error}</p>
          <Button size={32} onClick={onRetry}>Retry</Button>
        </div>
      )}

      <div className="dz-version-banner" role="status">
        <span className="dz-version-banner-icon" aria-hidden="true"><IconClock /></span>
        <span className="dz-version-banner-text" title={title}>{title}</span>
        {pages.length > 1 && shownPage && (
          <Select aria-label="Version page" appearance="quiet" value={shownPage} options={pages} onChange={setPage} className="dz-version-page" />
        )}
        <span className="dz-version-banner-actions">
          <Button size={32} variant="ghost" onClick={onBack}>Back to current</Button>
          <Button size={32} variant="primary" busy={restoring} disabled={!doc || !!restoreUnavailable} title={restoreUnavailable} onClick={onRestore}>Restore</Button>
        </span>
      </div>
    </div>
  );
}
