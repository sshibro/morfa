// What other parts of the editor take from the component feature:
// - ComponentPropertyBindButton: "◇" beside a layer's eye, a text's content or a nested instance in a main.
// - ComponentHeaderActions / componentHeaderAction: "Create component", "Combine as variants" for the
//   selection header's registry.
// - ComponentCanvasOverlay: the "+" on a selected variant set, for EditorLayout's `overlay` slot.
// - SwapMenu: the searchable component list with pictures (assets, prototype panels may reuse it).
// The sections themselves are listed in ../component-sections.ts.
export {ComponentPropertyBindButton, type ComponentPropertyBindButtonProps} from './ComponentPropertyBindButton';
export {ComponentHeaderActions, componentHeaderAction, canOfferComponent} from './ComponentHeaderActions';
export {ComponentCanvasOverlay} from './ComponentCanvasOverlay';
export {SwapMenu, type SwapMenuProps} from './SwapMenu';
export {ComponentSection} from './ComponentSection';
export {InstanceSection} from './InstanceSection';
export {VariableModesSection} from './VariableModesSection';
