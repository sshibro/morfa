import type {DesignDocument} from '../../../../shared/design/types';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import type {DesignFileKind} from '../../../../shared/design/api';
import {requestNavigation} from '../../../navigation';
import {duplicateDesignFile, restoreDesignFile, trashDesignFile} from '../../api';
import {getCommand, registerCommand, type Command} from './registry';
import {desktopHost} from '../../../desktop/host';

// "File" commands that act on the open file as a whole: its version history (MAIN_MENU `file.versions`,
// `file.save-version` ⌥⌘S), the portable copy ("Save to computer (.rdesign)", "Open file from
// computer…") and, when the editor has not registered its own, "Duplicate file" and "Move to trash".
// They need the open editor (its file, name, dialogs and toasts): DesignEditor binds it with
// `bindFileCommandHost` while it is mounted; without a host they are disabled.

export type FileToast = (message: string, options?: {kind?: 'info' | 'success' | 'error'; action?: {label: string; onClick: () => void}}) => void;

export type FileCommandHost = {
  fileId: string;
  /** The file's current name (the portable file is named after it). */
  fileName(): string;
  /** `openDialog` of the editor's services: 'versions' shows the history. */
  openDialog(id: string, params?: Record<string, unknown>): void;
  toast: FileToast;
  /** Stores pending edits (before a copy is made of the server's document). */
  flush?(): Promise<void>;
  /** A board's copy says so (docs/board.md); absent is a design file. */
  kind?: DesignFileKind;
};

let host: FileCommandHost | null = null;

/** Binds the open editor; returns the unbinding. */
export function bindFileCommandHost(next: FileCommandHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

const hasHost = () => host !== null;
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
export const designFileHref = (fileId: string) => '#design/' + encodeURIComponent(fileId);

/** Asks the system file dialog for one file; resolves null when it is closed without a choice. The desktop app
 *  asks its native dialog (src/desktop/host.ts). */
export function pickFile(accept: string, doc: Document = document): Promise<File | null> {
  if (desktopHost.pickFile) return desktopHost.pickFile(accept);
  return new Promise(resolve => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    doc.body.appendChild(input);
    input.click();
  });
}

/** Opens a file in a new tab, or says how to when the browser blocked the tab (it opens after an upload, outside the click). */
export function openInNewTab(fileId: string, name: string, toast: FileToast) {
  const href = designFileHref(fileId);
  if (desktopHost.openWindow) {
    desktopHost.openWindow(href);
    toast(`"${name}" opened in a new window`, {kind: 'success'});
    return;
  }
  const tab = window.open(href, '_blank');
  if (tab) {
    tab.opener = null;
    toast(`"${name}" opened in a new tab`, {kind: 'success'});
  } else {
    toast(`"${name}" added to files`, {kind: 'success', action: {label: 'Open', onClick: () => void window.open(href, '_blank', 'noopener')}});
  }
}

let portableBusy = false;
/** Module-level: the bundler's preload keeps the function that first asked for a chunk, and one written inside
 *  `savePortable` would keep the document it was given. */
const loadPortable = () => import('../../persistence/portable');

/** "Save to computer (.rdesign)": the document with its pictures, downloaded as `<name>.rdesign`. */
export async function savePortable(doc: DesignDocument, name: string, toast: FileToast, kind?: DesignFileKind) {
  if (portableBusy) return;
  portableBusy = true;
  // The file's document, taken before the first await (the module may still have to load): the store's table may be written
  // in place meanwhile, and the file must hold one moment.
  const snapshot = snapshotDocument(doc);
  try {
    const {exportPortable, portableFilename, saveBlob} = await loadPortable();
    await saveBlob(await exportPortable(name, snapshot, {kind}), portableFilename(name));
  } catch (error) {
    toast(errorText(error, 'Could not prepare the .rdesign file.'), {kind: 'error'});
  } finally {
    portableBusy = false;
  }
}

/** "Open file from computer…": a .rdesign becomes a new file of this account, opened in a new tab. */
export async function openPortable(toast: FileToast, pick: () => Promise<File | null> = () => pickFile('.rdesign')) {
  const file = await pick();
  if (!file) return;
  if (!/\.rdesign$/i.test(file.name)) {
    toast('Only .rdesign files can be opened.', {kind: 'error'});
    return;
  }
  try {
    const {openPortableAsNewFile} = await loadPortable();
    const {file: created} = await openPortableAsNewFile(file);
    openInNewTab(created.id, created.name, toast);
  } catch (error) {
    toast(errorText(error, 'Could not open the file.'), {kind: 'error'});
  }
}

const VERSION_COMMANDS: Command[] = [
  {
    id: 'file.versions',
    label: 'Version history',
    group: 'file',
    enabled: hasHost,
    run: () => host?.openDialog('versions'),
  },
  {
    id: 'file.save-version',
    label: 'Save version…',
    group: 'file',
    shortcut: {code: 'KeyS', mod: true, alt: true},
    enabled: hasHost,
    run: () => host?.openDialog('versions', {save: true}),
  },
  {
    id: 'file.save-portable',
    label: 'Save to computer (.rdesign)',
    group: 'file',
    enabled: hasHost,
    run: ctx => {
      // Big files: the copy holds every page, so the pages the store let go come back first.
      if (host) {
        const {fileName, toast, kind} = host;
        return ctx.store.ensureAllPages().then(() => savePortable(ctx.store.getState().doc, fileName(), toast, kind));
      }
    },
  },
  {
    id: 'file.open-portable',
    label: 'Open file from computer…',
    group: 'file',
    enabled: hasHost,
    run: () => {
      if (host) return openPortable(host.toast);
    },
  },
];

/** Used only when the editor registers no command of the same id (it may bring its own). */
const FALLBACK_COMMANDS: Command[] = [
  {
    id: 'file.duplicate',
    label: 'Duplicate file',
    group: 'file',
    enabled: hasHost,
    run: async () => {
      const current = host;
      if (!current) return;
      try {
        await current.flush?.();
        const {file} = await duplicateDesignFile(current.fileId);
        current.toast(`Copy of "${file.name}" created`, {kind: 'success', action: {label: 'Open', onClick: () => void window.open(designFileHref(file.id), '_blank', 'noopener')}});
      } catch (error) {
        current.toast(errorText(error, 'Could not create a copy.'), {kind: 'error'});
      }
    },
  },
  {
    id: 'file.trash',
    label: 'Move to trash',
    group: 'file',
    enabled: hasHost,
    run: async () => {
      const current = host;
      if (!current) return;
      try {
        await current.flush?.();
        await trashDesignFile(current.fileId);
        const name = current.fileName();
        requestNavigation({view: 'designs'});
        current.toast(`"${name}" moved to trash`, {action: {label: 'Undo', onClick: () => void restoreDesignFile(current.fileId).catch(() => undefined)}});
      } catch (error) {
        current.toast(errorText(error, 'Could not move the file to trash.'), {kind: 'error'});
      }
    },
  },
];

export const FILE_COMMAND_IDS = [...VERSION_COMMANDS, ...FALLBACK_COMMANDS].map(command => command.id);

/** Registers the versions and portable commands, and the fallbacks whose ids are still free. Returns the undo. */
export function registerFileCommands(): () => void {
  const undo = VERSION_COMMANDS.map(command => registerCommand(command));
  for (const command of FALLBACK_COMMANDS) if (!getCommand(command.id)) undo.push(registerCommand(command));
  return () => undo.forEach(off => off());
}
