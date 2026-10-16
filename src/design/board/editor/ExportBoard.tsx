import {useMemo, useRef, useState} from 'react';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {SegmentedControl} from '../../ui/Tabs';
import {exportBounds, exportRaster, ExportError} from '../../engine/export-raster';
import {boardExportIds, fittingScale, stickiesCsv, tablesCsv, type BoardExportScope as Scope} from '../export';
import {DOT_COLOR, DOT_SPACING} from '../../engine/render/dot-grid';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import {useEditorServices, type EditorDialogProps} from '../../editor/services';

// "Export board" (docs/board.md §Export): FigJam's export — the whole board (its page) or the selection, as one PNG, JPG or PDF page
// (white, transparent or the dotted canvas behind it, as FigJam offers per format), or its stickies or tables as CSV;
// painted by the same renderer as the canvas (export-raster.ts). A design file exports the layers with export settings; a board has no
// such panel, so the board's "Export…" (⇧⌘E) opens this instead. The picture is scaled down when it would be larger than a browser
// can encode; the PDF holds the picture losslessly on a page of the board's size.

type Format = 'png' | 'jpg' | 'pdf' | 'csv';
const FORMATS = [{value: 'png', label: 'PNG'}, {value: 'jpg', label: 'JPG'}, {value: 'pdf', label: 'PDF'}, {value: 'csv', label: 'CSV'}] as const;
/** FigJam's backgrounds per format ("Export your FigJam board"): PNG transparent, solid or grid; JPG solid or grid; PDF solid. */
type Background = 'solid' | 'transparent' | 'grid';
const BACKGROUNDS: Record<Exclude<Format, 'csv'>, readonly {value: Background; label: string}[]> = {
  png: [{value: 'solid', label: 'White'}, {value: 'transparent', label: 'Transparent'}, {value: 'grid', label: 'Grid'}],
  jpg: [{value: 'solid', label: 'White'}, {value: 'grid', label: 'Grid'}],
  pdf: [{value: 'solid', label: 'White'}],
};
type CsvContent = 'stickies' | 'tables';
const CSV_CONTENTS = [{value: 'stickies', label: 'Stickies'}, {value: 'tables', label: 'Tables'}] as const;
const SCALES = [{value: '1', label: '1×'}, {value: '2', label: '2×'}] as const;
const SCOPES = [{value: 'page', label: 'Whole board'}, {value: 'selection', label: 'Selection'}] as const;

// Module-level: the bundler's preload keeps the function that first asked for a chunk (and the dialog it would close over).
const loadRunner = () => import('../../panels/design/layout/export/run');
const loadPdf = () => import('../../panels/design/layout/export/pdf');
const fileName = (name: string, extension: string) => (name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Board').slice(0, 120) + '.' + extension;

export function BoardExportDialog({params, onClose, name}: EditorDialogProps & {name: () => string}) {
  const services = useEditorServices();
  const {store} = services;
  // What was there when the dialog opened, as a document of its own: the store's table may be written in place meanwhile.
  const [state] = useState(() => {
    const current = store.getState();
    return {...current, doc: snapshotDocument(current.doc)};
  });
  const hasSelection = state.selection.length > 0;
  const [scope, setScope] = useState<Scope>(params.scope === 'selection' && hasSelection ? 'selection' : 'page');
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState<'1' | '2'>('2');
  const [background, setBackground] = useState<Background>('solid');
  const [csvContent, setCsvContent] = useState<CsvContent>('stickies');
  const backgrounds = format === 'csv' ? [] : BACKGROUNDS[format];
  const shownBackground = backgrounds.some(option => option.value === background) ? background : 'solid';
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const ids = useMemo(() => boardExportIds(state.doc, state.pageId, scope, state.selection), [state, scope]);

  const run = async () => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      // The export's own document: it spans awaits, and the store's table may be written in place meanwhile.
      const doc = snapshotDocument(store.getState().doc);
      if (format === 'csv') {
        const {downloadFile} = await loadRunner();
        if (csvContent === 'stickies') {
          const csv = stickiesCsv(doc, ids);
          if (!csv) throw new ExportError('There are no stickies here.', 'empty');
          downloadFile(fileName(name(), 'csv'), new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8'}));
        } else {
          const tables = tablesCsv(doc, ids);
          if (!tables.length) throw new ExportError('There are no tables here.', 'empty');
          tables.forEach((table, k) => downloadFile(fileName(tables.length > 1 ? `${name()} — ${table.name || 'Table'} ${k + 1}` : name(), 'csv'), new Blob(['\uFEFF' + table.csv], {type: 'text/csv;charset=utf-8'})));
        }
        services.toast('File saved', 'success');
        onClose();
        return;
      }
      const deps = {images: services.images, fonts: services.fonts, booleanGeometry};
      const bounds = exportBounds(doc, ids, services.fonts);
      if (!bounds) throw new ExportError('Nothing to export: the board is empty.', 'empty');
      const factor = fittingScale(bounds, Number(scale));
      const png = await exportRaster(doc, ids, {format: 'PNG', constraint: {type: 'SCALE', value: factor}}, deps);
      // A board is paper: white under it, the board's dotted canvas for "Grid", nothing for a transparent PNG.
      const flat = shownBackground === 'transparent' ? png : await onBackground(png, shownBackground === 'grid' ? factor : null, format === 'jpg' ? 'image/jpeg' : 'image/png');
      if (cancelled.current) return;
      const {downloadFile} = await loadRunner();
      if (format === 'png' || format === 'jpg') downloadFile(fileName(name(), format), flat);
      else {
        const {writePdf} = await loadPdf();
        const bitmap = await createImageBitmap(flat);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new ExportError('Could not save the PDF: the browser ran out of memory.', 'too_large');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bytes = await writePdf([{width: bounds.width, height: bounds.height, image: {width: pixels.width, height: pixels.height, rgba: pixels.data}}], {title: name()});
        downloadFile(fileName(name(), 'pdf'), new Blob([bytes as BlobPart], {type: 'application/pdf'}));
      }
      services.toast(factor < Number(scale) - 0.01 ? 'File saved (the board is large: the scale was reduced so the browser could save it)' : 'File saved', 'success');
      onClose();
    } catch (error) {
      services.toast(error instanceof Error && error.message ? error.message : 'Could not export the board.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Export board" onClose={() => {
      cancelled.current = true;
      onClose();
    }} width={400} className="bd-export" dismissible={!busy} footer={
      <>
        <Button size={32} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size={32} variant="primary" busy={busy} disabled={!ids.length} onClick={() => void run()}>Export</Button>
      </>
    }>
      <div className="bd-export-rows">
        <div className="bd-export-row"><span>What</span>
          <SegmentedControl options={hasSelection ? SCOPES : SCOPES.slice(0, 1)} value={scope} onChange={value => setScope(value)} aria-label="What to export" />
        </div>
        <div className="bd-export-row"><span>Format</span>
          <SegmentedControl options={FORMATS} value={format} onChange={value => setFormat(value)} aria-label="Format" />
        </div>
        {format === 'csv' ? (
          <div className="bd-export-row"><span>What is in the file</span>
            <SegmentedControl options={CSV_CONTENTS} value={csvContent} onChange={value => setCsvContent(value)} aria-label="What is in the file" />
          </div>
        ) : (
          <>
            <div className="bd-export-row"><span>Quality</span>
              <SegmentedControl options={SCALES} value={scale} onChange={value => setScale(value)} aria-label="Scale" />
            </div>
            {backgrounds.length > 1 && (
              <div className="bd-export-row"><span>Background</span>
                <SegmentedControl options={backgrounds} value={shownBackground} onChange={value => setBackground(value)} aria-label="Background" />
              </div>
            )}
          </>
        )}
        {!ids.length && <p className="bd-export-note">The board is empty.</p>}
      </div>
    </Dialog>
  );
}

/** The board's canvas under a "Grid" export: its light grey and its dots (the canvas's spacing and colour, at the export's scale). */
const GRID_PAPER = '#F5F5F5';

/** The picture over white (the board's paper), or over the dotted canvas when `gridScale` (export px per page px) is given. */
async function onBackground(png: Blob, gridScale: number | null, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return png;
  ctx.fillStyle = gridScale ? GRID_PAPER : '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (gridScale) {
    const step = DOT_SPACING * gridScale, size = Math.max(1, Math.round(1.2 * gridScale));
    ctx.fillStyle = DOT_COLOR;
    for (let y = step / 2; y < canvas.height; y += step) for (let x = step / 2; x < canvas.width; x += step) ctx.fillRect(Math.round(x), Math.round(y), size, size);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob(type === 'image/jpeg' ? {type, quality: 0.92} : {type});
}
