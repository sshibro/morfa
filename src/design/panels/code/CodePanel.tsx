import '../../styles/panel-code.css';
import {memo, useCallback, useEffect, useMemo, useState} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import type {TextMeasurer} from '../../../../shared/design/text-layout';
import {topLevelSelection} from '../../../../shared/design/tree';
import {cssForLayers} from '../../../../shared/design/codegen/css';
import {toReact, toVue, type ComponentInfo, type GeneratedFile, type ReactResult, type Styling} from '../../../../shared/design/codegen/react';
import {filesZip} from '../../../../shared/design/codegen/project';
import {collectTokens, suggestTokens, tailwindTheme, tokensCss, tokensTs} from '../../../../shared/design/codegen/tokens';
import {Button, IconButton} from '../../ui/Button';
import {IconCode, IconDownload, IconExport, IconSettings, layerIcon} from '../../ui/icons';
import {useMenuTrigger, type MenuItem} from '../../ui/Menu';
import {PanelSection} from '../../ui/PanelSection';
import {EmptyState} from '../../ui/ProgressBar';
import {Select, type SelectEntry} from '../../ui/Select';
import {Spinner} from '../../ui/Spinner';
import {SegmentedControl} from '../../ui/Tabs';
import {formatNumber} from '../../ui/number-expression';
import {useEditorServices} from '../../editor/services';
import {downloadBlob, fetchPictures, fontFallback, REACT_EXPORT_DIALOG, VUE_EXPORT_DIALOG} from '../../engine/commands/code';
import {goToMain} from '../../engine/commands/components';
import {CodeView} from './CodeView';
import {ComponentSection} from './ComponentSection';
import {CopyButton} from './CopyButton';
import {languageOf} from './highlight';
import {AssetsSection, LayoutSection, MeasureRows, StylesSection, TypographySection} from './InspectSections';
import {cssList, fileTabLabel, typeLabel} from './inspect';
import {codeScope, scopeHolds} from './scope';
import {formatOf, isVue, readSettings, writeSettings, type CodeLanguage, type CodeSettings} from './settings';
import {useSettled} from './useSettled';
import {DevNotesSection} from '../../annotations';
import {useDesignStore} from '../../engine/useDesignStore';

// "Code" (Dev Mode, docs/design-tool.md §Design to code): what Figma's Dev Mode inspect panel shows, in its order: the layer,
// its component (props, the states that are CSS, a playground), the code (CSS, React or Vue in three stylings, or the file's
// tokens; px or rem, hex, rgb or hsl; tokens suggested for raw colours; as code or a list of values), the box model and
// auto layout, typography, styles and variables, assets and export. Read-only. Code is generated when the document
// settles, never during a drag, and only when something the selection's code reads changed (scope.ts): a co-editor's edit
// elsewhere in the file costs a pass over that list. Long files are virtualized.

const LANGUAGES: readonly SelectEntry<CodeLanguage>[] = [
  {value: 'css', label: 'CSS'},
  {value: 'react', label: 'React + CSS Modules'},
  {value: 'tailwind', label: 'React + Tailwind'},
  {value: 'inline', label: 'React + inline styles'},
  {separator: true},
  {value: 'vue', label: 'Vue + CSS Modules'},
  {value: 'vue-tailwind', label: 'Vue + Tailwind'},
  {value: 'vue-inline', label: 'Vue + inline styles'},
  {separator: true},
  {value: 'tokens', label: 'Tokens'},
];
const STYLING: Record<Exclude<CodeLanguage, 'css' | 'tokens'>, Styling> = {react: 'css-modules', tailwind: 'tailwind', inline: 'inline', vue: 'css-modules', 'vue-tailwind': 'tailwind', 'vue-inline': 'inline'};
/** The export the tab offers: the project of the language in view. */
const exportLabel = (language: CodeLanguage) => (isVue(language) ? 'Export to Vue…' : 'Export to React…');
/** Layers past which the tab stops generating live and points to the export. */
const LIVE_LIMIT = 4000;
/** Selections past this many layers are generated after the frame that shows the new selection. */
const HEAVY = 600;

function countLayers(doc: DesignDocument, ids: readonly NodeId[], limit: number): number {
  let count = 0;
  const stack = [...ids];
  while (stack.length && count <= limit) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    count++;
    if (node.children) stack.push(...node.children);
  }
  return count;
}

type Output =
  | {kind: 'files'; files: GeneratedFile[]; entry: ComponentInfo | null; react: ReactResult | null}
  | {kind: 'too-large'};

function generate(doc: DesignDocument, ids: readonly NodeId[], settings: CodeSettings, measurer: TextMeasurer): Output | null {
  const format = formatOf(settings);
  if (settings.language === 'tokens') {
    const tokens = collectTokens(doc, {fontFallback});
    const css = tokensCss(tokens, {format});
    return {kind: 'files', entry: null, react: null, files: css ? [{path: 'src/tokens.css', contents: css}, {path: 'src/theme.css', contents: tailwindTheme(tokens, new Map(), {format})}, {path: 'src/tokens.ts', contents: tokensTs(tokens)}] : []};
  }
  if (!ids.length) return null;
  if (countLayers(doc, ids, LIVE_LIMIT) > LIVE_LIMIT) return {kind: 'too-large'};
  if (settings.language === 'css') return {kind: 'files', entry: null, react: null, files: [{path: 'style.css', contents: cssForLayers(doc, ids, {fontFallback, format, suggest: settings.suggest})}]};
  const react = (isVue(settings.language) ? toVue : toReact)(doc, ids, {styling: STYLING[settings.language], measurer, fontFallback, format, suggestTokens: settings.suggest});
  const entry = react.entries[0] ?? null;
  const first = new Set(entry?.files ?? []);
  const files = [...react.files].sort((a, b) => Number(first.has(b.path)) - Number(first.has(a.path)));
  return {kind: 'files', files, entry, react};
}

/** The code for the inputs: small selections in render, big ones a moment later (the click that selected them paints
 *  first; the previous code stays, dimmed, until the new one is ready). */
function useGenerated(doc: DesignDocument, ids: readonly NodeId[], settings: CodeSettings, measurer: TextMeasurer): {output: Output | null; pending: boolean} {
  const react = settings.language !== 'css' && settings.language !== 'tokens';
  const heavy = useMemo(() => react && countLayers(doc, ids, HEAVY) > HEAVY, [doc, ids, react]);
  const now = useMemo(() => (heavy ? null : generate(doc, ids, settings, measurer)), [heavy, doc, ids, settings, measurer]);
  const [late, setLate] = useState<{doc: DesignDocument; ids: readonly NodeId[]; settings: CodeSettings; output: Output | null} | null>(null);
  useEffect(() => {
    if (!heavy) return;
    const timer = setTimeout(() => setLate({doc, ids, settings, output: generate(doc, ids, settings, measurer)}), 32);
    return () => clearTimeout(timer);
  }, [heavy, doc, ids, settings, measurer]);
  if (!heavy) return {output: now, pending: false};
  const fresh = !!late && late.doc === doc && late.ids === ids && late.settings === settings;
  return {output: late?.output ?? null, pending: !fresh};
}

export const CodePanel = memo(function CodePanel() {
  const services = useEditorServices();
  const {store} = services;
  const {doc: settled, selection} = useSettled(store);
  // Everything below reads the selection's scope only: a change elsewhere in the file keeps `doc` the same object.
  const doc = useCodeDoc(settled, selection);
  const ids = useMemo(() => topLevelSelection(doc, selection).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE'), [doc, selection]);
  const [settings, setSettings] = useState<CodeSettings>(readSettings);
  const change = useCallback((patch: Partial<CodeSettings>) => setSettings(current => {
    const next = {...current, ...patch};
    writeSettings(next);
    return next;
  }), []);
  const format = useMemo(() => formatOf(settings), [settings]);
  const {output, pending} = useGenerated(doc, ids, settings, store.measurer);
  // Notes and measurements for developers (src/design/annotations): the selection's, or the page's.
  const pageId = useDesignStore(state => state.pageId, Object.is, {store, slice: 'page'});
  // Measurements may join any layer of the page: the notes read the settled document (their reads are small).
  const devNotes = <DevNotesSection store={store} doc={settled} pageId={pageId} ids={ids} canEdit={!services.readOnly} reveal={services.revealNodes} />;

  const node = ids.length === 1 ? doc.nodes[ids[0]] : undefined;
  const tokens = useMemo(() => {
    const table = collectTokens(doc, {fontFallback});
    return settings.suggest ? suggestTokens(table) : table;
  }, [doc, settings.suggest]);
  const exportReact = useCallback(() => services.openDialog(isVue(settings.language) ? VUE_EXPORT_DIALOG : REACT_EXPORT_DIALOG, {ids: [...store.getState().selection], pageId: store.getState().pageId}), [services, store, settings.language]);
  // A component's own props: from a React or Vue output that names one (the CSS and tokens views generate none).
  const component = useComponentInfo(doc, ids, node, store.measurer, output);
  const instance = node?.type === 'INSTANCE';
  const toMain = useCallback(() => {
    if (node) goToMain(store, node.id);
  }, [store, node]);

  if (!ids.length && settings.language !== 'tokens') {
    return (
      <div className="dz-code-panel">
        <div className="dz-code-header is-empty"><span className="dz-code-header-name">Nothing selected</span></div>
        {devNotes}
        <EmptyState className="dz-code-empty" icon={<IconCode />} title="Select a layer" actions={<Button icon={<IconExport />} onClick={exportReact}>{exportLabel(settings.language)}</Button>}>
          A click selects any layer, even a nested one; hover another to see the distances. The code, sizes, typography, colors and assets will appear here.
        </EmptyState>
        <div className="dz-code-empty-tokens">
          <Button variant="ghost" onClick={() => change({language: 'tokens'})}>File tokens</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="dz-code-panel">
      {node ? <SelectionHeader node={node} /> : ids.length > 1 ? <div className="dz-code-header"><span className="dz-code-header-name">{ids.length} layers selected</span></div> : null}
      {devNotes}
      {component && <ComponentSection info={component} instance={instance} onGoToMain={instance ? toMain : undefined} framework={isVue(settings.language) ? 'vue' : 'react'} />}
      <CodeSection output={output} pending={pending} settings={settings} onChange={change} onExport={exportReact} doc={doc} node={node} />
      {node && <LayoutSection doc={doc} node={node} format={format} />}
      {node && <TypographySection node={node} tokens={tokens} format={format} />}
      {ids.length > 0 && <StylesSection doc={doc} ids={ids} tokens={tokens} format={format} />}
      {ids.length > 0 && <AssetsSection doc={doc} ids={ids} />}
    </div>
  );
});

/** The document as "Code" reads it for `selection`: the same object while nothing in the selection's scope changed
 *  (scope.ts), so a co-editor's edit elsewhere in the file regenerates nothing and re-renders no section; the new document
 *  once something the tab shows did. */
function useCodeDoc(doc: DesignDocument, selection: readonly NodeId[]): DesignDocument {
  const [held, setHeld] = useState(() => ({doc, selection, scope: codeScope(doc, selection)}));
  if (held.doc === doc && held.selection === selection) return doc;
  if (held.selection === selection && held.scope && scopeHolds(held.scope, doc)) return held.doc;
  setHeld({doc, selection, scope: codeScope(doc, selection)});
  return doc;
}

/** The component a single selection is (or is an instance of), as React writes it: from the React output in view, or
 *  generated for the CSS view, so its props and playground stay in every language. */
function useComponentInfo(doc: DesignDocument, ids: readonly NodeId[], node: SceneNode | undefined, measurer: TextMeasurer, output: Output | null): ComponentInfo | null {
  const isComponent = !!node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE');
  const fromOutput = output?.kind === 'files' && output.entry?.kind === 'component' ? output.entry : null;
  return useMemo(() => {
    if (!isComponent) return null;
    if (fromOutput) return fromOutput;
    try {
      const entry = toReact(doc, ids, {measurer, fontFallback}).entries[0];
      return entry?.kind === 'component' ? entry : null;
    } catch {
      return null;
    }
  }, [isComponent, fromOutput, doc, ids, measurer]);
}

function SelectionHeader({node}: {node: SceneNode}) {
  const Icon = layerIcon(node.type, {mask: node.isMask, image: node.fills.some(fill => fill.type === 'IMAGE'), layout: node.autoLayout?.layoutMode});
  const component = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE';
  return (
    <div className={`dz-code-header ${component ? 'is-component' : ''}`.trim()}>
      <span className="dz-code-header-icon"><Icon /></span>
      <div className="dz-code-header-text">
        <span className="dz-code-header-name" title={node.name}>{node.name}</span>
        {/* “393 × 852” never breaks inside, and fractions take the Russian comma as the fields do. */}
        <span className="dz-code-header-meta">{typeLabel(node)} · {formatNumber(node.width, 2)}{' × '}{formatNumber(node.height, 2)}</span>
      </div>
      <CopyButton text={node.name} label="Copy layer name" />
    </div>
  );
}

// ── Code ───────────────────────────────────────────────────────────────────────────────────────

/** Memoised like the sections: a change elsewhere in the file re-renders the panel (useSettled), none of what it holds. */
const CodeSection = memo(function CodeSection({output, pending, settings, onChange, onExport, doc, node}: {
  output: Output | null; pending: boolean; settings: CodeSettings; onChange: (patch: Partial<CodeSettings>) => void; onExport: () => void; doc: DesignDocument; node: SceneNode | undefined;
}) {
  const list = settings.language === 'css' && settings.view === 'list' && !!node;
  const actions = (
    <>
      <Select value={settings.language} options={LANGUAGES} onChange={language => onChange({language})} appearance="quiet" aria-label="Code language" className="dz-code-language" />
      <SettingsMenu settings={settings} onChange={onChange} />
    </>
  );
  return (
    <PanelSection title="Code" actions={actions} className="dz-code-section">
      {settings.language === 'css' && node && (
        <SegmentedControl value={settings.view} onChange={view => onChange({view})} fill aria-label="CSS view"
          options={[{value: 'code', label: 'Code'}, {value: 'list', label: 'List'}]} />
      )}
      {pending && <p className="dz-code-pending" role="status"><Spinner size={12} /> Preparing the code…</p>}
      {list ? <CssListView doc={doc} id={node!.id} settings={settings} /> : output?.kind === 'too-large' ? (
        <p className="dz-panel-note">The selection has more than {LIVE_LIMIT.toLocaleString('en-US')} layers — code of this size is easier to get as an archive via "{exportLabel(settings.language)}".</p>
      ) : output ? (
        <div className={`dz-code-output ${pending ? 'is-stale' : ''}`.trim()}><FilesView key={settings.language} output={output} language={settings.language} /></div>
      ) : null}
      <div className="dz-code-actions">
        <Button variant="ghost" icon={<IconExport />} onClick={onExport}>{exportLabel(settings.language)}</Button>
      </div>
    </PanelSection>
  );
});

/** Units, colour format and token suggestions (Figma's code settings), in a menu beside the language. */
function SettingsMenu({settings, onChange}: {settings: CodeSettings; onChange: (patch: Partial<CodeSettings>) => void}) {
  const items = useCallback((): MenuItem[] => [
    {type: 'label', label: 'Units'},
    {id: 'unit-px', label: 'Pixels (px)', checked: settings.unit === 'px', radio: true, onSelect: () => onChange({unit: 'px'})},
    {id: 'unit-rem', label: 'rem (1rem = 16px)', checked: settings.unit === 'rem', radio: true, onSelect: () => onChange({unit: 'rem'})},
    {type: 'separator'},
    {type: 'label', label: 'Color'},
    {id: 'color-hex', label: 'HEX', checked: settings.color === 'hex', radio: true, onSelect: () => onChange({color: 'hex'})},
    {id: 'color-rgb', label: 'RGB', checked: settings.color === 'rgb', radio: true, onSelect: () => onChange({color: 'rgb'})},
    {id: 'color-hsl', label: 'HSL', checked: settings.color === 'hsl', radio: true, onSelect: () => onChange({color: 'hsl'})},
    {type: 'separator'},
    {id: 'suggest', label: 'Use tokens', description: 'A color equal to a variable is written as the variable', checked: settings.suggest, onSelect: () => onChange({suggest: !settings.suggest})},
  ], [settings, onChange]);
  const menu = useMenuTrigger({items, label: 'Code settings', placement: 'bottom-end', minWidth: 220});
  return (
    <>
      <IconButton label="Code settings" {...menu.triggerProps}><IconSettings /></IconButton>
      {menu.element}
    </>
  );
}

function CssListView({doc, id, settings}: {doc: DesignDocument; id: NodeId; settings: CodeSettings}) {
  const groups = useMemo(() => cssList(doc, id, {format: formatOf(settings), fontFallback, suggest: settings.suggest}), [doc, id, settings]);
  if (!groups.length) return <p className="dz-panel-note">The layer has no styles of its own.</p>;
  return (
    <div className="dz-code-list">
      {groups.map(group => (
        <div key={group.title}>
          <h4 className="dz-code-subtitle">{group.title}</h4>
          <MeasureRows rows={group.rows} />
        </div>
      ))}
    </div>
  );
}

const fileLabel = (path: string) => path.split('/').pop() ?? path;

function FilesView({output, language}: {output: Extract<Output, {kind: 'files'}>; language: CodeLanguage}) {
  const services = useEditorServices();
  const {files, entry, react} = output;
  const [current, setCurrent] = useState<string | null>(null);
  const path = files.some(file => file.path === current) ? current! : files[0]?.path ?? null;
  const file = files.find(f => f.path === path) ?? null;
  const [busy, setBusy] = useState(false);

  if (!files.length) return <p className="dz-panel-note">{language === 'tokens' ? 'The file has no styles or variables yet, so there is nothing to make tokens from.' : 'Nothing to show.'}</p>;

  const download = async () => {
    if (!react) return;
    setBusy(true);
    try {
      const urls = new Map(react.assets.map(asset => [asset.path, asset.url] as const));
      const {bytes, failed} = await fetchPictures(urls);
      downloadBlob(new Blob([filesZip(react.files, bytes) as Uint8Array<ArrayBuffer>], {type: 'application/zip'}), `${entry?.name ?? 'component'}.zip`);
      if (failed.length) services.toast(`Could not download ${failed.length} images. The rest is in the archive.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {entry?.usage && (
        <div className="dz-code-block">
          <div className="dz-code-bar"><span className="dz-code-bar-title">Usage</span><CopyButton text={entry.usage} label="Copy usage" /></div>
          <CodeView code={entry.usage} language={isVue(language) ? 'html' : 'tsx'} maxLines={4} label="Component usage" />
        </div>
      )}
      {files.length > 1 && (
        <div className="dz-code-files" role="tablist" aria-label="Files">
          {files.map(f => (
            <button key={f.path} type="button" role="tab" aria-selected={f.path === path} className="dz-code-file" onClick={() => setCurrent(f.path)} title={f.path}>
              {fileTabLabel(f.path)}
            </button>
          ))}
        </div>
      )}
      {file && (
        <div className="dz-code-block">
          <div className="dz-code-bar">
            <span className="dz-code-bar-title">{language === 'css' ? 'CSS' : file.path.replace(/^src\//, '')}</span>
            <CopyButton text={file.contents} label="Copy code" />
          </div>
          <CodeView code={file.contents} language={language === 'css' ? 'css' : languageOf(file.path)} maxLines={22} label={`Code: ${fileLabel(file.path)}`} />
        </div>
      )}
      {react && react.warnings.length > 0 && (
        <div className="dz-code-notes">
          <h4 className="dz-code-subtitle">To bring over manually</h4>
          <ul className="dz-code-warnings">{react.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}
      {react && (
        <div className="dz-code-actions">
          <Button icon={<IconDownload />} busy={busy} onClick={download}>Download files</Button>
        </div>
      )}
    </>
  );
}
