import {ApiError} from '../../../api';
import {FigmaApiError} from '../../../figma-import/figma-client';
import {FigFileError} from '../../../figma-import/fig-file/container';
import {FigmaImportError, type FigmaLimitHit} from '../../../../shared/design/figma-import';
import type {FigmaErrorFacts} from '../../../figma-import/figma-errors';

// The import's errors across the worker's edge (import-runner.ts): plain data out, the same classes back in, so the dialog's
// `instanceof` checks (FigmaImportDialog.tsx `fail`) answer as they did when the import ran on the page.

export type WireError = {
  name: string;
  message: string;
  facts?: FigmaErrorFacts;
  status?: number;
  details?: unknown;
  limit?: FigmaLimitHit;
};

export function toWire(error: unknown): WireError {
  if (error instanceof FigmaApiError)
    return {name: 'FigmaApiError', message: error.message, facts: {kind: error.kind, status: error.status, retryAfter: error.retryAfter, rateType: error.rateType, upgradeLink: error.upgradeLink, tooLarge: error.tooLarge}};
  if (error instanceof FigmaImportError) return {name: 'FigmaImportError', message: error.message, limit: error.limit};
  if (error instanceof FigFileError) return {name: 'FigFileError', message: error.message};
  if (error instanceof DOMException && error.name === 'AbortError') return {name: 'AbortError', message: error.message};
  const plain = error as {message?: unknown; status?: unknown; details?: unknown; name?: unknown} | null;
  return {
    name: error instanceof ApiError ? 'ApiError' : typeof plain?.name === 'string' ? plain.name : 'Error',
    message: typeof plain?.message === 'string' ? plain.message : String(error),
    ...(typeof plain?.status === 'number' ? {status: plain.status} : {}),
    ...(plain?.details !== undefined ? {details: plain.details} : {}),
  };
}

export function fromWire(wire: WireError): Error {
  switch (wire.name) {
    case 'FigmaApiError':
      return new FigmaApiError(wire.facts!);
    case 'FigmaImportError':
      return new FigmaImportError(wire.message, wire.limit);
    case 'FigFileError':
      return new FigFileError(wire.message);
    case 'AbortError':
      return new DOMException(wire.message, 'AbortError');
    case 'ApiError':
      return new ApiError(wire.message, wire.status ?? 0, wire.details as ConstructorParameters<typeof ApiError>[2]);
    default:
      return Object.assign(new Error(wire.message), {name: wire.name, ...(wire.status !== undefined ? {status: wire.status} : {}), ...(wire.details !== undefined ? {details: wire.details} : {})});
  }
}
