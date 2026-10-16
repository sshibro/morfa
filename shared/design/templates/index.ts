import type {DesignDocument} from '../types';
import {TEMPLATE_CATALOG, type TemplateEntry, type TemplateId} from './catalog';
import {TemplateBuilder, type BuildOptions} from './kit';
import {buildMarketplaceCard} from './marketplace';
import {buildMobileApp} from './mobile';
import {buildPresentation} from './presentation';
import {buildSite} from './site';
import {buildSocial} from './social';
import {buildUiKit} from './ui-kit';

// Starter templates for a new file ("New file ▾"): pure builders that return a whole document made with
// the editor's own operations (shared/design/templates/kit.ts). Each is laid out with the measurer it is
// given, so the client builds it after the template's fonts have loaded and the file opens already measured.

export {TEMPLATE_CATALOG, type TemplateEntry, type TemplateFont, type TemplateId} from './catalog';
export type {BuildOptions} from './kit';

export type DesignTemplate = TemplateEntry & {build(options: BuildOptions): DesignDocument};

/** "Blank file": one empty page, as a new file starts. */
export function buildBlank(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  b.page('Page 1');
  return b.finish();
}

const BUILDERS: Record<TemplateId, (options: BuildOptions) => DesignDocument> = {
  blank: buildBlank,
  mobile: buildMobileApp,
  site: buildSite,
  presentation: buildPresentation,
  social: buildSocial,
  'ui-kit': buildUiKit,
  marketplace: buildMarketplaceCard,
};

export const DESIGN_TEMPLATES: readonly DesignTemplate[] = TEMPLATE_CATALOG.map(entry => ({...entry, build: BUILDERS[entry.id]}));

export const templateById = (id: string): DesignTemplate | undefined => DESIGN_TEMPLATES.find(template => template.id === id);
