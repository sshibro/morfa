import '../../styles/prototype.css';
import '../../styles/phone-player.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {ApiError} from '../../../api';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {DevicePreset} from '../../../../shared/design/prototype';
import {openDesignFile} from '../../api';
import {createFontRegistry} from '../../engine/fonts';
import {createImageCache} from '../../engine/images';
import {Button, IconButton} from '../../ui/Button';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {IconChevronDown, IconChevronLeft, IconChevronRight, IconClose, IconFile, IconLink, IconOffline, IconRestore} from '../../ui/icons';
import {EmptyState} from '../../ui/ProgressBar';
import {Spinner} from '../../ui/Spinner';
import {subscribeEditorFeed} from '../feed';
import {IconProtoActualSize, IconProtoExitFullscreen, IconProtoFit, IconProtoFlow, IconProtoFullscreen, IconProtoHotspots} from '../icons';
import {editorHash, presentHash} from '../route';
import {PlayerEngine, type PlayerInfo} from './engine';
import {usePhoneBar} from './phone/usePhoneBar';

// "Player": a prototype presented in its own tab (#design/<fileId>?present=<frameId>), on a dark
// stage, optionally inside a neutral device frame drawn in CSS. The document comes live from the
// editor tab that opened it (feed.ts), or from the saved file when no editor answers. The canvas and
// everything that happens on it belong to PlayerEngine; this shell only lays it out.

type Load = {status: 'loading'} | {status: 'ready'; doc: DesignDocument} | {status: 'error'; error: unknown};
type Mode = 'fit' | 'actual';
const MODE_KEY = 'morfa-design-player-mode';
const STAGE_PADDING = 32;
const COMPACT = '(max-width: 600px) and (pointer: coarse)';

/** Whether the page is full screen, and the toggle (null where the browser does not allow it, as in a frame). */
function useFullscreen(): {on: boolean; toggle: (() => void) | null} {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const changed = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  return {on, toggle: typeof document !== 'undefined' && document.fullscreenEnabled ? toggle : null};
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const changed = () => setMatches(list.matches);
    changed();
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, [query]);
  return matches;
}

export type PlayerProps = {fileId: string; frameId: NodeId};

export default function Player({fileId, frameId}: PlayerProps) {
  const [load, setLoad] = useState<Load>({status: 'loading'});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = false;
    const off = subscribeEditorFeed(fileId, doc => {
      live = true;
      setLoad({status: 'ready', doc});
    });
    const controller = new AbortController();
    // An open editor answers within a frame or two; without one the saved file is read.
    const timer = setTimeout(() => {
      if (live) return;
      openDesignFile(fileId, controller.signal)
        .then(opened => {
          if (!live && !controller.signal.aborted) setLoad({status: 'ready', doc: opened.document});
        })
        .catch(error => {
          if (!live && !controller.signal.aborted) setLoad({status: 'error', error});
        });
    }, 300);
    return () => {
      off();
      clearTimeout(timer);
      controller.abort();
    };
  }, [fileId, attempt]);

  const close = useCallback(() => {
    window.close();
    // A tab the player did not open itself cannot close: go back to the editor instead.
    setTimeout(() => {
      if (!window.closed) location.hash = editorHash(fileId);
    }, 120);
  }, [fileId]);

  if (load.status === 'error') {
    const missing = load.error instanceof ApiError && load.error.status === 404;
    return (
      <div className="dz dz-player" data-theme="dark">
        <div className="dz-player-state">
          {missing ? (
            <EmptyState icon={<IconFile />} title="File not found" actions={<Button size={32} onClick={close}>Close</Button>}>It may have been deleted or moved to the trash.</EmptyState>
          ) : (
            <EmptyState tone="error" icon={<IconOffline />} title="Could not open the prototype" actions={<Button size={32} variant="primary" onClick={() => {
              setLoad({status: 'loading'});
              setAttempt(value => value + 1);
            }}>Try again</Button>}>
              {load.error instanceof Error ? load.error.message : 'Check your connection and try again.'}
            </EmptyState>
          )}
        </div>
      </div>
    );
  }
  return <Presentation fileId={fileId} frameId={frameId} doc={load.status === 'ready' ? load.doc : null} onClose={close} />;
}

function Presentation({fileId, frameId, doc, onClose}: {fileId: string; frameId: NodeId; doc: DesignDocument | null; onClose: () => void}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const engine = useRef<PlayerEngine | null>(null);
  const [info, setInfo] = useState<PlayerInfo | null>(null);
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'actual' ? 'actual' : 'fit';
    } catch {
      return 'fit';
    }
  });
  const [hotspots, setHotspots] = useState(false);
  const fullscreen = useFullscreen();
  // The page's flows, as Figma's presentation lists them: picking one starts it (the address changes, so a reload keeps it).
  const flows = info?.flows ?? [];
  const flowStart = info?.flowStart ?? null;
  const flowMenu = useMenuTrigger({
    label: 'Flows',
    minWidth: 200,
    items: useCallback((): MenuItem[] => [
      {type: 'label', label: 'Flows'},
      ...flows.map((flow): MenuItem => ({id: flow.nodeId, label: flow.name, checked: flow.nodeId === flowStart, radio: true, onSelect: () => {
        if (flow.nodeId === flowStart) engine.current?.restart();
        else location.hash = presentHash(fileId, flow.nodeId);
      }})),
    ], [flows, flowStart, fileId]),
  });
  const [stageSize, setStageSize] = useState({width: 0, height: 0});
  const barElement = useRef<HTMLElement>(null);
  const phoneBar = usePhoneBar(stage, barElement);
  const showBar = useRef(phoneBar.show);
  showBar.current = phoneBar.show;
  const deps = useMemo(() => ({fonts: createFontRegistry(), images: createImageCache(), onMissTap: () => showBar.current()}), []);

  useEffect(() => {
    const created = new PlayerEngine(canvas.current!, deps, setInfo);
    engine.current = created;
    return () => {
      created.dispose();
      engine.current = null;
    };
  }, [deps]);
  useEffect(() => {
    if (doc) engine.current?.setDocument(doc, frameId);
  }, [doc, frameId]);
  useEffect(() => engine.current?.setShowHotspots(hotspots), [hotspots]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setStageSize({width: element.clientWidth, height: element.clientHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // On a phone the prototype is the phone: no bezel, the whole stage.
  const compact = useMediaQuery(COMPACT);
  const device = compact ? null : info?.device ?? null;
  const chrome = chromeOf(device?.preset ?? null, device?.landscape ?? false);
  const padding = compact ? 0 : STAGE_PADDING;
  const screen = info?.screen ?? {width: 0, height: 0};
  const outer = {width: screen.width + chrome.left + chrome.right + chrome.extraX * 2, height: screen.height + chrome.top + chrome.bottom + chrome.extraBottom};
  const fit = mode === 'actual' || !screen.width || !stageSize.width
    ? 1
    : Math.max(0.05, Math.min((stageSize.width - 2 * padding) / outer.width, (stageSize.height - 2 * padding) / outer.height));
  useLayoutEffect(() => {
    if (screen.width) engine.current?.setDisplay(fit);
  }, [fit, screen.width]);
  // A change of screen resolution (another monitor) repaints at the new density.
  useEffect(() => {
    let query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const changed = () => {
      engine.current?.setDisplay(fit, window.devicePixelRatio || 1);
      query.removeEventListener('change', changed);
      query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', changed);
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, [fit]);

  // The browser's own chrome matches the dark stage while presenting.
  useLayoutEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const previous = meta?.getAttribute('content');
    meta?.setAttribute('content', '#2C2C2C');
    return () => {
      if (meta && previous) meta.setAttribute('content', previous);
    };
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = info?.frameName ? `${info.frameName} — Player` : 'Player — Design';
    return () => {
      document.title = previous;
    };
  }, [info?.frameName]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  // The prototype's address: it opens for the people who can open the file (a team's members), at this flow's start.
  // "Link copied" shows, then fades out with its text still there, then leaves.
  const [copied, setCopied] = useState<'shown' | 'hiding' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(copied === 'shown' ? 'hiding' : null), copied === 'shown' ? 1800 : 200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyLink = () => {
    const start = info?.flowStart ?? frameId;
    const url = location.origin + location.pathname + presentHash(fileId, start);
    void navigator.clipboard?.writeText(url).then(() => setCopied('shown'), () => {});
  };

  const toggleMode = () => {
    const next = mode === 'fit' ? 'actual' : 'fit';
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private windows: the choice lasts this visit.
    }
  };

  const loading = !doc || !info || (!info.ready && !info.missing);
  const style = {'--dz-player-backdrop': info?.background ?? '#1e1e1e'} as CSSProperties;
  const k = fit;
  return (
    <div className={`dz dz-player ${phoneBar.hidden ? 'is-bar-hidden' : ''}`.trim()} data-theme="dark" style={style}>
      <header ref={barElement} className="dz-player-bar">
        <div className="dz-player-title">
          {info?.flowName && (flows.length > 1 ? (
            <>
              <button type="button" className="dz-player-flow is-menu" {...flowMenu.triggerProps} aria-label={`Flow “${info.flowName}”: choose another`}>
                <IconProtoFlow /><span className="dz-player-flow-name">{info.flowName}</span><IconChevronDown size={12} />
              </button>
              {flowMenu.element}
              <span className="dz-player-slash" aria-hidden="true">/</span>
            </>
          ) : <><span className="dz-player-flow"><IconProtoFlow />{info.flowName}</span><span className="dz-player-slash" aria-hidden="true">/</span></>)}
          <span className="dz-player-frame">{info?.frameName || 'Prototype'}</span>
          {info && info.flowLength > 1 && info.flowIndex >= 0 && <span className="dz-player-count">{info.flowIndex + 1} of {info.flowLength}</span>}
        </div>
        <div className="dz-player-tools">
          <IconButton label="Restart" shortcut="KeyR" onClick={() => engine.current?.restart()} disabled={!info?.frameId}><IconRestore /></IconButton>
          <IconButton label="Previous screen" shortcut="ArrowLeft" onClick={() => engine.current?.step(-1)} disabled={!info || info.flowIndex <= 0}><IconChevronLeft /></IconButton>
          <IconButton label="Next screen" shortcut="ArrowRight" onClick={() => engine.current?.step(1)} disabled={!info || info.flowIndex < 0 || info.flowIndex >= info.flowLength - 1}><IconChevronRight /></IconButton>
          <span className="dz-player-divider" aria-hidden="true" />
          <IconButton label="Show hotspots" pressed={hotspots} onClick={() => setHotspots(!hotspots)}><IconProtoHotspots /></IconButton>
          <IconButton label={mode === 'fit' ? 'Zoom to 100%' : 'Zoom to fit'} onClick={toggleMode}>{mode === 'fit' ? <IconProtoActualSize /> : <IconProtoFit />}</IconButton>
          {fullscreen.toggle && (
            <IconButton label={fullscreen.on ? 'Exit full screen' : 'Full screen'} onClick={fullscreen.toggle}>
              {fullscreen.on ? <IconProtoExitFullscreen /> : <IconProtoFullscreen />}
            </IconButton>
          )}
          <span className="dz-player-divider" aria-hidden="true" />
          <span className={`dz-player-copied ${copied === 'shown' ? 'is-shown' : ''}`.trim()} role="status">{copied ? 'Link copied' : ''}</span>
          <IconButton label="Copy prototype link — anyone with access to the file can open it" onClick={copyLink}><IconLink /></IconButton>
          <IconButton label="Close player" shortcut="Escape" onClick={onClose}><IconClose /></IconButton>
        </div>
      </header>
      <main ref={stage} className={`dz-player-stage ${mode === 'actual' ? 'is-actual' : ''}`} aria-label="Prototype">
        {info?.missing ? (
          <div className="dz-player-state">
            <EmptyState icon={<IconFile />} title="Frame not found" actions={<Button size={32} onClick={() => {location.hash = editorHash(fileId);}}>Open file</Button>}>
              This frame is no longer on the page. Run the prototype from the editor again.
            </EmptyState>
          </div>
        ) : null}
        <div className={`dz-player-device is-${device?.preset.kind ?? 'none'} ${device?.landscape ? 'is-landscape' : ''} ${loading || info?.missing ? 'is-hidden' : ''}`}
          style={{
            padding: `${chrome.top * k}px ${chrome.right * k}px ${chrome.bottom * k}px ${chrome.left * k}px`,
            borderRadius: device ? (device.preset.screenRadius + chrome.top) * k : 0,
            marginBottom: chrome.extraBottom * k,
          }}>
          <div className="dz-player-screen" style={{width: screen.width * k, height: screen.height * k, borderRadius: (device?.preset.screenRadius ?? 0) * k}}>
            <canvas ref={canvas} className="dz-player-canvas" role="img" aria-label={info?.frameName ? `Screen “${info.frameName}”` : 'Prototype'} />
            {device?.preset.cutout === 'island' && <span className="dz-player-island" style={islandStyle(k, device.landscape)} aria-hidden="true" />}
            {device?.preset.cutout === 'punch' && <span className="dz-player-punch" style={punchStyle(k, device.landscape)} aria-hidden="true" />}
          </div>
          {device?.preset.kind === 'laptop' && <span className="dz-player-base" style={{height: chrome.extraBottom * k, left: -chrome.extraX * k, right: -chrome.extraX * k, bottom: -chrome.extraBottom * k}} aria-hidden="true" />}
          {device?.preset.kind === 'desktop' && <span className="dz-player-stand" style={{height: chrome.extraBottom * k, bottom: -chrome.extraBottom * k, width: Math.min(260, screen.width * 0.22) * k}} aria-hidden="true" />}
        </div>
        {loading && !info?.missing && <div className="dz-player-loading"><Spinner size={20} label="Loading fonts and images" /></div>}
      </main>
    </div>
  );
}

type Chrome = {top: number; right: number; bottom: number; left: number; extraBottom: number; extraX: number};

/** The device's frame around the screen, CSS px at 100 %. */
function chromeOf(preset: DevicePreset | null, landscape: boolean): Chrome {
  switch (preset?.kind) {
    case 'phone': return {top: 12, right: 12, bottom: 12, left: 12, extraBottom: 0, extraX: 0};
    case 'tablet': return {top: 20, right: 20, bottom: 20, left: 20, extraBottom: 0, extraX: 0};
    case 'laptop': return {top: 16, right: 16, bottom: 22, left: 16, extraBottom: 16, extraX: Math.round((preset.width || 0) * 0.06)};
    case 'desktop': return {top: 16, right: 16, bottom: 28, left: 16, extraBottom: 72, extraX: 0};
    default: return {top: 0, right: 0, bottom: 0, left: 0, extraBottom: landscape ? 0 : 0, extraX: 0};
  }
}

function islandStyle(k: number, landscape: boolean): CSSProperties {
  const long = 124 * k, short = 36 * k, inset = 11 * k;
  return landscape
    ? {left: inset, top: '50%', width: short, height: long, marginTop: -long / 2, borderRadius: short / 2}
    : {top: inset, left: '50%', width: long, height: short, marginLeft: -long / 2, borderRadius: short / 2};
}

function punchStyle(k: number, landscape: boolean): CSSProperties {
  const size = 12 * k, inset = 12 * k;
  return landscape ? {left: inset, top: '50%', width: size, height: size, marginTop: -size / 2} : {top: inset, left: '50%', width: size, height: size, marginLeft: -size / 2};
}
