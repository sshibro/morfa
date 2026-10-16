// The renderer of "Morfa" (docs/design-tool.md §Renderer, §Performance).
//
// - `createSceneRenderer(canvas, deps)`: the tiled, cached canvas (SceneRenderer + `live`, stats and
//   the page's spatial index for hit testing).
// - `paintNodeTree(target, doc, rootIds, options)`: the one painting path, shared by tiles, the live
//   layer, exports, thumbnails and the prototype player.
// - `SpatialIndex`: page-space bounds of every node, synced from document to document.

export {createCanvasSceneRenderer, createSceneRenderer, createSceneRendererAsync, createSwitchingSceneRenderer} from './scene-renderer';
export type {DesignSceneRenderer, RenderStats, SceneRendererDeps} from './scene-renderer';
export {clearEffectCache, paintNodeTree, sameLook, worldOfNode} from './painter';
export {SpatialIndex} from './spatial-index';
export type {DirtyArea, IndexSync} from './spatial-index';
export type {PaintOptions, SceneIndex, SceneRenderOptions} from './types';
