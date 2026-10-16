import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode} from 'react';
import {documentCaps} from '../../../../shared/design/big-files';
import {
  CATALOG_LIMITS,
  CATALOG_TABLE_LIMITS,
  CatalogTableError,
  autoMapping,
  bindingFits,
  catalogCapacity,
  catalogPageName,
  catalogRows,
  matchPhotoFiles,
  mappingProblem,
  parseTableBytes,
  parseTableText,
  placeholderColumn,
  rowSku,
  slotText,
  templateSlots,
  utf8Length,
  type CatalogBinding,
  type CatalogCapacity,
  type CatalogMapping,
  type CatalogSlot,
  type CatalogTable,
} from '../../../../shared/design/marketplace/catalog';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {isImageFile} from '../../engine/tools/image';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {IconAlert, IconCheck, IconFile, IconImage, IconImport} from '../../ui/icons';
import {Select, type SelectEntry} from '../../ui/Select';
import {runCatalog, type CatalogOutcome, type CatalogProgress} from './run';

// "Catalog from a table" (docs/marketplaces.md §Catalog run): the card under the dialog is the template. Four honest steps: the table
// (a file or pasted cells, its first rows shown), which column fills which layer (matched automatically, every choice editable, the
// first row previewed), how many cards the file still holds, then the run with its progress and a summary of what has no photo.

type Step = 'table' | 'map' | 'run' | 'done';
type Source = {name: string; table: CatalogTable};

const number = (value: number) => value.toLocaleString('en-US');
const counted = (value: number, forms: readonly [one: string, other: string]) => `${number(value)} ${value === 1 ? forms[0] : forms[1]}`;
const CARDS = ['card', 'cards'] as const;
const CARDS_MADE = ['card', 'cards'] as const;
const ROWS = ['row', 'rows'] as const;
const COLUMNS = ['column', 'columns'] as const;
const TABLE_ACCEPT = '.xlsx,.csv,.tsv,.txt,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LIMIT_WHY: Record<NonNullable<CatalogCapacity['limit']>, (caps: ReturnType<typeof documentCaps>) => string> = {
  nodes: caps => `a file holds up to ${number(caps.nodes)} layers`,
  bytes: caps => `a file cannot be larger than ${Math.round(caps.bytes / 1024 / 1024)} MB`,
  pages: caps => `the file already has ${number(caps.pages)} pages`,
  images: () => `a file holds up to ${number(10_000)} pictures`,
};

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

/** Select values: "keep", "template", "files" or "c<column>". */
const bindingValue = (binding: CatalogBinding | undefined): string => (!binding || binding.kind === 'keep' ? 'keep' : binding.kind === 'column' ? `c${binding.column}` : binding.kind);
const bindingOf = (value: string): CatalogBinding =>
  value.startsWith('c') ? {kind: 'column', column: Number(value.slice(1))} : value === 'template' ? {kind: 'template'} : value === 'files' ? {kind: 'files'} : {kind: 'keep'};

export default function CatalogDialog({frameId, onClose}: {frameId: NodeId; onClose: () => void}) {
  const services = useEditorServices();
  const {store} = services;
  const [step, setStep] = useState<Step>('table');
  const [source, setSource] = useState<Source | null>(null);
  const [tableError, setTableError] = useState('');
  const [reading, setReading] = useState(false);
  const [pasted, setPasted] = useState('');
  const [mapping, setMapping] = useState<CatalogMapping>({sku: null, bindings: {}});
  const [photos, setPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<CatalogProgress | null>(null);
  const [outcome, setOutcome] = useState<CatalogOutcome | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  // The template as the dialog opened on it (the dialog is modal: nobody here changes it meanwhile).
  const opened = useMemo(() => store.getState().doc, [store]);
  const template = opened.nodes[frameId];
  const slots = useMemo(() => templateSlots(opened, frameId), [opened, frameId]);
  const table = source?.table ?? null;

  const takeTable = useCallback((next: Source) => {
    setSource(next);
    setTableError('');
    // Without a photo column the product takes dropped files, so the drop zone is there to be used.
    setMapping(autoMapping(next.table, slots, {files: true}));
  }, [slots]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > CATALOG_TABLE_LIMITS.bytes) {
      setTableError(`The table is larger than ${CATALOG_TABLE_LIMITS.bytes / 1024 / 1024} MB.`);
      return;
    }
    setReading(true);
    try {
      takeTable({name: file.name, table: parseTableBytes(new Uint8Array(await file.arrayBuffer()), file.name)});
    } catch (error) {
      setTableError(error instanceof CatalogTableError ? error.message : 'Could not read the table.');
    } finally {
      setReading(false);
    }
  };
  const readText = (text: string) => {
    if (!text.trim()) return false;
    try {
      takeTable({name: 'Pasted cells', table: parseTableText(text)});
      setPasted('');
      return true;
    } catch (error) {
      setTableError(error instanceof CatalogTableError ? error.message : 'Could not read the cells.');
      return false;
    }
  };

  // ── Mapping, rows and room ──
  const rows = useMemo(() => (table ? catalogRows(table, mapping) : {rows: [], withoutSku: []}), [table, mapping]);
  const usesPhotos = slots.some(slot => slot.kind === 'image' && (mapping.bindings[slot.id]?.kind ?? 'keep') !== 'keep');
  const wantsFiles = slots.some(slot => mapping.bindings[slot.id]?.kind === 'files');
  // The file's size once, when the mapping opens: a 20 MB file takes a moment to measure.
  const docBytes = useMemo(() => (step === 'map' ? utf8Length(JSON.stringify(store.getState().doc)) : 0), [step, store]);
  const capacity = useMemo(() => {
    if (!table || step !== 'map') return null;
    const columns = new Set<number>();
    for (const binding of Object.values(mapping.bindings)) if (binding.kind === 'column') columns.add(binding.column);
    let bytes = 0;
    for (const row of rows.rows) for (const column of columns) bytes += utf8Length(table.rows[row][column]);
    const doc = store.getState().doc;
    return catalogCapacity({doc, frameId, rows: rows.rows.length, caps: documentCaps(), docBytes, rowBytes: rows.rows.length ? (bytes / rows.rows.length) * 1.2 : 0, photos: usesPhotos});
  }, [table, step, mapping, rows, docBytes, store, frameId, usesPhotos]);
  const problem = !table ? null : mappingProblem(mapping, slots, table) ?? (rows.rows.length ? null : `The column "${table.headers[mapping.sku ?? 0]}" has no article numbers.`);
  const fits = capacity ? capacity.fits : rows.rows.length;
  const photoMatches = useMemo(() => {
    if (!table || !wantsFiles || !photos.length) return 0;
    return matchPhotoFiles(rows.rows.map(row => rowSku(table, mapping, row)), photos.map(file => file.name)).filter(index => index >= 0).length;
  }, [table, wantsFiles, photos, rows, mapping]);

  const setBinding = (slot: CatalogSlot, value: string) => setMapping(current => ({...current, bindings: {...current.bindings, [slot.id]: bindingOf(value)}}));

  const start = async () => {
    if (!table || problem || !fits) return;
    const run = (controller.current = new AbortController());
    setStep('run');
    setProgress({phase: 'cards', done: 0, total: fits});
    // "Files from the computer" with no files dropped keeps the placeholder quietly.
    const effective = wantsFiles && !photos.length
      ? {...mapping, bindings: Object.fromEntries(Object.entries(mapping.bindings).map(([id, binding]) => [id, binding.kind === 'files' ? {kind: 'keep'} as const : binding]))}
      : mapping;
    const result = await runCatalog({
      store,
      fileId: services.fileId,
      frameId,
      table,
      mapping: effective,
      rows: rows.rows.slice(0, fits),
      files: photos,
      signal: run.signal,
      onProgress: setProgress,
    });
    if (controller.current === run) controller.current = null;
    setOutcome(result);
    setStep('done');
  };

  const show = () => {
    if (!outcome?.pageId) return;
    store.setPage(outcome.pageId);
    services.revealNodes(outcome.cardIds.slice(0, outcome.columns * 2));
    onClose();
  };

  let body: ReactNode, footer: ReactNode;
  if (!template) {
    body = <Failure title="Template not found" text="The card was deleted. Choose another card and open the catalog again." />;
    footer = <Button size={32} onClick={onClose}>Close</Button>;
  } else if (step === 'table') {
    body = (
      <>
        <p className="dz-mp-catalog-intro">
          Each row of the table will become a copy of the card "{template.name}": texts and photos go into its layers, the article number into the card's parameters. Everything stays editable.
        </p>
        {source ? (
          <TableSummary source={source} onReplace={() => setSource(null)} />
        ) : (
          <TablePick busy={reading} error={tableError} onFile={readFile} pasted={pasted} setPasted={value => {setPasted(value); setTableError('');}} onPaste={readText} />
        )}
      </>
    );
    footer = (
      <>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="primary" disabled={!source && !pasted.trim()} busy={reading}
          onClick={() => (source || readText(pasted)) && setStep('map')}>Next</Button>
      </>
    );
  } else if (step === 'map' && table) {
    const caps = documentCaps();
    const fitsAll = fits >= rows.rows.length;
    body = (
      <>
        <section className="dz-mp-catalog-section" aria-labelledby="dz-mp-catalog-sku">
          <div className="dz-mp-catalog-row">
            <div className="dz-mp-catalog-layer">
              <span id="dz-mp-catalog-sku" className="dz-mp-catalog-layer-name">Article number</span>
              <span className="dz-mp-catalog-layer-hint">The card's name and its "Article number" parameter</span>
            </div>
            <Select size={24} aria-label="Article number column" placeholder="Choose a column" value={mapping.sku === null ? null : `c${mapping.sku}`}
              options={table.headers.map((header, column) => ({value: `c${column}`, label: header}))}
              onChange={value => setMapping(current => ({...current, sku: Number(value.slice(1))}))} />
          </div>
        </section>
        <MappingSection title="Texts" slots={slots.filter(slot => slot.kind === 'text')} table={table} mapping={mapping} previewRow={rows.rows[0] ?? 0} opened={opened} onChange={setBinding} />
        <MappingSection title="Photos" slots={slots.filter(slot => slot.kind === 'image')} table={table} mapping={mapping} previewRow={rows.rows[0] ?? 0} opened={opened} onChange={setBinding} />
        {wantsFiles && <PhotoDrop files={photos} matched={photoMatches} rows={rows.rows.length} onFiles={files => setPhotos(current => [...current, ...files])} onClear={() => setPhotos([])} />}
        <div className="dz-mp-catalog-summary" role="status">
          {problem ? (
            <p className="dz-mp-catalog-note is-warning"><IconAlert size={16} />{problem}</p>
          ) : (
            <p className="dz-mp-catalog-note">
              {counted(fits, CARDS_MADE)} — on a new page "{catalogPageName(new Date(), opened.pages.map(id => opened.nodes[id]?.name ?? ''))}". Every {CATALOG_LIMITS.batchRows} are undone in one step.
            </p>
          )}
          {!problem && !fitsAll && capacity?.limit && (
            <p className="dz-mp-catalog-note is-warning"><IconAlert size={16} />
              {fits ? `The file can hold ${counted(fits, CARDS)} of ${number(rows.rows.length)}: ${LIMIT_WHY[capacity.limit](caps)}. Make the other rows in another file.` : `The file is full: ${LIMIT_WHY[capacity.limit](caps)}. Create the catalog in a new file.`}
            </p>
          )}
          {rows.withoutSku.length > 0 && !problem && <p className="dz-mp-catalog-note">{counted(rows.withoutSku.length, ROWS)} without an article number will be skipped.</p>}
          {table.cut > 0 && <p className="dz-mp-catalog-note">Read the first {number(CATALOG_TABLE_LIMITS.rows)} rows; {number(table.cut)} more did not fit.</p>}
        </div>
      </>
    );
    footer = (
      <>
        <Button size={32} onClick={() => setStep('table')}>Back</Button>
        <Button size={32} variant="primary" disabled={!!problem || !fits} onClick={start}>Create {counted(fits, CARDS)}</Button>
      </>
    );
  } else if (step === 'run') {
    const ratio = progress && progress.total ? progress.done / progress.total : 0;
    body = (
      <div className="dz-mp-catalog-run">
        <div className="dz-mp-catalog-run-head">
          <span>{progress?.phase === 'photos' ? 'Uploading photos' : 'Creating cards'}</span>
          {progress && <span className="dz-mp-catalog-run-count">{number(progress.done)} of {number(progress.total)}</span>}
        </div>
        <div className="dz-mp-catalog-bar" role="progressbar" aria-label={progress?.phase === 'photos' ? 'Photos' : 'Cards'} aria-valuemin={0}
          aria-valuemax={progress?.total ?? 0} aria-valuenow={progress?.done ?? 0} style={{'--dz-ratio': ratio} as CSSProperties}>
          <span className="dz-mp-catalog-bar-fill" />
        </div>
        <p className="dz-mp-catalog-note">You can stop at any time: finished cards stay, every {CATALOG_LIMITS.batchRows} are undone in one step.</p>
      </div>
    );
    footer = <Button size={32} onClick={() => controller.current?.abort()}>Stop</Button>;
  } else if (outcome) {
    body = <Summary outcome={outcome} skipped={rows.withoutSku.length} />;
    footer = (
      <>
        <Button size={32} onClick={onClose}>Close</Button>
        {outcome.cardIds.length > 0 && <Button size={32} variant="primary" data-autofocus onClick={show}>Go to the catalog</Button>}
      </>
    );
  }

  const running = step === 'run';
  return (
    <Dialog title="Catalog from a table" onClose={onClose} width={560} dismissible={step === 'table' && !source} closable={!running} className="dz-mp-catalog" footer={footer}>
      {body}
    </Dialog>
  );
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────

function TablePick({busy, error, onFile, pasted, setPasted, onPaste}: {
  busy: boolean;
  error: string;
  onFile: (file: File | undefined) => void;
  pasted: string;
  setPasted: (value: string) => void;
  onPaste: (text: string) => boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div className="dz-mp-catalog-field">
      <label className={`dz-mp-catalog-drop${over ? ' is-over' : ''}`} aria-busy={busy || undefined}
        onDragOver={event => {
          if (busy || !hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          event.preventDefault();
          setOver(false);
          if (!busy) onFile(event.dataTransfer.files[0]);
        }}>
        <input type="file" accept={TABLE_ACCEPT} className="dz-mp-catalog-drop-input" disabled={busy} aria-label="Table with products"
          onChange={event => {
            onFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }} />
        <span className="dz-mp-catalog-drop-icon" aria-hidden="true"><IconImport /></span>
        <span className="dz-mp-catalog-drop-text"><b>Choose an .xlsx or .csv table</b><span>or drop it here</span></span>
      </label>
      <textarea className="dz-mp-catalog-paste" value={pasted} rows={3} spellCheck={false} aria-label="Cells from a table"
        placeholder="…or paste cells from Excel or Google Sheets: the first row holds the headers"
        onChange={event => setPasted(event.currentTarget.value)}
        onPaste={event => {
          const text = event.clipboardData.getData('text/plain');
          if (text.includes('\n') && onPaste(text)) event.preventDefault();
        }} />
      {error && <p className="dz-mp-catalog-error" role="alert">{error}</p>}
      <p className="dz-mp-catalog-hint">An article number column is required. Texts go in columns named like the layers, or in {'{{Column}}'} inside a text; photos are https:// links or files with the article number in the name.</p>
    </div>
  );
}

function TableSummary({source, onReplace}: {source: Source; onReplace: () => void}) {
  const {table} = source;
  const preview = table.rows.slice(0, CATALOG_LIMITS.previewRows);
  return (
    <div className="dz-mp-catalog-field">
      <div className="dz-mp-catalog-source">
        <span className="dz-mp-catalog-drop-icon" aria-hidden="true"><IconFile /></span>
        <span className="dz-mp-catalog-drop-text">
          <b>{source.name}</b>
          <span>{counted(table.rows.length, ROWS)} · {counted(table.headers.length, COLUMNS)}{table.encoding === 'windows-1251' ? ' · Windows-1251' : ''}</span>
        </span>
        <Button onClick={onReplace}>Another table</Button>
      </div>
      <div className="dz-mp-catalog-preview" tabIndex={0} aria-label="First rows of the table" role="region">
        <table>
          <thead><tr>{table.headers.map((header, column) => <th key={column} scope="col">{header}</th>)}</tr></thead>
          <tbody>
            {preview.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} title={cell}>{cell}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      {table.rows.length > preview.length && <p className="dz-mp-catalog-hint">Showing the first {preview.length} of {counted(table.rows.length, ROWS)}.</p>}
    </div>
  );
}

// ── Mapping ────────────────────────────────────────────────────────────────────────────────────

function MappingSection({title, slots, table, mapping, previewRow, opened, onChange}: {
  title: string;
  slots: readonly CatalogSlot[];
  table: CatalogTable;
  mapping: CatalogMapping;
  previewRow: number;
  opened: DesignDocument;
  onChange: (slot: CatalogSlot, value: string) => void;
}) {
  if (!slots.length) return null;
  const columns: SelectEntry<string>[] = table.headers.map((header, column) => ({value: `c${column}`, label: header}));
  return (
    <section className="dz-mp-catalog-section">
      <h3 className="dz-mp-catalog-section-title">{title}</h3>
      {slots.map(slot => {
        const binding = mapping.bindings[slot.id];
        const fits = !binding || bindingFits(binding, slot, table);
        const options: SelectEntry<string>[] = slot.kind === 'text'
          ? [{value: 'keep', label: 'Keep as is'}, ...(slot.placeholders.length ? [{value: 'template', label: 'Fill into {{…}}'}] : []), {separator: true}, ...columns]
          : [{value: 'keep', label: 'Keep as is'}, {value: 'files', label: 'Files from the computer'}, {separator: true}, {heading: 'Links from a column'}, ...columns];
        const text = slot.kind === 'text' && fits ? slotText(slot, binding, table, previewRow, opened.nodes[slot.id]?.text?.characters ?? slot.sample) : null;
        const unknown = slot.kind === 'text' && binding?.kind === 'template' ? slot.placeholders.filter(name => placeholderColumn(name, table.headers) === null) : [];
        return (
          <div key={slot.id} className="dz-mp-catalog-row">
            <div className="dz-mp-catalog-layer">
              <span className="dz-mp-catalog-layer-name">
                {slot.kind === 'image' ? <IconImage size={12} /> : null}{slot.name}
              </span>
              {text !== null ? (
                <span className="dz-mp-catalog-layer-value" title={text}>{text.trim() ? text : 'empty: the layer will be hidden'}</span>
              ) : slot.kind === 'text' ? (
                <span className="dz-mp-catalog-layer-hint" title={slot.sample}>{slot.sample || ' '}</span>
              ) : null}
              {unknown.length > 0 && <span className="dz-mp-catalog-layer-warn">No such column: {unknown.map(name => `{{${name}}}`).join(', ')}</span>}
            </div>
            <Select size={24} aria-label={`${title}: ${slot.name}`} value={fits ? bindingValue(binding) : 'keep'} options={options} onChange={value => onChange(slot, value)} />
          </div>
        );
      })}
    </section>
  );
}

function PhotoDrop({files, matched, rows, onFiles, onClear}: {files: readonly File[]; matched: number; rows: number; onFiles: (files: File[]) => void; onClear: () => void}) {
  const [over, setOver] = useState(false);
  const take = (list: FileList | null | undefined) => onFiles(Array.from(list ?? []).filter(isImageFile));
  return (
    <div className="dz-mp-catalog-field">
      <label className={`dz-mp-catalog-drop is-small${over ? ' is-over' : ''}`}
        onDragOver={event => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files);
        }}>
        <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/avif,image/gif" className="dz-mp-catalog-drop-input" aria-label="Product photos"
          onChange={event => {
            take(event.currentTarget.files);
            event.currentTarget.value = '';
          }} />
        <span className="dz-mp-catalog-drop-icon" aria-hidden="true"><IconImage /></span>
        <span className="dz-mp-catalog-drop-text">
          <b>{files.length ? `Photos: ${number(files.length)}, matched to article numbers ${number(matched)} of ${number(rows)}` : 'Add product photos'}</b>
          <span>The file name holds the article number: 12345.jpg, 12345_1.png</span>
        </span>
      </label>
      {files.length > 0 && <button type="button" className="dz-mp-catalog-link" onClick={onClear}>Remove photos</button>}
    </div>
  );
}

// ── Result ─────────────────────────────────────────────────────────────────────────────────────

function Failure({title, text}: {title: string; text: string}) {
  return (
    <div className="dz-mp-catalog-done is-error" role="alert">
      <span className="dz-mp-catalog-done-icon" aria-hidden="true"><IconAlert /></span>
      <div className="dz-mp-catalog-done-text"><p className="dz-mp-catalog-done-title">{title}</p><p className="dz-mp-catalog-hint">{text}</p></div>
    </div>
  );
}

function Summary({outcome, skipped}: {outcome: CatalogOutcome; skipped: number}) {
  const made = outcome.cardIds.length;
  if (!made) return <Failure title={outcome.stopped ? 'Stopped' : 'No cards created'} text={outcome.failure ?? 'No cards were created.'} />;
  const title = outcome.stopped || outcome.failure ? `Created ${number(made)} of ${counted(outcome.asked, CARDS_MADE)}` : `Done: ${counted(made, CARDS_MADE)}`;
  return (
    <div className="dz-mp-catalog-result">
      <div className={`dz-mp-catalog-done${outcome.failure ? ' is-warning' : ''}`} role="status">
        <span className="dz-mp-catalog-done-icon" aria-hidden="true">{outcome.failure ? <IconAlert /> : <IconCheck />}</span>
        <div className="dz-mp-catalog-done-text">
          <p className="dz-mp-catalog-done-title">{title}</p>
          <p className="dz-mp-catalog-hint">On the page "{outcome.pageName}". Every {CATALOG_LIMITS.batchRows} cards are undone in one step.</p>
          {outcome.failure && <p className="dz-mp-catalog-error">{outcome.failure}</p>}
        </div>
      </div>
      {outcome.withoutPhoto.length > 0 && (
        <details className="dz-mp-catalog-missing">
          <summary>Without a photo: {number(outcome.withoutPhoto.length)}</summary>
          <p className="dz-mp-catalog-hint">These cards keep the placeholder from the template: replace the photo by hand or run the catalog again.</p>
          <ul>
            {outcome.withoutPhoto.slice(0, 200).map((entry, index) => <li key={index}><b>{entry.sku}</b> — {entry.reason}</li>)}
          </ul>
        </details>
      )}
      {skipped > 0 && <p className="dz-mp-catalog-note">Skipped without an article number: {number(skipped)}.</p>}
    </div>
  );
}
