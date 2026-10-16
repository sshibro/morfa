import '../styles/panel-code.css';
import {useMemo, useState} from 'react';
import type {NodeId, SceneNode} from '../../../shared/design/types';
import {topLevelSelection} from '../../../shared/design/tree';
import {snapshotDocument} from '../../../shared/design/table-cache';
import {pageLayers, projectFiles, projectZip} from '../../../shared/design/codegen/project';
import type {Framework, Styling} from '../../../shared/design/codegen/react';
import {vueProjectFiles} from '../../../shared/design/codegen/vue-project';
import {slugName} from '../../../shared/design/codegen/names';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {Select, type SelectEntry} from '../ui/Select';
import {SegmentedControl} from '../ui/Tabs';
import {TextInput} from '../ui/TextInput';
import {Checkbox} from '../ui/Toggle';
import {downloadBlob, fetchPictures, fontFallback} from '../engine/commands/code';
import {useEditorServices} from './services';

// "Export to React…" and "Export to Vue…": picks what to export (the selection, a page, or the whole file,
// layer by layer), the styling, and a project name, then builds a Vite + React (or Vue 3) + TypeScript project
// and downloads it as a zip (docs/design-tool.md §Design to code). Pictures are fetched from the file's own
// storage; any that fail are named in the README and in the dialog, never silently dropped.

export type ReactExportDialogProps = {
  onClose: () => void;
  /** The selection when the dialog was opened (the command passes it). */
  ids?: readonly NodeId[];
  pageId?: NodeId;
  /** The file's name, for the project name. */
  fileName?: string;
  /** The project's framework: React (default) or Vue. */
  framework?: Framework;
};

type Scope = 'selection' | `page:${string}` | 'all';

const STYLINGS = [
  {value: 'css-modules', label: 'CSS Modules'},
  {value: 'tailwind', label: 'Tailwind'},
  {value: 'inline', label: 'Inline styles'},
] as const;

const KIND: Partial<Record<SceneNode['type'], string>> = {COMPONENT: 'Component', COMPONENT_SET: 'Variants', INSTANCE: 'Instance', SECTION: 'Section'};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ReactExportDialog({onClose, ids = [], pageId, fileName, framework = 'react'}: ReactExportDialogProps) {
  const vue = framework === 'vue';
  const services = useEditorServices();
  // The dialog's document, taken once: the export it starts spans awaits, and the store's table may be written in place.
  const doc = useMemo(() => snapshotDocument(services.store.getState().doc), [services]);
  const currentPage = pageId ?? services.store.getState().pageId;
  const selection = useMemo(() => topLevelSelection(doc, ids).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE'), [doc, ids]);
  const [scope, setScope] = useState<Scope>(selection.length ? 'selection' : `page:${currentPage}`);
  const [styling, setStyling] = useState<Styling>('css-modules');
  const [name, setName] = useState(fileName || doc.nodes[currentPage]?.name || 'Design');
  const [unchecked, setUnchecked] = useState<ReadonlySet<NodeId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const scopes: SelectEntry<Scope>[] = [
    ...(selection.length ? [{value: 'selection' as const, label: `Selection (${selection.length})`}, {separator: true as const}] : []),
    ...doc.pages.map(id => ({value: `page:${id}` as const, label: doc.nodes[id]?.name ?? 'Page'})),
    ...(doc.pages.length > 1 ? [{separator: true as const}, {value: 'all' as const, label: 'All pages'}] : []),
  ];

  // The layers on offer, grouped by page.
  const groups = useMemo(() => {
    if (scope === 'selection') return [{pageId: '', title: '', layers: selection.map(id => doc.nodes[id])}];
    const pages = scope === 'all' ? doc.pages : [scope.slice(5)];
    return pages.map(id => ({pageId: id, title: scope === 'all' ? doc.nodes[id]?.name ?? '' : '', layers: pageLayers(doc, id)}));
  }, [scope, doc, selection]);
  const all = groups.flatMap(group => group.layers);
  const chosen = all.filter(node => !unchecked.has(node.id));
  const components = chosen.filter(node => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET').length;
  const screens = chosen.length - components;

  const toggle = (id: NodeId, on: boolean) => setUnchecked(previous => {
    const next = new Set(previous);
    if (on) next.delete(id);
    else next.add(id);
    return next;
  });
  const setAll = (on: boolean) => setUnchecked(on ? new Set() : new Set(all.map(node => node.id)));

  const exportProject = async () => {
    setBusy(true);
    setProblem(null);
    // Let the button show its spinner before the generator takes the thread.
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      const project = (vue ? vueProjectFiles : projectFiles)(doc, chosen.map(node => node.id), {name, styling, measurer: services.store.measurer, fontFallback});
      const urls = new Map(project.code.assets.map(asset => [asset.path, asset.url] as const));
      const {bytes, failed} = await fetchPictures(urls);
      if (failed.length) {
        const readme = project.files.find(file => file.path === 'README.md');
        if (readme) readme.contents += `\n## Could not download images\n\n${failed.map(path => `- \`${path}\``).join('\n')}\n\nSave them from the design manually to these paths.\n`;
      }
      const zip = projectZip(project, bytes);
      downloadBlob(new Blob([zip as Uint8Array<ArrayBuffer>], {type: 'application/zip'}), `${project.folder}.zip`);
      if (failed.length) {
        setProblem(`The archive was downloaded, but ${plural(failed.length, 'image', 'images')} could not be fetched. They are listed in the README.`);
      } else {
        services.toast(`Project "${project.folder}" downloaded`, 'success');
        onClose();
      }
    } catch (error) {
      setProblem(error instanceof Error ? `Could not build the project: ${error.message}` : 'Could not build the project.');
    } finally {
      setBusy(false);
    }
  };

  const folder = slugName(name, 'design-export');
  return (
    <Dialog title={vue ? 'Export to Vue' : 'Export to React'} onClose={onClose} width={420} dismissible={!busy} footer={
      <>
        <Button size={32} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size={32} variant="primary" busy={busy} disabled={!chosen.length} onClick={exportProject}>Download {folder}.zip</Button>
      </>
    }>
      <div className="dz-react-export">
        <label className="dz-react-field">
          <span className="dz-react-label">Project name</span>
          <TextInput size={32} value={name} onChange={setName} aria-label="Project name" />
        </label>
        <div className="dz-react-field">
          <span className="dz-react-label">What to export</span>
          <Select size={32} value={scope} options={scopes} onChange={next => {setScope(next); setUnchecked(new Set());}} aria-label="What to export" />
          {all.length ? (
            <div className="dz-react-layers" role="group" aria-label="Layers">
              {groups.map(group => (
                <div key={group.pageId || 'selection'}>
                  {group.title && <div className="dz-react-page">{group.title}</div>}
                  {group.layers.map(node => (
                    <div key={node.id} className={`dz-react-layer ${node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE' ? 'is-component' : ''}`.trim()}>
                      <Checkbox checked={!unchecked.has(node.id)} onChange={on => toggle(node.id, on)}>{node.name}</Checkbox>
                      <span className="dz-react-layer-kind">{KIND[node.type] ?? 'Screen'}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : <p className="dz-react-summary">Nothing to export on this page.</p>}
          {all.length > 1 && (
            <div className="dz-react-tools">
              <span className="dz-react-summary">
                {[screens ? plural(screens, 'screen', 'screens') : '', components ? plural(components, 'component', 'components') : ''].filter(Boolean).join(' · ') || 'Nothing selected'}
              </span>
              <Button variant="ghost" onClick={() => setAll(chosen.length !== all.length)}>{chosen.length === all.length ? 'Deselect all' : 'Select all'}</Button>
            </div>
          )}
        </div>
        <div className="dz-react-field">
          <span className="dz-react-label">Styling</span>
          <SegmentedControl options={STYLINGS} value={styling} onChange={setStyling} fill aria-label="Styling" />
        </div>
        <p className="dz-react-summary">{vue ? 'Vite, Vue 3 and TypeScript, one single-file component per screen and component.' : 'Vite, React 19 and TypeScript.'} Components the screens use are added to the archive automatically, tokens go to tokens.css.</p>
        {problem && <p className="dz-react-error" role="alert">{problem}</p>}
      </div>
    </Dialog>
  );
}
