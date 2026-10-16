// Today's vector PDF of a document, printed by the server's own Chromium pipeline (server/design/pdf/: the print
// flavour SVG per page, the sandboxed browser of browser.ts, exact page boxes), without the database: pictures come
// from `picture(name)`. Used by scripts/export/pdf-check.ts for the references the wasm engine is compared with.
import {printChromium, printedPages, pictureTable} from '../../server/design/pdf/export';
import {closePdfBrowser} from '../../server/design/pdf/browser';
import type {PrintablePicture} from '../../server/design/pdf/pictures';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';

export async function chromiumPdf(doc: DesignDocument, ids: readonly NodeId[], measurer: TextMeasurer, picture: (name: string) => Promise<PrintablePicture | null>, title = 'Export'): Promise<Buffer> {
  const table = pictureTable(doc);
  const pages = await printedPages(doc, ids, measurer, table.imageHref);
  const {pdf} = await printChromium(doc, pages, title, async index => {
    const name = table.nameOf(index);
    return name === undefined ? null : picture(name);
  }, 600_000);
  return pdf;
}

export {closePdfBrowser};
