import {registerCommand} from '../engine/commands/registry';
import {registerAnnotationTools} from './tools';
import {annotationsState} from './state';

// Dev annotations and measurements in "Morfa" (docs/design-tool.md §Dev annotations and measurements): what the
// editor's chunk carries. The tools ("Annotation" Y, "Measurement" ⇧M) and "View → Annotations" (⇧Y) register on import (one
// feature line in DesignEditor.tsx); the canvas layer and the "Code" section load with their first use (./host.tsx).

registerAnnotationTools();
registerCommand({
  id: 'view.annotations',
  label: 'Annotations',
  group: 'view',
  shortcut: {code: 'KeyY', shift: true},
  checked: ctx => annotationsState(ctx.store).get().visible,
  run: ctx => {
    const state = annotationsState(ctx.store);
    state.set({visible: !state.get().visible});
  },
});

export {ANNOTATION_TOOL, MEASURE_TOOL, annotationsState, devNotesShown, type AnnotationsUI} from './state';
export {AnnotationsHost, DevNotesSection} from './host';
