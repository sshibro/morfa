// The starter templates as the gallery lists them: names, one line each, and the faces each sets type
// in. No builders here, so the file browser can show the list without loading them (index.ts adds them).

export type TemplateId = 'blank' | 'mobile' | 'site' | 'presentation' | 'social' | 'ui-kit' | 'marketplace';

export type TemplateFont = {family: string; weights: number[]};

export type TemplateEntry = {
  id: TemplateId;
  /** The gallery's title, and the new file's name. */
  name: string;
  description: string;
  /** Every face the template sets type in (load them before building, so the layout measures real type). */
  fonts: TemplateFont[];
};

export const TEMPLATE_CATALOG: readonly TemplateEntry[] = [
  {id: 'blank', name: 'Blank file', description: 'An empty page', fonts: []},
  {id: 'mobile', name: 'Mobile app', description: 'iPhone 16 screens, components and a dark theme', fonts: [{family: 'Inter', weights: [400, 500, 600, 700]}]},
  {id: 'site', name: 'Website', description: '1440 px landing page on a 12-column grid', fonts: [{family: 'Manrope', weights: [300, 500, 600, 700, 800]}]},
  {
    id: 'presentation', name: 'Presentation', description: 'Three 1920 × 1080 slides with text styles',
    fonts: [{family: 'Inter Tight', weights: [600, 700]}, {family: 'Inter', weights: [400, 500, 600]}],
  },
  {
    id: 'social', name: 'Social media', description: 'Instagram post, story and a Telegram picture',
    fonts: [{family: 'Playfair Display', weights: [800]}, {family: 'Manrope', weights: [600, 800]}],
  },
  {id: 'ui-kit', name: 'UI kit', description: 'Buttons, fields, tags and other components with styles', fonts: [{family: 'Inter', weights: [400, 500, 600, 700]}]},
  // The gallery asks which marketplace and whether one card or six slides before it builds (NewFileMenu.tsx).
  {id: 'marketplace', name: 'Marketplace card', description: 'Wildberries, Ozon or Yandex Market: 900 × 1200 with a rules check', fonts: [{family: 'Inter', weights: [500, 700]}]},
];
