// The desktop shell's commands (desktop/src-tauri/src/commands.rs), typed. Calls go through Tauri's own global
// (`withGlobalTauri`, desktop/src-tauri/tauri.conf.json), so the web app needs no Tauri package; the shell's ACL
// lets only the app's origin call them.

export type HostInfo = {version: string; platform: string; appOrigin: string; window: string};

/** desktop/src-tauri/src/fonts.rs `FontInfo`: a face of this computer, shaped like the Local Font Access API's FontData. */
export type DesktopFont = {id: number; family: string; fullName: string; postscriptName: string; style: string; weight: number; italic: boolean; collection: boolean};

export type PickedFile = {token: string; name: string; size: number};

/** desktop/src-tauri/src/menu.rs `WebMenu`. */
export type WebMenuItem =
  | {type: 'command'; id: string; label: string; shortcut?: string; enabled: boolean; checked?: boolean; clipboard?: 'copy' | 'cut' | 'paste'}
  | {type: 'separator'}
  | {type: 'submenu'; label: string; items: WebMenuItem[]};
export type WebMenu = {sections: {label: string; items: WebMenuItem[]}[]};

/** desktop/src-tauri/src/shell.rs `HostEvent`. */
export type HostEvent = {type: 'menu'; command: string} | {type: 'portable'; token: string; name: string} | {type: 'files'};

type Channel<T> = {onmessage: (message: T) => void};
export type TauriCore = {
  invoke: <T>(cmd: string, args?: Record<string, unknown> | Uint8Array | ArrayBuffer, options?: {headers: Record<string, string>}) => Promise<T>;
  Channel: new <T>() => Channel<T>;
};

export function tauriCore(scope: object = globalThis): TauriCore | undefined {
  return (scope as {__TAURI__?: {core?: TauriCore}}).__TAURI__?.core;
}

export type Host = ReturnType<typeof createHost>;

/** The shell's commands over a Tauri core (tests pass a fake one). */
export function createHost(core: TauriCore) {
  const bytes = (value: unknown): ArrayBuffer => {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    if (Array.isArray(value)) return new Uint8Array(value).buffer;
    throw new Error('Expected bytes.');
  };
  return {
    connect(onEvent: (event: HostEvent) => void): Promise<HostInfo> {
      const events = new core.Channel<HostEvent>();
      events.onmessage = onEvent;
      return core.invoke<HostInfo>('connect', {events});
    },
    setMenu: (menu: WebMenu) => core.invoke<void>('set_menu', {menu}),
    reportLocation: (fileId: string | null, title: string) => core.invoke<void>('report_location', {fileId, title}),
    listFonts: () => core.invoke<DesktopFont[]>('list_fonts'),
    readFont: async (id: number) => bytes(await core.invoke<unknown>('read_font', {id})),
    /** Answers the saved file's name, or null when the dialog was closed. */
    async savePortable(blob: Blob, name: string): Promise<string | null> {
      const body = new Uint8Array(await blob.arrayBuffer());
      return core.invoke<string | null>('save_portable', body, {headers: {'x-morfa-name': encodeURIComponent(name)}});
    },
    pickPortable: () => core.invoke<PickedFile | null>('pick_portable'),
    takePortable: async (token: string) => bytes(await core.invoke<unknown>('take_portable', {token})),
    openWindow: (hash: string) => core.invoke<void>('open_window', {hash}),
  };
}
