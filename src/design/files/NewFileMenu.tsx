import '../styles/templates.css';
import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import type {DesignFileSummary} from '../../../shared/design/api';
import type {DesignDocument} from '../../../shared/design/types';
import {TEMPLATE_CATALOG, type TemplateId} from '../../../shared/design/templates/catalog';
import {requestNavigation} from '../../navigation';
import {createDesignFile} from '../api';
import {Button} from '../ui/Button';
import {IconChevronDown, IconPlus} from '../ui/icons';
import {Popover} from '../ui/Popover';
import {Spinner} from '../ui/Spinner';
import {useToast} from '../ui/Toast';
import {BOARD_NAMES} from '../../../shared/design/board/names';
import {IconBoard} from './board-icon';
import {errorText as shownError} from '../ui/error-text';
import type {NewCardChoice} from '../marketplace/canvas/new-card';

// "Marketplace card" asks first (marketplace, one card or six slides); its chooser loads when picked.
const loadCardChooser = () => import('../marketplace/canvas/NewCardChooser');
const NewCardChooser = lazy(() => loadCardChooser().then(module => ({default: module.NewCardChooser})));

// "New file ▾" for the file browser's top bar: the button makes an empty file, the arrow opens a gallery
// of starter templates (shared/design/templates) with their pictures. The builders, fonts and painter
// load with the gallery the first time it opens (templates-runtime.ts), not with the file browser.

type Runtime = typeof import('./templates-runtime');
let runtime: Promise<Runtime> | null = null;
const loadRuntime = () => (runtime ??= import('./templates-runtime').catch(error => {
  runtime = null;
  throw error;
}));

type CardId = TemplateId;
const CARDS = TEMPLATE_CATALOG;

export type NewFileMenuProps = {
  /** The new file is made: open it (default: the editor in this tab). */
  onCreated?: (file: DesignFileSummary) => void;
  disabled?: boolean;
  /** Where the file goes: a team (and one of its projects) instead of the caller's personal files (docs/design-tool.md §Teams). */
  target?: {teamId: string; projectId: string | null};
};

const errorText = (error: unknown) => shownError(error, 'Could not create the file.');

export function NewFileMenu({onCreated, disabled, target}: NewFileMenuProps) {
  const toast = useToast();
  const arrow = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<CardId | null>(null);

  // `choice`: "Marketplace card" asks for a marketplace and one card or six slides first (NewCardChooser).
  const create = useCallback(async (id: CardId, choice?: NewCardChoice) => {
    if (creating) return;
    setCreating(id);
    try {
      let document: DesignDocument | undefined;
      let name: string | undefined;
      if (id !== 'blank') {
        const {buildTemplate} = await loadRuntime();
        document = await buildTemplate(id, choice ? {marketplaceCard: choice} : {});
        name = choice ? (await loadCardChooser()).newCardFileName(choice) : CARDS.find(card => card.id === id)!.name;
      }
      const {file} = await createDesignFile({...(document ? {name, document} : {}), ...(target ? {teamId: target.teamId, projectId: target.projectId} : {})});
      setOpen(false);
      if (onCreated) onCreated(file);
      else requestNavigation({kind: 'design', fileId: file.id});
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    } finally {
      setCreating(null);
    }
  }, [creating, onCreated, toast, target]);

  return (
    <div className="dz-new-file" role="group" aria-label="New file">
      <Button size={32} variant="primary" icon={<IconPlus />} busy={creating === 'blank'} disabled={disabled || (!!creating && creating !== 'blank')}
        className="dz-new-file-main" onClick={() => void create('blank')}>New file</Button>
      <Button ref={arrow} size={32} variant="primary" className="dz-new-file-more" disabled={disabled} aria-label="New file from a template" aria-haspopup="dialog" aria-expanded={open}
        onPointerDown={() => void loadRuntime().catch(() => undefined)} onClick={() => setOpen(value => !value)}>
        <IconChevronDown size={12} />
      </Button>
      {open && arrow.current && (
        <Popover anchor={arrow.current} placement="bottom-end" aria-label="Templates" className="dz-templates-popover" onClose={() => setOpen(false)}>
          <TemplateGallery creating={creating} onPick={(id, choice) => void create(id, choice)} />
        </Popover>
      )}
    </div>
  );
}

/** "New board" (docs/board.md): an empty board, opened at once; its templates are on the board's "+". */
export function NewBoardButton({onCreated, disabled, target, size = 32}: NewFileMenuProps & {size?: 24 | 32}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const {file} = await createDesignFile({kind: 'board', ...(target ? {teamId: target.teamId, projectId: target.projectId} : {})});
      if (onCreated) onCreated(file);
      else requestNavigation({kind: 'design', fileId: file.id});
    } catch (error) {
      toast(shownError(error, 'Could not create the board.'), {kind: 'error'});
    } finally {
      setCreating(false);
    }
  };
  return (
    <Button size={size} icon={<IconBoard />} busy={creating} disabled={disabled} className="dz-new-board" onClick={() => void create()}>{BOARD_NAMES.create}</Button>
  );
}

function TemplateGallery({creating, onPick}: {creating: CardId | null; onPick: (id: CardId, choice?: NewCardChoice) => void}) {
  const [choosingCard, setChoosingCard] = useState(false);
  if (choosingCard)
    return (
      <Suspense fallback={<div className="dz-templates"><Spinner size={20} label="Loading" /></div>}>
        <NewCardChooser busy={creating === 'marketplace'} disabled={!!creating} onBack={() => setChoosingCard(false)} onCreate={choice => onPick('marketplace', choice)} />
      </Suspense>
    );
  return (
    <div className="dz-templates">
      <header className="dz-templates-header">
        <h2 className="dz-templates-title">Start from a template</h2>
        <p className="dz-templates-lead">Ready-made designs with components, styles and auto layout.</p>
      </header>
      <ul className="dz-templates-grid">
        {CARDS.map(card => (
          <li key={card.id}>
            <button type="button" className="dz-template" disabled={!!creating} aria-busy={creating === card.id || undefined}
              onClick={() => (card.id === 'marketplace' ? setChoosingCard(true) : onPick(card.id))}>
              <span className="dz-template-thumb">
                {card.id === 'blank' ? <span className="dz-template-blank"><IconPlus size={20} /></span> : <TemplateThumb id={card.id} />}
                {creating === card.id && <span className="dz-template-busy"><Spinner size={20} label="Creating the file" /></span>}
              </span>
              <span className="dz-template-name">{card.name}</span>
              <span className="dz-template-description">{card.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Built documents for the cards, kept for the visit: building is the slow part. */
const cardDocs = new Map<CardId, Promise<DesignDocument>>();
/** One card is built at a time, so the gallery stays responsive while the pictures arrive. */
let queue: Promise<unknown> = Promise.resolve();

function TemplateThumb({id}: {id: Exclude<CardId, 'blank'>}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    let doc = cardDocs.get(id);
    if (!doc) {
      doc = queue.then(async () => {
        const {buildTemplate} = await loadRuntime();
        await new Promise(resolve => setTimeout(resolve, 0));
        return buildTemplate(id);
      });
      queue = doc.catch(() => undefined);
      cardDocs.set(id, doc);
      doc.catch(() => cardDocs.delete(id));
    }
    Promise.all([doc, loadRuntime()]).then(([built, {paintTemplateCard}]) => {
      const element = canvas.current;
      if (!live || !element) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = element.getBoundingClientRect();
      element.width = Math.max(1, Math.round(rect.width * dpr));
      element.height = Math.max(1, Math.round(rect.height * dpr));
      paintTemplateCard(element, id, built);
      setReady(true);
    }, () => undefined);
    return () => {live = false;};
  }, [id]);
  return <canvas ref={canvas} className={`dz-template-canvas ${ready ? 'is-ready' : ''}`.trim()} aria-hidden="true" />;
}
