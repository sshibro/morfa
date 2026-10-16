import type {ComponentType} from 'react';

// Entry points other modules of "Morfa" fill in. Each is honest while empty: the browser
// shows the action as not available yet and never pretends it ran.

// ── .rdesign files (src/design/persistence/portable.ts, written by the persistence module) ────
// Loaded through import.meta.glob so this module builds whether or not that file exists yet; once it
// does, it ships as its own lazy chunk.

export type PortableModule = {
  /** Documented contract: imports a .rdesign file as a new file of this account. */
  openPortableAsNewFile(file: File): Promise<{fileId: string}>;
  /** Optional: downloads a file as .rdesign ("Save to computer (.rdesign)"). */
  downloadPortableFile?: (fileId: string, name?: string) => Promise<void>;
};

const portable = import.meta.glob<PortableModule>('../persistence/portable.ts');
const PORTABLE_PATH = '../persistence/portable.ts';

export const portableAvailable = () => PORTABLE_PATH in portable;
export const loadPortable = (): Promise<PortableModule> | null => (portable[PORTABLE_PATH] ? portable[PORTABLE_PATH]() : null);

// ── Figma import (written by the Figma-import module) ─────────────────────

export type FigmaImportDialogProps = {
  onClose: () => void;
  /** The new file's id: the browser opens it. */
  onImported: (fileId: string) => void;
};

/**
 * The Figma importer (src/design/import/figma), its own lazy chunk. While it is null, "Import from
 * Figma" opens a dialog that says the import is not available yet.
 */
export const loadFigmaImport: (() => Promise<ComponentType<FigmaImportDialogProps>>) | null = () => import('../import/figma/FigmaImportDialog').then(module => module.FigmaImportDialog);
