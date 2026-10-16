// What a Figma import approximated or left out, in the words the final screen shows. The mapper
// notes every case once per kind with a count and a few layer names; nothing is silently dropped.

/** Groups on the report screen, in this order. */
export type FigmaReportGroup = 'fonts' | 'components' | 'appearance' | 'text' | 'vectors' | 'layout' | 'prototype' | 'styles' | 'limits' | 'images';

export const FIGMA_REPORT_GROUPS: Record<FigmaReportGroup, string> = {
  fonts: 'Fonts',
  components: 'Components',
  appearance: 'Fills and effects',
  text: 'Text',
  vectors: 'Vectors',
  layout: 'Auto layout',
  prototype: 'Prototype',
  styles: 'Styles and variables',
  limits: 'File limits',
  images: 'Images',
};

export type FigmaReportItem = {
  key: string;
  group: FigmaReportGroup;
  message: string;
  /** How many layers (or values) it concerns. */
  count: number;
  /** A few layer names, for orientation. */
  examples: string[];
};

/** One font that was not in the catalogue and what stands in for it. */
export type FigmaFontSubstitution = {from: string; to: string; layers: number};

export type FigmaImportReport = {
  fileName: string;
  pages: number;
  /** Layers in the new file. */
  nodes: number;
  components: number;
  instances: number;
  /** Pictures the file uses (before any upload). */
  images: number;
  fonts: FigmaFontSubstitution[];
  items: FigmaReportItem[];
};

const MAX_EXAMPLES = 3;

/** Collects report items while mapping. */
export class ReportBuilder {
  private readonly items = new Map<string, FigmaReportItem>();
  private readonly fonts = new Map<string, FigmaFontSubstitution>();

  /** Notes one occurrence of `key`; the message of the first note wins. */
  note(key: string, group: FigmaReportGroup, message: string, example?: string, count = 1): void {
    let item = this.items.get(key);
    if (!item) this.items.set(key, item = {key, group, message, count: 0, examples: []});
    item.count += count;
    const name = example?.trim();
    if (name && item.examples.length < MAX_EXAMPLES && !item.examples.includes(name)) item.examples.push(name.slice(0, 80));
  }

  font(from: string, to: string): void {
    const key = `${from}→${to}`;
    const entry = this.fonts.get(key);
    if (entry) entry.layers++;
    else this.fonts.set(key, {from, to, layers: 1});
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  build(base: Omit<FigmaImportReport, 'fonts' | 'items'>): FigmaImportReport {
    const order = Object.keys(FIGMA_REPORT_GROUPS) as FigmaReportGroup[];
    const items = [...this.items.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    const fonts = [...this.fonts.values()].sort((a, b) => b.layers - a.layers || a.from.localeCompare(b.from));
    return {...base, fonts, items};
  }
}
