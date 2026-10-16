import {useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type RefObject} from 'react';
import type {DesignDocument, NodeId} from '../../../shared/design/types';
import type {LibrarySnapshot} from '../../../shared/design/libraries';
import type {EditorServices} from '../editor/services';
import {ThumbnailPainter} from '../panels/left/thumbnails';
import {librarySession, onLibrarySessions, type LibrarySession, type LibrarySessionState} from './session';

// React access to an open file's library session (src/design/libraries/session.ts) for the dialogs and the assets panel.

export function useLibrarySession(services: EditorServices): LibrarySession | undefined {
  return useSyncExternalStore(onLibrarySessions, () => librarySession(services), () => undefined);
}

const NO_STATE = () => null;
const NO_SUBSCRIBE = () => () => {};
export function useLibraryState(session: LibrarySession | undefined): LibrarySessionState | null {
  return useSyncExternalStore(session?.subscribe ?? NO_SUBSCRIBE, session?.getState ?? NO_STATE, NO_STATE);
}

export type Loaded<T> = {status: 'loading'} | {status: 'error'; error: string} | {status: 'ready'; value: T};

/** A library version's snapshot, fetched once per session (null skips: a closed section asks for nothing). */
export function useSnapshot(session: LibrarySession | undefined, libraryId: string | null, version: number | null): Loaded<LibrarySnapshot> {
  const [state, setState] = useState<Loaded<LibrarySnapshot>>({status: 'loading'});
  useEffect(() => {
    if (!session || !libraryId || !version) return;
    let live = true;
    setState({status: 'loading'});
    session.snapshot(libraryId, version).then(
      value => live && setState({status: 'ready', value}),
      error => live && setState({status: 'error', error: error instanceof Error ? error.message : 'Could not load the library.'}),
    );
    return () => {
      live = false;
    };
  }, [session, libraryId, version]);
  return state;
}

/** A thumbnail painter for a snapshot's document (or the open file's, without one), dropped with it. */
export function useSnapshotPainter(services: EditorServices, doc: DesignDocument | null): ThumbnailPainter {
  const painter = useMemo(() => new ThumbnailPainter(services, doc ? () => doc : undefined), [services, doc]);
  useEffect(() => () => painter.dispose(), [painter]);
  return painter;
}

/** Paints a node's thumbnail into the canvas while it is on screen. */
export function useThumbnail(canvas: RefObject<HTMLCanvasElement | null>, painter: ThumbnailPainter, id: NodeId, version: number, size: number): void {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(each => each.isIntersecting)), {rootMargin: '64px'});
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  useEffect(() => {
    const element = canvas.current;
    return () => {
      if (element) painter.cancel(element);
    };
  }, [canvas, painter]);
  useLayoutEffect(() => {
    if (visible && canvas.current) painter.draw(canvas.current, id, version, size, size);
  }, [visible, version, size, id, painter, canvas]);
}

export const errorText = (error: unknown, fallback = 'Could not complete the action.') => (error instanceof Error && error.message ? error.message : fallback);

export const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** "12 components · 4 styles · 1 collection". */
export function manifestSummary(manifest: LibrarySnapshot['manifest']): string {
  const parts: string[] = [];
  if (manifest.components.length) parts.push(count(manifest.components.length, 'component', 'components'));
  if (manifest.styles.length) parts.push(count(manifest.styles.length, 'style', 'styles'));
  if (manifest.variableCollections.length) parts.push(count(manifest.variableCollections.length, 'collection', 'collections'));
  return parts.join(' · ') || 'Empty';
}
