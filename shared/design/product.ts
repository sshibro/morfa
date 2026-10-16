// The product's name, kept in one place so a rename is one edit ("Morfa", morfa.example / app.morfa.example). Every customer-facing string that names the product reads
// PRODUCT_NAME or the vocabulary key below: the landing, the sign-in screen, the code generator's comments and README,
// the file browser.

/** The product's name as customers read it (decided 2026-10-08). */
export const PRODUCT_NAME = 'Morfa';

/** The product's words by key, the i18n side of the shared Russian vocabulary (docs/design-tool.md). */
export const PRODUCT_VOCABULARY = {
  'product.name': PRODUCT_NAME,
} as const;

export type ProductKey = keyof typeof PRODUCT_VOCABULARY;

/** The vocabulary entry for `key`. */
export const productText = (key: ProductKey): string => PRODUCT_VOCABULARY[key];
