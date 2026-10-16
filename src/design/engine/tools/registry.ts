import type {Tool} from './types';

// Tools by id. A tool module registers a factory; each canvas makes its own instance, so drag
// state never leaks between two canvases. Registering an id again replaces it (hot reload).
// The toolbar shows a tool once it is registered and listens here, so a module that registers
// after the editor opened (a lazily loaded one) appears without a reload.

export type ToolFactory = () => Tool;

const factories = new Map<string, ToolFactory>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of [...listeners]) listener();
};

export function registerTool(id: string, factory: ToolFactory): () => void {
  const added = !factories.has(id);
  factories.set(id, factory);
  if (added) changed();
  return () => {
    if (factories.get(id) !== factory) return;
    factories.delete(id);
    changed();
  };
}

export const hasTool = (id: string) => factories.has(id);

/** Tools one editor uses in place of the shared ones (docs/board.md: a board's "Move"), keyed by that editor's store. */
const scoped = new WeakMap<object, Map<string, ToolFactory>>();

/** Makes the canvases of `scope` (an editor's store) create `id` with `factory` instead of the shared tool. Register before the canvas
 *  mounts. Returns the undo. */
export function registerScopedTool(scope: object, id: string, factory: ToolFactory): () => void {
  let tools = scoped.get(scope);
  if (!tools) scoped.set(scope, (tools = new Map()));
  tools.set(id, factory);
  return () => {
    if (tools.get(id) === factory) tools.delete(id);
  };
}

export function createTool(id: string, scope?: object): Tool | null {
  const factory = (scope && scoped.get(scope)?.get(id)) || factories.get(id);
  return factory ? factory() : null;
}

export const toolIds = () => [...factories.keys()];

/** Tools registered or removed: `useSyncExternalStore(onToolsChange, toolsVersion)`. */
export function onToolsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export const toolsVersion = () => version;
