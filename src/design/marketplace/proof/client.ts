// Russian text proofing on the client (docs/marketplaces.md §Russian text proofing): the spelling issues of a card's text layers,
// fetched from /api/marketplace/proof and kept per text. A pause in typing sends only the texts nobody has checked yet; what came back
// is kept by the text itself (the same words on another card, or after an undo, are not asked again). Owned by the Card Canvas module.

import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {api} from '../../../api';
import {cardTexts, PROOF_LIMITS, proofWords, uniqueTexts, type ProofAnswer, type ProofIssue, type ProofText} from '../../../../shared/design/marketplace/proof';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {useDesignStore} from '../../engine/useDesignStore';

export type {ProofIssue};

/** Text → its issues, for every text the editor showed. */
const spelling = new Map<string, readonly ProofIssue[]>();
/** Texts on their way to the server. */
const asking = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
const KEEP = 4000;

function remember(text: string, issues: readonly ProofIssue[]) {
  if (spelling.size >= KEEP) spelling.delete(spelling.keys().next().value!);
  spelling.set(text, issues);
}
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const useRevision = () => useSyncExternalStore(subscribe, () => revision);

const sameTexts = (a: readonly ProofText[], b: readonly ProofText[]) => a.length === b.length && a.every((item, i) => item.id === b[i].id && item.text === b[i].text);

/** Asks the server for the spelling of texts nobody has checked, in requests of at most PROOF_LIMITS.texts. */
async function askSpelling(fileId: string, texts: readonly ProofText[]): Promise<void> {
  const wanted = uniqueTexts(texts).filter(item => !spelling.has(item.text) && !asking.has(item.text));
  if (!wanted.length) return;
  for (const item of wanted) asking.add(item.text);
  try {
    for (let start = 0; start < wanted.length; start += PROOF_LIMITS.texts) {
      const chunk = wanted.slice(start, start + PROOF_LIMITS.texts);
      // A text without a word to check (numbers, Latin) needs no request.
      const sent = chunk.filter(item => proofWords(item.text).length);
      for (const item of chunk) if (!sent.includes(item)) remember(item.text, []);
      if (!sent.length) continue;
      const answer = await api<ProofAnswer>('/marketplace/proof', {
        method: 'POST',
        body: JSON.stringify({fileId, texts: sent.map(item => ({id: item.id, text: item.text.slice(0, PROOF_LIMITS.chars)}))}),
      });
      for (const item of sent) remember(item.text, answer.issues[item.id] ?? []);
    }
  } finally {
    for (const item of wanted) asking.delete(item.text);
    changed();
  }
}

/** How long typing must pause before the texts are checked. */
export const PROOF_DEBOUNCE_MS = 600;

/** Text layer → its issues; undefined while the card's texts have not been checked yet. */
export function useCardProofing(frameId: NodeId): Readonly<Record<NodeId, readonly ProofIssue[]>> | undefined {
  const {fileId} = useEditorServices();
  const texts = useDesignStore(state => cardTexts(state.doc, frameId), sameTexts, {slice: 'doc'});
  const version = useRevision();
  // The card whose first check came back (a check that failed leaves the card unchecked until its texts change).
  const [checked, setChecked] = useState<NodeId | null>(null);
  useEffect(() => {
    let alive = true;
    const first = checked !== frameId;
    const timer = setTimeout(() => {
      askSpelling(fileId, texts).then(
        () => alive && setChecked(frameId),
        () => undefined,
      );
    }, first ? 0 : PROOF_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `checked` is read only to skip the pause on a card's first check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, frameId, texts]);
  return useMemo(() => {
    const all = texts.every(item => spelling.has(item.text));
    if (checked !== frameId && !all) return undefined;
    const out: Record<NodeId, readonly ProofIssue[]> = {};
    for (const {id, text} of texts) {
      const issues = spelling.get(text) ?? [];
      if (issues.length) out[id] = issues;
    }
    return out;
    // `version` changes whenever an answer arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texts, checked, frameId, version]);
}
