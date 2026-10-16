import {designIdFromHash, requestNavigation} from '../navigation';
import {installLocalFonts} from './fonts';
import {desktopFontsReady, desktopHost, watchEditorMenu, type EditorMenuSource} from './host';
import {createHost, tauriCore, type Host, type HostEvent, type TauriCore} from './ipc';
import {runMenuCommand, webMenu} from './menu';

// The web side of the desktop app (docs/desktop.md). Loaded only inside the shell (host.ts `startDesktop`), never in
// a browser. It connects to the shell, installs local fonts, routes file open/save through native dialogs, keeps the
// native menu in step with the editor's, and tells the shell which file the window shows.

/** A short message at the bottom of the window (the bridge has no React tree to toast through). */
function notice(text: string, doc: Document = document) {
  const box = doc.createElement('div');
  box.setAttribute('role', 'status');
  box.textContent = text;
  Object.assign(box.style, {
    position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647', maxWidth: '480px',
    padding: '8px 14px', borderRadius: '6px', background: '#18181b', color: '#fff', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.25)',
  } satisfies Partial<CSSStyleDeclaration>);
  doc.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : typeof error === 'string' && error ? error : fallback);

export type BridgeOptions = {
  core?: TauriCore;
  scope?: Window & typeof globalThis;
  /** How long menu changes wait before going to the shell. */
  menuDelay?: number;
  /** Opens a portable file's bytes as a new file (tests pass their own). */
  openPortable?: (file: File) => Promise<{fileId: string}>;
};

export type Bridge = {host: Host; stop: () => void; syncMenu: () => Promise<void>; reportLocation: () => Promise<void>};

let started: Promise<Bridge | null> | undefined;

/** Starts once per page. */
export function startBridge(options: BridgeOptions = {}): Promise<Bridge | null> {
  return (started ??= connectBridge(options));
}

export async function connectBridge(options: BridgeOptions = {}): Promise<Bridge | null> {
  const scope = options.scope ?? window;
  const core = options.core ?? tauriCore(scope);
  if (!core) return null;
  const host = createHost(core);
  const doc = scope.document;
  const openPortable = options.openPortable ?? (async (file: File) => {
    const {openPortableAsNewFile} = await import('../design/persistence/portable');
    return openPortableAsNewFile(file);
  });

  let source: EditorMenuSource | null = null;
  let sentMenu = '';
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  const syncMenu = async () => {
    menuTimer = undefined;
    const menu = webMenu(source);
    const text = JSON.stringify(menu);
    if (text === sentMenu) return;
    sentMenu = text;
    await host.setMenu(menu).catch(error => {
      sentMenu = '';
      console.error('Morfa desktop menu:', error);
    });
  };
  // Enabled and checked states follow the editor: after a key, a click or a command, at most every `menuDelay` ms.
  const scheduleMenu = () => {
    if (menuTimer === undefined) menuTimer = setTimeout(() => void syncMenu(), options.menuDelay ?? 250);
  };

  let sentLocation = '';
  const reportLocation = async () => {
    const fileId = designIdFromHash(scope.location.hash) || null;
    const key = `${fileId}\u0000${doc.title}`;
    if (key === sentLocation) return;
    sentLocation = key;
    await host.reportLocation(fileId, doc.title).catch(() => {
      sentLocation = '';
    });
  };

  const openPicked = async (token: string, name: string) => {
    try {
      const bytes = await host.takePortable(token);
      const {fileId} = await openPortable(new File([bytes], name, {type: 'application/json'}));
      requestNavigation({kind: 'design', fileId});
    } catch (error) {
      notice(errorText(error, 'Could not open the file.'), doc);
    }
  };

  const onEvent = (event: HostEvent) => {
    if (event.type === 'menu') {
      runMenuCommand(event.command, source, doc);
      scheduleMenu();
    } else if (event.type === 'files') requestNavigation({view: 'designs'});
    else if (event.type === 'portable') void openPicked(event.token, event.name);
  };

  await host.connect(onEvent);

  if (installLocalFonts(host, scope)) desktopFontsReady();
  desktopHost.saveFile = async (blob, filename) => {
    const saved = await host.savePortable(blob, filename);
    if (saved) notice(`File "${saved}" saved.`, doc);
  };
  desktopHost.pickFile = async accept => {
    if (!/\.rdesign/i.test(accept)) return null;
    const picked = await host.pickPortable();
    if (!picked) return null;
    return new File([await host.takePortable(picked.token)], picked.name, {type: 'application/json'});
  };
  desktopHost.openWindow = hash => void host.openWindow(hash);

  const stopMenu = watchEditorMenu(next => {
    source = next;
    scheduleMenu();
  });
  const titleObserver = new scope.MutationObserver(() => void reportLocation());
  const title = doc.querySelector('title');
  if (title) titleObserver.observe(title, {childList: true, characterData: true, subtree: true});
  else titleObserver.observe(doc.head, {childList: true, subtree: true});
  const onHash = () => void reportLocation();
  scope.addEventListener('hashchange', onHash);
  for (const type of ['keyup', 'pointerup', 'focus'] as const) scope.addEventListener(type, scheduleMenu, true);
  await reportLocation();

  return {
    host,
    syncMenu,
    reportLocation,
    stop() {
      stopMenu();
      titleObserver.disconnect();
      scope.removeEventListener('hashchange', onHash);
      for (const type of ['keyup', 'pointerup', 'focus'] as const) scope.removeEventListener(type, scheduleMenu, true);
      if (menuTimer !== undefined) clearTimeout(menuTimer);
      delete desktopHost.saveFile;
      delete desktopHost.pickFile;
      delete desktopHost.openWindow;
    },
  };
}
