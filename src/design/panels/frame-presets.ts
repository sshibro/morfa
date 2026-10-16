import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import {createNode, newId} from '../../../shared/design/defaults';
import type {Rect} from '../../../shared/design/geometry';
import {boundsOf} from '../../../shared/design/constraints';
import {isFrameLikeNode} from '../../../shared/design/tree';
import type {DesignStore, EditorState} from '../engine/store';
import {marketplaceCardName, newCardMeta, withCardMeta} from '../../../shared/design/marketplace/meta';
import {marketplaceSpec, type Marketplace} from '../../../shared/design/marketplace/specs';

// The frame sizes the right panel offers while "Frame" (F) is the tool, as in Figma: a click puts a
// frame of that size next to the last frame on the page (or in the middle of the view when there is
// none), selects it and hands back to "Move". Sizes are CSS px (points) of the devices'
// viewports, the current models of 2026; paper in PostScript points (1/72 in).

export type FramePreset = {
  id: string;
  name: string;
  width: number;
  height: number;
  /** "Marketplaces": the frame becomes this marketplace's card (docs/marketplaces.md §Frames and the new card). */
  marketplace?: Marketplace;
};
export type FramePresetGroup = {id: string; label: string; presets: FramePreset[]};

const p = (id: string, name: string, width: number, height: number): FramePreset => ({id, name, width, height});

export const FRAME_PRESET_GROUPS: readonly FramePresetGroup[] = [
  {id: 'phone', label: 'Phone', presets: [
    p('iphone-16', 'iPhone 16', 393, 852),
    p('iphone-16-pro', 'iPhone 16 Pro', 402, 874),
    p('iphone-16-pro-max', 'iPhone 16 Pro Max', 440, 956),
    p('iphone-se', 'iPhone SE', 375, 667),
    p('android-compact', 'Android Compact', 412, 917),
    p('android-medium', 'Android Medium', 700, 840),
  ]},
  {id: 'tablet', label: 'Tablet', presets: [
    p('ipad-mini', 'iPad mini 8.3', 744, 1133),
    p('ipad-pro-11', 'iPad Pro 11', 834, 1194),
    p('ipad-pro-12-9', 'iPad Pro 12.9', 1024, 1366),
    p('surface-pro-8', 'Surface Pro 8', 1440, 960),
  ]},
  {id: 'desktop', label: 'Desktop', presets: [
    p('macbook-air-13', 'MacBook Air 13', 1280, 832),
    p('macbook-pro-14', 'MacBook Pro 14', 1512, 982),
    p('macbook-pro-16', 'MacBook Pro 16', 1728, 1117),
    p('desktop-1440', 'Desktop', 1440, 1024),
    p('desktop-1920', 'Desktop Full HD', 1920, 1080),
  ]},
  {id: 'presentation', label: 'Presentation', presets: [
    p('slide-16-9', 'Slide 16:9', 1920, 1080),
    p('slide-4-3', 'Slide 4:3', 1024, 768),
  ]},
  {id: 'watch', label: 'Watch', presets: [
    p('apple-watch-41', 'Apple Watch 41mm', 176, 215),
    p('apple-watch-45', 'Apple Watch 45mm', 198, 242),
  ]},
  {id: 'social', label: 'Social', presets: [
    p('vk-post-square', 'VK post', 1080, 1080),
    p('vk-post-portrait', 'VK post 4:5', 1080, 1350),
    p('telegram-post', 'Telegram post', 1280, 720),
    p('story', 'Story', 1080, 1920),
    p('youtube-cover', 'YouTube cover', 1280, 720),
  ]},
  // A product card's main photo, its badge zones drawn on the canvas and Spec Lint in "Card" (docs/marketplaces.md).
  {id: 'marketplace', label: 'Marketplaces', presets: [
    {...p('wb-card', 'Wildberries', 900, 1200), marketplace: 'wb'},
    {...p('ozon-card', 'Ozon', 900, 1200), marketplace: 'ozon'},
    {...p('ozon-fresh-card', 'Ozon fresh 1:1', 1200, 1200), marketplace: 'ozon'},
    {...p('ym-card', 'Yandex Market', 900, 1200), marketplace: 'ym'},
  ]},
  {id: 'paper', label: 'Paper', presets: [
    p('a4', 'A4', 595, 842),
    p('a5', 'A5', 420, 595),
    p('letter', 'Letter', 612, 792),
  ]},
];

/** Whether the right panel shows the presets instead of the selection's properties. */
export const framePresetsVisible = (state: Pick<EditorState, 'tool'>) => state.tool === 'frame';

/** Space between a new frame and the one it is placed next to. */
export const PRESET_GAP = 100;
const MAX_STEPS = 200;

/** Where a new frame of `size` goes on the page: right of the last top-level frame (stepping on past
 *  anything it would overlap), or centred on `centre` when the page has no frame. Whole pixels. */
export function presetPlacement(doc: DesignDocument, pageId: NodeId, size: {width: number; height: number}, centre: Vec): Vec {
  const children = doc.nodes[pageId]?.children ?? [];
  let last: Rect | null = null;
  for (let i = children.length - 1; i >= 0 && !last; i--) {
    const node = doc.nodes[children[i]];
    if (node?.visible && (isFrameLikeNode(node) || node.type === 'SECTION')) last = boundsOf(node);
  }
  if (!last) return {x: Math.round(centre.x - size.width / 2), y: Math.round(centre.y - size.height / 2)};
  const boxes = children.map(id => doc.nodes[id]).filter(node => node?.visible).map(node => boundsOf(node));
  const place = {x: Math.round(last.x + last.width + PRESET_GAP), y: Math.round(last.y), width: size.width, height: size.height};
  for (let step = 0; step < MAX_STEPS; step++) {
    const blocking = boxes.find(box => place.x < box.x + box.width && box.x < place.x + place.width && place.y < box.y + box.height && box.y < place.y + place.height);
    if (!blocking) break;
    place.x = Math.round(blocking.x + blocking.width + PRESET_GAP);
  }
  return {x: place.x, y: place.y};
}

/** Inserts a frame of the preset's size on the page (one undo step), selects it and returns its id. A marketplace preset makes
 *  the frame that marketplace's card, the main photo of a new set, named "WB · Main photo". */
export function insertPresetFrame(store: DesignStore, preset: FramePreset, centre: Vec): NodeId {
  const state = store.getState();
  const at = presetPlacement(state.doc, state.pageId, preset, centre);
  const id = newId();
  const card = preset.marketplace ? {name: marketplaceCardName(preset.marketplace), pluginData: withCardMeta(undefined, newCardMeta(preset.marketplace, newId()))} : {name: preset.name};
  store.transact(preset.marketplace ? `Card ${marketplaceSpec(preset.marketplace).short}` : 'Frame', tx => {
    tx.create(createNode('FRAME', {id, ...card, x: at.x, y: at.y, width: preset.width, height: preset.height}), state.pageId);
    return {select: [id]};
  });
  store.setTool('move');
  return id;
}
