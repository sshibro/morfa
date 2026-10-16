import {fontFamilies} from '../../fonts';

// Figma's font families → the families Morfa ships (shared/fonts.ts, all with Cyrillic). An exact
// name wins; a face the catalogue cannot carry (no Cyrillic, commercial, system) takes the family
// closest in construction, as shared/site-snapshot/fonts.ts does for imported sites; anything else
// falls back by class (serif, mono, script, sans). Every substitution is reported, and the text
// keeps the original name in `pluginData.figmaFont`.

/** Lower-case letters and digits only: "Plus Jakarta Sans" → "plusjakartasans". */
export const fontKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9а-яё]/g, '');

/** Popular faces outside the catalogue, keyed like `fontKey`, with the catalogue family to use. */
const LOOKALIKES: Record<string, string> = {
  poppins: 'Montserrat', gilroy: 'Montserrat', gotham: 'Montserrat', gothampro: 'Montserrat', proximanova: 'Montserrat',
  ttnorms: 'Montserrat', ttnormspro: 'Montserrat', ttcommons: 'Montserrat', ttcommonspro: 'Montserrat', museosans: 'Montserrat', museosanscyrl: 'Montserrat',
  dmsans: 'Manrope', plusjakartasans: 'Manrope', circular: 'Manrope', circularstd: 'Manrope', spacegrotesk: 'Manrope', sora: 'Manrope', urbanist: 'Manrope',
  futura: 'Jost', futurapt: 'Jost', outfit: 'Jost', josefinsans: 'Jost', lexend: 'Jost', kumbhsans: 'Jost',
  avenir: 'Nunito Sans', avenirnext: 'Nunito Sans', avenirnextcyr: 'Nunito Sans', mulishvariable: 'Mulish',
  lato: 'Open Sans', segoeui: 'Open Sans', notosansdisplay: 'Noto Sans', firagosans: 'Fira Sans',
  figtree: 'Onest', worksans: 'Inter', publicsans: 'Inter', interdisplay: 'Inter', intervariable: 'Inter', manropevariable: 'Manrope',
  sfpro: 'Inter', sfprodisplay: 'Inter', sfprotext: 'Inter', sfprorounded: 'Nunito', sfuidisplay: 'Inter', sfuitext: 'Inter', sanfrancisco: 'Inter',
  helvetica: 'Inter', helveticaneue: 'Inter', arial: 'Inter', systemui: 'Inter', applesystem: 'Inter', neuehaasgrotesk: 'Inter', neuehaasunica: 'Inter',
  graphik: 'Inter', aktivgrotesk: 'Inter', suisseintl: 'Inter', ysdisplay: 'Inter', ystext: 'Inter', yandexsans: 'Inter', yandexsansdisplay: 'Inter', yandexsanstext: 'Inter',
  heebo: 'Roboto', barlow: 'Roboto', arimo: 'Roboto', robotovariable: 'Roboto', barlowcondensed: 'Roboto Condensed', archivonarrow: 'Roboto Condensed',
  geistsans: 'Geist', golos: 'Golos Text', golosui: 'Golos Text', golostextvf: 'Golos Text',
  sourcesanspro: 'Source Sans 3', sourceserifpro: 'Source Serif 4', ibmplexsanscondensed: 'IBM Plex Sans',
  quicksand: 'Comfortaa', varelaround: 'Nunito', titilliumweb: 'Exo 2', orbitron: 'Tektur',
  madefordisplay: 'Wix Madefor Display', madefortext: 'Wix Madefor Text', wixmadefordisplayv2: 'Wix Madefor Display', wixmadefortextv2: 'Wix Madefor Text',
  bebasneue: 'Oswald', bebas: 'Oswald', anton: 'Oswald', leaguegothic: 'Oswald', druk: 'Oswald', drukcyr: 'Oswald', impact: 'Oswald', fjallaone: 'Oswald',
  drukwide: 'Unbounded', drukwidecyr: 'Unbounded', benzin: 'Unbounded', syne: 'Unbounded', clashdisplay: 'Unbounded',
  timesnewroman: 'PT Serif', times: 'PT Serif', georgia: 'PT Serif', librebaskerville: 'PT Serif', baskerville: 'PT Serif',
  crimsontext: 'EB Garamond', crimsonpro: 'EB Garamond', garamond: 'EB Garamond', adobegaramond: 'EB Garamond', adobegaramondpro: 'EB Garamond', cormorant: 'Cormorant Garamond',
  dmserifdisplay: 'Playfair Display', dmseriftext: 'PT Serif', fraunces: 'Playfair Display', ibmplexserif: 'IBM Plex Serif',
  bodonimoda: 'Oranienbaum', bodoni: 'Oranienbaum', didot: 'Oranienbaum', abrilfatface: 'Yeseva One',
  dancingscript: 'Marck Script', satisfy: 'Marck Script', kaushanscript: 'Marck Script', greatvibes: 'Great Vibes',
  sacramento: 'Great Vibes', parisienne: 'Great Vibes', allura: 'Great Vibes', alexbrush: 'Great Vibes',
  indieflower: 'Caveat', shadowsintolight: 'Caveat', patrickhand: 'Caveat', permanentmarker: 'Caveat', gloriahallelujah: 'Caveat', comicsansms: 'Caveat',
  spacemono: 'JetBrains Mono', sfmono: 'JetBrains Mono', menlo: 'JetBrains Mono', consolas: 'JetBrains Mono', monaco: 'JetBrains Mono',
  courier: 'JetBrains Mono', couriernew: 'JetBrains Mono', ubuntumono: 'JetBrains Mono', inconsolata: 'JetBrains Mono', dmmono: 'JetBrains Mono',
};

// Style words static faces carry in the family name ("Montserrat SemiBold"), and edition words.
const STYLE_SUFFIX = /(thin|hairline|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique)+$/;
const EDITION_SUFFIX = /(variable|vf|pro|std|new|cyr|cyrillic|ui|display|text)+$/;

let catalogue: Map<string, string> | null = null;
/** Catalogue family names by key, built once. */
function catalogueByKey(): Map<string, string> {
  if (catalogue) return catalogue;
  catalogue = new Map();
  for (const font of Object.values(fontFamilies)) if (!catalogue.has(fontKey(font.family))) catalogue.set(fontKey(font.family), font.family);
  return catalogue;
}

/** The family a name stands for, or undefined. */
function known(key: string): string | undefined {
  if (!key) return undefined;
  return catalogueByKey().get(key) ?? LOOKALIKES[key];
}

function byClass(name: string): string {
  const lower = name.toLowerCase();
  if (/mono|code|courier|consol|terminal/.test(lower)) return 'JetBrains Mono';
  if (/script|hand|brush|marker|callig/.test(lower)) return 'Caveat';
  if (!/sans/.test(lower) && /serif|garamond|times|georgia|antiqua|roman|playfair|didot|bodoni|baskerville|slab|caslon|minion/.test(lower)) return 'PT Serif';
  return 'Inter';
}

export type FontMatch = {family: string; substituted: boolean};

/** Icon fonts whose ligatures name the icon ("gas_station"): set in another font they spell the name instead. */
export const ICON_FONT = /material ?(symbols|icons)|font ?awesome|ionicons|feather|remix ?icon|phosphor|tabler|bootstrap ?icons|glyphicons|icomoon|lucide|boxicons|line ?awesome/i;

const cache = new Map<string, FontMatch>();

/** The catalogue family for a Figma family name. */
export function matchFigmaFont(name: string | undefined): FontMatch {
  const original = (name ?? '').trim();
  if (!original) return {family: 'Inter', substituted: false};
  const cached = cache.get(original);
  if (cached) return cached;
  const key = fontKey(original);
  const exact = catalogueByKey().get(key);
  let result: FontMatch;
  if (exact) result = {family: exact, substituted: false};
  else {
    const styled = key.replace(STYLE_SUFFIX, '');
    const edition = styled.replace(EDITION_SUFFIX, '');
    const family = known(key) ?? known(styled) ?? known(edition) ?? byClass(original);
    // "Montserrat SemiBold" is Montserrat itself, set in another weight: not a substitution.
    result = {family, substituted: fontKey(family) !== styled};
  }
  cache.set(original, result);
  return result;
}

/** Weight from a Figma style name when `fontWeight` is missing ("Semi Bold Italic" → 600). */
export function weightOfStyle(style: string | undefined): number | undefined {
  if (!style) return undefined;
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  const table: [RegExp, number][] = [
    [/hairline|thin/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/bold/, 700], [/medium/, 500], [/regular|normal|book|roman|plain/, 400],
  ];
  for (const [pattern, weight] of table) if (pattern.test(s)) return weight;
  return undefined;
}
