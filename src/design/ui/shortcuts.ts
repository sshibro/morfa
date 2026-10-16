// Keyboard shortcuts as the command registry writes them (docs/design-tool.md §Commands) and as
// menus, tooltips and the toolbar print them. A shortcut is a `+`-joined string of modifiers and one
// key named by `KeyboardEvent.code`, so it is the same physical key on the Russian layout:
//   'Mod+KeyZ'  'Mod+Shift+KeyZ'  'Shift+KeyL'  'KeyV'  'Mod+Backslash'  'Shift+Digit1'  'Alt+Mod+KeyC'
// `Mod` is ⌘ on a Mac and Ctrl elsewhere; `Ctrl` is always the Control key. Pure: no DOM besides an
// optional KeyboardEvent-shaped object, so node tests cover it.

export type ParsedShortcut = {mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; code: string};

const MODIFIERS = new Set(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Cmd']);

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
  // A lone '+' key is written 'Shift+Equal'; a trailing empty part means a malformed string.
  if (!parts.length || shortcut.trim().endsWith('+')) return null;
  const parsed: ParsedShortcut = {mod: false, ctrl: false, alt: false, shift: false, code: ''};
  for (const part of parts) {
    if (!MODIFIERS.has(part)) {
      if (parsed.code) return null;
      parsed.code = part;
    } else if (part === 'Mod' || part === 'Cmd' || part === 'Meta') parsed.mod = true;
    else if (part === 'Ctrl') parsed.ctrl = true;
    else if (part === 'Alt') parsed.alt = true;
    else parsed.shift = true;
  }
  return parsed.code ? parsed : null;
}

/** Key names for codes whose label is not the code's last letters. Mac uses symbols, others words. */
const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  Backslash: ['\\', '\\'], Slash: ['/', '/'], Period: ['.', '.'], Comma: [',', ','], Semicolon: [';', ';'],
  Quote: ['\'', '\''], Backquote: ['`', '`'], BracketLeft: ['[', '['], BracketRight: [']', ']'],
  Equal: ['+', '+'], Minus: ['−', '-'], NumpadAdd: ['+', '+'], NumpadSubtract: ['−', '-'],
  Enter: ['↩', 'Enter'], NumpadEnter: ['↩', 'Enter'], Escape: ['Esc', 'Esc'], Space: ['Space', 'Space'], Tab: ['⇥', 'Tab'],
  Backspace: ['⌫', 'Backspace'], Delete: ['⌦', 'Del'],
  ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
  PageUp: ['PgUp', 'PgUp'], PageDown: ['PgDn', 'PgDn'], Home: ['Home', 'Home'], End: ['End', 'End'],
};

export function keyLabel(code: string, mac: boolean): string {
  const known = KEY_LABELS[code];
  if (known) return mac ? known[0] : known[1];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return code;
}

/** Whether menus should print ⌘⌥⇧ or Ctrl+Alt+Shift. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & {userAgentData?: {platform?: string}}).userAgentData;
  return /mac|iphone|ipad/i.test(data?.platform || navigator.platform || navigator.userAgent);
}

/** '⇧⌘Z' on a Mac (modifiers in Apple's order ⌃⌥⇧⌘), 'Ctrl+Shift+Z' elsewhere. Unknown input is returned as is. */
export function formatShortcut(shortcut: string, mac = isMacPlatform()): string {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  const key = keyLabel(parsed.code, mac);
  if (mac) return (parsed.ctrl ? '⌃' : '') + (parsed.alt ? '⌥' : '') + (parsed.shift ? '⇧' : '') + (parsed.mod ? '⌘' : '') + key;
  return [parsed.ctrl || parsed.mod ? 'Ctrl' : '', parsed.alt ? 'Alt' : '', parsed.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

type KeyLike = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** True when the event is exactly this shortcut (extra modifiers do not match). */
export function matchesShortcut(event: KeyLike, shortcut: string, mac = isMacPlatform()): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed || event.code !== parsed.code) return false;
  const wantMeta = mac && parsed.mod;
  const wantCtrl = parsed.ctrl || (!mac && parsed.mod);
  return event.metaKey === wantMeta && event.ctrlKey === wantCtrl && event.altKey === parsed.alt && event.shiftKey === parsed.shift;
}

/** Inside a text field the keyboard belongs to the field: single-key tool shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== 'function') return false;
  const element = target as HTMLElement;
  return element.isContentEditable || !!element.closest('input, textarea, select, [contenteditable="true"]');
}
