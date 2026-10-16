import type {MenuItem} from '../../ui/menu-model';
import {tidySeparators} from '../../ui/menu-model';

// The main menu is a structure of command ids; the engine's command registry
// (docs/design-tool.md §Commands, `registerCommand({id, label, shortcut?, run, enabled?})`) fills it.
// An id the registry does not know is left out, so a feature appears in the menu the day its
// command file is imported, and nothing unbuilt is ever shown as working.

/** What the chrome needs from a registered command. */
export type ChromeCommand = {
  id: string;
  label: string;
  /** shortcuts.ts format: 'Mod+KeyZ'. */
  shortcut?: string;
  run: () => void;
  /** Read when the menu opens. */
  enabled?: () => boolean;
  /** Present on toggles ("Rulers", "Pixel grid"): a check mark when true. */
  checked?: () => boolean;
};

/** Looks a command up by id (the registry's `getCommand`, or a Map's `get`). */
export type CommandLookup = (id: string) => ChromeCommand | undefined;

export type MainMenuEntry = string | '-' | {label: string; items: MainMenuEntry[]};
export type MainMenuSection = {id: string; label: string; items: MainMenuEntry[]};

/**
 * The main menu's sections and the command ids each lists, in Figma's order. Ids are the
 * convention for the engine's commands (`<section>.<action>`); the registry may also pass its own
 * structure to EditorLayout as `menu`.
 */
export const MAIN_MENU: MainMenuSection[] = [
  {id: 'file', label: 'File', items: [
    'file.new', 'file.duplicate', 'file.rename', '-',
    'file.place-image', 'file.open-portable', 'file.save-portable', '-',
    'file.save-version', 'file.versions', '-',
    'file.libraries', 'file.publish-library', '-',
    'file.export', 'file.export-selection', 'file.export-react', 'file.export-vue', '-',
    'file.trash',
  ]},
  {id: 'edit', label: 'Edit', items: [
    'edit.undo', 'edit.redo', '-',
    'edit.copy', 'edit.cut', 'edit.paste', 'edit.paste-over', 'edit.paste-replace', 'edit.duplicate', 'edit.delete', '-',
    {label: 'Copy as', items: ['edit.copy-text', 'edit.copy-css', 'edit.copy-svg', 'edit.copy-png', 'edit.copy-link']}, '-',
    'edit.copy-properties', 'edit.paste-properties', '-',
    'edit.select-all', 'edit.select-none', 'edit.select-inverse', 'edit.select-matching',
    {label: 'Select all with same', items: ['edit.select-same-fill', 'edit.select-same-stroke', 'edit.select-same-effect', '-', 'edit.select-same-text', 'edit.select-same-font', '-', 'edit.select-same-instance']}, '-',
    'edit.find',
  ]},
  {id: 'view', label: 'View', items: [
    'view.pixel-grid', 'view.snap-pixel-grid', 'view.layout-grids', 'view.card-zones', 'view.rulers', 'view.outlines', 'view.pixel-preview', 'view.annotations', 'view.comments', 'view.multiplayer-cursors', '-',
    'view.toggle-ui', 'view.minimize-ui', 'view.panel-layers', 'view.panel-assets', '-',
    'view.zoom-in', 'view.zoom-out', 'view.zoom-100', 'view.zoom-fit', 'view.zoom-selection', '-',
    'view.page-previous', 'view.page-next',
  ]},
  {id: 'object', label: 'Object', items: [
    'object.frame-selection', 'object.group', 'object.ungroup', 'object.select-parent', 'object.resize-to-fit', '-',
    'object.auto-layout', 'object.suggest-auto-layout', 'object.remove-auto-layout', 'object.remove-all-auto-layout', '-',
    'object.create-component', 'object.create-multiple-components', 'object.combine-variants', 'object.add-variant', 'object.multi-edit-variants', 'object.create-instance', '-',
    'object.reset-instance', 'object.detach-instance', 'object.push-to-main', 'object.restore-component', 'object.go-to-main', 'object.select-instances', '-',
    'object.mask', 'object.lock', 'object.hide', '-',
    'object.bring-to-front', 'object.bring-forward', 'object.send-backward', 'object.send-to-back', '-',
    'object.flip-horizontal', 'object.flip-vertical', 'object.rotate-180', 'object.rotate-90-cw', 'object.rotate-90-ccw', '-',
    {label: 'Boolean operations', items: ['object.boolean-union', 'object.boolean-subtract', 'object.boolean-intersect', 'object.boolean-exclude', '-', 'object.flatten', 'object.shape-builder']},
    'object.outline-stroke', 'object.rasterize', '-',
    'object.remove-fill', 'object.remove-stroke', 'object.swap-fill-stroke',
  ]},
  {id: 'text', label: 'Text', items: [
    'text.bold', 'text.italic', 'text.underline', 'text.strikethrough', '-',
    'text.list-bulleted', 'text.list-numbered', '-',
    'text.align-left', 'text.align-center', 'text.align-right', 'text.align-justify', '-',
    'text.size-increase', 'text.size-decrease', 'text.letter-spacing-increase', 'text.letter-spacing-decrease', 'text.line-height-increase', 'text.line-height-decrease', '-',
    'text.case-upper', 'text.case-lower',
  ]},
  {id: 'arrange', label: 'Arrange', items: [
    'arrange.align-left', 'arrange.align-center-h', 'arrange.align-right', '-',
    'arrange.align-top', 'arrange.align-center-v', 'arrange.align-bottom', '-',
    'arrange.distribute-h', 'arrange.distribute-v', 'arrange.tidy-up', '-',
    'arrange.round-to-pixels',
  ]},
  {id: 'help', label: 'Help', items: ['help.shortcuts', 'help.guide', '-', 'help.support']},
];

/** Turns menu entries into menu items, reading `enabled` and `checked` now (the menu is opening). */
export function buildMenuItems(entries: readonly MainMenuEntry[], lookup: CommandLookup, path = ''): MenuItem[] {
  const items: MenuItem[] = [];
  entries.forEach((entry, index) => {
    if (entry === '-') {
      items.push({type: 'separator'});
      return;
    }
    if (typeof entry === 'object') {
      const children = buildMenuItems(entry.items, lookup, `${path}${index}.`);
      if (children.some(child => child.type !== 'separator')) items.push({type: 'submenu', id: `menu:${path}${index}`, label: entry.label, items: children});
      return;
    }
    const command = lookup(entry);
    if (!command) return;
    items.push({
      id: command.id,
      label: command.label,
      shortcut: command.shortcut,
      disabled: command.enabled ? !command.enabled() : false,
      ...(command.checked ? {checked: command.checked()} : {}),
      onSelect: command.run,
    });
  });
  return tidySeparators(items);
}

/** The whole main menu: "Back to files", quick actions, a submenu per section with commands, then `extra` (the theme). */
export function buildMainMenu(sections: readonly MainMenuSection[], lookup: CommandLookup, options: {onBackToFiles: () => void; extra?: MenuItem[]}): MenuItem[] {
  const quick = lookup('app.quick-actions');
  const items: MenuItem[] = [
    {id: 'app.back-to-files', label: 'Back to files', onSelect: options.onBackToFiles},
    ...(quick ? [{id: quick.id, label: quick.label, shortcut: quick.shortcut, onSelect: quick.run} satisfies MenuItem] : []),
    {type: 'separator'},
  ];
  for (const section of sections) {
    const children = buildMenuItems(section.items, lookup);
    if (children.length) items.push({type: 'submenu', id: `menu:${section.id}`, label: section.label, items: children});
  }
  if (options.extra?.length) items.push({type: 'separator'}, ...options.extra);
  return tidySeparators(items);
}

/** A lookup over a list of commands (placeholders, tests). */
export const lookupFrom = (commands: readonly ChromeCommand[]): CommandLookup => {
  const byId = new Map(commands.map(command => [command.id, command]));
  return id => byId.get(id);
};
