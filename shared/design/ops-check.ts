import type {DesignDocument} from './types';
import type {DocumentPatch} from './patch';
import {checkPatchedDocument as checkPatchedDocumentTs, type DesignValidation} from './schema';
import {engineTs} from './engine-switch';
import {checkPatchedDocumentWasm, viaOps} from './ops-engine';

/** schema.ts `checkPatchedDocument` through the ops engine switch (lane L2a): schema.ts stays the model's (S1), so
 *  its callers import this one. */
export function checkPatchedDocument(before: DesignDocument, after: DesignDocument, patch: DocumentPatch, nodeCount?: () => number): DesignValidation<DesignDocument> {
  if (engineTs('ops')) return checkPatchedDocumentTs(before, after, patch, nodeCount);
  return viaOps(
    'checkPatchedDocument',
    () => checkPatchedDocumentTs(before, after, patch, nodeCount),
    () => checkPatchedDocumentWasm(before, after, patch, nodeCount),
    () => [patch],
  );
}
