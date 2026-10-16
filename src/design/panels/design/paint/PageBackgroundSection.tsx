import '../../../styles/panel-paint.css';
import {memo, useState} from 'react';
import type {NodeId, Paint} from '../../../../../shared/design/types';
import {defaultPageBackground, solid} from '../../../../../shared/design/defaults';
import {useDesignStore} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {IconButton} from '../../../ui/Button';
import {besidePanel} from '../../../ui/ColorPicker';
import {IconRestore} from '../../../ui/icons';
import {PanelSection} from '../../../ui/PanelSection';
import type {Rect} from '../../../ui/position';
import {useResolvedTheme} from '../../../ui/theme';
import {parseHex, toHex} from './color';
import {useCommitter, type Recipe} from './editing';
import {PaintPicker} from './PaintPicker';
import {HexField, PaintSwatch} from './PaintRows';

// "Page" with nothing selected: the page's background colour (no alpha: the canvas behind it is
// the page itself), with the same picker as fills. A page that never had a colour of its own follows the
// editor's theme (#F5F5F5 light, #1E1E1E dark, as in Figma) and says "Default"; once a colour is
// picked it stays in both themes, and "Default color" gives the page back to the theme.

export const PageBackgroundSection = memo(function PageBackgroundSection({pageId, first = false}: {pageId?: NodeId; first?: boolean}) {
  const id = useDesignStore(state => pageId ?? state.pageId, Object.is, {slice: 'page'});
  const own = useDesignStore(state => state.doc.nodes[id]?.backgroundColor, Object.is, {slice: ['doc', 'page']});
  const theme = useResolvedTheme();
  const color = own ?? defaultPageBackground(theme);
  const committer = useCommitter();
  const [open, setOpen] = useState<{anchor: Rect; row: Element} | null>(null);
  const paint: Paint = solid(color);
  const write = (next: Paint): Recipe => tx => {
    if (next.type === 'SOLID') userUpdate(tx, id, {backgroundColor: {r: next.color.r, g: next.color.g, b: next.color.b}});
  };
  return (
    <PanelSection title="Page" first={first}>
      <div className={`dz-paint-row is-page ${own ? 'is-own' : 'is-default'} ${open ? 'is-open' : ''}`.trim()}>
        <div className="dz-paint-field">
          <PaintSwatch paint={paint} open={!!open} label="Page background" onClick={row => setOpen(current => (current ? null : {anchor: besidePanel(row), row}))} />
          <HexField value={toHex(color)} label="Page background" onCommit={text => {
            const parsed = parseHex(text);
            if (parsed) committer.set('Page background', write(solid(parsed.color)));
          }} />
          {!own && <span className="dz-paint-default">Default</span>}
        </div>
        {own && (
          <IconButton label="Default color" onClick={() => {
            setOpen(null);
            committer.set('Default page background', tx => userUpdate(tx, id, {backgroundColor: undefined}));
          }}>
            <IconRestore />
          </IconButton>
        )}
      </div>
      {open && (
        <PaintPicker anchor={open.anchor} trigger={open.row} onClose={() => setOpen(null)} paint={paint} label="Page background" committer={committer} kinds="solid" alpha={false} write={write} />
      )}
    </PanelSection>
  );
});
