// Russian text proofing (docs/marketplaces.md §Russian text proofing): what the editor sends to /api/marketplace/proof and what comes
// back, the limits both sides hold, and which words the spelling check reads. WB marks down cards with garbled captions, so every text layer
// of a card is checked against a Russian Hunspell dictionary on the server, free. Pure: the client, the server and the tests read the
// same rules.

import type {DesignDocument, NodeId} from '../types';
import {descendants} from './meta';

/** One problem in a text layer: the word (or words) as written, what is wrong, and what to write instead (best first). */
export type ProofIssue = {word: string; message: string; suggestions: string[]};

/** One request: at most `texts` texts of at most `chars` characters each. */
export const PROOF_LIMITS = {texts: 60, chars: 2000} as const;

export type ProofText = {id: string; text: string};
export type ProofBody = {fileId: string; texts: ProofText[]};
/** Text id → its issues; a text without issues is absent or empty. */
export type ProofAnswer = {issues: Record<string, ProofIssue[]>};

/** "maybe "quality"", or "not in the dictionary". (The spellchecker itself is Russian: the marketplaces' cards are in Russian.) */
export const spellingMessage = (suggestions: readonly string[]) => (suggestions.length ? `maybe "${suggestions[0]}"` : 'not in the dictionary');

const CYRILLIC = /^\p{Script=Cyrillic}+$/u;
const UPPER = /^\p{Lu}+$/u;

/** A word the spelling check reads: Cyrillic letters only (a hyphenated word reads as its whole and its parts). Words with digits
 *  ("5см"), Latin words and anything mixed are skipped, as are single letters and abbreviations of up to five capitals ("ГОСТ", "США"). */
export function checkableWord(word: string): boolean {
  const parts = word.split('-');
  if (parts.some(part => !CYRILLIC.test(part))) return false;
  const letters = parts.join('');
  if (letters.length < 2) return false;
  if (UPPER.test(letters) && letters.length <= 5) return false;
  return true;
}

/** The words of a text in order, each once per text: runs of letters and digits, hyphens inside a word kept. */
export function proofWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Composed first (a "й" typed as "и" and a breve stays one letter); stress marks left over are dropped.
  for (const match of text.normalize('NFC').matchAll(/[\p{L}\p{M}\p{N}]+(?:[-‐‑][\p{L}\p{M}\p{N}]+)*/gu)) {
    const word = match[0].replace(/[‐‑]/g, '-').replace(/\p{M}/gu, '');
    if (!checkableWord(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** The card's text layers that hold words, in layer order. */
export function cardTexts(doc: Pick<DesignDocument, 'nodes'>, frameId: NodeId): ProofText[] {
  const out: ProofText[] = [];
  for (const node of descendants(doc, frameId)) if (node.type === 'TEXT' && node.text?.characters.trim()) out.push({id: node.id, text: node.text.characters});
  return out;
}

/** Each text once, in order (the first layer that holds it names it). */
export function uniqueTexts(texts: readonly ProofText[]): ProofText[] {
  const seen = new Set<string>();
  return texts.filter(item => !seen.has(item.text) && !!seen.add(item.text));
}
