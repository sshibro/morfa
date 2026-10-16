import type {NodeId} from '../../../../shared/design/types';
import type {SpatialIndex} from '../../../../shared/design/tree';
import type {DesignStore} from '../store';
import type {EditKind} from '../tools/types';

// Every action with a name: menus, the context menu, quick actions (⌘/) and shortcuts all read this
// registry, so a feature adds a command file and one import line (docs/design-tool.md §Commands).
// Shortcuts are physical keys (`KeyboardEvent.code`), so ⌘G is the same key on the Russian layout and on QWERTY.

/** `mod` is ⌘ on Mac and Ctrl elsewhere; `ctrl` is the Control key itself (on Mac only it differs from `mod`). */
export type Shortcut = {code: string; mod?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean};

export type ClipboardAccess = {
  writeText(text: string): Promise<void> | void;
  /** Null when the system clipboard cannot be read (no permission). */
  readText(): Promise<string | null>;
};

export type CommandContext = {
  store: DesignStore;
  /** CSS px of the canvas; zoom commands frame content in it. */
  canvasSize(): {width: number; height: number};
  /** Opens the text or vector editor (Enter on a text). */
  enterEdit?(id: NodeId, kind?: EditKind): void;
  clipboard?: ClipboardAccess;
  index?(): SpatialIndex | null;
};

export type Command = {
  id: string;
  /** Russian, as menus show it. */
  label: string;
  group?: string;
  shortcut?: Shortcut;
  /** More keys for the same command (⌘Y for redo, Backspace for delete); menus show `shortcut`. */
  alternates?: readonly Shortcut[];
  /** Left out of menus and quick actions (arrow nudges). */
  hidden?: boolean;
  /** Holding the key repeats the command. */
  repeat?: boolean;
  /** Bound to the browser's copy/cut/paste event: its keys are left to the browser, which then fires
   *  the event the canvas handles (that is the only way to use the clipboard without a permission prompt). */
  clipboardEvent?: 'copy' | 'cut' | 'paste';
  run(ctx: CommandContext): void | Promise<void>;
  enabled?(ctx: CommandContext): boolean;
  checked?(ctx: CommandContext): boolean;
};

export type KeyLike = {code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean};

const commands = new Map<string, Command>();

/** Adds a command (or replaces one with the same id). Returns the undo of the registration. */
export function registerCommand(command: Command): () => void {
  commands.set(command.id, command);
  return () => {
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export const getCommand = (id: string) => commands.get(id);

export function listCommands(options: {includeHidden?: boolean; group?: string} = {}): Command[] {
  return [...commands.values()].filter(command => (options.includeHidden || !command.hidden) && (!options.group || command.group === options.group));
}

export const isEnabled = (command: Command, ctx: CommandContext) => !command.enabled || command.enabled(ctx);

/** Runs a command if it exists and is enabled. */
export function runCommand(id: string, ctx: CommandContext): boolean {
  const command = commands.get(id);
  if (!command || !isEnabled(command, ctx)) return false;
  void command.run(ctx);
  return true;
}

export function shortcutMatches(shortcut: Shortcut, event: KeyLike, mac: boolean): boolean {
  if (shortcut.code !== event.code || !!shortcut.shift !== event.shiftKey || !!shortcut.alt !== event.altKey) return false;
  if (mac) return !!shortcut.mod === event.metaKey && !!shortcut.ctrl === event.ctrlKey;
  return (!!shortcut.mod || !!shortcut.ctrl) === event.ctrlKey && !event.metaKey;
}

/** The command whose shortcut (or alternate) the key press is. Should two commands share a key, the
 *  first one `prefer` accepts wins (the keyboard passes "can run now", so the key does what applies to
 *  the selection, as Figma resolves its own shared keys); otherwise the first registered. */
export function findByShortcut(event: KeyLike, mac: boolean, prefer?: (command: Command) => boolean): Command | undefined {
  let first: Command | undefined;
  for (const command of commands.values()) {
    const hit = (command.shortcut && shortcutMatches(command.shortcut, event, mac)) || command.alternates?.some(shortcut => shortcutMatches(shortcut, event, mac));
    if (!hit) continue;
    if (!prefer || prefer(command)) return command;
    first ??= command;
  }
  return first;
}
