import {DEFAULT_FORMAT, type CodeFormat} from '../../../../shared/design/codegen/format';

// The "Code" tab's settings, remembered on this device (as Figma's Dev Mode keeps its language and units): the language,
// lengths in px or rem, the colour format, whether raw colours are written as the tokens that have their value, and
// whether a layer's CSS shows as code or as a list of values.

export type CodeLanguage = 'css' | 'react' | 'tailwind' | 'inline' | 'vue' | 'vue-tailwind' | 'vue-inline' | 'tokens';

export type CodeSettings = {
  language: CodeLanguage;
  unit: CodeFormat['unit'];
  color: CodeFormat['color'];
  /** Raw colours equal to a colour token's value are written as the token (Figma's suggested variables). */
  suggest: boolean;
  /** CSS as code or as a list of values that copy one by one. */
  view: 'code' | 'list';
};

export const DEFAULT_SETTINGS: CodeSettings = {language: 'react', unit: 'px', color: 'hex', suggest: true, view: 'code'};

const KEY = 'morfa-design-code-settings';
/** The language alone was remembered under this key before the settings. */
const LEGACY_KEY = 'morfa-design-code-mode';

const LANGUAGES: readonly CodeLanguage[] = ['css', 'react', 'tailwind', 'inline', 'vue', 'vue-tailwind', 'vue-inline', 'tokens'];

/** The languages that write Vue single-file components. */
export const isVue = (language: CodeLanguage) => language === 'vue' || language === 'vue-tailwind' || language === 'vue-inline';

/** The stored settings, each field checked (storage is the browser's; a bad value falls back to the default). */
export function readSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): CodeSettings {
  const out = {...DEFAULT_SETTINGS};
  try {
    const raw = storage?.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<Record<keyof CodeSettings, unknown>>) : {};
    const legacy = storage?.getItem(LEGACY_KEY);
    const language = stored.language ?? legacy;
    if (LANGUAGES.includes(language as CodeLanguage)) out.language = language as CodeLanguage;
    if (stored.unit === 'px' || stored.unit === 'rem') out.unit = stored.unit;
    if (stored.color === 'hex' || stored.color === 'rgb' || stored.color === 'hsl') out.color = stored.color;
    if (typeof stored.suggest === 'boolean') out.suggest = stored.suggest;
    if (stored.view === 'code' || stored.view === 'list') out.view = stored.view;
  } catch {
    // Storage can be off (private windows) or hold something else: the defaults are fine.
  }
  return out;
}

export function writeSettings(settings: CodeSettings, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Only a convenience.
  }
}

export const formatOf = (settings: CodeSettings): CodeFormat => ({...DEFAULT_FORMAT, unit: settings.unit, color: settings.color});

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
