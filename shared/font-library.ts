import type {FontFamily, FontKind} from './fonts';
// The web-font library: the most used faces of the web and the best Cyrillic
// families from Google Fonts, installed from @fontsource and served from /fonts
// like the rest of the catalogue. Only faces that carry the full Russian alphabet
// are listed. Faces
// shared/fonts.ts already vendors (Rubik, Nunito, Commissioner, Geologica, Yeseva
// One, Dela Gothic One, Alumni Sans, Literata) are reused by id, not repeated.

const SANS = 'Arial, sans-serif';
const NARROW = 'Arial Narrow, sans-serif';
const HEAVY = 'Arial Black, sans-serif';
const SERIF = 'Georgia, serif';
const SCRIPT = 'cursive';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const variableFace = (family: string, dir: string, kind: FontKind, fallback: string, min: number, max: number): FontFamily => ({family, dir, kind, fallback, variable: true, weights: [min, max]});
const staticFace = (family: string, dir: string, kind: FontKind, fallback: string, weights: number[]): FontFamily => ({family, dir, kind, fallback, variable: false, weights});

export const libraryFamilyIds = [
  'roboto', 'open-sans', 'montserrat', 'raleway', 'mulish', 'pt-sans', 'fira-sans', 'ubuntu', 'source-sans', 'noto-sans', 'geist',
  'madefor-display', 'madefor-text', 'sofia-sans', 'ysabeau', 'alegreya-sans', 'roboto-condensed',
  'exo-2', 'comfortaa', 'montserrat-alternates', 'tenor-sans', 'jura', 'russo-one', 'tektur', 'poiret-one', 'philosopher', 'press-start', 'pixelify-sans',
  'lora', 'merriweather', 'eb-garamond', 'noto-serif', 'source-serif', 'spectral', 'alegreya', 'roboto-slab', 'vollkorn', 'old-standard', 'alice', 'forum', 'oranienbaum',
  'pacifico', 'lobster', 'marck-script', 'bad-script', 'great-vibes', 'amatic-sc', 'neucha',
  'roboto-mono', 'plex-mono', 'fira-code', 'source-code', 'geist-mono',
] as const;
export type LibraryFamilyId = (typeof libraryFamilyIds)[number];

export const libraryFamilies: Record<LibraryFamilyId, FontFamily> = {
  // Text grotesks
  roboto: variableFace('Roboto', 'roboto', 'sans', SANS, 100, 900),
  'open-sans': variableFace('Open Sans', 'open-sans', 'sans', SANS, 300, 800),
  montserrat: variableFace('Montserrat', 'montserrat', 'sans', SANS, 100, 900),
  raleway: variableFace('Raleway', 'raleway', 'sans', SANS, 100, 900),
  mulish: variableFace('Mulish', 'mulish', 'sans', SANS, 200, 1000),
  'pt-sans': staticFace('PT Sans', 'pt-sans', 'sans', SANS, [400, 700]),
  'fira-sans': staticFace('Fira Sans', 'fira-sans', 'sans', SANS, [300, 400, 500, 600, 700]),
  ubuntu: staticFace('Ubuntu', 'ubuntu', 'sans', SANS, [300, 400, 500, 700]),
  'source-sans': variableFace('Source Sans 3', 'source-sans-3', 'sans', SANS, 200, 900),
  'noto-sans': variableFace('Noto Sans', 'noto-sans', 'sans', SANS, 100, 900),
  geist: variableFace('Geist', 'geist', 'sans', SANS, 100, 900),
  'madefor-display': variableFace('Wix Madefor Display', 'wix-madefor-display', 'sans', SANS, 400, 800),
  'madefor-text': variableFace('Wix Madefor Text', 'wix-madefor-text', 'sans', SANS, 400, 800),
  'sofia-sans': variableFace('Sofia Sans', 'sofia-sans', 'sans', SANS, 1, 1000),
  ysabeau: variableFace('Ysabeau', 'ysabeau', 'sans', SANS, 1, 1000),
  'alegreya-sans': staticFace('Alegreya Sans', 'alegreya-sans', 'sans', SANS, [300, 400, 500, 700]),
  'roboto-condensed': variableFace('Roboto Condensed', 'roboto-condensed', 'sans', NARROW, 100, 900),
  // Display faces
  'exo-2': variableFace('Exo 2', 'exo-2', 'display', SANS, 100, 900),
  comfortaa: variableFace('Comfortaa', 'comfortaa', 'display', SANS, 300, 700),
  'montserrat-alternates': staticFace('Montserrat Alternates', 'montserrat-alternates', 'display', SANS, [400, 500, 600, 700]),
  'tenor-sans': staticFace('Tenor Sans', 'tenor-sans', 'display', SANS, [400]),
  jura: variableFace('Jura', 'jura', 'display', SANS, 300, 700),
  'russo-one': staticFace('Russo One', 'russo-one', 'display', HEAVY, [400]),
  tektur: variableFace('Tektur', 'tektur', 'display', SANS, 400, 900),
  'poiret-one': staticFace('Poiret One', 'poiret-one', 'display', SANS, [400]),
  philosopher: staticFace('Philosopher', 'philosopher', 'display', SANS, [400, 700]),
  'press-start': staticFace('Press Start 2P', 'press-start-2p', 'display', MONO, [400]),
  'pixelify-sans': variableFace('Pixelify Sans', 'pixelify-sans', 'display', SANS, 400, 700),
  // Serifs
  lora: variableFace('Lora', 'lora', 'serif', SERIF, 400, 700),
  merriweather: variableFace('Merriweather', 'merriweather', 'serif', SERIF, 300, 900),
  'eb-garamond': variableFace('EB Garamond', 'eb-garamond', 'serif', SERIF, 400, 800),
  'noto-serif': variableFace('Noto Serif', 'noto-serif', 'serif', SERIF, 100, 900),
  'source-serif': variableFace('Source Serif 4', 'source-serif-4', 'serif', SERIF, 200, 900),
  spectral: staticFace('Spectral', 'spectral', 'serif', SERIF, [300, 400, 500, 600, 700]),
  alegreya: variableFace('Alegreya', 'alegreya', 'serif', SERIF, 400, 900),
  'roboto-slab': variableFace('Roboto Slab', 'roboto-slab', 'serif', SERIF, 100, 900),
  vollkorn: variableFace('Vollkorn', 'vollkorn', 'serif', SERIF, 400, 900),
  'old-standard': staticFace('Old Standard TT', 'old-standard-tt', 'serif', SERIF, [400, 700]),
  alice: staticFace('Alice', 'alice', 'serif', SERIF, [400]),
  forum: staticFace('Forum', 'forum', 'serif', SERIF, [400]),
  oranienbaum: staticFace('Oranienbaum', 'oranienbaum', 'serif', SERIF, [400]),
  // Scripts
  pacifico: staticFace('Pacifico', 'pacifico', 'script', SCRIPT, [400]),
  lobster: staticFace('Lobster', 'lobster', 'script', SCRIPT, [400]),
  'marck-script': staticFace('Marck Script', 'marck-script', 'script', SCRIPT, [400]),
  'bad-script': staticFace('Bad Script', 'bad-script', 'script', SCRIPT, [400]),
  'great-vibes': staticFace('Great Vibes', 'great-vibes', 'script', SCRIPT, [400]),
  'amatic-sc': staticFace('Amatic SC', 'amatic-sc', 'script', SCRIPT, [400, 700]),
  neucha: staticFace('Neucha', 'neucha', 'script', SCRIPT, [400]),
  // Monospaced
  'roboto-mono': variableFace('Roboto Mono', 'roboto-mono', 'mono', MONO, 100, 700),
  'plex-mono': staticFace('IBM Plex Mono', 'ibm-plex-mono', 'mono', MONO, [400, 500, 600]),
  'fira-code': variableFace('Fira Code', 'fira-code', 'mono', MONO, 300, 700),
  'source-code': variableFace('Source Code Pro', 'source-code-pro', 'mono', MONO, 200, 900),
  'geist-mono': variableFace('Geist Mono', 'geist-mono', 'mono', MONO, 100, 900),
};
