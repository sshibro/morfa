import '../styles/guide.css';
import {useMemo, useRef, useState, type ReactNode} from 'react';
import {DESIGN_LIMITS} from '../../../shared/design/limits';
import {getCommand} from '../engine/commands/registry';
import {contactSupport, supportChannel} from '../engine/commands/help';
import {hasTool} from '../engine/tools';
import {loadFigmaImport} from '../files/integrations';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconSearch} from '../ui/icons';
import {Kbd} from '../ui/Spinner';
import {TextInput} from '../ui/TextInput';
import {TOOLS, type ToolId} from './chrome/tools';
import {resolveCommand, searchPalette, shortcutString} from './command-bridge';
import {getEditorPanel, type EditorDialogProps} from './services';
import {groupRows, shortcutRows} from './ShortcutsDialog';

// "Help ▸ Guide": a short guide for designers who come from Figma — what is the same, what is
// not there yet — and the basics of the tool, then every shortcut, searchable.
// Keys and menu paths are read from the registries when the dialog opens, and a topic about a feature
// shows only while that feature is in the editor, so the guide never describes something unbuilt.

type Topic = {id: string; title: string; group: 'start' | 'basics' | 'reference'; available?: () => boolean; body: () => ReactNode};

/** The key of a registered command (menu ids resolve through the editor's aliases); nothing when it has none. */
function K({id}: {id: string}) {
  const command = resolveCommand(id);
  return command?.shortcut ? <Kbd shortcut={shortcutString(command.shortcut)} className="dz-guide-kbd" /> : null;
}

/** A tool's key, while the tool is in the toolbar. */
function T({tool}: {tool: ToolId}) {
  const shortcut = TOOLS[tool].shortcut;
  return shortcut && hasTool(tool) ? <Kbd shortcut={shortcut} className="dz-guide-kbd" /> : null;
}

/** A command named as its menu shows it, with its key. */
function C({id, children}: {id: string; children?: ReactNode}) {
  const command = resolveCommand(id);
  return <span className="dz-guide-cmd">&quot;{children ?? command?.label ?? id}&quot;{command?.shortcut ? <> <K id={id} /></> : null}</span>;
}

const Path = ({children}: {children: ReactNode}) => <span className="dz-guide-path">{children}</span>;

const has = (id: string) => !!resolveCommand(id);
const prototypesAvailable = () => !!getCommand('prototype.play') || !!getEditorPanel('prototype');
const codeAvailable = () => has('file.export-react');

const TOPICS: Topic[] = [
  {
    id: 'figma',
    title: 'For people coming from Figma',
    group: 'start',
    body: () => (
      <>
        <p>Design works the same way: canvas in the middle, layers on the left, properties on the right, tools at the bottom. Shortcuts follow the position of the key, not the letter on it, so they work on any keyboard layout.</p>
        <h4>What is the same</h4>
        <ul>
          <li>Tools and their keys: Move <T tool="move" />, Frame <T tool="frame" />, Rectangle <T tool="rectangle" />, Ellipse <T tool="ellipse" />, Pen <T tool="pen" />, Text <T tool="text" />, Hand <T tool="hand" />.</li>
          <li>Frames, groups <K id="object.group" />, sections, constraints, auto layout <K id="object.auto-layout" />, layout grids.</li>
          <li>Components <K id="object.create-component" />, instances with overrides, variants and component properties.</li>
          <li>Styles and variables with modes, boolean operations, masks, export to PNG, JPG, WEBP, SVG and PDF.</li>
          <li><C id="app.quick-actions" /> searches every command by name.</li>
          <li>Dev Mode (⇧D) and Draw are modes on the toolbar.</li>
        </ul>
        <h4>What is not there yet</h4>
        <ul>
          <li>Collaboration, comments and plugins: Design is built for one designer, and only you can see your files.</li>
          {!prototypesAvailable() && <li>Prototypes and the player.</li>}
        </ul>
      </>
    ),
  },
  {
    id: 'frames',
    title: 'Frames and layers',
    group: 'basics',
    body: () => (
      <>
        <p>A frame <T tool="frame" /> is the base of a layout: a screen, a card, a button. While the tool is selected, ready-made device and format sizes appear on the right. Frames nest inside each other and clip their content when that is turned on.</p>
        <ul>
          <li>A click selects the top layer, a double click goes inside a group or frame, and a click with {isMacLabel('⌘', 'Ctrl')} selects the deepest layer.</li>
          <li><C id="object.group" />, <C id="object.frame-selection" />, <C id="object.select-parent" />.</li>
          <li>Layers and pages are on the File tab on the left <K id="view.panel-layers" />; components, styles and variables are on the Assets tab <K id="view.panel-assets" />.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'auto-layout',
    title: 'Auto layout',
    group: 'basics',
    body: () => (
      <>
        <p><C id="object.auto-layout" /> arranges the layers of a frame in a row or a column: direction, gaps and padding are set in the Auto layout section of the Design panel.</p>
        <ul>
          <li>Size on each axis: Fixed, Hug contents or Fill container (follows the parent).</li>
          <li>The Wrap direction lays layers out in rows, and Absolute position in the Position section takes a layer out of the flow.</li>
          {has('object.remove-auto-layout') && <li><C id="object.remove-auto-layout" /> leaves the layers where they are.</li>}
        </ul>
      </>
    ),
  },
  {
    id: 'components',
    title: 'Components and variants',
    group: 'basics',
    body: () => (
      <>
        <p><C id="object.create-component" /> turns the selection into a main component. Drag instances from Assets, or make one by copying the main component with {isMacLabel('⌥', 'Alt')}. Changes to the main component reach every instance, and overrides in an instance are kept.</p>
        <ul>
          <li><C id="object.combine-variants" /> combines components into a component set; variant properties are set in the Components section.</li>
          <li>Component properties: Variant, Boolean, Text, Instance swap.</li>
          <li><C id="object.reset-instance" />, <C id="object.detach-instance" />, <C id="object.go-to-main" />.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'styles',
    title: 'Styles and variables',
    group: 'basics',
    body: () => (
      <>
        <p>A style stores a fill, text, effects or a grid and updates every layer where it is applied. The four-dot button in a section of the Design panel applies a style or creates a new one; all styles are collected in Assets ▸ Styles.</p>
        <p>Variables are colors, numbers, strings and booleans with modes (for example, a light and a dark theme). They are listed in Assets ▸ Variables, and the button next to a field binds it to a variable.</p>
      </>
    ),
  },
  {
    id: 'prototypes',
    title: 'Prototypes',
    group: 'basics',
    available: prototypesAvailable,
    body: () => (
      <p>On the Prototype tab of the right panel, layers get interactions: on click, while hovering or after a delay, they navigate to a frame, open an overlay or follow a link. The ▶ button in the right panel opens the player.</p>
    ),
  },
  {
    id: 'export',
    title: 'Export',
    group: 'basics',
    body: () => (
      <>
        <p>In the Export section of the Design panel, a layer gets formats and scales: PNG, JPG, WEBP, SVG, PDF. <C id="file.export" /> gathers all the export settings of the page, <C id="file.export-selection" /> only those of the selection.</p>
        {has('edit.copy-png') && <p>Edit ▸ Copy as puts the selection on the clipboard as PNG, SVG, CSS or text.</p>}
      </>
    ),
  },
  {
    id: 'code',
    title: 'Code',
    group: 'basics',
    available: codeAvailable,
    body: () => (
      <>
        <p>The Code tab of the right panel shows React and CSS for the selected layer: auto layout becomes flexbox, and styles and variables become CSS variables.</p>
        <p><C id="file.export-react" /> downloads a Vite + React + TypeScript project with components, images and tokens, <C id="file.export-vue" /> the same project in Vue 3.</p>
      </>
    ),
  },
  {
    id: 'figma-import',
    title: 'Import from Figma',
    group: 'basics',
    available: () => loadFigmaImport !== null,
    body: () => (
      <p>In the file list: <Path>Import ▸ Import from Figma…</Path> Drop a .fig file into the window (in Figma: File → Save local copy), or paste a link to a file and connect your Figma account or a personal access token. The file is read right in the browser, and at the end you get a report of what carried over only approximately.</p>
    ),
  },
  {
    id: 'versions',
    title: 'Version history',
    group: 'basics',
    available: () => has('file.versions'),
    body: () => (
      <>
        <p>Changes are saved automatically, a second after an edit; the status shows under the file name. Automatic versions appear as you work.</p>
        <ul>
          <li><C id="file.versions" /> shows past versions; any of them can be opened and restored.</li>
          {has('file.save-version') && <li><C id="file.save-version" /> saves a named version, for example before a big edit.</li>}
          <li>Automatic versions are kept for {DESIGN_LIMITS.historyDays} days.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'commands',
    title: 'Find, properties, links',
    group: 'basics',
    body: () => (
      <ul>
        <li><C id="edit.find" /> searches the text in layers and the layer names on the page or in the whole file, and replaces text one match at a time or all at once.</li>
        <li><C id="edit.copy-properties" /> and <C id="edit.paste-properties" /> carry fills, strokes, effects, corner radius, opacity and font from one layer to others.</li>
        <li><C id="edit.paste-replace" /> puts what you copied in place of the selected layer.</li>
        <li><C id="edit.copy-link" /> copies a link that opens the file at this layer. Only you can open the file with it.</li>
        <li><C id="object.rasterize" /> turns the selection into an image.</li>
      </ul>
    ),
  },
  {id: 'shortcuts', title: 'Keyboard shortcuts', group: 'reference', body: () => <ShortcutsReference />},
];

function isMacLabel(mac: string, other: string) {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? mac : other;
}

const GROUPS: {id: Topic['group']; title: string}[] = [
  {id: 'start', title: 'Getting started'},
  {id: 'basics', title: 'Basics'},
  {id: 'reference', title: 'Reference'},
];

export default function GuideDialog({params, onClose}: EditorDialogProps) {
  const topics = useMemo(() => TOPICS.filter(topic => !topic.available || topic.available()), []);
  const [selected, setSelected] = useState(() => (typeof params.topic === 'string' && topics.some(topic => topic.id === params.topic) ? params.topic : topics[0].id));
  const topic = topics.find(item => item.id === selected) ?? topics[0];
  const article = useRef<HTMLElement>(null);
  const [channel] = useState(() => supportChannel());
  const choose = (id: string) => {
    setSelected(id);
    article.current?.scrollTo({top: 0});
  };
  return (
    <Dialog title="Guide" onClose={onClose} width={780} className="dz-guide"
      footer={
        <>
          {channel && <Button size={32} variant="ghost" className="dz-guide-support" onClick={() => contactSupport(channel)}>Contact support</Button>}
          <Button size={32} variant="primary" onClick={onClose}>Done</Button>
        </>
      }>
      <nav className="dz-guide-nav" aria-label="Guide sections">
        {GROUPS.map(group => {
          const list = topics.filter(item => item.group === group.id);
          if (!list.length) return null;
          return (
            <div key={group.id} className="dz-guide-nav-group">
              <div className="dz-guide-nav-title">{group.title}</div>
              {list.map(item => (
                <button key={item.id} type="button" className="dz-guide-topic" aria-current={item.id === topic.id ? 'page' : undefined} onClick={() => choose(item.id)}>
                  {item.title}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <article ref={article} className="dz-guide-article" aria-labelledby="dz-guide-heading">
        <h3 id="dz-guide-heading">{topic.title}</h3>
        {topic.body()}
      </article>
    </Dialog>
  );
}

/** Every key of the registry, grouped as the menus are, searchable by name. */
function ShortcutsReference() {
  const [query, setQuery] = useState('');
  const [rows] = useState(() => shortcutRows());
  const groups = useMemo(() => {
    let shown = rows;
    if (query.trim()) {
      const entries = rows.map(row => ({id: row.id, label: row.label, shortcut: row.shortcut, keywords: `${row.group} ${row.id.replace(/[.-]+/g, ' ')}`}));
      const order = new Map(searchPalette(entries, query).map((entry, index) => [entry.id, index]));
      shown = rows.filter(row => order.has(row.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    }
    return groupRows(shown);
  }, [rows, query]);
  return (
    <div className="dz-guide-keys">
      <TextInput value={query} onChange={setQuery} icon={<IconSearch />} placeholder="Search commands" aria-label="Search commands" size={32} />
      {groups.length ? groups.map(({group, rows: list}) => (
        <section key={group} className="dz-guide-keys-group" aria-label={group}>
          <h4>{group}</h4>
          <dl>
            {list.map(row => (
              <div key={row.id} className="dz-guide-keys-row">
                <dt>{row.label}</dt>
                <dd><Kbd shortcut={row.shortcut} /></dd>
              </div>
            ))}
          </dl>
        </section>
      )) : <p className="dz-guide-empty">Nothing found</p>}
    </div>
  );
}
