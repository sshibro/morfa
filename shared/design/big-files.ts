// The big-files switch (docs/decisions/big-files.md §1): with it on, the fixed 50 000-layer / 20 MB cap gives way to
// `DESIGN_BIG_FILE_CAPS` (a safety net) and the memory budget of the browser tab (2 GB, warnings at 60 % and 75 %,
// pages loaded on demand), as the owner decided (docs/TARGETS.md §9). Off by default until the GPU renderer meets C3/C11;
// the coordinator flips `DEFAULT_BIG_FILES` then (and `crates/model/src/limits.rs` `big_files()`'s DEFAULT).
//
// Where it is read from, first match wins: `setBigFiles` (tests); in Node `DESIGN_BIG_FILES` (api, the bench) — the
// collab service reads `MORFA_BIG_FILES` through the model crate; in the browser `?bigFiles=1` in the address (a local run,
// the e2e), then `globalThis.__MORFA_BIG_FILES__`, set from `/api/config.bigFiles`. Plain values only: importable anywhere.
import {DESIGN_BIG_FILE_CAPS, DESIGN_DOCUMENT_CAPS} from './limits';

export const DEFAULT_BIG_FILES = false;

type Runtime = {
  process?: {env?: Record<string, string | undefined>; versions?: {node?: string}};
  location?: {search?: string};
  __MORFA_BIG_FILES__?: boolean;
};
const runtime = globalThis as unknown as Runtime;

let override: boolean | null = null;

/** Tests: `true`/`false` pin the switch, `null` reads the environment again. */
export function setBigFiles(on: boolean | null): void {
  override = on;
}

function parseFlag(value: string | undefined, where: string): boolean | null {
  if (value === undefined || value === '') return null;
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  throw new Error(`big-files: ${where} is '${value}'; expected 1 or 0`);
}

/** Whether documents past the fixed cap are accepted and the editor loads pages on demand. */
export function bigFilesEnabled(): boolean {
  if (override !== null) return override;
  const env = runtime.process?.versions?.node ? runtime.process.env : undefined;
  if (env) return parseFlag(env.DESIGN_BIG_FILES, 'DESIGN_BIG_FILES') ?? DEFAULT_BIG_FILES;
  const query = runtime.location?.search ? new URLSearchParams(runtime.location.search).get('bigFiles') : null;
  const asked = parseFlag(query ?? undefined, '?bigFiles=');
  if (asked !== null) return asked;
  if (typeof runtime.__MORFA_BIG_FILES__ === 'boolean') return runtime.__MORFA_BIG_FILES__;
  return DEFAULT_BIG_FILES;
}

/** The browser's switch, from `/api/config.bigFiles` (src/App.tsx) — before the editor opens a file. */
export function installBigFiles(on: boolean | undefined): void {
  if (typeof on === 'boolean') runtime.__MORFA_BIG_FILES__ = on;
}

export type DocumentCaps = {readonly nodes: number; readonly bytes: number; readonly pages: number};

/** The caps in force: `DESIGN_DOCUMENT_CAPS` (fixed) or `DESIGN_BIG_FILE_CAPS` (the switch on). Read at call time. */
export function documentCaps(): DocumentCaps {
  return bigFilesEnabled() ? DESIGN_BIG_FILE_CAPS : DESIGN_DOCUMENT_CAPS;
}

const MB = 1024 * 1024;
/** "27,4": megabytes with one decimal, as the messages show a size. */
export const megabytes = (bytes: number): string => (bytes / MB).toLocaleString('en-US', {maximumFractionDigits: 1});
/** "73 412": a count as the messages show it. */
export const countText = (count: number): string => count.toLocaleString('en-US');

/** "The file is larger than 20 MB." for the caps in force; with the file's size, how far over it is ("The file is 27.4 MB, the limit is 20 MB."). */
export const tooLargeMessage = (caps: DocumentCaps = documentCaps(), bytes?: number): string =>
  bytes === undefined
    ? `The file is larger than ${Math.round(caps.bytes / MB)} MB. Split it into several files.`
    : `The file is ${megabytes(bytes)} MB, the limit is ${Math.round(caps.bytes / MB)} MB. Split it into several files.`;
/** The layer cap's refusal with the file's count ("The file has 73,412 layers, the limit is 50,000."). */
export const tooManyLayersMessage = (count: number, caps: DocumentCaps = documentCaps()): string =>
  `The file has ${countText(count)} layers, the limit is ${countText(caps.nodes)}.`;
