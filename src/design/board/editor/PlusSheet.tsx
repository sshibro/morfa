import {memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {DesignTemplateSummary} from '../../../../shared/design/api';
import type {NodeId, Vec} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {createBoardText, createSticker} from '../../../../shared/design/board/create';
import {STAMPS, STICKERS, type StickerSpec} from '../../../../shared/design/board/art';
import {SECTION_COLORS} from '../../../../shared/design/board/palette';
import {BOARD_TEMPLATE_GROUPS, BOARD_TEMPLATES, buildBoardTemplate, insertBoardTemplate, type BoardTemplateSpec} from '../../../../shared/design/board/templates';
import type {CommandContext} from '../../engine/commands';
import {currentViewport, type DesignStore} from '../../engine/store';
import {FIT_PADDING, fitRect} from '../../engine/viewport';
import type {EditorServices} from '../../editor/services';
import {StampFace} from '../chrome/Toolbar';
import {BdSearch} from '../chrome/icons';
import {canPublishTemplate, insertTemplateContent, listTeamTemplates, subscribeTemplatePlace, templateContent, templatePlace} from '../team-templates';
import {PUBLISH_TEMPLATE_DIALOG_ID} from './dialogs';
import {setBoardChoices} from '../state';
import {insertBuild, placement} from '../tools/common';

// The "+" sheet (docs/board.md §"+"): FigJam's "More" over the toolbar. A search over everything, then tabs: templates (the
// built-in Russian ones), stickers (drawn, vector), stamps and emoji. A pick lands in the middle of the view as one undo step and is
// selected; a template is zoomed to. The sheet rises from the toolbar (board.css), its contents never animate.

export type PlusSheetTab = 'all' | 'templates' | 'stickers' | 'stamps' | 'emoji';
type Tab = PlusSheetTab;
const TABS: {id: Tab; label: string}[] = [
  {id: 'all', label: 'All'},
  {id: 'templates', label: 'Templates'},
  {id: 'stickers', label: 'Stickers'},
  {id: 'stamps', label: 'Stamps'},
  {id: 'emoji', label: 'Emoji'},
];

/** Emoji placed as large text (the system's colour emoji font draws them). */
export const BOARD_EMOJI: readonly {char: string; label: string}[] = [
  {char: '👍', label: 'Thumbs up'}, {char: '❤️', label: 'Heart love'}, {char: '🎉', label: 'Party hooray'}, {char: '🔥', label: 'Fire'},
  {char: '💡', label: 'Idea light bulb'}, {char: '🚀', label: 'Rocket launch'}, {char: '✅', label: 'Done check'}, {char: '❓', label: 'Question'},
  {char: '⭐', label: 'Star'}, {char: '👀', label: 'Eyes looking'}, {char: '🤔', label: 'Thinking'}, {char: '😂', label: 'Laughing'},
  {char: '🙌', label: 'Hooray hands'}, {char: '👏', label: 'Applause'}, {char: '⚠️', label: 'Warning'}, {char: '📌', label: 'Pushpin pin'},
  {char: '🎯', label: 'Target'}, {char: '⏰', label: 'Time alarm clock'}, {char: '☕', label: 'Coffee break'}, {char: '🏆', label: 'Trophy win'},
];

const fold = (text: string) => text.toLocaleLowerCase('en');

/** `tab`: the tab it opens on (the stamp wheel's "+" opens it on "Emoji"). */
export type PlusSheetProps = {store: DesignStore; services: EditorServices; context: () => CommandContext; onClose: () => void; tab?: PlusSheetTab};

export const PlusSheet = memo(function PlusSheet({store, services, context, onClose, tab: firstTab = 'all'}: PlusSheetProps) {
  const [tab, setTab] = useState<Tab>(firstTab);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus({preventScroll: true}), []);
  // A press outside the sheet (on the canvas, another pill) closes it; the toolbar's "+" toggles it itself.
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!sheet.current || sheet.current.contains(target) || target?.closest?.('.bd-plus')) return;
      onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [onClose]);

  const words = fold(query.trim());
  const match = (text: string) => !words || fold(text).includes(words);
  const templates = useMemo(() => BOARD_TEMPLATES.filter(template => match(`${template.name} ${template.description} ${template.keywords}`)), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  const stickers = useMemo(() => STICKERS.filter(sticker => match(`${sticker.label} ${sticker.keywords} sticker`)), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  const stamps = useMemo(() => STAMPS.filter(stamp => match(`${stamp.label} stamp`)), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  const emoji = useMemo(() => BOARD_EMOJI.filter(entry => match(`${entry.label} emoji smiley`)), [words]); // eslint-disable-line react-hooks/exhaustive-deps

  const centre = (): Vec => {
    const size = context().canvasSize();
    const viewport = currentViewport(store.getState());
    return {x: viewport.x + size.width / 2 / viewport.zoom, y: viewport.y + size.height / 2 / viewport.zoom};
  };

  const placeTemplate = (template: BoardTemplateSpec) => {
    const built = buildBoardTemplate(template.id, newId);
    const at = centre();
    const corner = {x: Math.round(at.x - built.bounds.width / 2), y: Math.round(at.y - built.bounds.height / 2)};
    const {pageId} = store.getState();
    let roots: NodeId[] = [];
    store.transact(`Template "${template.name}"`, tx => {
      roots = insertBoardTemplate(tx, built, pageId, corner);
    });
    store.setSelection([]);
    onClose();
    const size = context().canvasSize();
    if (size.width && size.height) store.setViewport(fitRect(size, {...corner, width: built.bounds.width, height: built.bounds.height}, FIT_PADDING * 2, 1));
    if (!roots.length) services.toast('Could not insert the template.', 'error');
  };

  const placeSticker = (sticker: StickerSpec) => {
    const state = store.getState();
    const at = centre();
    const {parentId, local} = placement(state, at, context().index?.() ?? null);
    const build = createSticker(newId, {x: Math.round(local.x - 60), y: Math.round(local.y - 60), sticker: sticker.id});
    if (build) insertBuild(store, 'Sticker', build, parentId);
    onClose();
  };

  const placeEmoji = (char: string) => {
    const state = store.getState();
    const at = centre();
    const {parentId, local} = placement(state, at, context().index?.() ?? null);
    insertBuild(store, 'Emoji', createBoardText(newId, {x: Math.round(local.x - 48), y: Math.round(local.y - 56), text: char, size: 96}), parentId);
    onClose();
  };

  const armStamp = (id: (typeof STAMPS)[number]['id']) => {
    setBoardChoices({stamp: id});
    store.setTool('board-stamp');
    onClose();
  };

  const show = (part: Tab) => tab === 'all' || tab === part;
  const nothing = !templates.length && !stickers.length && !stamps.length && !emoji.length;

  return (
    <div ref={sheet} className="bd-sheet" role="dialog" aria-label="More: templates, stickers, stamps">
      <div className="bd-sheet-head">
        <label className="bd-sheet-search">
          <BdSearch size={20} />
          <input ref={search} type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="We cannot read minds, but if you type it, we will find it"
            aria-label="Search templates, stickers and stamps"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                if (query) setQuery('');
                else onClose();
              }
            }} />
        </label>
        <div className="bd-sheet-tabs" role="tablist" aria-label="Sections">
          {TABS.map(entry => (
            <button key={entry.id} type="button" role="tab" className="bd-sheet-tab" aria-selected={tab === entry.id} onClick={() => setTab(entry.id)}>{entry.label}</button>
          ))}
        </div>
      </div>
      <div className="bd-sheet-body">
        {nothing && <p className="bd-sheet-empty">Nothing found. Try another word: "retro", "ideas", "heart".</p>}
        {tab === 'all' && !words && templates.length > 0 && <UseCases templates={templates} onTemplate={placeTemplate} onSticker={placeSticker} onAll={() => setTab('templates')} />}
        {show('templates') && templates.length > 0 && !(tab === 'all' && !words) && (
          tab === 'templates' && !words
            ? (Object.keys(BOARD_TEMPLATE_GROUPS) as BoardTemplateSpec['group'][]).map(group => (
              <SheetSection key={group} title={BOARD_TEMPLATE_GROUPS[group].title} lead={BOARD_TEMPLATE_GROUPS[group].lead}>
                <TemplateGrid templates={templates.filter(template => template.group === group)} onPick={placeTemplate} />
              </SheetSection>
            ))
            : (
              <SheetSection title="Templates">
                <TemplateGrid templates={templates} onPick={placeTemplate} />
              </SheetSection>
            )
        )}
        {tab === 'templates' && !words && <TeamTemplates store={store} services={services} centre={centre} canvasSize={() => context().canvasSize()} onClose={onClose} />}
        {show('stickers') && stickers.length > 0 && (
          <SheetSection title="Stickers">
            <div className="bd-sheet-grid is-stickers">
              {stickers.map(sticker => (
                <button key={sticker.id} type="button" className="bd-sheet-item" aria-label={sticker.label} title={sticker.label} onClick={() => placeSticker(sticker)}>
                  <StickerPreview sticker={sticker} />
                </button>
              ))}
            </div>
          </SheetSection>
        )}
        {show('stamps') && stamps.length > 0 && (
          <SheetSection title="Stamps" lead="Choose a stamp and click the board. E turns it on or off.">
            <div className="bd-sheet-grid is-stamps">
              {stamps.map(stamp => (
                <button key={stamp.id} type="button" className="bd-sheet-item" aria-label={stamp.label} title={stamp.label} onClick={() => armStamp(stamp.id)}>
                  <StampFace color={stamp.color} glyph={stamp.id === 'avatar' ? 'Me' : stamp.glyph} icon={stamp.icon} stroke={stamp.stroke} size={40} />
                </button>
              ))}
            </div>
          </SheetSection>
        )}
        {show('emoji') && emoji.length > 0 && (
          <SheetSection title="Emoji">
            <div className="bd-sheet-grid is-emoji">
              {emoji.map(entry => (
                <button key={entry.char} type="button" className="bd-sheet-item is-emoji" aria-label={entry.label} title={entry.label} onClick={() => placeEmoji(entry.char)}>
                  <span aria-hidden="true">{entry.char}</span>
                </button>
              ))}
            </div>
          </SheetSection>
        )}
      </div>
    </div>
  );
});

/** The "All" tab before anything is typed (FigJam's "+" sheet, as the owner's screenshot shows it: "Brainstorm together", "Run a
 *  meeting"…): a section per use, each a row of its templates and a sticker or two that go with it. */
const USE_CASE_STICKERS: Record<BoardTemplateSpec['group'], readonly string[]> = {
  ideas: ['light-bulb', 'star'],
  meetings: ['coffee', 'party'],
  planning: ['rocket', 'flag'],
  diagrams: ['question', 'target'],
};

function UseCases({templates, onTemplate, onSticker, onAll}: {templates: readonly BoardTemplateSpec[]; onTemplate: (template: BoardTemplateSpec) => void; onSticker: (sticker: StickerSpec) => void; onAll: () => void}) {
  return (
    <>
      {(Object.keys(BOARD_TEMPLATE_GROUPS) as BoardTemplateSpec['group'][]).map(group => {
        const stickers = USE_CASE_STICKERS[group].map(id => STICKERS.find(sticker => sticker.id === id)).filter((sticker): sticker is StickerSpec => !!sticker);
        return (
          <SheetSection key={group} title={BOARD_TEMPLATE_GROUPS[group].title} lead={BOARD_TEMPLATE_GROUPS[group].lead}>
            <ul className="bd-sheet-templates is-use-case">
              {templates.filter(template => template.group === group).slice(0, 2).map(template => (
                <li key={template.id}><TemplateCard template={template} onPick={onTemplate} /></li>
              ))}
              {stickers.map(sticker => (
                <li key={sticker.id}>
                  <button type="button" className="bd-template is-sticker" onClick={() => onSticker(sticker)}>
                    <span className="bd-template-art is-sticker"><StickerPreview sticker={sticker} /></span>
                    <span className="bd-template-name">{sticker.label}</span>
                    <span className="bd-template-description">Sticker</span>
                  </button>
                </li>
              ))}
            </ul>
          </SheetSection>
        );
      })}
      <button type="button" className="bd-sheet-more" onClick={onAll}>All templates</button>
    </>
  );
}

/** The team's own templates (team-templates.ts, lane S's routes): its boards published as templates, newest first; and the way
 *  to publish this one. Nothing on a personal board. */
function TeamTemplates({store, services, centre, canvasSize, onClose}: {store: DesignStore; services: EditorServices; centre: () => Vec; canvasSize: () => {width: number; height: number}; onClose: () => void}) {
  const place = useSyncExternalStore(subscribeTemplatePlace, templatePlace, templatePlace);
  const teamId = place?.teamId ?? null;
  const [templates, setTemplates] = useState<DesignTemplateSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!teamId) return;
    let live = true;
    listTeamTemplates(teamId).then(answer => live && setTemplates(answer.templates), () => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, [teamId]);
  if (!teamId || !place) return null;
  const insert = async (template: DesignTemplateSummary) => {
    if (busy || store.readOnly) return;
    setBusy(template.id);
    try {
      const content = await templateContent(template.id, place.fileId);
      const at = centre();
      const corner = {x: Math.round(at.x - content.bounds.width / 2), y: Math.round(at.y - content.bounds.height / 2)};
      const {bounds} = insertTemplateContent(store, template, content, corner);
      onClose();
      const size = canvasSize();
      if (size.width && size.height) store.setViewport(fitRect(size, bounds, FIT_PADDING * 2, 1));
    } catch {
      services.toast('Could not add the team template.', 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <SheetSection title="Team templates" lead="Your team's boards published as templates.">
      {templates === null ? <p className="bd-sheet-lead">Loading…</p> : templates.length === 0 ? <p className="bd-sheet-lead">None yet: publish a board from the "File" menu.</p> : (
        <ul className="bd-sheet-templates">
          {templates.map(template => (
            <li key={template.id}>
              <button type="button" className="bd-template is-team" aria-busy={busy === template.id} onClick={() => void insert(template)}>
                {template.thumbnailUrl ? <img className="bd-template-art" src={template.thumbnailUrl} alt="" /> : <span className="bd-template-art is-empty" aria-hidden="true" />}
                <span className="bd-template-name">{template.name}</span>
                <span className="bd-template-description">{template.description || `Published by ${template.publishedBy.name}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {canPublishTemplate() && <button type="button" className="bd-sheet-more" onClick={() => {
        onClose();
        services.openDialog(PUBLISH_TEMPLATE_DIALOG_ID);
      }}>Publish this board as a template…</button>}
    </SheetSection>
  );
}

function SheetSection({title, lead, children}: {title: string; lead?: string; children: ReactNode}) {
  return (
    <section className="bd-sheet-section">
      <h3 className="bd-sheet-title">{title}</h3>
      {lead && <p className="bd-sheet-lead">{lead}</p>}
      {children}
    </section>
  );
}

function TemplateGrid({templates, onPick}: {templates: readonly BoardTemplateSpec[]; onPick: (template: BoardTemplateSpec) => void}) {
  return (
    <ul className="bd-sheet-templates">
      {templates.map(template => <li key={template.id}><TemplateCard template={template} onPick={onPick} /></li>)}
    </ul>
  );
}

function TemplateCard({template, onPick}: {template: BoardTemplateSpec; onPick: (template: BoardTemplateSpec) => void}) {
  return (
    <button type="button" className="bd-template" onClick={() => onPick(template)}>
      <TemplateArt template={template} />
      <span className="bd-template-name">{template.name}</span>
      <span className="bd-template-description">{template.description}</span>
    </button>
  );
}

/** A small drawing of a template: its colour's section with a few notes, so the cards read at a glance without a picture. */
function TemplateArt({template}: {template: BoardTemplateSpec}) {
  const color = SECTION_COLORS.find(entry => entry.id === template.color) ?? SECTION_COLORS[0];
  const notes = template.id === 'kanban' ? [[8, 14], [8, 30], [36, 14], [64, 14], [92, 14]] : template.id === 'mind-map' || template.id === 'flowchart' || template.id === 'five-whys' ? [] : [[10, 14], [34, 14], [58, 14], [10, 38], [34, 38]];
  return (
    <svg className="bd-template-art" viewBox="0 0 120 68" aria-hidden="true">
      <rect x="0.5" y="0.5" width="119" height="67" rx="6" fill={color.hex} />
      <rect x="6" y="5" width="28" height="5" rx="2.5" fill={color.chip} />
      {notes.map(([x, y], i) => <rect key={i} x={x} y={y} width={20} height={20} rx="1.5" fill="#FFFFFF" stroke="rgba(0,0,0,0.08)" />)}
      {template.id === 'mind-map' && (
        <g fill="none" stroke={color.chip} strokeWidth="1.5">
          <path d="M60 34 C44 34 44 18 28 18 M60 34 C44 34 44 50 28 50 M60 34 C76 34 76 18 92 18 M60 34 C76 34 76 50 92 50" />
          <ellipse cx="60" cy="34" rx="14" ry="9" fill="#FFFFFF" />
          {[[16, 14], [16, 46], [92, 14], [92, 46]].map(([x, y], i) => <rect key={i} x={x} y={y} width="14" height="8" rx="3" fill="#FFFFFF" />)}
        </g>
      )}
      {(template.id === 'flowchart' || template.id === 'five-whys') && (
        <g fill="#FFFFFF" stroke={color.chip} strokeWidth="1.25">
          <path d="M28 34h18M64 34h18" fill="none" />
          <rect x="10" y="26" width="18" height="16" rx="3" />
          <path d="M55 24l9 10-9 10-9-10z" />
          <rect x="82" y="26" width="18" height="16" rx={template.id === 'flowchart' ? 8 : 3} />
        </g>
      )}
    </svg>
  );
}

/** A sticker drawn from its layers, as on the canvas. */
const StickerPreview = memo(function StickerPreview({sticker}: {sticker: StickerSpec}) {
  return (
    <svg viewBox="0 0 96 96" width="56" height="56" aria-hidden="true">
      {sticker.layers.map((layer, i) => 'ellipse' in layer
        ? <ellipse key={i} cx={layer.ellipse[0]} cy={layer.ellipse[1]} rx={layer.ellipse[2]} ry={layer.ellipse[3]} fill={layer.fill ?? 'none'} stroke={layer.stroke ?? 'none'} strokeWidth={layer.width ?? 3} />
        : <path key={i} d={layer.d} fill={layer.fill ?? 'none'} stroke={layer.stroke ?? 'none'} strokeWidth={layer.width ?? 3} strokeLinecap={layer.cap === 'round' ? 'round' : 'butt'} strokeLinejoin="round" />)}
    </svg>
  );
});
