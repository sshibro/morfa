import {memo, useMemo, useState, type CSSProperties, type ReactNode} from 'react';
import type {Style, StyleId} from '../../../../shared/design/types';
import {groupStyles, styleDisplayName, type StyleGroup} from '../../../../shared/design/styles';
import {useDesignStore} from '../../engine/useDesignStore';
import {useEditorServices} from '../../editor/services';
import {Button} from '../../ui/Button';
import {PanelSection} from '../../ui/PanelSection';
import {StylePreview} from '../left/AssetsPanel';
import {textStyleSummary, variablesSummary} from '../left/assets-model';
import {StyleEditor} from '../left/StyleEditor';
import type {DesignSection} from './sections';
import '../../styles/panel-paint.css';

// With nothing selected, Figma's panel describes the file: the page, its local variables and its local
// styles. "Page" and the colour and effect styles are the paint feature's; this list adds
// "Variables" (115: what the file holds, and the button that opens the variables dialog),
// "Text styles" (119, before the colour styles) and "Grid styles" (122, after the effect styles): a click opens the
// same style editor as "Assets".

const LocalVariablesSection = memo(function LocalVariablesSection() {
  const services = useEditorServices();
  const summary = useDesignStore(state => variablesSummary(state.doc), Object.is, {slice: 'doc'});
  return (
    <PanelSection title="Variables">
      <p className="dz-file-variables-summary">{summary}</p>
      <Button className="dz-file-variables-open" onClick={() => services.openDialog('variables')}>Open variables</Button>
    </PanelSection>
  );
});

/** "28/36": size over line height, the part of the summary that fits beside a name. */
const sizeLine = (style: Style) => textStyleSummary(style).split(' · ')[0];
/** "Columns · 12": a grid style's first grid, the part that fits beside a name. */
const gridLine = (style: Style) => {
  const grid = style.grids?.[0];
  if (!grid) return '';
  const more = (style.grids?.length ?? 0) > 1 ? ` +${(style.grids?.length ?? 1) - 1}` : '';
  return (grid.pattern === 'GRID' ? `Grid · ${grid.sectionSize}` : `${grid.pattern === 'COLUMNS' ? 'Columns' : 'Rows'} · ${grid.count}`) + more;
};

type ListedStyle = 'TEXT' | 'GRID';
const STYLE_SECTION_TITLES: Record<ListedStyle, string> = {TEXT: 'Text styles', GRID: 'Grid styles'};

/** "Text styles" and "Grid styles" with nothing selected: a click opens the style editor "Assets" opens. */
const TypedStylesSection = memo(function TypedStylesSection({type}: {type: ListedStyle}) {
  const styles = useDesignStore(state => state.doc.styles, Object.is, {slice: 'doc'});
  // Local styles only: a shared library's copies are read-only and listed under their library in "Assets".
  const grouped = useMemo(() => groupStyles(Object.values(styles).filter(style => style.type === type && !style.remote)), [styles, type]);
  const [editing, setEditing] = useState<{id: StyleId; anchor: Element} | null>(null);
  const edited = editing ? styles[editing.id] : undefined;

  const renderGroup = (group: StyleGroup, depth: number): ReactNode => (
    <div key={group.path || '/'} className="dz-style-group">
      {group.path && <div className="dz-style-folder" style={{'--dz-depth': depth - 1} as CSSProperties}>{group.name}</div>}
      {group.styles.map(style => (
        <div key={style.id} className={`dz-style-item ${editing?.id === style.id ? 'is-current' : ''}`.trim()} style={{'--dz-depth': depth} as CSSProperties}>
          <button type="button" className="dz-style-apply" aria-haspopup="dialog" aria-expanded={editing?.id === style.id} title={type === 'TEXT' ? textStyleSummary(style) : gridLine(style)}
            onClick={event => {
              const anchor = event.currentTarget.closest('.dz-style-item') ?? event.currentTarget;
              setEditing(current => (current?.id === style.id ? null : {id: style.id, anchor}));
            }}>
            <StylePreview style={style} />
            <span className="dz-style-name">{styleDisplayName(style)}</span>
            <span className="dz-style-meta">{type === 'TEXT' ? sizeLine(style) : gridLine(style)}</span>
          </button>
        </div>
      ))}
      {group.groups.map(child => renderGroup(child, depth + 1))}
    </div>
  );

  return (
    <PanelSection title={STYLE_SECTION_TITLES[type]}>
      <div className="dz-style-list">{renderGroup(grouped, 0)}</div>
      {editing && edited && <StyleEditor style={edited} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </PanelSection>
  );
});

const hasStyles = (styles: Record<string, Style>, type: ListedStyle) => {
  for (const id in styles) if (styles[id].type === type && !styles[id].remote) return true;
  return false;
};

const TextStylesSection = memo(function TextStylesSection() {
  return <TypedStylesSection type="TEXT" />;
});
const GridStylesSection = memo(function GridStylesSection() {
  return <TypedStylesSection type="GRID" />;
});

export const fileSections: DesignSection[] = [
  {id: 'local-variables', order: 115, applies: ({ids}) => !ids.length, Component: LocalVariablesSection},
  {id: 'text-styles', order: 119, applies: ({ids, doc}) => !ids.length && hasStyles(doc.styles, 'TEXT'), Component: TextStylesSection},
  // After the colour (120) and effect (121) styles, as Figma lists a file's local styles.
  {id: 'grid-styles', order: 122, applies: ({ids, doc}) => !ids.length && hasStyles(doc.styles, 'GRID'), Component: GridStylesSection},
];
