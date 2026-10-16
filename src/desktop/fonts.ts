import type {DesktopFont, Host} from './ipc';

// Local fonts in the desktop app (Figma desktop's "local fonts"): `queryLocalFonts` as Chrome has it, answered by
// the shell from the system's installed faces. The editor's registry (src/design/engine/fonts.ts) reads the list
// like Chrome's and, through `morfaBytes`, loads each face from its file: the same bytes feed the canvas and the
// Rust text engine, so nothing depends on the web view's own `local()` matching (WebKit limits it to system fonts).

/** What `queryLocalFonts` answers here: Chrome's FontData fields plus the face's bytes. */
export type DesktopFontData = {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob: () => Promise<Blob>;
  /** Absent for a face inside a collection (.ttc): the registry draws it with `local()` then. */
  morfaBytes?: () => Promise<ArrayBuffer>;
};

export type QueryLocalFonts = ((options?: {postscriptNames?: string[]}) => Promise<DesktopFontData[]>) & {morfaDesktop: true};

export function fontData(host: Pick<Host, 'readFont'>, font: DesktopFont): DesktopFontData {
  let read: Promise<ArrayBuffer> | undefined;
  // One read per face, however many registries and sizes ask.
  const bytes = () => (read ??= host.readFont(font.id).catch(error => {
    read = undefined;
    throw error;
  }));
  return {
    family: font.family,
    fullName: font.fullName,
    postscriptName: font.postscriptName,
    style: font.style,
    blob: async () => new Blob([await bytes()], {type: 'font/sfnt'}),
    ...(font.collection ? {} : {morfaBytes: bytes}),
  };
}

/** `queryLocalFonts` over the shell: the list is read once and kept; `postscriptNames` filters like Chrome's. */
export function createQueryLocalFonts(host: Pick<Host, 'listFonts' | 'readFont'>): QueryLocalFonts {
  let listing: Promise<DesktopFontData[]> | undefined;
  const all = () => (listing ??= host.listFonts().then(fonts => fonts.map(font => fontData(host, font)), error => {
    listing = undefined;
    throw error;
  }));
  const query = async (options?: {postscriptNames?: string[]}) => {
    const fonts = await all();
    const wanted = options?.postscriptNames;
    return wanted ? fonts.filter(font => wanted.includes(font.postscriptName)) : fonts.slice();
  };
  return Object.assign(query, {morfaDesktop: true as const});
}

/** Puts it where the editor looks (`window.queryLocalFonts`). Inside the app it takes the place of a web view's own
 *  (WebView2 on Windows has Chrome's): the shell's list needs no permission prompt and hands over bytes. */
export function installLocalFonts(host: Pick<Host, 'listFonts' | 'readFont'>, scope: object = globalThis): boolean {
  Object.defineProperty(scope, 'queryLocalFonts', {value: createQueryLocalFonts(host), configurable: true, writable: true});
  return true;
}
