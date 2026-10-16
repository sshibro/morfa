import '../../styles/figma-import.css';
import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode} from 'react';
import {ApiError} from '../../../api';
import {parseFigmaLink, FigmaLinkError} from '../../../../shared/figma/link';
import {documentCaps} from '../../../../shared/design/big-files';
import {PRODUCT_NAME} from '../../../../shared/design/product';
import {FIGMA_REPORT_GROUPS, FigmaImportError, type FigmaImportReport, type FigmaReportGroup} from '../../../../shared/design/figma-import';
import type {FigmaImportDialogProps} from '../../files/integrations';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {IconAlert, IconArrow, IconCheck, IconFile, IconImport, IconKey, IconLink} from '../../ui/icons';
import {Spinner} from '../../ui/Spinner';
import {SegmentedControl} from '../../ui/Tabs';
import {TextInput} from '../../ui/TextInput';
import {Checkbox} from '../../ui/Toggle';
import {figmaAccessToken} from '../../../figma-import/connection-api';
import {createFigmaClient, FigmaApiError} from '../../../figma-import/figma-client';
import {FigFileError} from '../../../figma-import/fig-file/container';
import {useFigmaConnection, type FigmaConnectionHandle} from '../../../figma-import/useFigmaConnection';
import {type ImportOutcome, type ImportStage} from './run-import';
import {figmaImportRunner, type FigmaAuth, type FigmaReadSummary as FigmaRead, type ImportRunner} from './import-runner';

// "Import from Figma": a link, the Figma connection (the site importer's, or a token kept only for
// this import when that importer is off on the server), the pages to bring, progress, and an
// honest report of what was approximated. Figma is called from this tab with the user's token; the
// result is a new "Design" file.

type Step =
  | {kind: 'link'}
  | {kind: 'reading'; stage: ImportStage}
  | {kind: 'pages'; read: FigmaRead}
  | {kind: 'running'; read: FigmaRead; stage: ImportStage; active: RunStep}
  | {kind: 'done'; outcome: ImportOutcome}
  | {kind: 'failed'; title: string; message: string; more?: string; back: 'link' | 'pages'; read?: FigmaRead};

type RunStep = 'read' | 'map' | 'create' | 'images' | 'save';
/** Where the file comes from: a .fig saved from Figma (no token) or a link read with a token. */
type Source = 'file' | 'link';
const SOURCES = [{value: 'file', label: '.fig file'}, {value: 'link', label: 'Link and token'}] as const;
/** A .fig read in this dialog has no Figma key: its read is told apart by this prefix. */
const FIG_KEY = 'fig:';
type SessionToken = {token: string; handle: string};

const TOKEN_HELP = 'Figma → Settings → Security → Personal access tokens → Generate new token, with the "File content — Read only" scope. The token starts with figd_.';
const TOKEN_REFUSED = 'Figma did not accept the token. Copy it again in full.';

const number = (value: number) => value.toLocaleString('en-US');
const counted = (value: number, one: string, other: string) => `${number(value)} ${value === 1 ? one : other}`;
/** Enter submits; leaving a field never does (TextInput's onCommit also fires on blur). */
const enter = (event: KeyboardEvent<HTMLInputElement>, submit: () => void) => {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  event.preventDefault();
  submit();
};
const isAbort = (error: unknown, signal?: AbortSignal) => !!signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');

const figKeyOf = (file: File) => `${FIG_KEY}${file.name}:${file.size}:${file.lastModified}`;
const isFig = (file: File) => /\.fig$/i.test(file.name);

export function FigmaImportDialog({onClose, onImported}: FigmaImportDialogProps) {
  const connection = useFigmaConnection();
  const [step, setStep] = useState<Step>({kind: 'link'});
  const [source, setSource] = useState<Source>('file');
  const [figPick, setFigPick] = useState<File | null>(null);
  const [figError, setFigError] = useState('');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [tokenOpen, setTokenOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Only for this import, when the server keeps no Figma connection: never stored anywhere.
  const session = useRef<SessionToken | null>(null);
  // The token's Figma handle once it is accepted ('' when the token may not read the user), null before.
  const [sessionHandle, setSessionHandle] = useState<string | null>(null);
  const auth = useRef<FigmaAuth | null>(null);
  // Where the import runs: a worker when the browser has one (import-runner.ts), made once per dialog.
  const runner = useRef<ImportRunner | null>(null);
  const runnerOf = () => (runner.current ??= figmaImportRunner());
  const controller = useRef<AbortController | null>(null);
  const linkedNode = useRef<string | undefined>(undefined);
  // The last file read in this dialog: "Back" and "Continue" again spend no second Figma call
  // (View and Collab seats get a few file reads a month).
  const lastRead = useRef<FigmaRead | null>(null);

  useEffect(() => () => {
    controller.current?.abort();
    runner.current?.dispose();
    runner.current = null;
  }, []);

  const state = connection.state;
  const mode: 'loading' | 'error' | 'session' | 'connected' | 'connect' =
    connection.loadError ? 'error' : !state ? 'loading' : !state.enabled ? 'session' : state.connection ? 'connected' : 'connect';

  const close = useCallback(() => {
    controller.current?.abort();
    onClose();
  }, [onClose]);

  /** The client for the next Figma calls; null when the user still has to connect. */
  const authFor = async (): Promise<FigmaAuth | null> => {
    if (mode === 'session') {
      if (!session.current) {
        const token = tokenDraft.trim();
        if (!token) {
          setTokenError('Paste your Figma access token.');
          return null;
        }
        setChecking(true);
        try {
          // A token with only "File content — Read only" may not read the user (that needs current_user:read): it
          // is accepted without a handle, and the file read that follows checks it.
          const handle = await createFigmaClient({token, kind: 'token'}).me().then(me => me.handle, error => {
            if (error instanceof FigmaApiError && error.kind === 'scope') return '';
            throw error;
          });
          session.current = {token, handle};
          setSessionHandle(handle);
          setTokenDraft('');
          setTokenError('');
        } catch (error) {
          setTokenError(error instanceof FigmaApiError && error.kind === 'token' ? TOKEN_REFUSED : error instanceof Error ? error.message : TOKEN_REFUSED);
          return null;
        } finally {
          setChecking(false);
        }
      }
      return {token: session.current.token, kind: 'token'};
    }
    if (mode === 'connected') {
      const {token, kind} = await figmaAccessToken();
      return {token, kind};
    }
    return null;
  };

  const fail = (error: unknown, back: 'link' | 'pages', read?: FigmaRead) => {
    if (isAbort(error, controller.current?.signal)) {
      setStep(back === 'pages' && read ? {kind: 'pages', read} : {kind: 'link'});
      return;
    }
    if (error instanceof FigmaApiError && (error.kind === 'token' || error.kind === 'scope')) {
      if (mode === 'session') {
        session.current = null;
        setSessionHandle(null);
      } else connection.lost();
      setTokenError(error.message);
      setStep({kind: 'link'});
      return;
    }
    if (error instanceof ApiError && error.details?.code === 'figma_reconnect') {
      connection.lost();
      setTokenError(error.message);
      setStep({kind: 'link'});
      return;
    }
    const message = error instanceof FigmaApiError || error instanceof FigmaImportError || error instanceof ApiError || error instanceof FigmaLinkError || error instanceof FigFileError
      ? error.message
      : 'Could not import the file. Try again.';
    setStep({kind: 'failed', title: back === 'link' ? 'Could not read the file' : 'Could not import the file', message, more: error instanceof FigmaApiError ? error.more : undefined, back, read});
  };

  const choosePages = (read: FigmaRead) => {
    // A link to a frame ("?node-id=12-34") chooses the page it is on.
    const linked = read.pages.find(entry => entry.id === read.linkedPage);
    setSelected(new Set(linked ? [linked.id] : read.pages.map(page => page.id)));
    setStep({kind: 'pages', read});
  };

  const pickFig = (file: File | undefined) => {
    if (!file) return;
    setSource('file');
    setFigError(isFig(file) ? '' : 'A .fig file is required: Figma saves it with Save local copy.');
    setFigPick(isFig(file) ? file : null);
  };

  const startFig = async () => {
    if (!figPick) {
      setFigError('Choose a .fig file.');
      return;
    }
    const fileKey = figKeyOf(figPick);
    if (lastRead.current?.fileKey === fileKey) {
      choosePages(lastRead.current);
      return;
    }
    const run = (controller.current = new AbortController());
    setStep({kind: 'reading', stage: {stage: 'read'}});
    // The runner keeps one file: the one read before is let go.
    lastRead.current = null;
    try {
      // Unpacked and kept where the import runs (the worker): the page never holds the kit.
      const read = await runnerOf().read({kind: 'fig', fileKey, file: figPick, fileName: figPick.name}, run.signal, stage => {
        if (!run.signal.aborted) setStep({kind: 'reading', stage});
      });
      if (run.signal.aborted) return;
      lastRead.current = read;
      linkedNode.current = undefined;
      choosePages(read);
    } catch (error) {
      fail(error, 'link');
    }
  };

  const start = async () => {
    if (step.kind !== 'link' || checking) return;
    if (source === 'file') return startFig();
    let fileKey: string;
    try {
      const parsed = parseFigmaLink(link);
      fileKey = parsed.fileKey;
      linkedNode.current = parsed.nodeId;
      setLinkError('');
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'Enter a link to a Figma file.');
      return;
    }
    if (lastRead.current?.fileKey === fileKey) {
      choosePages(lastRead.current);
      return;
    }
    let next: FigmaAuth | null;
    try {
      next = await authFor();
    } catch (error) {
      fail(error, 'link');
      return;
    }
    if (!next) return;
    auth.current = next;
    const run = (controller.current = new AbortController());
    setStep({kind: 'reading', stage: {stage: 'read'}});
    lastRead.current = null;
    try {
      const read = await runnerOf().read({kind: 'link', fileKey, auth: next, nodeId: linkedNode.current}, run.signal, stage => {
        if (!run.signal.aborted) setStep({kind: 'reading', stage});
      });
      if (run.signal.aborted) return;
      lastRead.current = read;
      choosePages(read);
    } catch (error) {
      fail(error, 'link');
    }
  };

  const transfer = async (read: FigmaRead) => {
    if (step.kind !== 'pages') return;
    const pageIds = read.pages.filter(page => selected.has(page.id)).map(page => page.id);
    if (!pageIds.length) return;
    const run = (controller.current = new AbortController());
    setStep({kind: 'running', read, stage: {stage: read.whole ? 'map' : 'read'}, active: read.whole ? 'map' : 'read'});
    try {
      let fresh: FigmaAuth | null = null;
      if (!read.fileKey.startsWith(FIG_KEY)) {
        // A server-kept token may have been refreshed since the file was read.
        fresh = mode === 'connected' ? await authFor() : auth.current;
        if (!fresh) throw new FigmaApiError({kind: 'token'});
      }
      const outcome = await runnerOf().run(read, pageIds, fresh, run.signal, stage => {
        if (run.signal.aborted) return;
        setStep(current => current.kind === 'running' ? {...current, stage, active: stage.stage === 'wait' ? current.active : stage.stage} : current);
      });
      if (!run.signal.aborted) setStep({kind: 'done', outcome});
    } catch (error) {
      fail(error, 'pages', read);
    }
  };

  const cancel = () => controller.current?.abort();

  const busy = step.kind === 'reading' || step.kind === 'running';
  const canStart = source === 'file'
    ? !!figPick
    : !!link.trim() && !checking && (mode === 'connected' || (mode === 'session' && (!!session.current || !!tokenDraft.trim())));

  let footer: ReactNode;
  let body: ReactNode;
  switch (step.kind) {
    case 'link':
    case 'reading': {
      // Reading keeps the form in place (no jump in the dialog's height); the status takes the connection's row.
      const reading = step.kind === 'reading';
      body = (
        <>
          <p className="dz-fi-intro">
            The whole file is brought over: pages, frames, components and variants, styles, auto layout and the prototype become editable layers. Images are copied into the new file.
          </p>
          <SegmentedControl options={SOURCES} value={source} onChange={setSource} size={32} fill aria-label="Import from" />
          {source === 'file' ? (
            <FigStep file={figPick} error={figError} onPick={pickFig} busy={reading} status={reading ? <Waiting stage={step.stage} fig /> : null} />
          ) : (
            <LinkStep link={link} setLink={value => {setLink(value); setLinkError('');}} linkError={linkError} onSubmit={() => canStart && !reading && start()} readOnly={reading}
              connect={reading ? <Waiting stage={step.stage} /> : (
                <ConnectBlock mode={mode} connection={connection} sessionHandle={sessionHandle} tokenDraft={tokenDraft} setTokenDraft={value => {setTokenDraft(value); setTokenError('');}}
                  tokenError={tokenError} tokenOpen={tokenOpen} setTokenOpen={setTokenOpen} onForgetSession={() => {session.current = null; setSessionHandle(null);}} onSubmit={() => canStart && start()} />
              )} />
          )}
        </>
      );
      footer = (
        <>
          <Button size={32} onClick={reading ? cancel : close}>{reading ? 'Cancel' : 'Cancel'}</Button>
          <Button size={32} variant="primary" busy={checking || reading} disabled={!canStart && !reading} onClick={start}>Continue</Button>
        </>
      );
      break;
    }
    case 'pages':
      body = <PagePicker read={step.read} selected={selected} setSelected={setSelected} />;
      footer = (
        <>
          <Button size={32} onClick={() => setStep({kind: 'link'})}>Back</Button>
          <Button size={32} variant="primary" disabled={!selected.size} onClick={() => transfer(step.read)}>
            {selected.size === step.read.pages.length ? 'Import file' : `Import ${counted(selected.size, 'page', 'pages')}`}
          </Button>
        </>
      );
      break;
    case 'running':
      body = <Progress read={step.read} stage={step.stage} active={step.active} />;
      footer = <Button size={32} onClick={cancel}>Cancel</Button>;
      break;
    case 'done':
      body = <Result outcome={step.outcome} />;
      footer = (
        <>
          <Button size={32} onClick={onClose}>Close</Button>
          <Button size={32} variant="primary" data-autofocus onClick={() => onImported(step.outcome.fileId)}>Open file</Button>
        </>
      );
      break;
    case 'failed':
      body = (
        <div className="dz-fi-done is-error" role="alert">
          <span className="dz-fi-done-icon" aria-hidden="true"><IconAlert /></span>
          <div className="dz-fi-done-text">
            <p className="dz-fi-done-title">{step.title}</p>
            <p className="dz-fi-hint">{step.message}</p>
            {step.more && <p className="dz-fi-hint">{step.more}</p>}
          </div>
        </div>
      );
      footer = (
        <>
          <Button size={32} onClick={close}>Close</Button>
          <Button size={32} variant="primary" onClick={() => setStep(step.back === 'pages' && step.read ? {kind: 'pages', read: step.read} : {kind: 'link'})}>Back</Button>
        </>
      );
      break;
  }

  return (
    <Dialog title="Import from Figma" onClose={close} width={480} dismissible={!busy && step.kind !== 'pages'} className="dz-fi" footer={footer}>
      {body}
    </Dialog>
  );
}

// ── Link and connection ────────────────────────────────────────────────────────────────────────

function FigStep({file, error, onPick, busy, status}: {file: File | null; error: string; onPick: (file: File | undefined) => void; busy: boolean; status: ReactNode}) {
  const [over, setOver] = useState(false);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  return (
    <div className="dz-fi-field">
      <label className={`dz-fi-drop${over ? ' is-over' : ''}${file ? ' is-picked' : ''}`} aria-busy={busy || undefined}
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
          if (!busy) onPick(event.dataTransfer.files[0]);
        }}>
        <input type="file" accept=".fig" className="dz-fi-drop-input" disabled={busy} data-autofocus
          onChange={event => {
            onPick(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }} />
        <span className="dz-fi-drop-icon" aria-hidden="true">{file ? <IconFile /> : <IconImport />}</span>
        {file ? (
          <span className="dz-fi-drop-text"><b>{file.name}</b><span>{megabytes(file.size)} · choose another</span></span>
        ) : (
          <span className="dz-fi-drop-text"><b>Choose a .fig file</b><span>or drag it here</span></span>
        )}
      </label>
      {error && <p className="dz-fi-error" role="alert">{error}</p>}
      {status ?? <p className="dz-fi-hint">In Figma, open the file and choose File → Save local copy. No token is needed, and Figma's file read limits do not apply.</p>}
    </div>
  );
}

const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toLocaleString('en-US', {maximumFractionDigits: 1})} MB`;

function LinkStep({link, setLink, linkError, onSubmit, connect, readOnly}: {link: string; setLink: (value: string) => void; linkError: string; onSubmit: () => void; connect: ReactNode; readOnly: boolean}) {
  return (
    <>
      <div className="dz-fi-field">
        <span className="dz-fi-label" id="dz-fi-link-label">Link to file</span>
        <TextInput size={32} value={link} onChange={setLink} onKeyDown={event => enter(event, onSubmit)} icon={<IconLink />} placeholder="https://www.figma.com/design/…"
          aria-labelledby="dz-fi-link-label" aria-invalid={!!linkError || undefined} readOnly={readOnly} />
        {linkError && <p className="dz-fi-error" role="alert">{linkError}</p>}
      </div>
      {connect}
    </>
  );
}

type ConnectProps = {
  mode: 'loading' | 'error' | 'session' | 'connected' | 'connect';
  connection: FigmaConnectionHandle;
  sessionHandle: string | null;
  tokenDraft: string;
  setTokenDraft: (value: string) => void;
  tokenError: string;
  tokenOpen: boolean;
  setTokenOpen: (open: boolean) => void;
  onForgetSession: () => void;
  onSubmit: () => void;
};

function ConnectBlock({mode, connection, sessionHandle, tokenDraft, setTokenDraft, tokenError, tokenOpen, setTokenOpen, onForgetSession, onSubmit}: ConnectProps) {
  const {state, busy, error, connectToken, connectOAuth, disconnect} = connection;
  if (mode === 'loading') return <div className="dz-fi-connected"><Spinner size={12} /> Checking the Figma connection…</div>;
  if (mode === 'error') return <p className="dz-fi-error" role="alert">{connection.loadError}</p>;

  if (mode === 'connected' || (mode === 'session' && sessionHandle !== null)) {
    const handle = mode === 'connected' ? state?.connection?.handle : sessionHandle;
    return (
      <div className="dz-fi-connected">
        <span className="dz-fi-dot" aria-hidden="true" />
        <span>{mode === 'connected' ? 'Figma connected' : 'Token accepted for this import'}{handle && <> · <b>@{handle}</b></>}</span>
        <button type="button" className="dz-fi-link-button" disabled={busy === 'disconnect'} onClick={mode === 'connected' ? disconnect : onForgetSession}>
          {mode === 'connected' ? 'Disconnect' : 'Use another token'}
        </button>
        {(tokenError || error) && <p className="dz-fi-error" role="alert">{tokenError || error}</p>}
      </div>
    );
  }

  const tokenField = (submit: () => void, busyToken: boolean) => (
    <div className="dz-fi-field">
      <span className="dz-fi-label" id="dz-fi-token-label">Figma access token</span>
      <div className="dz-fi-row">
        <TextInput size={32} type="password" value={tokenDraft} onChange={setTokenDraft} onKeyDown={event => enter(event, submit)} placeholder="figd_…" icon={<IconKey />} aria-labelledby="dz-fi-token-label" />
        {mode === 'connect' && <Button size={32} busy={busyToken} disabled={!tokenDraft.trim()} onClick={submit}>Connect</Button>}
      </div>
      <p className="dz-fi-hint">{TOKEN_HELP}</p>
    </div>
  );

  if (mode === 'session') {
    return (
      <div className="dz-fi-connect">
        {tokenField(onSubmit, false)}
        <p className="dz-fi-hint">The token is used only for this import: {PRODUCT_NAME} does not save it and forgets it when you close the window.</p>
        {tokenError && <p className="dz-fi-error" role="alert">{tokenError}</p>}
      </div>
    );
  }

  const connectWithToken = async () => {
    if (await connectToken(tokenDraft)) setTokenDraft('');
  };
  return (
    <div className="dz-fi-connect">
      <p className="dz-fi-connect-title">Connect Figma to read the file</p>
      <div className="dz-fi-actions">
        {state?.oauth && <Button size={32} variant="primary" busy={busy === 'oauth'} disabled={busy === 'token'} onClick={connectOAuth}>Connect with Figma</Button>}
        {state?.oauth && !tokenOpen && <Button size={32} variant="ghost" onClick={() => setTokenOpen(true)}>Connect with a token</Button>}
      </div>
      {busy === 'oauth-wait' && <p className="dz-fi-hint" role="status">Finish connecting in the Figma window.</p>}
      {(tokenOpen || !state?.oauth) && tokenField(connectWithToken, busy === 'token')}
      {(tokenOpen || !state?.oauth) && (
        <p className="dz-fi-hint">{state?.remember ? `${PRODUCT_NAME} stores the token encrypted and uses it only to read designs.` : 'The token stays in this tab only: paste it again after a reload.'}</p>
      )}
      {(tokenError || error) && <p className="dz-fi-error" role="alert">{tokenError || error}</p>}
    </div>
  );
}

// ── Reading and progress ───────────────────────────────────────────────────────────────────────

function Waiting({stage, fig}: {stage: ImportStage; fig?: boolean}) {
  return (
    <div className="dz-fi-wait" role="status">
      <Spinner size={14} />
      {stage.stage === 'wait' ? <span>Figma asks to wait <b>{stage.seconds} s</b> — then we will continue on our own</span> : <span>{fig ? 'Reading the .fig file — large files take up to a minute' : 'Reading the file in Figma — large files take up to a minute'}</span>}
    </div>
  );
}

const RUN_STEPS: {id: RunStep; label: string}[] = [
  {id: 'read', label: 'Reading the selected pages'},
  {id: 'map', label: 'Building layers'},
  {id: 'create', label: 'Creating the file'},
  {id: 'images', label: 'Copying images'},
  {id: 'save', label: 'Saving the file'},
];

function Progress({read, stage, active}: {read: FigmaRead; stage: ImportStage; active: RunStep}) {
  const steps = read.whole ? RUN_STEPS.filter(entry => entry.id !== 'read') : RUN_STEPS;
  const current = steps.findIndex(entry => entry.id === active);
  const images = stage.stage === 'images' ? stage : null;
  return (
    <div className="dz-fi-steps" role="status" aria-live="polite">
      {steps.map((entry, index) => {
        const status = index < current ? 'done' : index === current ? 'active' : 'pending';
        let detail = '';
        if (status === 'active' && stage.stage === 'wait') detail = `waiting for Figma: ${stage.seconds} s`;
        else if (status === 'active' && stage.stage === 'read' && stage.page) detail = `${stage.page.done + 1} of ${stage.page.total}`;
        else if (status === 'active' && images) detail = `${number(images.done)} of ${number(images.total)}`;
        return (
          <div key={entry.id}>
            <div className={`dz-fi-step is-${status}`}>
              <span className="dz-fi-step-icon" aria-hidden="true">
                {status === 'done' ? <IconCheck key="done" /> : status === 'active' ? <Spinner key="active" size={14} /> : <span key="pending" className="dz-fi-pending" />}
              </span>
              <span>{entry.label}</span>
              {detail && <span className="dz-fi-step-detail">{detail}</span>}
            </div>
            {entry.id === 'images' && status === 'active' && images && images.total > 0 && (
              <div className="dz-fi-bar" role="progressbar" aria-valuemin={0} aria-valuemax={images.total} aria-valuenow={images.done} aria-label="Images">
                <div className="dz-fi-bar-fill" style={{'--dz-ratio': images.done / images.total} as CSSProperties} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Pages ──────────────────────────────────────────────────────────────────────────────────────

function PagePicker({read, selected, setSelected}: {read: FigmaRead; selected: ReadonlySet<string>; setSelected: (next: ReadonlySet<string>) => void}) {
  const all = selected.size === read.pages.length;
  const layers = useMemo(() => read.pages.reduce((sum, page) => sum + (selected.has(page.id) ? page.layers ?? 0 : 0), 0), [read, selected]);
  const known = read.pages.every(page => page.layers !== null);
  const leftComponents = read.pages.some(page => !selected.has(page.id) && page.components > 0);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <>
      <div className="dz-fi-file">
        <p className="dz-fi-file-name" title={read.name}>{read.name}</p>
        <button type="button" className="dz-fi-link-button" onClick={() => setSelected(new Set(all ? [] : read.pages.map(page => page.id)))}>
          {all ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="dz-fi-pages" role="group" aria-label="Pages">
        {read.pages.map(page => (
          <div key={page.id} className="dz-fi-page">
            <Checkbox checked={selected.has(page.id)} onChange={on => toggle(page.id, on === true)}>{page.name}</Checkbox>
            <span className="dz-fi-page-meta">
              {page.layers === null ? 'read after selection' : counted(page.layers, 'layer', 'layers')}
              {page.components > 0 && ` · ${counted(page.components, 'component', 'components')}`}
            </span>
          </div>
        ))}
      </div>
      <div className="dz-fi-summary">
        <p>
          {all ? 'All pages' : `${counted(selected.size, 'page', 'pages')} selected of ${number(read.pages.length)}`}
          {known && selected.size > 0 && ` · ${counted(layers, 'layer', 'layers')}`}
        </p>
        {known && layers > documentCaps().nodes && (
          <p className="dz-fi-note is-warning"><IconAlert />A single Design file holds up to {number(documentCaps().nodes)} layers: the last layers will not be imported. Choose fewer pages and import the rest as a separate file.</p>
        )}
        {leftComponents && <p className="dz-fi-note">Components from unselected pages that the selected ones need are imported to a separate "Components" page.</p>}
        {!read.whole && <p className="dz-fi-note">The file is large: Figma returns it page by page after you choose.</p>}
      </div>
    </>
  );
}

// ── Result ─────────────────────────────────────────────────────────────────────────────────────

function Result({outcome}: {outcome: ImportOutcome}) {
  const {report} = outcome;
  const stats = [
    counted(report.pages, 'page', 'pages'),
    counted(report.nodes, 'layer', 'layers'),
    report.components ? counted(report.components, 'component', 'components') : '',
    outcome.imagesCopied ? counted(outcome.imagesCopied, 'image', 'images') : '',
  ].filter(Boolean);
  const groups = groupItems(report);
  return (
    <>
      <div className="dz-fi-done">
        <span className="dz-fi-done-icon" aria-hidden="true"><IconCheck /></span>
        <div className="dz-fi-done-text">
          <p className="dz-fi-done-title">File is ready</p>
          <p className="dz-fi-done-name" title={outcome.name}>{outcome.name}</p>
          <p className="dz-fi-done-stats">{stats.join(' · ')}</p>
        </div>
      </div>
      {groups.length || report.fonts.length ? (
        <div className="dz-fi-report">
          <p className="dz-fi-report-title">What was imported differently</p>
          {report.fonts.length > 0 && (
            <div className="dz-fi-group">
              <p className="dz-fi-group-title">{FIGMA_REPORT_GROUPS.fonts} — replaced with similar fonts from the catalog</p>
              {report.fonts.map(font => (
                <div key={font.from + font.to} className="dz-fi-item">
                  <span className="dz-fi-font">{font.from}<IconArrow width={12} height={12} style={{rotate: '45deg'}} />{font.to}</span>
                  <span className="dz-fi-item-count">{counted(font.layers, 'layer', 'layers')}</span>
                </div>
              ))}
            </div>
          )}
          {groups.map(([group, items]) => (
            <div key={group} className="dz-fi-group">
              <p className="dz-fi-group-title">{FIGMA_REPORT_GROUPS[group]}</p>
              {items.map(item => (
                <div key={item.key} className="dz-fi-item">
                  <span>{item.message}</span>
                  <span className="dz-fi-item-count">{number(item.count)}</span>
                  {item.examples.length > 0 && <span className="dz-fi-item-examples">{item.examples.map(name => `“${name}”`).join(', ')}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="dz-fi-hint">Everything read from Figma was imported without simplification.</p>
      )}
    </>
  );
}

function groupItems(report: FigmaImportReport) {
  const groups = new Map<FigmaReportGroup, FigmaImportReport['items']>();
  for (const item of report.items) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  return [...groups.entries()];
}
