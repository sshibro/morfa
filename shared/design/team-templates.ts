// Custom team templates (help.figma.com "Create custom templates in FigJam"): a team's board published as
// a template its people insert from the "+" sheet. The wire types are in shared/design/api.ts §Templates; the server is
// server/design/templates.ts. No zod and no server imports.

/** Templates one team may publish (FigJam's five). */
export const TEAM_TEMPLATE_LIMIT = 5;

export const TEAM_TEMPLATE_CAPS = {
  /** Characters of a template's name and description (code points). */
  name: 80,
  description: 300,
  /** The stored snapshot of one version (the first page's top-level objects): a template is a starting point, not a file. */
  snapshotBytes: 5 * 1024 * 1024,
  /** Versions kept of one template: the newest ones. */
  versionsKept: 5,
  /** Templates one list answers. */
  listed: 200,
} as const;

export type DesignTemplateScope = 'team' | 'organization';
export const isTemplateScope = (value: unknown): value is DesignTemplateScope => value === 'team' || value === 'organization';
