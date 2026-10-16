// The left panel of the editor (EditorLayout's `pages`, `layers` and `assets` slots).
//   pages={<PagesPanel />} layers={<LayersPanel commandContext={...} />} assets={<AssetsPanel />}
// Each reads the open file through useEditorServices(); `registerLeftPanelCommands()` adds
// "Collapse all layers" (⌥L) and "Rename" (⌘R) to the command registry.

export {PagesPanel, PAGES_HEIGHT_KEY} from './PagesPanel';
export {addPage, duplicatePage, movePage} from './page-actions';
export {LayersPanel, type LayersPanelProps} from './LayersPanel';
export {LayersTree, type LayersTreeProps} from './LayersTree';
export {AssetsPanel, ASSETS_VIEW_KEY, VariablesDialog} from './AssetsPanel';
export {StyleEditor} from './StyleEditor';
export {canHoldInstance, placeInstanceAt, showMainComponent} from './assets-actions';
export {LAYER_MENU, LEFT_PANEL_COMMANDS, layerMenuItems, registerLeftPanelCommands} from './commands';
export {layerTreeState} from './tree-state';
export {componentIndex} from './component-index';
