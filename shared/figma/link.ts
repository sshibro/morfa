export type FigmaLink = {fileKey: string; nodeId?: string};

/** A link the importer cannot use; the message is shown to the user as is. */
export class FigmaLinkError extends Error {}

const EMPTY = 'Paste a link to a Figma file.';
const NOT_FIGMA = 'A link to a Figma file is required: figma.com/design/…';
const COPY_FIRST = 'This is a file from Figma Community. Open it, save a copy to your drafts and paste the link to the copy.';
const REFUSED: Record<string, string> = {
  board: 'FigJam boards cannot be imported. A link to a Figma Design file is required.',
  slides: 'Figma Slides decks cannot be imported. A link to a Figma Design file is required.',
  site: 'Figma Sites cannot be imported. A link to a Figma Design file is required.',
  make: 'Figma Make projects cannot be imported. A link to a Figma Design file is required.',
  buzz: 'Figma Buzz files cannot be imported. A link to a Figma Design file is required.',
  community: COPY_FIRST,
};

const HOSTS = new Set(['figma.com', 'www.figma.com', 'embed.figma.com']);
const FILE_KINDS = new Set(['design', 'file', 'proto']);
const FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
// 12-34 in a URL, 12:34 in the API; instance sublayers read I12-34;56-78.
const NODE_ID = /^I?\d+[-:]\d+(?:;\d+[-:]\d+)*$/;

function addressOf(value: string): URL {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value.replace(/^\/\//, ''));
  } catch {
    throw new FigmaLinkError(NOT_FIGMA);
  }
}

function nodeIdOf(address: URL): string | undefined {
  const raw = address.searchParams.get('node-id')?.trim();
  return raw && NODE_ID.test(raw) ? raw.replace(/-/g, ':') : undefined;
}

function parse(raw: string, embedded: boolean): FigmaLink {
  const value = raw.trim();
  if (!value) throw new FigmaLinkError(EMPTY);
  const address = addressOf(value);
  if (!/^https?:$/.test(address.protocol) || !HOSTS.has(address.hostname.toLowerCase())) throw new FigmaLinkError(NOT_FIGMA);
  const parts = address.pathname.split('/').filter(Boolean);
  const kind = parts[0]?.toLowerCase() ?? '';
  if (kind === 'embed') {
    const inner = address.searchParams.get('url');
    if (!inner || embedded) throw new FigmaLinkError(NOT_FIGMA);
    return parse(inner, true);
  }
  if (REFUSED[kind]) throw new FigmaLinkError(REFUSED[kind]);
  if (!FILE_KINDS.has(kind)) throw new FigmaLinkError(NOT_FIGMA);
  const fileKey = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  if (!fileKey || !FILE_KEY.test(fileKey)) throw new FigmaLinkError(NOT_FIGMA);
  const nodeId = nodeIdOf(address);
  return nodeId ? {fileKey, nodeId} : {fileKey};
}

/** The file (and the frame, when the link names one) a Figma link points at. */
export function parseFigmaLink(raw: string): FigmaLink {
  return parse(raw, false);
}

/** A link back to the file, for reports and import records. */
export const figmaFileUrl = (fileKey: string) => `https://www.figma.com/design/${fileKey}`;
