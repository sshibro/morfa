// Figma's REST answers read from the browser (src/figma-import/figma-client.ts). Only the
// limit the design tool's Figma import uses.

// A Figma answer bigger than this is refused before parsing.
export const MAX_FIGMA_RESPONSE_BYTES = 80 * 1024 * 1024;
