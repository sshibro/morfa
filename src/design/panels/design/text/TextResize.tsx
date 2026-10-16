import type {NodeId, SceneNode, TextProps} from '../../../../../shared/design/types';
import {applyTextOp} from '../../../engine/commands/text';
import {useEditorServices} from '../../../editor/services';
import {Button} from '../../../ui/Button';
import {IconTextAutoHeight, IconTextAutoWidth, IconTextFixed, IconTextTruncate} from '../../../ui/icons';
import {NumberField} from '../../../ui/NumberField';
import {SegmentedControl, type SegmentOption} from '../../../ui/Tabs';
import {Row} from '../shared/fields';
import {mixedOf, type Mixed} from '../shared/mixed';

// A text box's resizing in "Layout", where Figma UI3 puts it beside W and H: auto width, auto height, fixed, or
// truncated with "Max lines". A text on a path has its path's box and no resizing (TextPathSection).

const RESIZE: SegmentOption<TextProps['textAutoResize']>[] = [
  {value: 'WIDTH_AND_HEIGHT', label: 'Auto width', icon: <IconTextAutoWidth />},
  {value: 'HEIGHT', label: 'Auto height', icon: <IconTextAutoHeight />},
  {value: 'NONE', label: 'Fixed size', icon: <IconTextFixed />},
  {value: 'TRUNCATE', label: 'Truncate text', icon: <IconTextTruncate />},
];

export type TextResizeView = {resize: Mixed<TextProps['textAutoResize']>; maxLines: Mixed<number | null>};

/** The resizing of these layers, or null unless every one is a text in a box. */
export function textResizeView(nodes: readonly SceneNode[]): TextResizeView | null {
  if (!nodes.length || !nodes.every(node => node.type === 'TEXT' && node.text && !node.textPath)) return null;
  return {
    resize: mixedOf(nodes.map(node => node.text!.textAutoResize)),
    maxLines: mixedOf<number | null>(nodes.map(node => node.text!.maxLines ?? null)),
  };
}

export function TextResizeRows({ids, view}: {ids: readonly NodeId[]; view: TextResizeView}) {
  const {store} = useEditorServices();
  const set = (props: Partial<TextProps>, label: string) => applyTextOp(store, {kind: 'props', props}, label, {ids});
  return (
    <>
      <Row layout="single">
        <SegmentedControl aria-label="Box size" options={RESIZE} value={view.resize === 'mixed' ? null : view.resize} fill
          onChange={value => set({textAutoResize: value}, 'Text box size')} />
      </Row>
      {view.resize === 'TRUNCATE' && (
        <Row>
          <NumberField value={view.maxLines} label="Max" aria-label="Max lines" title="Max lines (empty — as many as fit)"
            placeholder="All" min={1} max={1000} precision={0}
            onChange={value => set({maxLines: Math.max(1, Math.round(value))}, 'Max lines')} />
          {/* "All" in the empty field says how many show; a limit set is taken back here. */}
          {view.maxLines !== null && view.maxLines !== 'mixed' && (
            <Button size={24} variant="ghost" className="dz-text-all-lines" onClick={() => set({maxLines: null}, 'Max lines')}>All lines</Button>
          )}
        </Row>
      )}
    </>
  );
}
