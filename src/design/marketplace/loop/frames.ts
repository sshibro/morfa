import {cardExportOf, cardMeta, cardsOnPage, withCardMeta, type CardMeta} from '../../../../shared/design/marketplace/meta';
import {collectCardFacts} from '../../../../shared/design/marketplace/facts';
import {lintCard, type LintCheck} from '../../../../shared/design/marketplace/lint';
import {pageIdOf} from '../../../../shared/design/tree';
import type {NodeId} from '../../../../shared/design/types';
import {runCommand} from '../../engine/commands/registry';
import type {EditorServices} from '../../editor/services';
import {renderCardImage} from '../export/render';

// What the Performance Loop does with frames in the editor: the picture a frame is published as (Card Canvas's renderer, with the
// card's own export settings), Spec Lint's failures that ask for "Publish anyway", the frames a test can compare, and the next
// round's new variant (a duplicate of the winner).

/** The frame as the marketplace gets it: the card re-flowed for `marketplace` with its export settings (`meta`: another card's, for a
 *  plain frame used as a variant). */
export async function renderFrame(services: EditorServices, frameId: NodeId, fallback: CardMeta): Promise<Blob> {
  const meta = cardMeta(services.store.getState().doc.nodes[frameId]) ?? fallback;
  return renderCardImage(services, frameId, fallback.marketplace, cardExportOf(meta));
}

/** Spec Lint's failed checks for the card on its marketplace (none when the facts cannot be read yet). */
export function lintFailures(services: EditorServices, frameId: NodeId, meta: CardMeta): LintCheck[] {
  const facts = collectCardFacts(services.store.getState().doc, frameId, meta);
  return facts ? lintCard(facts).checks.filter(check => check.status === 'fail') : [];
}

/** Frames a test may set against `frameId`: the cards on its page for the same marketplace, its own set (`group`) first. */
export function variantCandidates(services: EditorServices, frameId: NodeId, meta: CardMeta): {id: NodeId; name: string}[] {
  const doc = services.store.getState().doc;
  const pageId = pageIdOf(doc, frameId);
  if (!pageId) return [];
  const cards = cardsOnPage(doc, pageId).filter(card => card.id !== frameId && card.meta.marketplace === meta.marketplace);
  const same = (card: {meta: CardMeta}) => (meta.group && card.meta.group === meta.group ? 0 : 1);
  return cards.sort((a, b) => same(a) - same(b)).map(card => ({id: card.id, name: doc.nodes[card.id]?.name || 'Untitled'}));
}

/** A copy of the frame beside it as the set's next variant (its number one past the set's highest), selected and shown. */
export function duplicateAsVariant(services: EditorServices, frameId: NodeId): NodeId | null {
  const ctx = services.canvas?.()?.commandContext();
  if (!ctx || services.readOnly) return null;
  services.store.setSelection([frameId]);
  if (!runCommand('duplicate', ctx)) return null;
  const copy = services.store.getState().selection[0];
  if (!copy || copy === frameId) return null;
  const doc = services.store.getState().doc;
  const meta = cardMeta(doc.nodes[copy]);
  if (meta) {
    const pageId = pageIdOf(doc, copy);
    const highest = pageId
      ? Math.max(0, ...cardsOnPage(doc, pageId).filter(card => meta.group && card.meta.group === meta.group).map(card => card.meta.variant ?? 1))
      : 1;
    services.store.transact('New variant', tx => {
      const node = tx.get(copy);
      if (node) tx.update(copy, {pluginData: withCardMeta(node.pluginData, {...meta, variant: highest + 1})});
      return {select: [copy]};
    });
  }
  services.revealNodes([copy]);
  return copy;
}

/** Saves a picture as a file (the cabinet test's two pictures). */
export function downloadPicture(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
