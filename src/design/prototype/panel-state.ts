import {useCallback, useRef} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {isTopLevelFrame, topLevelFrames} from '../../../shared/design/prototype';
import type {Transaction} from '../../../shared/design/transaction';
import {shallowEqual, useDesignStore} from '../engine/useDesignStore';
import type {DesignStore, EditorState, Gesture} from '../engine/store';
import {userUpdate} from '../engine/user-edit';
import type {NumberChangeSource} from '../ui/NumberField';

// What the "Prototype" tab reads from the store, narrowed to the fields it shows: moving or resizing a
// layer (new x, y, width) re-renders nothing here, only prototype fields do. Edits go through
// `userUpdate` (styles, instance overrides), scrubs through one gesture (one undo step).

const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

export type ProtoNodeView = {
  id: NodeId;
  type: SceneNode['type'];
  name: string;
  reactions: SceneNode['reactions'];
  overflowDirection: SceneNode['overflowDirection'];
  scrollBehavior: SceneNode['scrollBehavior'];
  overlayPositionType: SceneNode['overlayPositionType'];
  overlayBackground: SceneNode['overlayBackground'];
  overlayBackgroundInteraction: SceneNode['overlayBackgroundInteraction'];
  frameLike: boolean;
  topLevel: boolean;
  /** Its parent is a frame other than the page: "Scroll behavior" applies. */
  inFrame: boolean;
};

function viewOf(doc: DesignDocument, node: SceneNode): ProtoNodeView {
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    reactions: node.reactions,
    overflowDirection: node.overflowDirection,
    scrollBehavior: node.scrollBehavior,
    overlayPositionType: node.overlayPositionType,
    overlayBackground: node.overlayBackground,
    overlayBackgroundInteraction: node.overlayBackgroundInteraction,
    frameLike: FRAME_LIKE.has(node.type),
    topLevel: isTopLevelFrame(doc, node.id),
    inFrame: !!parent && FRAME_LIKE.has(parent.type),
  };
}

const selectSelection = (state: EditorState) => state.selection;
export const useSelection = (store: DesignStore) => useDesignStore(selectSelection, shallowEqual, {store, slice: 'selection'});

export function useProtoNodes(store: DesignStore, ids: readonly NodeId[]): ProtoNodeView[] {
  const selector = useCallback((state: EditorState) => ids.map(id => state.doc.nodes[id]).filter((node): node is SceneNode => !!node).map(node => viewOf(state.doc, node)), [ids]);
  return useDesignStore(selector, sameViews, {store, slice: ['doc', 'selection']});
}

const sameViews = (a: ProtoNodeView[], b: ProtoNodeView[]) => a.length === b.length && a.every((view, i) => shallowEqual(view, b[i]));

export type PageView = Pick<SceneNode, 'id' | 'flowStartingPoints' | 'prototypeDevice' | 'prototypeBackground'>;
const selectPage = (state: EditorState): PageView => {
  const page = state.doc.nodes[state.pageId];
  return {id: state.pageId, flowStartingPoints: page?.flowStartingPoints, prototypeDevice: page?.prototypeDevice, prototypeBackground: page?.prototypeBackground};
};
export const usePageView = (store: DesignStore) => useDesignStore(selectPage, shallowEqual, {store, slice: ['doc', 'page']});

/** Top-level frames of the page as [id, name] pairs (destination pickers). */
export type FrameEntry = readonly [NodeId, string];
const selectFrames = (state: EditorState): FrameEntry[] => topLevelFrames(state.doc, state.pageId).map(id => [id, state.doc.nodes[id]?.name ?? ''] as const);
const sameEntries = (a: FrameEntry[], b: FrameEntry[]) => a.length === b.length && a.every((entry, i) => entry[0] === b[i][0] && entry[1] === b[i][1]);
export const useFrames = (store: DesignStore) => useDesignStore(selectFrames, sameEntries, {store, slice: ['doc', 'page']});

/** Edits one or more nodes by hand. `source` 'scrub' runs inside one gesture until `end`. */
export function useNodeEdit(store: DesignStore) {
  const gesture = useRef<Gesture | null>(null);
  const edit = useCallback((label: string, ids: readonly NodeId[], make: (node: SceneNode) => Partial<SceneNode> | null, source?: NumberChangeSource) => {
    const recipe = (tx: Transaction) => {
      for (const id of ids) {
        const node = tx.get(id);
        const partial = node && make(node);
        if (partial) userUpdate(tx, id, partial);
      }
    };
    if (source === 'scrub') {
      if (!gesture.current?.active) gesture.current = store.gesture(label);
      gesture.current.update(recipe);
      return;
    }
    store.transact(label, recipe);
  }, [store]);
  const end = useCallback((cancelled: boolean) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current?.active) return;
    if (cancelled) current.cancel();
    else current.commit();
  }, []);
  return {edit, end};
}
