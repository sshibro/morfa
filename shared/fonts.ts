import {libraryFamilies, libraryFamilyIds} from './font-library';

// The font catalogue of design files: self-hosted families, every one with Cyrillic. Files are copied from
// @fontsource packages (or assets/fonts for vendored faces) into public/fonts by scripts/copy-fonts.ts and
// served from /fonts, so the editor, exports and the vector PDF load the same files without external requests.
// The families and their files only. Documents name a family by `family`, so the set
// of families must not shrink without a migration of stored documents.

// Style group of a face, for filtering the gallery and grouping the family menus.
export type FontKind = 'sans' | 'serif' | 'display' | 'script' | 'mono';
export const fontKinds: readonly {id: FontKind; label: string}[] = [
  {id: 'sans', label: 'Sans serif'}, {id: 'serif', label: 'Serif'}, {id: 'display', label: 'Display'}, {id: 'script', label: 'Handwriting'}, {id: 'mono', label: 'Monospace'},
];

export type FontFamily = {
  family: string;
  dir: string;
  kind: FontKind;
  fallback: string;
  variable: boolean;
  weights: number[];
  // A variable face states its weight range ('200 700'); `unicodeRange` is for files that hold one subset of a family.
  files?: {name: string; weight: number | string; style?: 'italic'; unicodeRange?: string}[];
  license?: string;
};

const SUBSETS = ['cyrillic', 'latin'] as const;

const cormorant: FontFamily = {family: 'Cormorant Garamond', dir: 'cormorant-garamond', kind: 'serif', fallback: 'Georgia, serif', variable: false, weights: [400, 500, 600]};
const manrope: FontFamily = {family: 'Manrope', dir: 'manrope', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [200, 800]};
const unbounded: FontFamily = {family: 'Unbounded', dir: 'unbounded', kind: 'display', fallback: 'Arial Black, sans-serif', variable: false, weights: [400, 500, 600]};
const golos: FontFamily = {family: 'Golos Text', dir: 'golos-text', kind: 'sans', fallback: 'Arial, sans-serif', variable: false, weights: [400, 500, 600]};
const onest: FontFamily = {family: 'Onest', dir: 'onest', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [100, 900]};
const prata: FontFamily = {family: 'Prata', dir: 'prata', kind: 'serif', fallback: 'Georgia, serif', variable: false, weights: [400]};
const plexSerif: FontFamily = {family: 'IBM Plex Serif', dir: 'ibm-plex-serif', kind: 'serif', fallback: 'Georgia, serif', variable: false, weights: [400, 500, 600]};
const plexSans: FontFamily = {family: 'IBM Plex Sans', dir: 'ibm-plex-sans', kind: 'sans', fallback: 'Arial, sans-serif', variable: false, weights: [400, 500, 600]};

const nunito: FontFamily = {family: 'Nunito Sans', dir: 'nunito-sans', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [200, 1000]};

const inter: FontFamily = {family: 'Inter', dir: 'inter', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [100, 900]};
const playfair: FontFamily = {family: 'Playfair Display', dir: 'playfair-display', kind: 'serif', fallback: 'Georgia, serif', variable: true, weights: [400, 900]};
const ptSerif: FontFamily = {family: 'PT Serif', dir: 'pt-serif', kind: 'serif', fallback: 'Georgia, serif', variable: false, weights: [400, 700]};
const oswald: FontFamily = {family: 'Oswald', dir: 'oswald', kind: 'display', fallback: 'Arial Narrow, Impact, sans-serif', variable: true, weights: [200, 700]};
const interTight: FontFamily = {family: 'Inter Tight', dir: 'inter-tight', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [100, 900]};
const jost: FontFamily = {family: 'Jost', dir: 'jost', kind: 'sans', fallback: 'Futura, Avenir Next, Arial, sans-serif', variable: true, weights: [100, 900]};
// Vendored in assets/fonts (OFL, @fontsource-variable/rubik 5.3.0): rounded heavy grotesk for products and services.
const rubik: FontFamily = {family: 'Rubik', dir: 'rubik', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [300, 900]};
// Vendored in assets/fonts (OFL, @fontsource/yeseva-one 5.3.0): heavy display serif, headings only.
const yeseva: FontFamily = {family: 'Yeseva One', dir: 'yeseva-one', kind: 'serif', fallback: 'Georgia, serif', variable: false, weights: [400]};
// Vendored in assets/fonts (OFL, @fontsource-variable/nunito 5.3.0): the rounded Nunito, not Nunito Sans.
const nunitoRounded: FontFamily = {family: 'Nunito', dir: 'nunito', kind: 'sans', fallback: 'Arial Rounded MT Bold, Arial, sans-serif', variable: true, weights: [200, 1000]};
// Vendored in assets/fonts (OFL, @fontsource-variable/commissioner 5.3.0). The files are the full-axes
// cut (wght 100–900, FLAR, VOLM, slnt) saved under the wght names this module expects, so a sheet
// can reach the flared, glyphic letterforms with font-variation-settings.
const commissioner: FontFamily = {family: 'Commissioner', dir: 'commissioner', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [100, 900]};
// Vendored in assets/fonts (OFL, @fontsource-variable/geologica 5.3.0): the full-axes cut (wght, SHRP,
// CRSV, slnt) saved under the wght names, like Commissioner above.
const geologica: FontFamily = {family: 'Geologica', dir: 'geologica', kind: 'sans', fallback: 'Arial, sans-serif', variable: true, weights: [100, 900]};
// Vendored in assets/fonts (OFL, @fontsource/oi 5.3.0): an inflated shouting display face, headings ≥ 40 px only.
const oi: FontFamily = {family: 'Oi', dir: 'oi', kind: 'display', fallback: 'Arial Black, sans-serif', variable: false, weights: [400]};
// Vendored in assets/fonts (OFL, @fontsource/dela-gothic-one 5.3.0): a heavy poster grotesk, headings only.
const dela: FontFamily = {family: 'Dela Gothic One', dir: 'dela-gothic-one', kind: 'display', fallback: 'Arial Black, sans-serif', variable: false, weights: [400]};
// Vendored in assets/fonts (OFL, Roboto Flex v30 from Google Fonts): a wide instance pinned with
// fontTools (wdth 120, opsz 144, other axes at defaults) that keeps only wght 400–1000.
const robotoFlex: FontFamily = {family: 'Roboto Flex', dir: 'roboto-flex', kind: 'display', fallback: 'Arial Black, sans-serif', variable: true, weights: [400, 1000]};
// Vendored in assets/fonts (OFL, @fontsource/days-one 5.3.0): a heavy round geometric display, headings only.
const daysOne: FontFamily = {family: 'Days One', dir: 'days-one', kind: 'display', fallback: 'Arial Black, sans-serif', variable: false, weights: [400]};
// Vendored in assets/fonts (OFL, @fontsource-variable/sofia-sans-extra-condensed 5.3.0): a calm extra-condensed display.
const robotoSerif: FontFamily = {family: 'Roboto Serif', dir: 'roboto-serif', kind: 'serif', fallback: 'Georgia, serif', variable: true, weights: [300, 900]};
const alumni: FontFamily = {family: 'Alumni Sans', dir: 'alumni-sans', kind: 'display', fallback: 'Arial Narrow, sans-serif', variable: true, weights: [100, 900]};
const literata: FontFamily = {family:'Literata',dir:'literata',kind:'serif',fallback:'Georgia, serif',variable:false,weights:[700,900],license:'LICENSE',files:[['Bold',700],['Black',900]].flatMap(([name,weight])=>[{name:`Literata-${name}.woff2`,weight:Number(weight)},{name:`Literata-${name}Italic.woff2`,weight:Number(weight),style:'italic' as const}])};
const sofiaXc: FontFamily = {family: 'Sofia Sans Extra Condensed', dir: 'sofia-sans-extra-condensed', kind: 'display', fallback: 'Arial Narrow, sans-serif', variable: true, weights: [100, 1000]};

// Creator-distributed fonts; full glyph sets retain extended Cyrillic and ligatures.
const nyght: FontFamily = {family:'Nyght Serif',dir:'nyght-serif',kind:'serif',fallback:'Georgia, serif',variable:false,weights:[300,400,500,700,900],license:'LICENSE.txt',files:[['Light',300],['Regular',400],['Medium',500],['Bold',700],['Dark',900]].flatMap(([name,weight])=>[{name:`NyghtSerif-${name}.woff2`,weight:Number(weight)},{name:`NyghtSerif-${name}Italic.woff2`,weight:Number(weight),style:'italic' as const}])};
const grunt: FontFamily = {family:'Grunt Grotesk',dir:'grunt-grotesk',kind:'display',fallback:'Arial, sans-serif',variable:false,weights:[300,700],license:'LICENSE.txt',files:[{name:'GruntGrotesk-Light.woff2',weight:300},{name:'GruntGrotesk-Bold.woff2',weight:700}]};
const ekran: FontFamily = {family:'Ekran',dir:'ekran',kind:'display',fallback:'Arial Black, sans-serif',variable:false,weights:[400],license:'LICENSE.txt',files:[{name:'Ekran.woff2',weight:400}]};
const lunna: FontFamily = {family:'LUNNA',dir:'lunna',kind:'display',fallback:'Arial, sans-serif',variable:false,weights:[400],license:'LICENSE.txt',files:[{name:'LUNNA.woff2',weight:400}]};

const caveat: FontFamily = {family: 'Caveat', dir: 'caveat', kind: 'script', fallback: 'cursive', variable: true, weights: [400, 700]};
const jetbrainsMono: FontFamily = {family: 'JetBrains Mono', dir: 'jetbrains-mono', kind: 'mono', fallback: 'ui-monospace, SFMono-Regular, Menlo, monospace', variable: true, weights: [100, 800]};

// Every family of the catalogue, by id.
export const fontFamilyIds = ['cormorant', 'manrope', 'unbounded', 'golos', 'onest', 'prata', 'plex-serif', 'plex-sans', 'nunito', 'inter', 'playfair', 'pt-serif', 'oswald', 'inter-tight', 'jost', 'caveat', 'jetbrains-mono', 'nyght', 'grunt', 'ekran', 'lunna', 'rubik', 'yeseva', 'nunito-rounded', 'commissioner', 'geologica', 'oi', 'dela', 'roboto-flex', 'days-one', 'sofia-xc', 'roboto-serif', 'alumni', 'literata', ...libraryFamilyIds] as const;
export type FontFamilyId = (typeof fontFamilyIds)[number];
export const fontFamilies: Record<FontFamilyId, FontFamily> = {
  cormorant, manrope, unbounded, golos, onest, prata, 'plex-serif': plexSerif, 'plex-sans': plexSans, nunito, inter, playfair, 'pt-serif': ptSerif,
  oswald, nyght, grunt, ekran, lunna, 'inter-tight': interTight, jost, caveat, 'jetbrains-mono': jetbrainsMono, rubik, yeseva, 'nunito-rounded': nunitoRounded, commissioner, geologica, oi, dela, 'roboto-flex': robotoFlex, 'days-one': daysOne, 'sofia-xc': sofiaXc, 'roboto-serif': robotoSerif, alumni, literata, ...libraryFamilies,
};

const fileName = (font: FontFamily, subset: string, weight: number | 'wght') => `${font.dir}-${subset}-${weight}-normal.woff2`;

// Relative file paths (below the fonts root) needed by one family.
export function fontFamilyFiles(font: FontFamily): string[] {
  if(font.files) return [...font.files.map(f=>`${font.dir}/${f.name}`),...(font.license?[`${font.dir}/${font.license}`]:[])];
  return SUBSETS.flatMap(subset =>
    font.variable ? [`${font.dir}/${fileName(font, subset, 'wght')}`] : font.weights.map(w => `${font.dir}/${fileName(font, subset, w)}`),
  );
}

// Every file of every family, used by copy-fonts and the vector PDF's renderer.
export function allFontFiles(): string[] {
  return [...new Set(Object.values(fontFamilies).flatMap(fontFamilyFiles))];
}
