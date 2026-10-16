// "Morfa": the lazily loaded root of the design area (#designs, #design/<fileId>). App renders
// it instead of the app shell and reaches it only through import(), so nothing here enters the
// app's first load. Its font and stylesheets load with this chunk, and every rule is scoped under
// `.dz`; the design language is the tool's own (docs/design-tool.md §Design language).
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/overlays.css';
import './styles/editor.css';
import './styles/files.css';
import './styles/phone-shell.css';
import './styles/phone-shell-overlays.css';
import {lazy, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore, type Ref} from 'react';
import {FileBrowser} from './files/FileBrowser';
import {recordViewed} from './files/viewed';
import {presentedFrame} from './prototype/route';
import {DesignSaveContext, type DesignHandle, type SaveFlush} from './editor/chrome/save-registration';
import {openEarly} from './editor/open-file';
import {DzScope} from './ui/layer';
import {Spinner} from './ui/Spinner';
import {ToastHost} from './ui/Toast';
import {TooltipLayer} from './ui/Tooltip';
import {useResolvedTheme} from './ui/theme';
// The support chat (src/support): its host listens for "Contact support" everywhere in the area; the panel is its own chunk.
import {SupportHost} from '../support/SupportHost';

export type {DesignHandle} from './editor/chrome/save-registration';

// The editor (and later the engine) is its own chunk: the file browser opens without it.
const DesignEditor = lazy(() => import('./editor/DesignEditor'));
// The prototype player, `#design/<fileId>?present=<frameId>` (src/design/prototype/open-player.ts):
// its own chunk too, opened in a new tab by ▶ and the flows' "Run".
const Player = lazy(() => import('./prototype/player/Player'));

const subscribeHash = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};
const presentedNow = () => presentedFrame(location.hash);

const THEME_COLOR = {light: '#FFFFFF', dark: '#2C2C2C'} as const;

export type DesignRootProps = {
  /** null: the file browser (#designs); an id: that file in the editor (#design/<id>). */
  fileId: string | null;
  /** App awaits `save()` before it leaves the area (src/App.tsx `transition`). */
  ref?: Ref<DesignHandle>;
};

export default function DesignRoot({fileId, ref}: DesignRootProps) {
  const theme = useResolvedTheme();
  const presented = useSyncExternalStore(subscribeHash, presentedNow, presentedNow);
  const flush = useRef<SaveFlush | null>(null);
  const register = useCallback((next: SaveFlush | null) => {
    flush.current = next;
  }, []);
  useImperativeHandle(ref, () => ({save: () => (flush.current ? flush.current() : Promise.resolve())}), []);

  // The browser chrome follows the tool while it is open, and gets the app's back afterwards.
  useLayoutEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const previous = meta?.getAttribute('content');
    meta?.setAttribute('content', THEME_COLOR[theme]);
    return () => {if (meta && previous) meta.setAttribute('content', previous);};
  }, [theme]);
  useEffect(() => {
    const previous = document.title;
    return () => {document.title = previous;};
  }, []);
  useEffect(() => {
    if (!fileId) document.title = 'Design — files';
    // The file browser's "Viewed" sort: when each file was last opened here (files/viewed.ts).
    else recordViewed(fileId);
  }, [fileId]);
  // The file's read starts beside the editor's chunk, not after it (lane O, editor/open-file.ts). A layout effect: it runs before
  // the editor's own (passive) effect when both mount in one commit.
  useLayoutEffect(() => {
    if (fileId && !presented) openEarly(fileId);
  }, [fileId, presented]);

  return (
    <DzScope className="dz-root" theme={theme}>
      <DesignSaveContext.Provider value={register}>
        <ToastHost>
          {fileId && presented ? (
            <Suspense fallback={<div className="dz-editor-state"><Spinner size={20} label="Opening the player" /></div>}>
              <Player key={fileId} fileId={fileId} frameId={presented} />
            </Suspense>
          ) : fileId ? (
            <Suspense fallback={<div className="dz-editor-state"><Spinner size={20} label="Opening the editor" /></div>}>
              <DesignEditor key={fileId} fileId={fileId} />
            </Suspense>
          ) : (
            <FileBrowser />
          )}
        </ToastHost>
      </DesignSaveContext.Provider>
      <SupportHost />
      <TooltipLayer />
    </DzScope>
  );
}
