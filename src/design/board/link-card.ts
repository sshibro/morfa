import type {ImageAsset, ImageRef, Vec} from '../../../shared/design/types';
import {newId} from '../../../shared/design/defaults';
import {createLinkCard, createSticky, insertPieces, type LinkCardContent} from '../../../shared/design/board/create';
import {api} from '../../api';
import type {DesignStore} from '../engine/store';
import {boardIdentity} from './tools/place';

// A link pasted on a board becomes a card with the page's title, description, site and picture (FigJam; help.figma.com "Import
// spreadsheet data, images, and designs"), from lane D's `GET /api/design-files/:id/link-preview?url=` (an editor of the file; the
// picture is stored as one of the file's own). When the page gives nothing (or the server refuses it), the link is a sticky as
// before. The board tells this module its file (BoardLayout).

type LinkPreview = {url: string; title: string | null; description: string | null; image: ImageRef | null; imageAsset: ImageAsset | null; site: string | null};

let boardFile: string | null = null;

/** The open board's file id (null when none is open or it is read-only): link cards ask its preview route. */
export function setLinkCardFile(fileId: string | null): () => void {
  boardFile = fileId;
  return () => {
    if (boardFile === fileId) boardFile = null;
  };
}

/** A pasted text that is one web address and nothing else. */
export function linkOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 2000) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export const linkCardsReady = () => boardFile !== null;

/** Asks for the link's preview and puts a card with its top-left corner around `centre`; a sticky with the link when there is none.
 *  One undo step either way. Resolves with what was made. */
export async function placeLinkCard(store: DesignStore, url: string, centre: Vec): Promise<'card' | 'sticky' | null> {
  const fileId = boardFile;
  let preview: LinkPreview | null = null;
  if (fileId) {
    try {
      preview = await api<LinkPreview>(`/design-files/${encodeURIComponent(fileId)}/link-preview?url=${encodeURIComponent(url)}`);
    } catch {
      preview = null;
    }
  }
  if (store.readOnly) return null;
  const {pageId} = store.getState();
  if (!preview || (!preview.title && !preview.description && !preview.image)) {
    const author = boardIdentity().name || undefined;
    const sticky = createSticky(newId, {x: Math.round(centre.x - 120), y: Math.round(centre.y - 120), text: url, author, showAuthor: !!author});
    store.transact('Paste link', tx => void insertPieces(tx, sticky, pageId), {select: [sticky.id]});
    return 'sticky';
  }
  const content: LinkCardContent = {url: preview.url || url, title: preview.title, description: preview.description, site: preview.site, image: preview.image && preview.imageAsset ? preview.image : null};
  const card = createLinkCard(newId, {x: Math.round(centre.x - 160), y: Math.round(centre.y - 120), content});
  store.transact('Link card', tx => {
    if (content.image && preview!.imageAsset) tx.setImage(content.image, preview!.imageAsset);
    insertPieces(tx, card, pageId);
  }, {select: [card.id]});
  return 'card';
}
