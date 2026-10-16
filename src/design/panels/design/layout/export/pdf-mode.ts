import {useEffect, useState} from 'react';
import {readApi} from '../../../../../api-read';
import type {PdfKind} from './files';

// Which PDF "Export" writes (docs/design-tool.md §Export): the vector PDF the server prints, or — where the
// server's switch is off (/api/config `designPdf: false`) — the picture inside a PDF page the browser writes,
// which the panel then names "PDF (raster)". Read once per page load; until the answer arrives, and when it
// cannot be read, the panel says "PDF" and the export itself reports what the server answers.

let known: PdfKind | null = null;
let pending: Promise<PdfKind> | null = null;
const listeners = new Set<(kind: PdfKind) => void>();

export function pdfKind(): Promise<PdfKind> {
  if (known) return Promise.resolve(known);
  pending ??= readApi<{designPdf?: boolean}>('/config')
    .then(config => (config.designPdf === false ? 'raster' : 'vector') as PdfKind)
    .catch(() => 'vector' as PdfKind)
    .then(kind => {
      known = kind;
      listeners.forEach(listener => listener(kind));
      return kind;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The PDF kind for labels: "PDF" until /api/config says the server's vector PDF is off. */
export function usePdfKind(): PdfKind {
  const [kind, setKind] = useState<PdfKind>(known ?? 'vector');
  useEffect(() => {
    listeners.add(setKind);
    void pdfKind().then(setKind);
    return () => {
      listeners.delete(setKind);
    };
  }, []);
  return kind;
}
