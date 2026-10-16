// Card Canvas: Russian spelling of a card's texts (docs/marketplaces.md §Russian text proofing). Hunspell (hunspell-asm, WebAssembly) with
// the Russian dictionary of Alexander Lebedev (dictionary-ru, BSD-3-Clause), loaded once per process on the first check: about 0.2 s and
// 25 MB, against 3 s and 240 MB for the pure-JavaScript nspell with the same dictionary. Answers are kept per word; a long request
// yields to the event loop between words so other requests keep moving.
import {
  checkableWord,
  proofWords,
  spellingMessage,
  type ProofIssue,
  type ProofText,
} from '../../../shared/design/marketplace/proof';

/** What the check needs of a speller (a test passes its own). */
export type Speller = {correct(word: string): boolean; suggest(word: string): string[]};

let loading: Promise<Speller> | null = null;

/** The process's Russian speller, loaded on first use. A failed load is tried again on the next call. */
export function russianSpeller(): Promise<Speller> {
  loading ??= (async (): Promise<Speller> => {
    const [{loadModule}, {default: dictionary}] = await Promise.all([import('hunspell-asm'), import('dictionary-ru')]);
    const factory = await loadModule();
    const hunspell = factory.create(
      factory.mountBuffer(dictionary.aff, 'ru_RU.aff'),
      factory.mountBuffer(dictionary.dic, 'ru_RU.dic'),
    );
    return {correct: word => hunspell.spell(word), suggest: word => hunspell.suggest(word)};
  })().catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}

/** A small first-in-first-out memory of answers. */
class Memo<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string): T | undefined {
    return this.map.get(key);
  }
  set(key: string, value: T) {
    if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, value);
  }
}

const known = new Memo<boolean>(100_000);
const suggested = new Memo<string[]>(20_000);
/** Suggestions take Hunspell 50–150 ms a word: at most this many new ones a request; the others say "not in the dictionary". */
export const SUGGESTIONS_PER_REQUEST = 12;
const YIELD_EVERY = 400;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** A word as Hunspell reads it: whole, or a hyphenated word whose every part is a word ("темно-синий", dark blue). */
function isCorrect(speller: Speller, word: string): boolean {
  const memo = known.get(word);
  if (memo !== undefined) return memo;
  let correct = speller.correct(word);
  if (!correct && word.includes('-'))
    correct = word.split('-').every(part => !checkableWord(part) || speller.correct(part));
  known.set(word, correct);
  return correct;
}

/** Each text's misspelled words, with up to three suggestions each. Texts without any are left out. */
export async function spellingIssues(
  texts: readonly ProofText[],
  speller?: Speller,
): Promise<Record<string, ProofIssue[]>> {
  const check = speller ?? (await russianSpeller());
  const out: Record<string, ProofIssue[]> = {};
  let words = 0;
  let suggestions = 0;
  for (const {id, text} of texts) {
    const issues: ProofIssue[] = [];
    for (const word of proofWords(text)) {
      if (++words % YIELD_EVERY === 0) await tick();
      if (isCorrect(check, word)) continue;
      let options = suggested.get(word);
      if (options === undefined && suggestions < SUGGESTIONS_PER_REQUEST) {
        suggestions++;
        options = check
          .suggest(word)
          .filter(option => option !== word)
          .slice(0, 3);
        suggested.set(word, options);
        await tick();
      }
      issues.push({word, message: spellingMessage(options ?? []), suggestions: options ?? []});
    }
    if (issues.length) out[id] = issues;
  }
  return out;
}
